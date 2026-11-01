// 端到端：**聊天窗**里发一句话，桥接真的收到、她真的回。
// 这是验收报告 F1 缺的那条测试——以前所有断言看的都是"源码里有没有这句话"。
// 顺带验 /api/work/pick-dir 在"应用没在跑"时快速失败（不把弹窗卡 90 秒）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-chatwork-'));
const DATA = path.join(TMP, 'data');
const STUB_PORT = 5621;
const LOCAL_PORT = 3621;
const API = path.join(TMP, 'api.json');

let calls = 0;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '嗯，收到了。' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n, ok ? '' : extra); ok ? pass++ : fail++; };
let child = null, chat = null;

try {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model', key: 'sk-stub' }, null, 2));
  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ api: { baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model' }, qq: { ownerUin: '10001' } }));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ reply: { debounceMs: 200 }, proactive: { enabled: false }, browse: { enabled: false }, work: { toolsEnabled: true } }));

  child = spawn(process.execPath, [path.join(SRC, 'bridge.mjs')], {
    env: { ...process.env, QQBOT_DATA: DATA, QQBOT_API_FILE: API, QQBOT_LOCAL_PORT: String(LOCAL_PORT), QQBOT_NAP_SKIP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: TMP,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); up = r.status === 400 || r.status === 200; } catch {}
  }
  check('桥接起来了', up, log.slice(-300));

  // 拉起聊天窗服务（和 launch.mjs 里一样，同进程 import 启服务）。
  // 必须把 APPDATA 指到临时目录：chatserver 是从 %APPDATA%\DSChatBot\where.json 找数据目录的，
  // 不隔离就会连到他真实的桥接、往真实聊天窗里发消息（我第一次就踩了）。
  const FAKE_APP = path.join(TMP, 'appdata');
  fs.mkdirSync(path.join(FAKE_APP, 'DSChatBot'), { recursive: true });
  fs.writeFileSync(path.join(FAKE_APP, 'DSChatBot', 'where.json'), JSON.stringify({ dataDir: DATA }));
  process.env.APPDATA = FAKE_APP;
  fs.mkdirSync(path.join(DATA, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'chat', 'config.json'), JSON.stringify({ bridgePort: LOCAL_PORT, dataDir: DATA, botName: 'test' }));
  process.env.QQBOT_DATA = DATA;
  process.env.QQBOT_LOCAL_PORT = String(LOCAL_PORT);
  process.env.QQBOT_CHAT_PORT = '3622';
  const cm = await import(pathToFileURL(path.join(SRC, 'chatserver.mjs')).href);
  const r0 = await cm.startServer(3622);
  chat = r0 && r0.server;
  const chatPort = r0 && r0.port;
  check('聊天窗服务起来了', !!chatPort, JSON.stringify(r0));

  // ---------- 这是核心：走聊天窗自己的 /api/send ----------
  const sendRes = await fetch(`http://127.0.0.1:${chatPort}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗' }),
  });
  const sendJson = await sendRes.json().catch(() => ({}));
  check('聊天窗 /api/send 返回 ok（F1 的根就在这条不通）', sendRes.status === 200 && sendJson.ok !== false, `${sendRes.status} ${JSON.stringify(sendJson).slice(0, 200)}`);

  // 桥接真的收到她才会张口 —— 等她说出 stub 那句话
  let replied = false;
  for (let i = 0; i < 40 && !replied; i++) {
    await sleep(400);
    try {
      const h = await (await fetch(`http://127.0.0.1:${LOCAL_PORT}/history?n=40`)).json();
      replied = (h.msgs || []).some((x) => String(x.text || '').includes('收到了'));
    } catch {}
  }
  check('她说出来了（说明消息真到了桥接）', replied, log.slice(-500));
  check('调用次数 +1（模型真的被叫了）', calls >= 1, 'calls=' + calls);

  // ---------- F4：应用没在跑时 pick-dir 要快失败，不能卡 90 秒 ----------
  const t0 = Date.now();
  const pd = await fetch(`http://127.0.0.1:${chatPort}/api/work/pick-dir`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '' }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, err: e.message }));
  const cost = Date.now() - t0;
  check('pick-dir 没卡住（< 8 秒，没主程序时要立刻说用不了）', cost < 8000, cost + 'ms');
  check('pick-dir 失败时明确告诉前端可以降级', pd && pd.ok === false, JSON.stringify(pd).slice(0, 200));
} catch (e) {
  console.log('FAIL 异常', e && e.message); fail++;
} finally {
  try { if (chat) chat.close(); } catch {}
  try { child && child.kill(); } catch {}
  try { stub.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}
