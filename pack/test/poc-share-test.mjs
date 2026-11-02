// 「她刷到什么，想跟人说一句」的闸门。
// 钉三件事：① 一天最多两次；② 两次之间至少三小时；③ 日期按东八区算（半夜不会算错天）。
import assert from 'node:assert';
import * as share from '../src/share.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

const T = Date.parse('2026-11-01T12:00:00+08:00');

check('第一次永远放行', () => {
  const g = share.canShare({}, T);
  assert.equal(g.ok, true);
  assert.equal(g.day, '2026-11-01');
  assert.equal(g.count, 0);
});

check('今天说过一次：还允许再说一次', () => {
  const g = share.canShare({ day: '2026-11-01', count: 1, lastAt: T - 4 * 3600e3 }, T);
  assert.equal(g.ok, true);
  assert.equal(g.count, 1);
});

check('今天已经说了两次：拦住', () => {
  const g = share.canShare({ day: '2026-11-01', count: 2, lastAt: T - 9 * 3600e3 }, T);
  assert.equal(g.ok, false);
  assert.match(g.why, /今天/);
});

check('三小时内刚说过：拦住', () => {
  const g = share.canShare({ day: '2026-11-01', count: 1, lastAt: T - 30 * 60e3 }, T);
  assert.equal(g.ok, false);
  assert.match(g.why, /刚说/);
});

check('昨天说满了，今天重新开始', () => {
  const g = share.canShare({ day: '2026-10-31', count: 2, lastAt: T - 12 * 3600e3 }, T);
  assert.equal(g.ok, true);
  assert.equal(g.count, 0);
});

check('跨东八区算天：UTC 16:30 已经是北京第二天', () => {
  const t = Date.parse('2026-11-01T16:30:00Z');   // 北京时间 11-02 00:30
  const g = share.canShare({ day: '2026-11-01', count: 2, lastAt: t - 9 * 3600e3 }, t);
  assert.equal(g.day, '2026-11-02');
  assert.equal(g.ok, true, '换天了应该重新放行');
});

check('记账：数量加一、记住时间与内容', () => {
  const next = share.record({ day: '2026-11-01', count: 1 }, { day: '2026-11-01', count: 1 }, T, '某个乐队在街边演出');
  assert.equal(next.count, 2);
  assert.equal(next.lastAt, T);
  assert.match(next.last, /乐队/);
});

check('坏数据不会炸', () => {
  assert.equal(share.canShare(null, T).ok, true);
  assert.equal(share.canShare('nonsense', T).ok, true);
  const r = share.record(null, { day: '2026-11-01', count: 0 }, T, '');
  assert.equal(r.count, 1);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
