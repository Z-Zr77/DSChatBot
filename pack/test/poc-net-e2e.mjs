// 端到端：fetch_url（P1-2）——真起桥接 + 假大脑 + 本地桩网页
// 验证：工作会话带 net 能力 → 她发 fetch_url → 真的抓了 → 页面文字回灌 → 审计落盘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-nete2e-'));
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');
const U = '1111111111';
const STUB_PORT = 5601;
const PAGE_PORT = 5602;
const LOCAL_PORT = 3599;
const API = path.join(TMP, 'api.json');
process.env.QQBOT_API_FILE = API;

const PAGE_TEXT = '深海测试页的标题在这里';

let calls = 0;
let sawResult = false;
const reqs = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls++;
    let j = {};
    try { j = JSON.parse(raw); } catch {}
    const sys = (j.messages && j.messages[0] && j.messages[0].content) || '';
    const user = (j.messages || []).map((m) => String(m.content || '')).join('\n');
    reqs.push({ sys, user, all: String(sys || '') + String(user || '') });
    if (user.includes('工具结果')) sawResult = true;
    const body = user.includes('工具结果')
      ? '抓到了，页面上写着「' + PAGE_TEXT + '」。'
      : '我上网看一眼。\n[[工具: {"name":"fetch_url","args":{"url":"http://127.0.0.1:' + PAGE_PORT + '/page"}}]]';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [ { message: { content: body } } ], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});

const page = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>t</title><script>var a=1</script></head><body><h1>' + PAGE_TEXT + '</h1><p>第二段</p></body></html>');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

let child = null;
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { console.log('PASS', name); pass++; } else { console.log('FAIL', name, extra); fail++; } };

try {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  await new Promise((r) => page.listen(PAGE_PORT, '127.0.0.1', r));
  fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model', key: 'stub-key', maxTokens: 400 }, null, 2));

  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: U, master: U } }));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    reply: { debounceMs: 200, privateDelayMs: 0, groupDelayMs: 0 },
    proactive: { enabled: false },
    browse: { enabled: false },
    work: { toolsEnabled: true, net: { enabled: true, allowHosts: [ '127.0.0.1' ] } },
  }));

  child = spawn(process.execPath, [ path.join(SRC, 'bridge.mjs') ], {
    env: { ...process.env, QQBOT_DATA: DATA, QQBOT_API_FILE: API, QQBOT_LOCAL_PORT: String(LOCAL_PORT), QQBOT_NAP_SKIP: '1', QQBOT_TOOLS: '1' },
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    cwd: TMP,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(300);
    try { const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); up = r.status === 400 || r.status === 200; } catch {}
  }
  check('桥接本地通道起来了', up, out.slice(-300));
  if (!up) throw new Error('local down');

  const st = await (await fetch('http://127.0.0.1:' + LOCAL_PORT + '/work/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: WS, caps: [ 'fs:read', 'net' ], useExisting: true }),
  })).json();
  check('工作会话带上了 net 能力', !!(st.state && st.state.caps && st.state.caps.includes('net')), JSON.stringify(st).slice(0, 200));

  const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你上网看一眼 http://127.0.0.1:' + PAGE_PORT + '/page 写了什么' }) });
  check('/say 接受了消息', r.status === 200);

  let reply = '';
  const chatFile = path.join(DATA, 'chat', U + '.jsonl');
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    const rows = readJsonl(chatFile).filter((x) => x.dir === 'out' && x.type === 'text');
    if (rows.length) { reply = rows.map((x) => x.text).join('\n'); break; }
  }
  check('她回了话', !!reply, '（没等到）');
  check('回复里带了页面内容', reply.includes(PAGE_TEXT), reply);
  check('没有把工具 JSON 发出去', !/\[\[工具|fetch_url|"args"/.test(reply), reply);
  check('工具结果回灌给了大脑', sawResult, 'calls=' + calls);
  check('日志里有 fetch_url ok', /\[tool\]\s+\d+\s+fetch_url ok/.test(out), out.slice(-500));
  check('这次请求里带了 fetch_url 且写了内网不抓', reqs.some((x) => /fetch_url/.test(x.all) && /内网/.test(x.all)), '');

  const audit = path.join(DATA, 'ledger', 'audit.jsonl');
  const lines = readJsonl(audit);
  const fe = lines.filter((x) => x.kind === 'fetch');
  check('审计里有 fetch 记录', fe.length > 0, JSON.stringify(lines).slice(0, 200));
  check('审计记了 200 与字节数', fe.some((x) => x.status === 200 && x.bytes > 0), JSON.stringify(fe).slice(0, 200));
  check('审计没记正文', !JSON.stringify(fe).includes(PAGE_TEXT), '');
} catch (e) {
  console.log('FAIL 端到端异常：', e.message);
  fail++;
} finally {
  try { child && child.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  try { page.close(); } catch {}
  if (!process.env.KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  await sleep(300);
  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}
