// 她刷到东西、想跟人说一句的"闸门"。
// 单独一个文件是为了能测：这里只有纯逻辑，不碰网络、不碰模型。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

const FILE = path.join(paths.PATHS.data, 'browse-share.json');

// 固定按东八区算日期，跟 daily.mjs 一致；不依赖进程时区。
function cstDay(now) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

export function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function save(st) {
  try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2)); } catch {}
}

// 一天最多 maxPerDay 次，两次之间至少隔 gapMs。
// 返回 { ok, why } 或 { ok: true, day, count }（count 是"今天已经说了几次"）。
export function canShare(st, now = Date.now(), maxPerDay = 2, gapMs = 3 * 3600e3) {
  const day = cstDay(now);
  const s = st && typeof st === 'object' ? st : {};
  const count = s.day === day ? Number(s.count) || 0 : 0;
  if (count >= maxPerDay) return { ok: false, why: '今天说过了' };
  if (s.lastAt && now - Number(s.lastAt) < gapMs) return { ok: false, why: '刚说过没多久' };
  return { ok: true, day, count };
}

// 说完之后记账：数量 +1、记下时间。
export function record(st, gate, now = Date.now(), text = '') {
  const s = st && typeof st === 'object' ? st : {};
  return { day: gate.day, count: (Number(gate.count) || 0) + 1, lastAt: now, last: String(text || '').slice(0, 80) };
}
