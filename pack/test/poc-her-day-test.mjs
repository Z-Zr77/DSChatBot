// 概览第一屏要"像她"：她在干什么、下一件事、今天发生的事、她还没做完的事。
// 这个测试钉三件事：① 控制台真的挂了 /api/her；② 返回字段对得上；③ 第一屏真的用到了它。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const ui = fs.readFileSync(path.join(SRC, 'ui.mjs'), 'utf8');
const daily = fs.readFileSync(path.join(SRC, 'daily.mjs'), 'utf8');
const loops = fs.readFileSync(path.join(SRC, 'loops.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

check('/api/her 路由存在', () => {
  assert.ok(ui.includes("p === '/api/her'"), '没有 /api/her');
});

check('用的是日程/事件/待办的真实数据，不是编的', () => {
  assert.match(ui, /daily\.loadPlan\(d\)/);
  assert.match(ui, /life\.loadEvents\(d\)/);
  assert.match(ui, /loops\.open\(mk\)/);
  assert.match(daily, /export function currentItem/);
  assert.match(daily, /export function nextItem/);
  assert.match(loops, /export function open/);
});

check('只报"已经发生了"的事件，不剧透未来', () => {
  assert.match(ui, /e\.at <= hm/);
});

check('第一屏真的渲染了这些行', () => {
  assert.ok(ui.includes("id=\"herDay\""), '卡片里没有 herDay 槽');
  for (const phrase of ["现在 ", "下一件 ", "刚发生：", "她还没做完："]) {
    assert.ok(ui.includes(phrase), '缺一行：' + phrase);
  }
});

check('取不到数据时静默降级，不影响第一屏', () => {
  const i = ui.indexOf("const H = await api('/api/her')");
  assert.ok(i > 0);
  const seg = ui.slice(i, i + 2000);
  assert.match(seg, /catch \(e\) \{\}/, '没有兜底 catch');
  assert.match(seg, /if \(!slot \|\| !H\) return;/, '没有空值保护');
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
