// poc-work-test.mjs — 工作模式第一步（凭据 / 路径边界 / 停止 / 到期）的行为测试
// 跑法：node pack/poc-work-test.mjs   （从项目根目录跑）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-'));
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
process.env.QQBOT_DATA = DATA;

// 假数据：一个"秘密"文件（模拟 config.json），一个可读文件
const SECRET = path.join(DATA, 'config.json');
fs.writeFileSync(SECRET, '{"key":"sk-should-never-leak"}');
const WS = path.join(ROOT, 'ws', 'work');
fs.mkdirSync(WS, { recursive: true });
const OK = path.join(WS, 'a.txt');
fs.writeFileSync(OK, 'hello');

const grants = await import('../src/grants.mjs');
const fsguard = await import('../src/fsguard.mjs');

const cases = [];
function t(name, fn) { cases.push([ name, fn ]); }

t('建议路径不会建目录（授权前不碰磁盘）', () => {
  const p = path.join(ROOT, 'suggest', '2026-10-30-task');
  assert.equal(fs.existsSync(p), false);
  const st = fsguard.realAncestor(p);
  assert.equal(fs.existsSync(p), false, 'realAncestor 不该建东西');
  assert.ok(st.real.length > 0);
});

t('open 不建目录；会话拿到 id/epoch', () => {
  const r = grants.open({ convKey: 'local:1', root: WS, caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(WS), true);       // WS 是测试自己建的
  assert.ok(r.state.id && r.state.epoch === 1);
  const st = grants.state('local:1');
  assert.equal(st.active, true);
  assert.deepEqual(st.caps, [ 'fs:read', 'fs:write' ]);
});

t('读：工作区内的文件可以读', () => {
  const c = fsguard.checkRead(OK, { roots: [ WS ] });
  assert.equal(c.ok, true);
});

t('读：工作区外的文件读不到', () => {
  const outside = path.join(ROOT, 'outside.txt');
  fs.writeFileSync(outside, 'nope');
  const c = fsguard.checkRead(outside, { roots: [ WS ] });
  assert.equal(c.ok, false);
  assert.match(c.err, /路径不在允许范围/);
});

t('读：禁读清单里的文件读不到（config.json）', () => {
  const c = fsguard.checkRead(SECRET, { roots: [ ROOT ], denyAbs: [ SECRET ] });
  assert.equal(c.ok, false);
  assert.match(c.err, /不允许读/);
});

t('读：.. 逃逸被挡', () => {
  const c = fsguard.checkRead(path.join(WS, '..', '..', 'outside.txt'), { roots: [ WS ] });
  assert.equal(c.ok, false);
});

t('写：工作区外拒绝', () => {
  const c = fsguard.checkWrite(path.join(ROOT, 'evil.txt'), { root: WS });
  assert.equal(c.ok, false);
  assert.equal(fs.existsSync(path.join(ROOT, 'evil.txt')), false, '不该真的建出来');
});

t('写：工作区内新文件允许（父目录存在）', () => {
  const target = path.join(WS, 'new.txt');
  const c = fsguard.checkWrite(target, { root: WS });
  assert.equal(c.ok, true);
  assert.equal(c.exists, false);
  assert.equal(fs.existsSync(target), false, '检查阶段不许落盘');
});

t('写：禁读清单同样禁写', () => {
  const c = fsguard.checkWrite(SECRET, { root: ROOT, denyAbs: [ SECRET ] });
  assert.equal(c.ok, false);
});

t('写：符号链接指向外部时拒绝', () => {
  const link = path.join(WS, 'link-out');
  const outsideDir = path.join(ROOT, 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  let made = false;
  try { fs.symlinkSync(outsideDir, link, 'junction'); made = true; } catch {}
  if (!made) { console.log('    (跳过：这台机器不允许建 junction)'); return; }
  const c = fsguard.checkWrite(path.join(link, 'x.txt'), { root: WS });
  assert.equal(c.ok, false);
  if (process.platform === 'win32') {
    try { execFileSync('cmd', [ '/c', 'rmdir', link ], { stdio: 'ignore' }); } catch {}
  }
});

t('能力：没有 fs:write 时 requireCap 拒绝', () => {
  grants.stop('local:1');
  grants.open({ convKey: 'local:2', root: WS, caps: [ 'fs:read' ], timeoutMin: 30 });
  const r = grants.requireCap('local:2', 'fs:write');
  assert.equal(r.ok, false);
  assert.match(r.err, /没有开通/);
});

t('停止：之后 requireCap 一律拒绝（迟到指令无效）', () => {
  const st = grants.state('local:2');
  const ep = st.epoch;
  grants.stop('local:2');
  const r = grants.requireCap('local:2', 'fs:read', ep);
  assert.equal(r.ok, false);
  assert.equal(grants.state('local:2').active, false);
});

t('停止：epoch 变了，旧 epoch 的调用被拒', () => {
  grants.open({ convKey: 'local:3', root: WS, caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
  const ep1 = grants.state('local:3').epoch;
  grants.stop('local:3');
  grants.open({ convKey: 'local:3', root: WS, caps: [ 'fs:read' ], timeoutMin: 30 });
  const ep2 = grants.state('local:3').epoch;
  assert.notEqual(ep1, ep2);
  const r = grants.requireCap('local:3', 'fs:read', ep1);
  assert.equal(r.ok, false);
  assert.match(r.err, /授权已失效/);
});

t('到期：过了时间就失效；touch 能续但只续给人', () => {
  grants.stop('local:3');
  grants.open({ convKey: 'local:4', root: WS, caps: [ 'fs:read' ], timeoutMin: 1 });
  const s = grants.active('local:4');
  s.expiresAt = Date.now() - 1;                       // 手工让它过期
  assert.equal(grants.state('local:4').active, false);
  assert.equal(grants.touch('local:4'), false);
});

t('续期：touch 把有效期往后推', () => {
  grants.open({ convKey: 'local:5', root: WS, caps: [ 'fs:read' ], timeoutMin: 5 });
  const before = grants.state('local:5').leftMs;
  const s = grants.active('local:5');
  s.expiresAt = Date.now() + 60e3;                    // 先压到 1 分钟
  grants.touch('local:5');
  const after = grants.state('local:5').leftMs;
  assert.ok(after > 60e3, '应当续到 5 分钟');
  assert.ok(after >= before - 60e3);
});

t('历史只记历史，重启后没有有效会话（内存）', () => {
  grants.stop('local:5');
  const h = grants.history(20);
  assert.ok(Array.isArray(h) && h.length > 0);
  assert.ok(h.every((x) => x.action && x.at));
  // 模块内 sessions 是私有 Map：换一个"新进程"等价于重新 import 拿不到旧会话
  assert.equal(grants.state('local:5').active, false);
});

t('静态：工具声明了 caps；bridge 按会话给范围并做能力检查', () => {
  const tools = fs.readFileSync(path.resolve('pack/src/tools.mjs'), 'utf8');
  assert.match(tools, /caps: \[ 'fs:read' \]/);
  assert.match(tools, /caps: \[ 'exec' \]/);
  assert.match(tools, /fsguard\.checkRead/);
  const bridge = fs.readFileSync(path.resolve('pack/src/bridge.mjs'), 'utf8');
  assert.match(bridge, /function toolCapsOk/);
  assert.match(bridge, /roots: __scope\.roots, deny: __scope\.deny/);
  assert.match(bridge, /p === '\/work\/start'/);
  assert.match(bridge, /grants\.requireCap/);
});

// 0.3.33：运行中改权限（三档），换 epoch 让迟到的旧结果失效
cases.push([ 'setCaps 改权限并换 epoch', async () => {
  const g = await import(new URL('../src/grants.mjs', import.meta.url).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-caps-'));
  const st = g.open({ convKey: 'caps:1', root: dir, caps: [ 'fs:read' ], inPlace: true });
  assert.equal(st.state.caps.length, 1);
  const e0 = st.state.epoch;
  const r = g.setCaps('caps:1', [ 'fs:read', 'fs:write', 'exec' ]);
  assert.ok(r.ok);
  assert.ok(r.state.caps.includes('fs:write'));
  assert.ok(r.state.epoch > e0);
  assert.equal(g.requireCap('caps:1', 'fs:write', e0).ok, false);
  assert.equal(g.requireCap('caps:1', 'fs:write', r.state.epoch).ok, true);
  g.stop('caps:1', 'test');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
} ]);

let pass = 0, fail = 0;
for (const [ name, fn ] of cases) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '->', e.message); fail++; }
}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
