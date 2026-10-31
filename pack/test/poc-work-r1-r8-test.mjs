// 复查 R1–R8 回归：真实 grants / fsguard / tools + 从 bridge 源码提取的授权函数 + 一次真起桥接的集成段
// 跑法（在 qq-bot 根目录）：node pack/poc-work-r1-r8-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('pack');
const SRC = path.join(ROOT, 'src');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, extra === undefined ? '' : extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-r18-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS, { recursive: true });
process.env.QQBOT_DATA = DATA;

const grants = await import(pathToFileURL(path.join(SRC, 'grants.mjs')).href);
const fsguard = await import(pathToFileURL(path.join(SRC, 'fsguard.mjs')).href);
const toolbox = await import(pathToFileURL(path.join(SRC, 'tools.mjs')).href);

// ---------- 从 bridge 源码里取授权相关函数（保证测的是真实现，不是复刻） ----------
const bsrc = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
function grab(name) {
  const i = bsrc.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let depth = 0, started = false, k = i;
  for (; k < bsrc.length; k++) {
    const ch = bsrc[k];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { k++; break; } }
  }
  return bsrc.slice(i, k);
}
const make = new Function('grants', 'toolbox', 'workCfg', 'workKey', 'workDeny', 'path', 'execCfg',
  grab('toolScope') + '\n' + grab('grantStillActive') + '\n' + grab('toolCapsOk') + '\nreturn { toolScope, grantStillActive, toolCapsOk };');
let execAllowed = false;
const execCfgStub = () => ({ mode: 'workspace', allow: [], timeoutMs: 60000, maxOutput: 8000 });
const api = make(grants, toolbox, () => ({ readRoots: [WS], exec: execAllowed, timeoutMin: 30 }), (c) => c.kind + ':' + c.id, () => [], path, execCfgStub);

