// 睡觉链路的回归用例：她真的会去睡、睡着不回、到点自己醒。
// 跑法：node pack\poc-sleep-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-'));
process.env.QQBOT_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'agent-home', 'memory', 'people'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({}), 'utf8');

const SRC = path.resolve('pack', 'src');
const mind = await import(new URL('file:///' + path.join(SRC, 'mind.mjs').replace(/\\/g, '/')).href);
const bridgeSrc = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

const U = '10001';

t('她说去睡：状态里记下睡到几点', () => {
  const r = mind.goSleep(U, 6);
  assert.ok(r.until > Date.now() + 5.9 * 3600e3, '睡 6 小时');
  assert.ok(mind.isAsleep(U), '应该是睡着状态');
  assert.equal(Math.round(mind.asleepUntil(U) / 1000), Math.round(r.until / 1000));
});

t('睡着时精力是回升的（+12/小时，不是继续掉）', () => {
  // mind.save() 会把 updated 刷成当前时间，要测衰减得直接改文件
  const f = path.join(tmp, 'state', U + '.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.energy = 10;
  st.updated = Date.now() - 2 * 3600e3;   // 假装两小时没更新
  fs.writeFileSync(f, JSON.stringify(st), 'utf8');
  const now = mind.load(U);
  assert.ok(now.energy > 30, '两小时应涨 24 左右，实际 ' + now.energy);
});

t('睡到点：checkWake 清睡眠并标记待招呼，takeWake 只给一次', () => {
  const st = mind.load(U);
  st.asleepUntil = Date.now() - 1000;      // 已经睡过了
  st.wakePending = false;
  mind.save(U, st);
  assert.ok(!mind.isAsleep(U), '过期后不算睡着');
  const w = mind.checkWake(U);
  assert.ok(w && w.wakePending, '应标记待招呼');
  assert.ok(mind.takeWake(U), '第一次能取到');
  assert.equal(mind.takeWake(U), null, '第二次取不到（只招呼一次）');
});

t('睡着期间她不算"待命"：asleepUntil 是未来时间', () => {
  mind.goSleep(U, 0.5);
  assert.ok(mind.isAsleep(U));
  const st = mind.load(U);
  assert.equal(st.wakePending, false);
});

t('桥接：[[睡了: 6]] 会被摘掉并记成 6 小时', () => {
  const m = bridgeSrc.match(/function extractExtras\(text\) \{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 extractExtras');
  assert.ok(/sleepHours = Math\.max\(0\.5, Math\.min\(12, Number\(n\) \|\| 7\)\)/.test(m[1]), '没有解析小时数');
  assert.ok(/sleepHours/.test(m[1]), '返回值里没带 sleepHours');
});

t('桥接：睡着时不回话，连敲 3 次才叫醒', () => {
  assert.ok(/mind\.isAsleep\(mkSleep\)/.test(bridgeSrc), '没有睡着拦截');
  assert.ok(/recentKnocks\(mkSleep, 20 \* 60e3\)/.test(bridgeSrc), '没有敲几次的判断');
  assert.ok(/knocks >= 3/.test(bridgeSrc), '阈值不是 3');
  assert.ok(/\[sleep\] 她睡着了，这条不回/.test(bridgeSrc), '没有静默日志');
});

t('桥接：说完这句就真的睡（goSleep 在发送之后调用）', () => {
  assert.ok(/if \(ex\.sleepHours\) \{/.test(bridgeSrc), '没有处理 sleepHours');
  assert.ok(/mind\.goSleep\(mk, ex\.sleepHours\)/.test(bridgeSrc), '没有写睡眠状态');
});

t('桥接：睡醒会自己冒一句（wakeTick 注册了定时器）', () => {
  assert.ok(/async function wakeTick\(\)/.test(bridgeSrc));
  assert.ok(/setInterval\(\(\) => \{ wakeTick\(\)/.test(bridgeSrc), '没有定时器');
  assert.ok(/你刚睡醒，睡了 \$\{wake\.sleepHrs/.test(bridgeSrc), '醒来的提示词没写');
});

t('提示词：两条通道都插了"撑不住就去睡"', () => {
  const n = (bridgeSrc.match(/sleepNote\(mk\)/g) || []).length;
  assert.ok(n >= 2, '只插了 ' + n + ' 处');
  assert.ok(/\[\[睡了: 7\]\]/.test(bridgeSrc), '没告诉她怎么写');
});

t('不再按钟点写死：提示词里没有"凌晨 2 点必须睡"', () => {
  assert.ok(!/凌晨 2 点.{0,8}必须睡|2 点后.{0,6}不许回/.test(bridgeSrc));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? 'FAIL' : 'OK'} — PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
