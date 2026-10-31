// 自拍环境一致性用例：她说"还在小区门口"，图就不能画成房间
// 跑法：node pack/poc-selfie-place-test.mjs
import assert from 'node:assert';
import * as self from '../src/self.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}

t('室外地点：小区门口 → 强制室外、不许室内光', () => {
  const p = self.selfiePrompt('站这个灯下面', { place: '小区门口' });
  assert.match(p, /小区门口/);
  assert.match(p, /这是室外/);
  assert.doesNotMatch(p, /真实室内光/);
});

t('室内地点：家里 → 室内光，不写室外规则', () => {
  const p = self.selfiePrompt('坐在沙发上', { place: '家里' });
  assert.match(p, /真实室内光/);
  assert.doesNotMatch(p, /这是室外/);
});

t('描述自己带室外词、没传地点 → 也按室外画', () => {
  const p = self.selfiePrompt('站在路灯下拍一张');
  assert.match(p, /室外/);
  assert.doesNotMatch(p, /真实室内光/);
});

t('什么都没说 → 不再默认"室内日常环境"', () => {
  const p = self.selfiePrompt('随手一张');
  assert.doesNotMatch(p, /没提到就当作室内/);
  assert.doesNotMatch(p, /真实室内光/);
});

t('接着上一张时不影响地点规则', () => {
  const p = self.selfiePrompt('还在小区门口', { keepIn: '小区门口，路灯下', outfit: '日常便装', place: '小区门口' });
  assert.match(p, /延续上一张自拍/);
  assert.match(p, /这是室外/);
});

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
