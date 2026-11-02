// 空回复重试：模型有时会返回空 content（最常见是 max_tokens 被"思考"吃光，finish_reason=length）。
// 以前这种情况直接判失败，她的回复凭空消失，用户只看到"她不理我"。
// 现在的约定：加预算重试一次；还是空，才如实报错。
// 跑法：node pack\run-tests.mjs（或单独 node pack\test\poc-brain-retry-test.mjs）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-retry-'));
process.env.QQBOT_DATA = tmp;

let calls = 0;
let mode = 'empty-then-ok';
const seen = [];

const srv = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    calls++;
    let j = {};
    try { j = JSON.parse(body); } catch {}
    seen.push(j);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const empty = mode === 'always-empty' || (mode === 'empty-then-ok' && calls === 1);
    if (empty) {
      res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }));
    }
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

fs.writeFileSync(path.join(tmp, 'setup.json'), JSON.stringify({
  api: { baseUrl: `http://127.0.0.1:${port}/v1`, key: 'test-key', model: 'test-model', maxTokens: 900 },
}), 'utf8');

const SRC = path.resolve('pack', 'src');
const brain = await import(new URL('file:///' + path.join(SRC, 'brain.mjs').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

function reset(m) { mode = m; calls = 0; seen.length = 0; }

await t('第一次空回复 → 自动重试，拿到内容', async () => {
  reset('empty-then-ok');
  const r = await brain.ask('在吗', null, { system: '你是一个人在聊天' });
  assert.equal(r.ok, true, '应该成功（实际：' + r.err + '）');
  assert.equal(r.text, '好');
  assert.equal(calls, 2, '应该请求两次，实际 ' + calls + ' 次');
  assert.equal(r.retried, true, '结果里应标记 retried');
});

await t('重试时把 max_tokens 放大（不然还是被思考吃光）', async () => {
  reset('empty-then-ok');
  await brain.ask('在吗');
  assert.equal(seen.length, 2, '应记录两次请求');
  assert.equal(seen[0].max_tokens, 900, '第一次沿用配置的 900');
  assert.ok(Number(seen[1].max_tokens) >= 1800, '第二次要翻倍，实际 ' + seen[1].max_tokens);
});

await t('两次都是空 → 如实失败，不假装回了一句', async () => {
  reset('always-empty');
  const r = await brain.ask('在吗');
  assert.equal(r.ok, false, '不该返回 ok');
  assert.match(String(r.err), /empty completion/, '错误信息要能查，实际：' + r.err);
  assert.equal(calls, 2, '只重试一次，不要无限重试，实际 ' + calls + ' 次');
});

srv.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
