// 「别再提了」和「忘掉」不是一件事；办完的事不能反复提。
// 钉住：① 别提的条目不进提示词；② 办完的条目不进提示词；③ 指令只在明确说法时生效。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const mem = fs.readFileSync(path.join(SRC, 'memory.mjs'), 'utf8');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

check('render 跳过「别提」和「已办」', () => {
  assert.match(mem, /it\.mute \|\| it\.done/);
});

check('有 muteByInstruction，且认得出「不要再提」', () => {
  assert.match(mem, /export function muteByInstruction/);
  assert.match(mem, /不要再提|别再提|别提/);
});

check('有 markDone：办完的事打标，不删', () => {
  assert.match(mem, /export function markDone/);
  assert.match(mem, /it\.done = Date\.now\(\)/);
});

check('照片发出去时，记忆里"要拍照"的也一起办完', () => {
  const i = bridge.indexOf("memory.markDone(memKeyOf(conv)");
  assert.ok(i > 0, '没有接上 markDone');
  assert.match(bridge.slice(i, i + 160), /拍照|照片/);
});

check('「连着两次不回」之后必回（护栏）', () => {
  assert.match(bridge, /skipStreak\[key\]/);
  assert.match(bridge, /streak >= 3/, '没有"连续三次必须回"的判断');
});

check('控制台能列出被按下去的东西（不然用户以为丢记忆了）', () => {
  assert.match(mem, /export function mutedList/);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
