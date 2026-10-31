// 整会话一次撤销 + search 的 GBK 回退
// 跑法：node pack/poc-undo-test.mjs（在仓库根）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-undo-'));
process.env.QQBOT_DATA = TMP;
process.env.QQBOT_API_FILE = path.join(TMP, 'api.json');

const WS = path.join(TMP, 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'a.txt'), '原始 A\n', 'utf8');
fs.writeFileSync(path.join(WS, 'b.txt'), '原始 B\n', 'utf8');

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
const opts = () => ({ roots: [ WS ], writeRoot: WS, wsId: WSID, base: WS, deny: [] });

await ta('#1 连续改动后整体撤销：文件内容全部回到最初', async () => {
  await tools.tools.write_file.run({ path: 'a.txt', content: '改过的 A\n' }, opts());
  await tools.tools.edit_file.run({ path: 'a.txt', old: '改过的', new: '又改过' }, opts());
  await tools.tools.write_file.run({ path: 'new.txt', content: '新建的\n' }, opts());
  await tools.tools.remove.run({ path: 'b.txt' }, opts());
  const r = snapshots.undoAll(WSID, WS);
  assert.equal(r.ok, true, 'undoAll 应全部成功：' + JSON.stringify(r.done.filter((x) => !x.ok)));
  assert.equal(fs.readFileSync(path.join(WS, 'a.txt'), 'utf8'), '原始 A\n');
  assert.equal(fs.existsSync(path.join(WS, 'new.txt')), false, '新建的文件应被撤销删掉');
  assert.equal(fs.readFileSync(path.join(WS, 'b.txt'), 'utf8'), '原始 B\n', '删除的应被捞回');
});

await ta('#2 已经撤销过的记录不会重复撤销', async () => {
  const r = snapshots.undoAll(WSID, WS);
  assert.equal(r.done.length, 0, '第二次应该没有可撤销的条目：' + JSON.stringify(r.done));
});

await ta('#3 用户中途手改过 → 撤到那条停下并报冲突，不覆盖', async () => {
  await tools.tools.write_file.run({ path: 'c.txt', content: '第一版\n' }, opts());
  await tools.tools.write_file.run({ path: 'c.txt', content: '第二版\n' }, opts());
  fs.writeFileSync(path.join(WS, 'c.txt'), '我手改的\n', 'utf8');
  const r = snapshots.undoAll(WSID, WS);
  assert.equal(r.ok, false, '应当停下');
  assert.equal(r.stoppedAt, 'c.txt');
  assert.equal(fs.readFileSync(path.join(WS, 'c.txt'), 'utf8'), '我手改的\n', '不能覆盖用户改动');
  const last = r.done[r.done.length - 1];
  assert.equal(last.conflict, true);
});

await ta('#4 search 能搜到 GBK 编码的中文文件', async () => {
  // "中文标题" 的 GBK 字节
  const gbk = Buffer.from([ 0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2 ]);
  fs.writeFileSync(path.join(WS, 'gbk.txt'), gbk);
  const r = await tools.tools.search.run({ pattern: '中文标题' }, opts());
  assert.equal(r.ok, true, r.err);
  assert.match(r.out, /gbk\.txt:1:/, 'GBK 文件应当被搜到，实际：' + r.out);
});

await ta('#5 search 仍是只读工具、工作区外仍被拒', async () => {
  assert.deepEqual(tools.tools.search.caps, [ 'fs:read' ]);
  const outside = path.join(TMP, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const r = await tools.tools.search.run({ pattern: 'x', path: outside }, opts());
  assert.equal(r.ok, false);
});

await ta('#6 bridge 暴露 /work/undo 且控制台代理了它', async () => {
  const b = fs.readFileSync('pack/src/bridge.mjs', 'utf8');
  assert.ok(b.includes("p === '/work/undo'"), '缺 /work/undo 路由');
  assert.ok(b.includes('snapshots.undoAll'), '缺 undoAll 调用');
  const u = fs.readFileSync('pack/src/ui.mjs', 'utf8');
  assert.ok(u.includes('/api/work/undo'), '控制台没代理 /api/work/undo');
  assert.ok(u.includes('workUndoAll'), '缺"撤销这次全部改动"按钮');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
