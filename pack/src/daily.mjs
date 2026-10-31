// 她自己的生活：每天一份日程表 + 每晚一篇自己写的日记
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const DIR = path.join(RQ, 'life');
const PLAN_DIR = path.join(DIR, 'plan');
const JOUR_DIR = path.join(DIR, 'journal');

const pad = (n) => String(n).padStart(2, '0');

// 固定按东八区算日期/时间，不依赖进程时区
function cst(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3);
}
export function today(offset = 0) {
  const d = cst(offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function nowHM() {
  const d = cst();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function hourNow() {
  return cst().getUTCHours();
}

const mk = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };

// ---------- 日程 ----------
export function planFile(date) { return path.join(PLAN_DIR, `${date}.json`); }

export function loadPlan(date) {
  try { return JSON.parse(fs.readFileSync(planFile(date), 'utf8')); } catch { return null; }
}

export function savePlan(plan) {
  try { mk(PLAN_DIR); fs.writeFileSync(planFile(plan.date), JSON.stringify(plan, null, 2), 'utf8'); } catch {}
}

// 此刻正在做的事（最后一条已开始的安排）
// 还没到第一条就是 null：以前会返回第一条，于是凌晨 6 点就被判定"正在吃 12:30 的午饭"，
// 还会被 lifeHere() 送进对话和自拍（2026-10-29 复查 F14）。
export function currentItem(plan) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) return null;
  const hm = nowHM();
  let cur = null;
  for (const it of plan.items) if (it.at <= hm) cur = it;
  return cur;
}

// 已经开始过、但还没轮到的那一条（用于"接下来要做什么"，不要当成正在做）
export function startedCount(plan) {
  if (!plan || !Array.isArray(plan.items)) return 0;
  const hm = nowHM();
  return plan.items.filter((it) => it.at <= hm).length;
}

export function nextItem(plan) {
  if (!plan || !Array.isArray(plan.items)) return null;
  const hm = nowHM();
  return plan.items.find((it) => it.at > hm) || null;
}

export function planText(plan) {
  if (!plan || !Array.isArray(plan.items)) return '';
  return plan.items.map((it) => `${it.at} ${it.place ? it.place + '｜' : ''}${it.what}`).join('\n');
}

// ---------- 日记 ----------
export function journalFile(date) { return path.join(JOUR_DIR, `${date}.md`); }

export function loadJournal(date) {
  try { return fs.readFileSync(journalFile(date), 'utf8').trim(); } catch { return ''; }
}

export function saveJournal(date, text) {
  try { mk(JOUR_DIR); fs.writeFileSync(journalFile(date), String(text).trim() + '\n', 'utf8'); } catch {}
}

// 最近一篇（不含今天）
export function lastJournal() {
  for (let i = 1; i <= 7; i++) {
    const d = today(-i);
    const t = loadJournal(d);
    if (t) return { date: d, text: t };
  }
  return null;
}

export function recentJournals(n = 3) {
  const out = [];
  for (let i = 1; i <= 10 && out.length < n; i++) {
    const d = today(-i);
    const t = loadJournal(d);
    if (t) out.push({ date: d, text: t });
  }
  return out;
}
