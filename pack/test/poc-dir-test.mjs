// 工作模式第三步：mkdir / move / copy / remove(回收站) / search / find 及恢复
// 跑法：node pack/poc-dir-test.mjs（在仓库根）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-dir-'));
process.env.QQBOT_DATA = TMP;
process.env.QQBOT_API_FILE = path.join(TMP, 'api.json');

const WS = path.join(TMP, 'workspace');
const OUT = path.join(TMP, 'outside');
fs.mkdirSync(path.join(WS, 'docs'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(WS, 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
fs.writeFileSync(path.join(WS, 'docs', 'note.md'), '# 标题\n这里提到 alpha 一次\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside\n', 'utf8');

const tools = await import(new URL('../src/tools.mjs', import.meta.url).href);
const grants = await import(new URL('../src/grants.mjs', import.meta.url).href);
const snapshots = await import(new URL('../src/snapshots.mjs', import.meta.url).href);

let pass = 0; let fail = 0;
async function ta(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); }
}

const KEY = 'local:123456789';
const op = grants.open({ convKey: KEY, root: WS, readRoots: [ WS ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
assert.ok(op.ok, 'open 失败：' + (op && op.err));
const WSID = op.state.id;
const opts = (extra = {}) => ({ roots: [ WS ], writeRoot: WS, wsId: WSID, base: WS, deny: [], ...extra });

await ta('#1 mkdir 建多级目录', async () => {
  const r = await tools.tools.mkdir.run({ path: 'out/deep/dir' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.ok(fs.existsSync(path.join(WS, 'out/deep/dir')));
});

await ta('#2 mkdir 撤销 = 删空目录', async () => {
  const r = await tools.tools.mkdir.run({ path: 'tmpdir' }, opts());
  assert.equal(r.ok, true, r.err);
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'tmpdir'), { root: WS });
  assert.equal(res.ok, true, res.err);
  assert.equal(fs.existsSync(path.join(WS, 'tmpdir')), false);
});

await ta('#3 mkdir 已有非空目录 → 不重复记；空目录撤销时里面有东西要拒绝', async () => {
  const mk = await tools.tools.mkdir.run({ path: 'busy' }, opts());
  fs.writeFileSync(path.join(WS, 'busy', 'x.txt'), 'x', 'utf8');
  const res = snapshots.restore(WSID, mk.edit.id, path.join(WS, 'busy'), { root: WS });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.ok(fs.existsSync(path.join(WS, 'busy', 'x.txt')));
});

await ta('#4 move 改名 + 撤销搬回', async () => {
  const r = await tools.tools.move.run({ from: 'a.txt', to: 'docs/a2.txt' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.ok(fs.existsSync(path.join(WS, 'docs/a2.txt')));
  assert.equal(fs.existsSync(path.join(WS, 'a.txt')), false);
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'a.txt'), { root: WS });
  assert.equal(res.ok, true, res.err);
  assert.ok(fs.existsSync(path.join(WS, 'a.txt')));
  assert.equal(fs.existsSync(path.join(WS, 'docs/a2.txt')), false);
});

await ta('#5 move 目标已存在 → 拒绝（不覆盖）', async () => {
  fs.writeFileSync(path.join(WS, 'b.txt'), 'bee\n', 'utf8');
  const r = await tools.tools.move.run({ from: 'a.txt', to: 'b.txt' }, opts());
  assert.equal(r.ok, false);
  assert.match(r.err, /目标已存在/);
  assert.ok(fs.existsSync(path.join(WS, 'a.txt')));
});

await ta('#6 move 到工作区外 → 拒绝', async () => {
  const r = await tools.tools.move.run({ from: 'a.txt', to: path.join(OUT, 'a.txt') }, opts());
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(WS, 'a.txt')));
});

await ta('#7 copy 复制 + 撤销删副本', async () => {
  const r = await tools.tools.copy.run({ from: 'a.txt', to: 'docs/a-copy.txt' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.equal(fs.readFileSync(path.join(WS, 'docs/a-copy.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'a.txt'), { root: WS });
  assert.equal(res.ok, true, res.err);
  assert.equal(fs.existsSync(path.join(WS, 'docs/a-copy.txt')), false);
});

await ta('#8 copy 到已存在目标 → 拒绝', async () => {
  const r = await tools.tools.copy.run({ from: 'a.txt', to: 'b.txt' }, opts());
  assert.equal(r.ok, false);
  assert.match(r.err, /目标已存在/);
});

await ta('#9 remove 进回收站、原位置消失、撤销搬回', async () => {
  const r = await tools.tools.remove.run({ path: 'b.txt' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.equal(fs.existsSync(path.join(WS, 'b.txt')), false);
  const trash = fs.readdirSync(path.join(WS, '.trash'));
  assert.equal(trash.length, 1);
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'b.txt'), { root: WS });
  assert.equal(res.ok, true, res.err);
  assert.equal(fs.readFileSync(path.join(WS, 'b.txt'), 'utf8'), 'bee\n');
});

await ta('#10a remove 目录 → 整棵搬进回收站、原位置消失、撤销搬回', async () => {
  fs.mkdirSync(path.join(WS, 'docs', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'docs', 'deep', 'x.txt'), 'xx\n');
  const r = await tools.tools.remove.run({ path: 'docs' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /文件夹/);
  assert.equal(fs.existsSync(path.join(WS, 'docs')), false);
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'docs'), { root: WS });
  assert.equal(res.ok, true, res.err);
  assert.equal(fs.readFileSync(path.join(WS, 'docs', 'deep', 'x.txt'), 'utf8'), 'xx\n');
});

await ta('#10b remove 目录：里面装着被保护的文件 → 拒绝整棵删', async () => {
  const cfg = path.join(WS, 'keep', 'config.json');
  fs.mkdirSync(path.join(WS, 'keep'), { recursive: true });
  fs.writeFileSync(cfg, '{}');
  const o = opts(); o.deny = [ cfg ];
  const r = await tools.tools.remove.run({ path: 'keep' }, o);
  assert.equal(r.ok, false, '应当拒绝');
  assert.match(r.err, /不该动/);
  assert.ok(fs.existsSync(cfg));
  fs.rmSync(path.join(WS, 'keep'), { recursive: true, force: true });
});

await ta('#11 remove 工作区外 → 拒绝', async () => {
  const r = await tools.tools.remove.run({ path: path.join(OUT, 'secret.txt') }, opts());
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(OUT, 'secret.txt')));
});

await ta('#12 恢复删除：原位置已有新文件 → 报冲突，不覆盖', async () => {
  const r = await tools.tools.remove.run({ path: 'b.txt' }, opts());
  assert.equal(r.ok, true, r.err);
  fs.writeFileSync(path.join(WS, 'b.txt'), '新写的\n', 'utf8');
  const res = snapshots.restore(WSID, r.edit.id, path.join(WS, 'b.txt'), { root: WS });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.equal(fs.readFileSync(path.join(WS, 'b.txt'), 'utf8'), '新写的\n');
});

await ta('#13 search 找文字（带行号）', async () => {
  const r = await tools.tools.search.run({ pattern: 'alpha' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /a\.txt:1: alpha/);
  assert.match(r.out, /note\.md:2:/);
});

await ta('#14 search 在工作区外 → 拒绝', async () => {
  const r = await tools.tools.search.run({ pattern: 'outside', path: OUT }, opts());
  assert.equal(r.ok, false);
});

await ta('#15 find 按名字找', async () => {
  const r = await tools.tools.find.run({ pattern: '*.md' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /\[F\] docs\/note\.md/);
});

await ta('#16 find 不列回收站与 node_modules', async () => {
  fs.mkdirSync(path.join(WS, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'node_modules', 'x', 'y.md'), 'no\n', 'utf8');
  const r = await tools.tools.find.run({ pattern: '*.md' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.ok(!/node_modules/.test(r.out), r.out);
});

await ta('#17 新工具都声明了对应 caps', async () => {
  assert.deepEqual(tools.tools.mkdir.caps, [ 'fs:write' ]);
  assert.deepEqual(tools.tools.move.caps, [ 'fs:write' ]);
  assert.deepEqual(tools.tools.copy.caps, [ 'fs:write' ]);
  assert.deepEqual(tools.tools.remove.caps, [ 'fs:write' ]);
  assert.deepEqual(tools.tools.search.caps, [ 'fs:read' ]);
  assert.deepEqual(tools.tools.find.caps, [ 'fs:read' ]);
});

await ta('#18 停掉会话后 requireCap 拒绝（网关层）', async () => {
  const st = grants.active(KEY);
  grants.stop(KEY, 'test');
  const chk = grants.requireCap(KEY, 'fs:write', st.epoch);
  assert.equal(chk.ok, false);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