// ---------- R1：任务开始固定授权，停止后不能借新授权 ----------
const key = 'local:1';
const conv = { kind: 'local', id: '1' };
const g1 = grants.open({ convKey: key, root: WS, readRoots: [WS], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
const pinned = { id: g1.state.id, epoch: g1.state.epoch };
const needWrite = { name: 'write_file', caps: [ 'fs:write' ] };
toolbox.tools.write_file = { desc: 'stub', caps: [ 'fs:write' ], async run() { return { ok: true, out: '' }; } };

let sc = api.toolScope(conv, pinned);
ok(sc.active === true && sc.epoch === pinned.epoch, 'R1 授权有效时按 pinned epoch 放行写能力', JSON.stringify(sc));
ok(api.toolCapsOk(conv, 'write_file', sc).ok === true, 'R1 有效授权下写能力通过');

grants.stop(key, 'user');
ok(api.toolCapsOk(conv, 'write_file', api.toolScope(conv, pinned)).ok === false, 'R1 停止后旧任务写能力被拒');

const g2 = grants.open({ convKey: key, root: WS, readRoots: [WS], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
const reSc = api.toolScope(conv, pinned);
ok(g2.state.epoch !== pinned.epoch, 'R1 重开是新的 epoch');
ok(reSc.stale === true && reSc.active === false, 'R1 停止后重开：旧任务拿不到新授权（stale）');
ok(api.toolCapsOk(conv, 'write_file', reSc).ok === false, 'R1 旧任务在新会话下仍不能写');
const fresh = { id: g2.state.id, epoch: g2.state.epoch };
ok(api.toolCapsOk(conv, 'write_file', api.toolScope(conv, fresh)).ok === true, 'R1 新任务用自己的授权才能写');
ok(api.grantStillActive(conv, pinned) === false && api.grantStillActive(conv, fresh) === true, 'R1 审批回来时只认原授权');
grants.stop(key, 'user');

// ---------- R2：exec 必须有活动工作会话；P1-1 起提示词里明确告诉她会跑命令 ----------
toolbox.tools.run_cmd = toolbox.tools.run_cmd || { desc: 'stub', caps: [ 'exec' ], async run() { return { ok: false, needApproval: true }; } };
ok(api.toolCapsOk(conv, 'run_cmd', { active: false, epoch: 0 }).ok === false, 'R2 没有工作会话时 run_cmd 直接拒');
const st2 = grants.open({ convKey: key, root: TMP, readRoots: [ TMP ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30, inPlace: true, source: 'test' }).state;
ok(api.toolCapsOk(conv, 'run_cmd', { active: true, epoch: st2.epoch, ws: { alive: true } }).ok === true, 'R2 有工作会话时放行进审批');
grants.stop(key, 'user');
ok(bsrc.includes('- run_cmd：在工作区里跑命令'), 'R2 提示词里告诉了她能跑命令（但要审批）');
ok(bsrc.includes('cancelApprovals(__wk)'), 'R2 停止会话会作废挂起审批');
ok(bsrc.includes("approved: true, roots: __scope.roots, deny: __scope.deny"), 'R2 审批执行时带上 roots/deny/base/epoch');

// ---------- R6：没有 caps 的工具默认拒绝 ----------
toolbox.tools.no_caps_stub = { desc: 'stub', async run() { return { ok: true }; } };
ok(api.toolCapsOk(conv, 'no_caps_stub', { active: true, epoch: 1 }).ok === false, 'R6 未声明 caps 的工具默认拒绝');

// ---------- R3：主配置被拦，.bak 也必须被拦；默认按路径前缀归类 ----------
const cfg = path.join(DATA, 'config.json');
fs.writeFileSync(cfg, '{"secret":1}');
fs.writeFileSync(cfg + '.bak', '{"secret":0}');
fs.writeFileSync(cfg + '.bak-20261029-2019', '{"secret":-1}');
const deny = [ cfg ];
const r1 = fsguard.checkRead(cfg, { base: DATA, roots: [ DATA ], denyAbs: deny });
const r2 = fsguard.checkRead(cfg + '.bak', { base: DATA, roots: [ DATA ], denyAbs: deny });
const r3 = fsguard.checkRead(cfg + '.bak-20261029-2019', { base: DATA, roots: [ DATA ], denyAbs: deny });
const r4 = fsguard.checkRead(path.join(DATA, 'config.jsonx'), { base: DATA, roots: [ DATA ], denyAbs: deny });
ok(r1.ok === false, 'R3 config.json 被拒');
ok(r2.ok === false, 'R3 config.json.bak 被拒');
ok(r3.ok === false, 'R3 config.json.bak-日期 被拒');
ok(r4.ok === true, 'R3 同前缀的普通文件不受影响');
const tr = await toolbox.call('read_file', { path: cfg + '.bak' }, { roots: [ DATA ], deny });
ok(tr.ok === false && String(tr.err).includes('不允许读'), 'R3 真 read_file 也读不到 .bak', tr.err);

// ---------- R5：硬链接外部文件拒绝写 ----------
const outside = path.join(TMP, 'outside.txt');
fs.writeFileSync(outside, 'outside-original');
const linkIn = path.join(WS, 'link-in.txt');
let linked = false;
try { fs.linkSync(outside, linkIn); linked = true; } catch (e) { console.log('SKIP 建不了硬链接：', e.code); }
if (linked) {
  const w1 = fsguard.checkWrite(linkIn, { base: WS, root: WS });
  ok(w1.ok === false && String(w1.err).includes('硬链接'), 'R5 多链接文件拒绝写', w1.err);
  const w2 = fsguard.checkWrite(path.join(WS, 'fresh.txt'), { base: WS, root: WS });
  ok(w2.ok === true, 'R5 普通新文件仍允许');
}

// ---------- R4 / R7 / R8：真起一个桥接，验证复制语义、无残留、发消息续期 ----------
const API = path.join(TMP, 'api.json');
process.env.QQBOT_API_FILE = API;
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const j = { id: 'x', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: '嗯。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j));
  });
});
fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: '10001', master: '10001' } }));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  reply: { debounceMs: 100, privateDelayMs: 0, groupDelayMs: 0 }, proactive: { enabled: false }, browse: { enabled: false },
  tools: { enabled: true, maxRounds: 2, ownerOnly: true }, work: { readRoots: [], timeoutMin: 30, exec: false },
}));
fs.writeFileSync(API, JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:5691', model: 'stub', key: 'stub-key', maxTokens: 300 }, null, 2));
const env = { ...process.env, QQBOT_DATA: DATA, QQBOT_API_FILE: API, QQBOT_LOCAL_PORT: '3691', QQBOT_UI_PORT: '3692', QQBOT_NAP_SKIP: '1', HOME: path.join(TMP, 'home'), USERPROFILE: path.join(TMP, 'home') };
fs.mkdirSync(env.HOME, { recursive: true });
const child = spawn(process.execPath, [ path.join(SRC, 'bridge.mjs') ], { env, stdio: [ 'ignore', 'pipe', 'pipe' ], cwd: TMP });
let blog = '';
child.stdout.on('data', (d) => (blog += d));
child.stderr.on('data', (d) => (blog += d));
const get = async (u) => (await fetch(u)).json();
const post = async (u, o) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o || {}) })).json();

