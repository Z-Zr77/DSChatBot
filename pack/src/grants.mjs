// grants.mjs — 工作会话凭据（只活在进程里；重启即失效）
//
// 设计要点（按 2026-10-30 评审修订）：
//   1. 只有用户在界面上点了「开始」，才会生成一个 grant；模型、聊天内容、文件内容都不能开权限。
//   2. grant 只在内存里。应用重启后一律失效：可以恢复任务记录（history），但写入必须重新点。
//   3. 到期只按"用户操作"续（发消息、点按钮、审批），工具自己在跑不算——否则一直跑就永不过期。
//   4. 停止时 epoch++，此后任何带着旧 epoch 的调用都会被拒（挡迟到的模型结果）。
//   5. grants.json 只记历史，不记"仍有效的权限"；从备份恢复数据也不会带回一个有效授权。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

export const CAPS = Object.freeze({ READ: 'fs:read', WRITE: 'fs:write', NET: 'net', EXEC: 'exec' });
const ALL_CAPS = [ CAPS.READ, CAPS.WRITE, CAPS.NET, CAPS.EXEC ];
const DEFAULT_TIMEOUT_MIN = 30;

const sessions = new Map();   // convKey -> session
let seq = 0;
let epochSeq = 0;   // 单调递增：任何新会话的 epoch 都不会和旧的重复

const now = () => Date.now();

function realOrResolve(p) {
  const abs = path.resolve(String(p || ''));
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

function inside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function historyFile() {
  return path.join(PATHS.ledger, 'grants.json');
}

function appendHistory(rec) {
  try {
    const f = historyFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let j = { items: [] };
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (!Array.isArray(j.items)) j.items = [];
    j.items.push(rec);
    j.items = j.items.slice(-200);
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) {
    try { console.warn('[grants] 历史写不进去：', e && e.message); } catch {}
  }
}

function normCaps(list) {
  const want = Array.isArray(list) ? list : [];
  return ALL_CAPS.filter((c) => want.includes(c));
}

// 开一个工作会话。dir 不在这里创建：目录由调用方（用户确认后的 UI 动作）负责。
export function open({ convKey, root, readRoots = [], caps = [], timeoutMin = DEFAULT_TIMEOUT_MIN, inPlace = false, source = '' }) {
  const key = String(convKey || '');
  if (!key) return { ok: false, err: '缺少会话标识' };
  const rootAbs = realOrResolve(root);
  if (!rootAbs || !path.isAbsolute(rootAbs)) return { ok: false, err: '工作目录无效' };
  const granted = normCaps(caps);
  if (!granted.length) return { ok: false, err: '没有勾选任何能力' };

  const prev = sessions.get(key);
  if (prev && prev.alive) {
    return { ok: false, err: '这个会话已经有工作授权了，先停掉再开', state: state(key) };
  }

  const roots = (Array.isArray(readRoots) && readRoots.length ? readRoots : [ rootAbs ]).map(realOrResolve);
  const mins = Math.max(1, Math.min(240, Number(timeoutMin) || DEFAULT_TIMEOUT_MIN));
  const s = {
    id: 'ws' + (++seq) + '-' + now().toString(36).slice(-4),
    convKey: key,
    root: rootAbs,
    readRoots: Array.from(new Set(roots)),
    caps: granted,
    inPlace: !!inPlace,
    source: String(source || ''),
    createdAt: now(),
    lastUserAt: now(),
    expiresAt: now() + mins * 60e3,
    timeoutMin: mins,
    epoch: ++epochSeq,
    alive: true,
    stoppedReason: '',
  };
  sessions.set(key, s);
  appendHistory({ id: s.id, at: new Date(s.createdAt).toISOString(), action: 'open', convKey: key, root: s.root, caps: s.caps, inPlace: s.inPlace, timeoutMin: mins, source: s.source, epoch: s.epoch });
  return { ok: true, state: state(key) };
}

// 用户操作续期：只有"人"的动作才调它
export function touch(convKey) {
  const s = sessions.get(String(convKey || ''));
  if (!s || !s.alive) return false;
  if (now() >= s.expiresAt) { expire(s); return false; }
  s.lastUserAt = now();
  s.expiresAt = now() + s.timeoutMin * 60e3;
  return true;
}

function expire(s) {
  if (!s.alive) return;
  s.alive = false;
  s.stoppedReason = 'timeout';
  s.epoch += 1;
  sessions.delete(s.convKey === undefined ? '' : s.convKey);
  appendHistory({ id: s.id, at: new Date().toISOString(), action: 'expire', convKey: s.convKey, reason: 'timeout', epoch: s.epoch });
}

// 取当前可用会话；过期就地作废
export function setCaps(convKey, caps) {
  const ws = active(String(convKey || ''));
  if (!ws) return { ok: false, err: '现在没有工作会话；这个权限先记下，下次进入工作模式时用' };
  ws.caps = normCaps(caps || []);
  ws.epoch = ++epochSeq;
  return { ok: true, state: ws };
}

export function active(convKey) {
  const key = String(convKey || '');
  const s = sessions.get(key);
  if (!s) return null;
  if (!s.alive) { sessions.delete(key); return null; }
  if (now() >= s.expiresAt) { expire(s); return null; }
  return s;
}

export function requireCap(convKey, cap, epoch) {
  const s = active(convKey);
  if (!s) return { ok: false, err: '没有工作授权（或者已经过期了）' };
  if (epoch != null && Number(epoch) !== s.epoch) return { ok: false, err: '授权已失效（会话被停过或重启过）' };
  if (!s.caps.includes(cap)) return { ok: false, err: '这个会话没有开通「' + cap + '」' };
  return { ok: true, session: s };
}

export function stop(convKey, reason = 'user') {
  const key = String(convKey || '');
  const s = sessions.get(key);
  if (!s) return { ok: true, already: true };
  s.alive = false;
  s.stoppedReason = String(reason || 'user');
  s.epoch += 1;
  sessions.delete(key);
  appendHistory({ id: s.id, at: new Date().toISOString(), action: 'stop', convKey: key, root: s.root, caps: s.caps, reason: s.stoppedReason, epoch: s.epoch });
  return { ok: true, id: s.id, reason: s.stoppedReason };
}

export function state(convKey) {
  const s = active(convKey);
  if (!s) return { active: false };
  return {
    active: true,
    id: s.id,
    root: s.root,
    readRoots: s.readRoots.slice(),
    caps: s.caps.slice(),
    inPlace: s.inPlace,
    epoch: s.epoch,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    leftMs: Math.max(0, s.expiresAt - now()),
    timeoutMin: s.timeoutMin,
  };
}

export function history(limit = 30) {
  try {
    const j = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    const items = Array.isArray(j.items) ? j.items : [];
    return items.slice(-Math.max(1, Math.min(200, limit)));
  } catch { return []; }
}

