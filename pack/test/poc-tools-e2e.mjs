// 端到端：用一个假的大脑服务器（OpenAI 兼容）验证 T1 工具轮——
// 第一次返回工具调用，第二次返回"看完了"的正文；然后检查桥接真的执行了 list_dir、并且没有把 JSON 发给用户。
// 跑法：node pack\poc-tools-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-e2e-'));
const DATA = path.join(TMP, 'data');
const U = '1111111111';
const STUB_PORT = 5599;
const LOCAL_PORT = 3598;
const API = path.join(TMP, 'api.json');
process.env.QQBOT_API_FILE = API;

let calls = 0;
let sawSystem = '';
const seenSystems = [];
const reqs = [];
let sawResultReq = false;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls++;
    try {
      const j = JSON.parse(raw);
      sawSystem = (j.messages && j.messages[0] && j.messages[0].content) || '';
      if (sawSystem) seenSystems.push(sawSystem);
      const allUser = (j.messages || []).map((m) => String(m.content || '')).join('\n');
      reqs.push({ sys: sawSystem, user: allUser });
      { const u = (j.messages || []).map((m) => String(m.content || '')).join('\n'); if (u.includes('工具结果')) sawResultReq = true; }
      const userMsg = (j.messages || []).map((m) => String(m.content || '')).join('\n');
      const sawResult = userMsg.includes('工具结果');
      const body = sawResult
        ? '翻到了：notes 里有「整理后复查-20261029.md」这些记录，我刚看过。'
        : '我去翻一眼。\n[[工具: ' + JSON.stringify({ name: 'list_dir', args: { path: path.join(DATA, 'work') } }) + ']]';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: body } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    } catch {
      res.writeHead(400); res.end('bad');
    }
  });
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function readJsonl(p) {
  try { return fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

let child = null;
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log('PASS', name); pass++; }
  else { console.log('FAIL', name, extra); fail++; }
}

try {
  // 1) 假大脑
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:' + STUB_PORT, model: 'stub-model', key: 'stub-key', maxTokens: 400 }, null, 2));

  // 2) 临时数据目录
  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: U, master: U } }));
  fs.mkdirSync(path.join(DATA, 'work'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'work', '整理后复查-20261029.md'), '# 记录');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ reply: { debounceMs: 300, privateDelayMs: 0, groupDelayMs: 0 }, proactive: { enabled: false }, browse: { enabled: false }, work: { toolsEnabled: true, readRoots: [] } }));

  // 3) 起桥接（不连 NapCat，只用本地通道）
  child = spawn(process.execPath, [path.join(SRC, 'bridge.mjs')], {
    env: { ...process.env, QQBOT_DATA: DATA, QQBOT_API_FILE: API, QQBOT_LOCAL_PORT: String(LOCAL_PORT), QQBOT_NAP_SKIP: '1', QQBOT_TOOLS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: TMP,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // 4) 等本地通道起来
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) }); up = r.status === 400 || r.status === 200; } catch {}
  }
  check('桥接本地通道起来了', up, out.slice(-300));
  if (!up) throw new Error('local channel down: ' + out.slice(-400));

  // 5) 发一句，让她去翻目录
  const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '帮我看看 notes 目录里都有啥' }) });
  check('/say 接受了消息', r.status === 200);

  // 6) 等回复
  let reply = '';
  const chatFile = path.join(DATA, 'chat', U + '.jsonl');
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const rows = readJsonl(chatFile).filter((x) => x.dir === 'out' && x.type === 'text');
    if (rows.length) { reply = rows.map((x) => x.text).join('\n'); break; }
  }
  check('她回了话', !!reply, '（没等到回复）');
  check('回复里是她看过之后的说法', /整理后复查|notes/.test(reply), reply);
  check('没有把工具 JSON 发给用户', !/\[\[工具|list_dir|"args"/.test(reply), reply);
  check('工具结果被回灌给大脑了', sawResultReq, 'calls=' + calls);
  // 记忆抽取那次也会带上他的话，所以只挑真正生成回复的那次（系统提示词里有回复规矩）
  const taskReqs = reqs.filter((x) => /notes 目录里都有啥/.test(x.user) && /直接给出要发到 QQ 的回复/.test(x.sys));
  const taskReq = taskReqs[0] || null;
  check('找到了生成回复的那次请求', !!taskReq, 'reqs=' + reqs.length + ' 回复请求=' + taskReqs.length);
  check('这次请求的系统提示词里带了工具说明', !!taskReq && /list_dir/.test(taskReq.sys) && /read_file/.test(taskReq.sys),
    taskReq ? taskReq.sys.slice(-160) : '（没找到任务请求）');
  check('工具说明里有 run_cmd 且写明要审批（P1-1）', !!taskReq && /run_cmd/.test(taskReq.sys) && /点头|审批/.test(taskReq.sys), taskReq ? taskReq.sys.slice(0, 80) : '');

  const skillsFile = path.join(DATA, 'agent-home', 'memory', 'skills', U + '.json');
  const sk = fs.existsSync(skillsFile) ? JSON.parse(fs.readFileSync(skillsFile, 'utf8')) : { items: [] };
  check('技能库记下了这次调用', sk.items.some((x) => x.name === 'list_dir' && x.ok), JSON.stringify(sk.items));
  check('日志里有 [tool] 行', /\[tool\]/.test(out), out.slice(-400));
} catch (e) {
  console.log('FAIL 端到端异常：', e.message);
  fail++;
} finally {
  try { child && child.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  if (!process.env.KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else { console.log('TMP kept at', TMP); }
  await sleep(300);
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
