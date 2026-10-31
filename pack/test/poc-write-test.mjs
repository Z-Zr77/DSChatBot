// 工作模式第二步：写工具 + 快照 + A/B/C 恢复
// 跑法：node pack/poc-write-test.mjs（在仓库根）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-write-'));
process.env.QQBOT_DATA = TMP;
process.env.QQBOT_API_FILE = path.join(TMP, 'api.json');

const WS = path.join(TMP, 'workspace');
const OUT = path.join(TMP, 'outside');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(WS, 'note.txt'), '第一行\n第二行\n第三行\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside\n', 'utf8');

const tools = await import(new URL('../src/tools.mjs', import.meta.url).href);
const grants = await import(new URL('../src/grants.mjs', import.meta.url).href);
const snapshots = await import(new URL('../src/snapshots.mjs', import.meta.url).href);

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); }
}

const KEY = 'local:123456789';
const open = grants.open({ convKey: KEY, root: WS, readRoots: [ WS ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
assert.ok(open.ok, 'open 失败：' + (open && open.err));
const WSID = open.state.id;

function opts(extra = {}) {
  return {
    roots: [ WS ], writeRoot: WS, wsId: WSID, base: WS,
    deny: [ path.join(TMP, 'config.json') ],
    ...extra,
  };
}

await ta('#1 write_file 在工作区新建文件', async () => {
  const r = await tools.tools.write_file.run({ path: 'new.txt', content: 'hello 工作区\n' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /已新建 new\.txt/);
  assert.equal(fs.readFileSync(path.join(WS, 'new.txt'), 'utf8'), 'hello 工作区\n');
  assert.ok(r.edit && r.edit.action === 'create');
});

await ta('#2 新建也留快照记录（before=null）', async () => {
  const list = snapshots.list(WSID, 50);
  const it = list.find((x) => x.rel === 'new.txt');
  assert.ok(it, '没有记录');
  assert.equal(it.before, null);
  assert.ok(it.after && it.after.sha);
});

await ta('#3 write_file 覆盖已有文件：旧内容进快照，回执带 diff', async () => {
  const r = await tools.tools.write_file.run({ path: 'note.txt', content: '第一行\n第二行改过\n第三行\n第四行加了一行\n' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /已覆盖 note\.txt/);
  assert.match(r.out, /改动/);
  const it = snapshots.list(WSID, 50).find((x) => x.rel === 'note.txt' && x.action === 'overwrite');
  assert.ok(it && it.before && it.before.sha);
});

await ta('#4 edit_file 唯一匹配替换成功', async () => {
  const r = await tools.tools.edit_file.run({ path: 'note.txt', old: '第三行', new: '第三行（改）' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /已替换 1 处/);
  assert.ok(fs.readFileSync(path.join(WS, 'note.txt'), 'utf8').includes('第三行（改）'));
});

await ta('#5 edit_file 找不到原文 → 拒绝（不许瞎猜）', async () => {
  const r = await tools.tools.edit_file.run({ path: 'note.txt', old: '这段根本不存在', new: 'x' }, opts());
  assert.equal(r.ok, false);
  assert.match(r.err, /找不到这段原文/);
});

await ta('#6 edit_file 多处匹配 → 拒绝，除非 all:true', async () => {
  fs.writeFileSync(path.join(WS, 'dup.txt'), 'a\nb\na\n', 'utf8');
  const r1 = await tools.tools.edit_file.run({ path: 'dup.txt', old: 'a', new: 'A' }, opts());
  assert.equal(r1.ok, false);
  assert.match(r1.err, /出现了 3 次|出现了 2 次/);
  const r2 = await tools.tools.edit_file.run({ path: 'dup.txt', old: 'a', new: 'A', all: true }, opts());
  assert.equal(r2.ok, true, r2.err);
});

await ta('#7 写工作区外 → 拒绝，且磁盘上没被创建', async () => {
  const r = await tools.tools.write_file.run({ path: path.join(OUT, 'hack.txt'), content: 'x' }, opts());
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(OUT, 'hack.txt')), false);
});

await ta('#8 .. 逃逸 → 拒绝', async () => {
  const r = await tools.tools.write_file.run({ path: '../outside/escape.txt', content: 'x' }, opts());
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(OUT, 'escape.txt')), false);
});

await ta('#9 禁写清单内的文件 → 拒绝', async () => {
  fs.writeFileSync(path.join(WS, 'deny.txt'), 'x', 'utf8');
  const o = opts({ deny: [ path.join(WS, 'deny.txt') ] });
  const r = await tools.tools.write_file.run({ path: 'deny.txt', content: 'y' }, o);
  assert.equal(r.ok, false);
  assert.match(r.err, /不允许/);
});

await ta('#10 符号链接指到工作区外 → 拒绝（不跟链接走）', async () => {
  const link = path.join(WS, 'link-out');
  let made = false;
  try { fs.symlinkSync(OUT, link, 'junction'); made = true; } catch {}
  if (!made) { console.log('  （这台机器建不了链接，跳过）'); return; }
  const r = await tools.tools.write_file.run({ path: 'link-out/hack2.txt', content: 'x' }, opts());
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(OUT, 'hack2.txt')), false);
});

