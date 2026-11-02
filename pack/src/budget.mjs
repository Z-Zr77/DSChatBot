import { AsyncLocalStorage } from "node:async_hooks";
// 成本计量与预算熔断（DECISIONS.md 第七条）
//
// 怎么算的、以及为什么不保证百分百准：
//  - 文本：token 数取自 DSH headless 的 usage 事件（inputTokens / cacheReadTokens / outputTokens），
//    这是模型端真实计数；不确定的只有**单价**（官网调价后改 config.json 的 budget.prices）。
//  - 语音合成：按送出的字符数 × 每千字符价（CosyVoice 按字符计费）。
//  - 语音识别：按音频秒数 × 每秒价（拿不到精确时长时按 5 秒估）。
//  - 看图：按调用次数估（图片 token 不透明，只能取均值）。
// 结论：文本很准（误差只来自单价），语音/图片是估算，整月账面与实际可能差 10~20%。
// 想对得更准：把阿里云真实账单填进控制台「实际账单」栏，直接看偏差。
import fs from 'node:fs';
import path from 'node:path';
import * as settings from './settings.mjs';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const DIR = path.join(RQ, 'state');
const FILE = path.join(DIR, 'budget.json');

const dayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const monthStr = () => dayStr().slice(0, 7);

function blank() {
  return {
    month: monthStr(),
    day: dayStr(),
    spent: 0,
    today: 0,
    calls: 0,
    byKind: { chat: 0, tts: 0, asr: 0, vision: 0 },
    byChannel: { private: 0, group: 0 },
    byChannelDay: { private: 0, group: 0 },
    closed: false,
    notified: false,
    actual: null,
  };
}

let st = null;

function rollover() {
  if (!st) return;
  if (st.month !== monthStr()) {
    const actual = st.actual;
    st = blank();
    st.actual = actual;
  }
  if (st.day !== dayStr()) {
    st.day = dayStr();
    st.today = 0;
    st.byChannelDay = { private: 0, group: 0 };
  }
}

export function load() {
  if (st) { rollover(); return st; }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  st = raw && typeof raw === 'object' ? raw : blank();
  st.byKind = Object.assign({ chat: 0, tts: 0, asr: 0, vision: 0 }, st.byKind || {});
  st.byChannel = Object.assign({ private: 0, group: 0 }, st.byChannel || {});
  // LEGACY_CHAT_FOLD：旧版本按 'chat' 记账，统一折进 private，否则群聊限额读不到真实数字
  if (st.byChannel.chat != null) { st.byChannel.private = (st.byChannel.private || 0) + Number(st.byChannel.chat || 0); delete st.byChannel.chat; }
  if (st.byChannelDay && st.byChannelDay.chat != null) { st.byChannelDay.private = (st.byChannelDay.private || 0) + Number(st.byChannelDay.chat || 0); delete st.byChannelDay.chat; }
  st.byChannelDay = Object.assign({ private: 0, group: 0 }, st.byChannelDay || {});
  rollover();
  return st;
}

let lastWrite = 0;
function save(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 3000) return;
  lastWrite = now;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf8');
  } catch {}
}

// 当前这条消息是从哪来的：私聊还是群。记账时按渠道分开，群额度才能单独卡
let CURRENT_CHANNEL = 'private';
const __als = new AsyncLocalStorage();
export function withChannel(ch, fn) { return __als.run(ch === "group" ? "group" : "private", fn); }
export function setChannel(ch) { CURRENT_CHANNEL = ch === 'group' ? 'group' : 'private'; }
export function currentChannel() { return __als.getStore() || CURRENT_CHANNEL; }
export function channelSpent(ch) {
  const s = load();
  const m = s.byChannel || {};
  return Number(m[ch] || 0);
}
export function channelDaySpent(ch) {
  const s = load();
  const m = s.byChannelDay || {};
  return Number(m[ch] || 0);
}

export function add(kind, yuan, channel) {
  const v = Number(yuan);
  if (!Number.isFinite(v) || v <= 0) return;
  const s = load();
  const r = (x) => Math.round(x * 10000) / 10000;
  s.spent = r(s.spent + v);
  s.today = r(s.today + v);
  s.byKind[kind] = r((s.byKind[kind] || 0) + v);
  const ch = channel || currentChannel();
  s.byChannel = s.byChannel || { private: 0, group: 0 };
  s.byChannel[ch] = r((s.byChannel[ch] || 0) + v);
  s.byChannelDay = s.byChannelDay || { private: 0, group: 0 };
  s.byChannelDay[ch] = r((s.byChannelDay[ch] || 0) + v);
  s.calls += 1;
  save();
}

export function chatCost(usage) {
  if (!usage) return 0;
  const p = settings.load().budget.prices;
  const hit = Number(usage.cacheReadTokens) || 0;
  const totalIn = Number(usage.inputTokens) || 0;
  const missIn = Math.max(0, totalIn - hit);
  const out = Number(usage.outputTokens) || 0;
  return (missIn / 1e6) * p.inputPerM + (hit / 1e6) * p.cacheHitPerM + (out / 1e6) * p.outputPerM;
}

export function ttsCost(chars) {
  return ((Number(chars) || 0) / 1000) * settings.load().budget.prices.ttsPerKChar;
}

export function asrCost(seconds) {
  return (Number(seconds) || 0) * settings.load().budget.prices.asrPerSec;
}

export function visionCost(calls = 1) {
  return (Number(calls) || 1) * settings.load().budget.prices.visionPerCall;
}

// 0 正常 / 1 开始降耗 / 2 停语音 / 3 只被动回复 / 4 通知并停止
export function level() {
  const b = settings.load().budget;
  if (!b.enabled) return 0;
  const cap = Number(b.monthlyCap) || 20;
  const extra = Number(b.notifyExtra) || 10;
  const s = load().spent;
  if (s >= cap + extra) return 4;
  if (s >= cap * 1.4) return 3;
  if (s >= cap * 1.2) return 2;
  if (s >= cap) return 1;
  return 0;
}

export function markNotified() {
  const s = load();
  s.notified = true;
  s.closed = true;
  save(true);
}

export function markClosed() {
  const s = load();
  s.closed = true;
  save(true);
}

export function setActual(v) {
  const s = load();
  s.actual = v === null || v === '' ? null : Number(v);
  save(true);
}

export function reset() {
  st = blank();
  save(true);
}

export function snapshot() {
  const b = settings.load().budget;
  const s = load();
  return {
    month: s.month,
    day: s.day,
    spent: s.spent,
    today: s.today,
    calls: s.calls,
    byKind: s.byKind,
    byChannel: s.byChannel,
    byChannelDay: s.byChannelDay,
    level: level(),
    closed: s.closed,
    notified: s.notified,
    cap: b.monthlyCap,
    enabled: b.enabled !== false,
    notifyExtra: b.notifyExtra,
    stopAt: (Number(b.monthlyCap) || 20) + (Number(b.notifyExtra) || 10),
    actual: s.actual ?? null,
    prices: b.prices,
  };
}
