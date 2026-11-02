// 「她自己上网」这个开关，以前只在界面上，代码根本没读。
// 钉三件事：① browseTick 真的检查 browse.enabled；② 默认是关的；③ 关着的时候不会分享。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
const settings = fs.readFileSync(path.join(SRC, 'settings.mjs'), 'utf8');
const share = fs.readFileSync(path.join(SRC, 'share.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

check('browseTick 开头就检查开关', () => {
  const i = bridge.indexOf('async function browseTick()');
  assert.ok(i > 0);
  const seg = bridge.slice(i, i + 420);
  assert.match(seg, /bcfg\.enabled !== true/, '没有读 browse.enabled');
});

check('默认开着，但没有搜索 key 时必须跳过（不编）', () => {
  const i = settings.indexOf('browse: {');
  const seg = settings.slice(i, i + 220);
  assert.match(seg, /enabled: true/);
  assert.match(bridge, /没有搜索 key/, '没有 key 必须跳过');
});

check('分享只在刷完之后发生，刷不到就没得说', () => {
  const i = bridge.indexOf('if (items.length) await maybeShare(items);');
  const j = bridge.indexOf('curiosity.appendSeen(items);');
  assert.ok(i > j && j > 0, '分享必须挂在 appendSeen 之后、且有 items 才发生');
});

check('分享闸门是纯逻辑，可以被测', () => {
  assert.match(share, /export function canShare/);
  assert.match(share, /export function record/);
});

console.log(`
通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
