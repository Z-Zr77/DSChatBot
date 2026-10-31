// 技能成长：每次工具调用都记一笔（成/败、参数摘要、错误），下次遇到同类就提醒她"上次这么干失败过"。
// 参考 Voyager 的 skill library：成功的做法留档、失败的经历当负样本，而不是重新想一遍。
import fs from 'node:fs';
import path from 'node:path';
import * as PATHS from './paths.mjs';

const DIR = path.join(PATHS.DATA, 'agent-home', 'memory', 'skills');
const MAX_ITEMS = 120;

function file(uin) {
  return path.join(DIR, String(uin).replace(/[^\dA-Za-z_-]/g, '') + '.json');
}
function load(uin) {
  try {
    const o = JSON.parse(fs.readFileSync(file(uin), 'utf8').replace(/^\uFEFF/, ''));
    return { items: Array.isArray(o.items) ? o.items : [] };
  } catch { return { items: [] }; }
}
function save(uin, o) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = file(uin) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, file(uin));
  } catch {}
}

function brief(v, n = 80) {
  const s = typeof v === 'string' ? v : JSON.stringify(v || {});
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 三个工具都记；err 只留前 120 字，够她认出来
export function note({ uin, name = '', args = {}, res = {}, at = Date.now() } = {}) {
  const u = String(uin || '');
  if (!u || !name) return null;
  const ok = !!(res && res.ok);
  const item = {
    at,
    name,
    args: brief(args, 90),
    ok,
    err: ok ? '' : brief((res && (res.err || res.out)) || '', 120),
    needApproval: !!(res && res.needApproval),
  };
  const o = load(u);
  o.items.push(item);
  o.items = o.items.slice(-MAX_ITEMS);
  save(u, o);
  return item;
}

// 同一工具最近失败的几条（一样的错就别再试一遍）
export function failures(uin, name, k = 2, now = Date.now()) {
  const o = load(uin);
  return o.items
    .filter((it) => it.name === name && !it.ok && now - (it.at || 0) < 30 * 86400e3)
    .slice(-k)
    .reverse();
}

export function hintText(uin, name) {
  const fs_ = failures(uin, name, 2);
  if (!fs_.length) return '';
  const lines = fs_.map((it) => `- ${it.args} → ${it.err || '失败'}`);
  return `【这个你以前试过，没成】${name}：\n${lines.join('\n')}\n那样不行，换个参数或者换个工具；实在不会就直接跟他说。`;
}

export function stats(uin) {
  const o = load(uin);
  const by = {};
  for (const it of o.items) {
    const b = by[it.name] || (by[it.name] = { ok: 0, fail: 0 });
    if (it.ok) b.ok++; else b.fail++;
  }
  return { total: o.items.length, by };
}

export function list(uin) { return load(uin).items; }
export function remove(uin, at) {
  const o = load(uin);
  const before = o.items.length;
  o.items = o.items.filter((x) => String(x.at) !== String(at));
  save(uin, o);
  return before - o.items.length;
}
export function reset(uin) { save(uin, { items: [] }); }
export const dir = DIR;