try {
  await new Promise((r) => fake.listen(5691, '127.0.0.1', r));
  for (let i = 0; i < 40; i++) { try { const h = await fetch('http://127.0.0.1:3691/ping'); if (h.ok) break; } catch {} await sleep(250); }

  // R4：选定已有目录 + 勾"直接用" → 工作区就是这个目录本身（不再复制、不套日期前缀）
  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'main.txt'), 'ORIGINAL');
  const copyTo = path.join(TMP, 'copy-target');
  const st4 = await post('http://127.0.0.1:3691/work/start', { root: proj, useExisting: true, caps: [ 'fs:read', 'fs:write' ], confirmWrite: true, copyTo });
  ok(st4.ok === true, 'R4 选中已有目录能开（勾了就用）', JSON.stringify(st4).slice(0, 200));
  ok(String(st4.state && st4.state.root).toLowerCase() === proj.toLowerCase(), 'R4 授权的是这个目录本身', st4.state && st4.state.root);
  ok(fs.readFileSync(path.join(proj, 'main.txt'), 'utf8') === 'ORIGINAL', 'R4 原目录文件没被改');
  ok(!fs.existsSync(copyTo), 'R4 不再偷偷复制到别的目录');

  // R7：已有一个会话时再开 → 400，且不留下新目录
  const ghost = path.join(TMP, 'ghost-dir');
  const st7 = await post('http://127.0.0.1:3691/work/start', { root: ghost, caps: [ 'fs:read' ] });
  ok(st7.ok === false, 'R7 已有会话时再开被拒');
  ok(!fs.existsSync(ghost), 'R7 失败请求没有留下空目录');

  // R7b：要写但没 confirmWrite → 拒，且不建目录
  await post('http://127.0.0.1:3691/work/stop', {});
  const ghost2 = path.join(TMP, 'ghost-dir-2');
  const st7b = await post('http://127.0.0.1:3691/work/start', { root: ghost2, caps: [ 'fs:read', 'fs:write' ] });
  ok(st7b.ok === false && !fs.existsSync(ghost2), 'R7b 写权限必须界面确认，且不留目录');

  // R8：发消息续期
  await post('http://127.0.0.1:3691/work/start', { root: copyTo, useExisting: true, inPlace: true, caps: [ 'fs:read' ], confirmWrite: false, timeoutMin: 1 });
  const before = (await get('http://127.0.0.1:3691/work')).work;
  await sleep(1200);
  await post('http://127.0.0.1:3691/say', { text: '在吗' });
  await sleep(600);
  const after = (await get('http://127.0.0.1:3691/work')).work;
  ok(after.active === true && after.leftMs > 59000, 'R8 他发消息会把 1 分钟的到期时间续回满（≈59s）', `${before.leftMs} → ${after.leftMs}`);
  await post('http://127.0.0.1:3691/work/stop', {});
} finally {
  try { child.kill(); } catch {}
  try { fake.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (fail) console.log('--- bridge log tail ---\n' + blog.slice(-2000));
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
