// 审批链路端到端：桥接真等她，控制台（这里用 HTTPS 调用 3098）点同意/拒绝后她才继续
// 跑法：node pack/poc-approve-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('pack');
const SRC = path.join(ROOT, 'src');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-ap-'));
const DATA = path.join(TMP, 'data');
const API = path.join(TMP, 'api.json');
process.env.QQBOT_API_FILE = API;
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'chat'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'home'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: '10001', master: '10001' } }));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ reply: { debounceMs: 300, privateDelayMs: 0, groupDelayMs: 0 }, proactive: { enabled: false }, browse: { enabled: false }, tools: { enabled: true, maxRounds: 3, ownerOnly: true }, work: { exec: true, timeoutMin: 30 } }));

// 假大脑：第一轮要命令（run_cmd），收到工具结果后回一句带标记的正文
const seen = [];
let round = 0;
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push(b);
    let reply;
    if (b.includes('【工具结果')) {
      const refused = b.includes('他拒绝了');
      reply = refused ? '那我不动了，你说。' : '跑完了，清单里有 notes。';
    } else {
      round++;
      reply = '[[工具: {"name":"run_cmd","args":{"cmd":["dir","."]}}]]';
    }
    const j = { id: 'x', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j));
  });
});

fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:5601', model: 'stub', key: 'stub-key', maxTokens: 500 }, null, 2));
const env = { ...process.env, QQBOT_DATA: DATA, QQBOT_API_FILE: API, QQBOT_LOCAL_PORT: '3591', QQBOT_UI_PORT: '3592', QQBOT_NAP_SKIP: '1', HOME: path.join(TMP, 'home'), USERPROFILE: path.join(TMP, 'home') };
const child = spawn(process.execPath, [path.join(SRC, 'bridge.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: TMP });
let blog = '';
child.stdout.on('data', (d) => (blog += d));
child.stderr.on('data', (d) => (blog += d));

const get = async (u) => (await fetch(u)).json();
const post = async (u, o) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o || {}) })).json();
const say = (text) => post('http://127.0.0.1:3591/say', { text });

try {
  await new Promise((r) => fake.listen(5601, '127.0.0.1', r));
  for (let i = 0; i < 40; i++) { try { const h = await fetch('http://127.0.0.1:3591/ping'); if (h.ok) break; } catch {} await sleep(250); }
  const WS = path.join(TMP, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'a.txt'), 'x');
  const wsStart = await post('http://127.0.0.1:3591/work/start', { root: WS, caps: [ 'fs:read', 'fs:write' ], useExisting: true, confirmWrite: true });
  ok(!!(wsStart && wsStart.ok), '工作会话开起来了（run_cmd 需要它）'); if (!(wsStart && wsStart.ok)) console.log('work/start =>', JSON.stringify(wsStart));


  // 第一轮：同意
  const p1 = say('帮我看看 notes 里有什么');
  let items = [];
  for (let i = 0; i < 60; i++) { await sleep(300); const r = await get('http://127.0.0.1:3591/approvals'); items = (r && r.items) || []; if (items.length) break; }
  ok(items.length === 1, '弹出了一张待审批卡片');
  if (!items.length) { console.log('--- bridge log ---\n' + blog.slice(-2500)); console.log('--- seen ---\n' + seen.map((s) => s.slice(0, 300)).join('\n====\n')); }
  ok(items[0] && items[0].name === 'run_cmd', '卡片里是 run_cmd');
  await post('http://127.0.0.1:3591/approve', { id: items[0].id, ok: true });
  await p1;
  await sleep(1500);
  const toolBody = seen.find((s) => s.includes('【工具结果'));
  ok(!!toolBody && toolBody.includes('目录') || !!toolBody, '工具结果回灌给了她');
  ok(blog.includes('[approve] 他点了同意'), '日志记了同意');
  ok(blog.includes('[tool] 10001 run_cmd ok'), 'run_cmd 真执行成功');
  const sk = JSON.parse(fs.readFileSync(path.join(DATA, 'agent-home', 'memory', 'skills', '10001.json'), 'utf8'));
  ok(sk.items.some((x) => x.name === 'run_cmd' && x.ok === true), '技能库记下这次成功');

  // 第二轮：拒绝
  const p2 = say('再看看 notes');
  let items2 = [];
  for (let i = 0; i < 60; i++) { await sleep(300); const r = await get('http://127.0.0.1:3591/approvals'); items2 = (r && r.items) || []; if (items2.length) break; }
  ok(items2.length === 1, '第二次又弹出一张');
  await post('http://127.0.0.1:3591/approve', { id: items2[0].id, ok: false });
  await p2;
  await sleep(1200);
  ok(blog.includes('[approve] 他点了拒绝'), '日志记了拒绝');
  const denied = seen.filter((s) => s.includes('他拒绝了'));
  ok(denied.length >= 1, '拒绝后告诉了她别执行');
  const sk2 = JSON.parse(fs.readFileSync(path.join(DATA, 'agent-home', 'memory', 'skills', '10001.json'), 'utf8'));
  ok(sk2.items.some((x) => x.name === 'run_cmd' && x.ok === false && /拒绝/.test(x.err || '')), '技能库记下被拒绝');

  // 超时路径只在代码里静态验证（等 90 秒太慢）
  const src = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  ok(/waitApproval\(rec, ms = 90e3\)/.test(src), '审批有 90 秒超时兜底');
  ok(/res\.timeout \?/.test(src), '超时会让她转告他"点一下同意"');
} catch (e) {
  fail++;
  console.log('FAIL 异常：', e.message);
} finally {
  try { child.kill(); } catch {}
  try { fake.close(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
