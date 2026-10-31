// P1-1：受限命令执行（exec.mjs + tools.run_cmd + bridge 接线）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-exec-'));
process.env.QQBOT_DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(process.env.QQBOT_DATA, 'work'), { recursive: true });

const exec = await import('../src/exec.mjs');
const tools = await import('../src/tools.mjs');

const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS, { recursive: true });
const OUTSIDE = path.join(TMP, 'outside.txt');
fs.writeFileSync(OUTSIDE, 'kept');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '—', (e && e.message) || e); fail++; }
}

const base = { root: WS, wsId: 'ws-test', mode: 'workspace' };

await t('1 白名单外程序被拒', async () => {
  const r = await exec.run([ 'cmd', '/c', 'echo', 'hi' ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /不在白名单/);
});

await t('2 带路径的 exe 被拒', async () => {
  const r = await exec.run([ 'C:\\Windows\\System32\\cmd.exe', '/c', 'echo' ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /不能用路径/);
});

await t('3 shell 元字符被拒', async () => {
  const r = await exec.run([ 'node', 'a.mjs', '&&', 'del', 'x' ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /不允许的字符/);
});

await t('4 危险片段被拒', async () => {
  const r = await exec.run([ 'git', 'clean', '-fdx' ], base);
  // git clean 不在白名单子命令里时也应被拒；这里只要求"不 ok"
  assert.equal(r.ok, false);
});

await t('5 node 内联执行被拒', async () => {
  const r = await exec.run([ 'node', '-e', 'console.log(1)' ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /内联/);
});

await t('6 参数路径越界被拒', async () => {
  const r = await exec.run([ 'node', OUTSIDE ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /不在工作区/);
});

await t('7 工作区内脚本能跑起来（cwd 锁在工作区）', async () => {
  fs.writeFileSync(path.join(WS, 'hi.mjs'), 'console.log(process.cwd());\n');
  const r = await exec.run([ 'node', 'hi.mjs' ], base);
  assert.equal(r.ok, true, r.err || r.out);
  assert.equal(r.out.trim().toLowerCase(), WS.toLowerCase());
});

await t('8 退出码非 0 报明确原因', async () => {
  fs.writeFileSync(path.join(WS, 'bad.mjs'), 'process.exit(3);\n');
  const r = await exec.run([ 'node', 'bad.mjs' ], base);
  assert.equal(r.ok, false);
  assert.match(r.err, /退出码 3/);
});

await t('9 超时被杀掉（不留进程）', async () => {
  fs.writeFileSync(path.join(WS, 'slow.mjs'), 'setTimeout(()=>{}, 30000);\n');
  const t0 = Date.now();
  const r = await exec.run([ 'node', 'slow.mjs' ], { ...base, timeoutMs: 1200 });
  const ms = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.err, /超时/);
  assert.ok(ms < 15000, 'should not wait 30s, took ' + ms);
});

await t('10 输出超长被截断', async () => {
  fs.writeFileSync(path.join(WS, 'big.mjs'), 'console.log("x".repeat(20000));\n');
  const r = await exec.run([ 'node', 'big.mjs' ], { ...base, maxOutput: 1000 });
  assert.equal(r.ok, true);
  assert.ok(r.out.length <= 1100, 'out len ' + r.out.length);
  assert.match(r.out, /中间省略/);
});

await t('11 环境变量不带密钥', async () => {
  process.env.QQBOT_FAKE_KEY = 'sk-should-not-leak';
  fs.writeFileSync(path.join(WS, 'env.mjs'), 'console.log(process.env.QQBOT_FAKE_KEY || "none");\n');
  const r = await exec.run([ 'node', 'env.mjs' ], base);
  assert.equal(r.ok, true, r.err || r.out);
  assert.equal(r.out.trim(), 'none');
});

await t('12 审计落盘', async () => {
  const f = path.join(process.env.QQBOT_DATA, 'ledger', 'audit.jsonl');
  assert.ok(fs.existsSync(f), 'audit.jsonl missing');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.ok(lines.length >= 5);
  const one = lines[lines.length - 1];
  assert.ok(one.cmd && Array.isArray(one.cmd));
  assert.equal(one.ws, 'ws-test');
});

await t('13 mode=off 直接拒', async () => {
  const r = await exec.run([ 'node', 'hi.mjs' ], { ...base, mode: 'off' });
  assert.equal(r.ok, false);
  assert.match(r.err, /没开/);
});

await t('14 停会话时杀掉在跑的进程树', async () => {
  fs.writeFileSync(path.join(WS, 'long.mjs'), 'setTimeout(()=>{}, 30000);\n');
  const p = exec.run([ 'node', 'long.mjs' ], { ...base, wsId: 'ws-kill', timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(exec.activeCount('ws-kill') >= 1, 'child not registered');
  const n = exec.killAll('ws-kill');
  assert.ok(n >= 1);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(exec.activeCount('ws-kill'), 0);
});

await t('15 tools.run_cmd 走的是 exec（不在工作区就拒）', async () => {
  const r = await tools.call('run_cmd', { cmd: [ 'node', 'hi.mjs' ] }, { approved: true, writeRoot: WS, wsId: 'ws-tools', execMode: 'workspace' });
  assert.equal(r.ok, true, r.err);
});

await t('16 tools.run_cmd 需要审批（未批准返回 needApproval）', async () => {
  const r = await tools.call('run_cmd', { cmd: [ 'node', 'hi.mjs' ] }, { writeRoot: WS });
  assert.equal(r.ok, false);
  assert.equal(r.needApproval, true);
});

await t('17 bridge 接线：execCfg / killAll / 审批带 dir', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'bridge.mjs'), 'utf8');
  assert.match(src, /function execCfg\(\)/);
  assert.match(src, /exec\.killAll\(__wsNow\.id\)/);
  assert.match(src, /askApproval\(tc\.name, tc\.args, workKey\(conv\), \{ dir: __scope\.writeRoot/);
  assert.match(src, /execMode: e\.mode/);
});

await t('18 settings 默认 exec 是对象且 mode=workspace', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'settings.mjs'), 'utf8');
  assert.match(src, /exec: \{ mode: 'workspace'/);
});

console.log('\nPASS', pass, '/ FAIL', fail);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
