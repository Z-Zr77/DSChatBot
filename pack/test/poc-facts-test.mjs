// 第一批「说法要跟事实对得上」回归用例
// 跑法：node pack/poc-facts-test.mjs
// 覆盖：低状态不附加虚构经历 / 普通状态不受影响 / 两处提示词已改成「可更正、计划≠完成」
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mind from '../src/mind.mjs';
import * as timing from '../src/timing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' → ' + (e && e.message)); fail++; }
}

const base = { lastUserAt: Date.now() - 10 * 60e3, energy: 80, mood: 80, affinity: 40, unansweredProactive: 0 };
const FACTS_BAN = ['五个小时', '有件事'];

// 1) 低电量：只说累，不说睡了几小时
t('低电量不编睡眠时长', () => {
  const s = mind.facts({ ...base, energy: 10 }, {});
  assert.ok(s.includes('很累'), '应描述当前累');
  for (const w of FACTS_BAN) assert.ok(!s.includes(w), '不该出现：' + w);
});

// 2) 低心情：只说低落，不编「有件事没解决」
t('低心情不编未解决的事', () => {
  const s = mind.facts({ ...base, mood: 10 }, {});
  assert.ok(s.includes('心情很低'), '应描述当前低落');
  for (const w of FACTS_BAN) assert.ok(!s.includes(w), '不该出现：' + w);
});

// 3) 普通状态：两条状态行都不出现（不受影响）
t('普通状态不加状态行', () => {
  const s = mind.facts({ ...base }, {});
  assert.ok(!s.includes('很累'), '不该出现累');
  assert.ok(!s.includes('心情很低'), '不该出现低落');
});

// 4) 提示词：两处都换成可更正版本，且不再禁止改口
const bridge = fs.readFileSync(path.join(HERE, '..', 'src', 'bridge.mjs'), 'utf8');
t('提示词两处都已替换', () => {
  assert.strictEqual((bridge.match(/【说法要跟事实对得上】/g) || []).length, 2, '应有 2 处');
  assert.strictEqual((bridge.match(/【不许自相矛盾】/g) || []).length, 0, '旧标题应清零');
  assert.ok(!bridge.includes('那就是事实，后面不能改口'), '旧的「不能改口」应清零');
});

// 5) 新提示词必须同时说明：可依据新信息更正 + 计划不等于已完成
t('提示词含「可更正」与「计划≠完成」', () => {
  const m = bridge.match(/【说法要跟事实对得上】[^']*/g) || [];
  assert.strictEqual(m.length, 2, '应能截到 2 条');
  for (const line of m) {
    assert.ok(/新情况/.test(line), '要允许依据新情况更正');
    assert.ok(/刚发生的变化/.test(line), '更正时要说清是刚发生的变化');
    assert.ok(/计划/.test(line), '要区分计划');
    assert.ok(/没做就别说成做完了/.test(line), '计划不能被说成已完成');
  }
});

// 6) 心里话不会再漏出去：缺一个右括号 / 写在同一行 / 正常闭合都要拆干净
t('[[想]] 缺右括号也不外发', () => {
  const r = timing.splitInner('[[想：又问我睡几个小时，这问题问得跟他真能管得着似的。]\n睡了几个小时我自己都记不清，反正不短\n你问这干嘛');
  assert.ok(r.inner.includes('又问我睡几个小时'), '要抓进 inner');
  assert.ok(!r.visible.includes('[['), 'visible 里不能有 [[ 前缀');
  assert.ok(r.visible.includes('睡了几个小时我自己都记不清'), '正文要留下');
});

t('[[想]] 写在同一行也能拆', () => {
  const r = timing.splitInner('[[想：烦。]] 嗯，还行');
  assert.strictEqual(r.inner, '烦。');
  assert.strictEqual(r.visible, '嗯，还行');
});

t('正常闭合的 [[想：…]] 不残留', () => {
  const r = timing.splitInner('[[想：行吧]]\n好吧\n早点睡');
  assert.strictEqual(r.inner, '行吧');
  assert.strictEqual(r.visible, '好吧\n早点睡');
});

t('[[想]] 跨行也能拆干净', () => {
  const r = timing.splitInner('[[想：第一句还没说完\n第二句收尾]]\n好吧，早点睡');
  assert.strictEqual(r.inner, '第一句还没说完 / 第二句收尾');
  assert.strictEqual(r.visible, '好吧，早点睡');
});

// 7) 聊天记录要有「距现在多久」，别让她把一小时前说成刚
t('聊天记录自动标时间差', () => {
  const now = new Date(2026, 9, 29, 22, 5, 0).getTime();
  const log = '- 2026-10-29 20:46 [我] 照片里那碗就是我刚端上的面\n- 2026-10-29 22:02 [App] 拿到面这么久了才吃上面？';
  const out = timing.agedLog(log, now);
  assert.ok(out.includes('（1 小时前）'), '一小时前要标出来，实际：' + out.split('\n')[0]);
  assert.ok(out.includes('（3 分钟前）') === false, '10 分钟内不标');
  assert.ok(out.split('\n')[1].includes('22:02'), '近的仍保留原时间');
});

// 8) 两处提示词都带「时间要对得上」细则
t('提示词含时间校准细则', () => {
  assert.strictEqual((bridge.match(/【时间要对得上】/g) || []).length, 2, '应有两处');
  assert.ok(bridge.includes('别把一小时前的事说成“刚上桌/刚拿到”'));
});

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