await ta('#11 恢复：磁盘没被动过 → 回滚成功', async () => {
  fs.writeFileSync(path.join(WS, 'rollback.txt'), '原始版本\n', 'utf8');
  const w = await tools.tools.write_file.run({ path: 'rollback.txt', content: '改过的版本\n' }, opts());
  assert.equal(w.ok, true, w.err);
  const it = snapshots.list(WSID, 50).find((x) => x.rel === 'rollback.txt');
  const r = snapshots.restore(WSID, it.id, path.join(WS, 'rollback.txt'));
  assert.equal(r.ok, true, r.err);
  assert.equal(r.action, 'restored');
  assert.equal(fs.readFileSync(path.join(WS, 'rollback.txt'), 'utf8'), '原始版本\n');
});

await ta('#12 恢复：她自己又改过 → 报冲突，不覆盖', async () => {
  const r = await tools.tools.write_file.run({ path: 'conflict.txt', content: '版本B\n' }, opts());
  assert.equal(r.ok, true, r.err);
  const it = snapshots.list(WSID, 50).find((x) => x.rel === 'conflict.txt');
  // 用户手改
  fs.writeFileSync(path.join(WS, 'conflict.txt'), '我手动改的\n', 'utf8');
  const res = snapshots.restore(WSID, it.id, path.join(WS, 'conflict.txt'));
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.equal(fs.readFileSync(path.join(WS, 'conflict.txt'), 'utf8'), '我手动改的\n');
});

await ta('#13 恢复新建文件 = 删掉它', async () => {
  const it = snapshots.list(WSID, 50).find((x) => x.rel === 'new.txt');
  const r = snapshots.restore(WSID, it.id, path.join(WS, 'new.txt'));
  assert.equal(r.ok, true, r.err);
  assert.equal(r.action, 'removed');
  assert.equal(fs.existsSync(path.join(WS, 'new.txt')), false);
});

await ta('#14 写盘不留 .tmp 临时文件', async () => {
  const left = fs.readdirSync(WS).filter((f) => f.includes('.qqbot-w-'));
  assert.deepEqual(left, []);
});

await ta('#15 会话停掉之后不能再写（网关复核撤权）', async () => {
  const st = grants.active(KEY);
  const epoch = st ? st.epoch : 0;
  grants.stop(KEY, 'test');
  const chk = grants.requireCap(KEY, 'fs:write', epoch);
  assert.equal(chk.ok, false, '停掉后 requireCap 必须拒绝');
  const bridge = fs.readFileSync('pack/src/bridge.mjs', 'utf8');
  assert.ok(bridge.includes('toolCapsOk(conv, tc.name, __scope)'), 'bridge 每次工具调用前要复核能力');
  assert.ok(bridge.includes('writeRoot: __scope.writeRoot') || bridge.includes('writeRoot:'), 'bridge 要把写根传给工具');
});

await ta('#16 没有工作区（日常聊天）时写 → 拒绝', async () => {
  const r = await tools.tools.write_file.run({ path: 'x.txt', content: 'x' }, { roots: [ WS ], base: WS, deny: [] });
  assert.equal(r.ok, false);
  assert.match(r.err, /没有工作区/);
});

t('#17 write_file / edit_file 都声明了 fs:write', () => {
  assert.deepEqual(tools.tools.write_file.caps, [ 'fs:write' ]);
  assert.deepEqual(tools.tools.edit_file.caps, [ 'fs:write' ]);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
