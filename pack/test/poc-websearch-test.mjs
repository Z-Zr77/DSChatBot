// 「她自己上网」必须真联网，不许拿模型编的当见闻。
// 钉三件事：① 走的是 enable_search；② 没 key 就跳过、不调模型；③ 关键词从 aliyun.key 兜底。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const ws = fs.readFileSync(path.join(SRC, 'websearch.mjs'), 'utf8');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
const settings = fs.readFileSync(path.join(SRC, 'settings.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

check('检索走百炼 compatible-mode + enable_search', () => {
  assert.match(ws, /compatible-mode\/v1\/chat\/completions/);
  assert.match(ws, /enable_search: true/);
});

check('没有 key 直接返回失败，不发请求', () => {
  assert.match(ws, /if \(!key\) return \{ ok: false, err: '没有可用的搜索 key' \}/);
});

check('key 兜底顺序：设置 > aliyun.key > 语音/看图', () => {
  const i = ws.indexOf('export function resolveKey');
  const seg = ws.slice(i, i + 420);
  assert.match(seg, /b\.key/);
  assert.match(seg, /readKeyFile\(\)/);
  assert.match(seg, /cfg\.tts/);
});

check('browseTick 没有 key 就跳过，不调模型', () => {
  const i = bridge.indexOf('async function browseTick()');
  const seg = bridge.slice(i, i + 900);
  assert.match(seg, /websearch\.resolveKey/);
  assert.match(seg, /没有搜索 key/);
  assert.ok(!/askBrain\(curiosity\.browsePrompt/.test(seg), '还在用模型瞎编');
});

check('刷到的东西照样进 seen、照样能分享', () => {
  const i = bridge.indexOf('async function browseTick()');
  const seg = bridge.slice(i, i + 1400);
  assert.match(seg, /curiosity\.appendSeen\(items\)/);
  assert.match(seg, /maybeShare\(items\)/);
});

check('默认开（有 key 才真跑）', () => {
  const i = settings.indexOf('browse: {');
  assert.match(settings.slice(i, i + 240), /enabled: true/);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
