// 验证：全新安装（没填主人 QQ、只填了 API Key）时，聊天能记下来、能取回来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-noqq-'));
const DATA = path.join(TMP, 'data');
const STUB_PORT = 5613;
const LOCAL_PORT = 3613;
const API = path.join(TMP, 'api.json');
process.env.QQBOT_API_FILE = API;

let calls = 0;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '嗯，我在听。' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n, ok ? '' : extra); ok ? pass++ : fail++; };
let child = null;

try {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model', key: 'sk-stub' }, null, 2));
  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ api: { baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model' }, qq: {} }));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ reply: { debounceMs: 200 }, proactive: { enabled: false }, browse: { enabled: false } }));

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
  check('启动时提示了没填主人 QQ', /还没填主人 QQ/.test(log), log.slice(0, 300));

  await fetch(`http://127.0.0.1:${LOCAL_PORT}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你是谁啊' }) });
  // 她回话是带延迟的（第一次说话 1.5–4 秒），固定睡 2.5 秒会偶发抢在回复之前，
  // 改成轮询到她说出那句话为止，最多等 12 秒。
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try {
      const t = JSON.parse(await (await fetch(`http://127.0.0.1:${LOCAL_PORT}/history?n=60`)).text() || '{}');
      if ((t.msgs || []).some((x) => String(x.text || '').includes('我在听'))) break;
    } catch {}
  }
  await sleep(300);

  const h = JSON.parse(await (await fetch(`http://127.0.0.1:${LOCAL_PORT}/history?n=60`)).text() || '{}');
  const m = JSON.parse(await (await fetch(`http://127.0.0.1:${LOCAL_PORT}/msgs?since=0`)).text() || '{}');
  const hl = (h.msgs || []).length;
  const ml = (m.msgs || []).length;
  check('history 取到了消息', hl >= 2, JSON.stringify(h).slice(0, 200));
  check('msgs 取到了消息', ml >= 2, JSON.stringify(m).slice(0, 200));
  check('history 里有他发的、也有她回的', (h.msgs || []).some((x) => String(x.text || '').includes('你是谁啊')) && (h.msgs || []).some((x) => String(x.text || '').includes('我在听')), JSON.stringify(h.msgs || []).slice(0, 300));

  const files = fs.existsSync(path.join(DATA, 'chat')) ? fs.readdirSync(path.join(DATA, 'chat')) : [];
  check('聊天落到 local.jsonl', files.includes('local.jsonl'), files.join(','));
} catch (e) {
  console.log('FAIL 异常', e.message); fail++;
} finally {
  try { child && child.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  if (!process.env.KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  await sleep(200);
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
