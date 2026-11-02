// 边界复审（F01–F12）反例套件：把审查里的 19 个探针固化成"必须被拒绝/保持正确"的断言
// 跑法：node pack/test/poc-boundary-test.mjs（或 npm test）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-bnd-'));
process.env.QQBOT_DATA = TMP;
process.env.QQBOT_API_FILE = path.join(TMP, 'api.json');

const WS = path.join(TMP, 'ws');
const OUT = path.join(TMP, 'out');
fs.mkdirSync(path.join(WS, 'sub'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const DENY = path.join(WS, 'private', 'config.json');
fs.mkdirSync(path.dirname(DENY), { recursive: true });
fs.writeFileSync(DENY, 'SECRET_TOKEN=abc123\n', 'utf8');
fs.writeFileSync(path.join(WS, 'note.txt'), 'hello\n', 'utf8');
fs.writeFileSync(path.join(WS, 'sub', 'ok.txt'), 'ok line\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside-data\n', 'utf8');

const tools = await import(new URL('../src/tools.mjs', import.meta.url).href);
const grants = await import(new URL('../src/grants.mjs', import.meta.url).href);
const snapshots = await import(new URL('../src/snapshots.mjs', import.meta.url).href);
const fsguard = await import(new URL('../src/fsguard.mjs', import.meta.url).href);
const attach = await import(new URL('../src/attach.mjs', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); } };

const KEY = 'local:1';
const open = grants.open({ convKey: KEY, root: WS, readRoots: [ WS ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
assert.ok(open.ok, 'open 失败');
const WSID = open.state.id;
const ro = () => ({ roots: [ WS ], deny: [ DENY ], base: WS });
const rw = () => ({ roots: [ WS ], deny: [ DENY ], base: WS, writeRoot: WS, wsId: WSID });

// 真 PNG（能被我自己的 probe 解开）：用 zlib 造一张 32×32
function makePng(w, h) {
  const crcTable = (() => {
    const t2 = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t2[n] = c >>> 0; }
    return t2;
  })();
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([ Buffer.from(type, 'latin1'), data ]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([ len, td, c ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 180; raw[o + 2] = 160; } }
  return Buffer.concat([
    Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// —— F01 禁读一致性 ——
await ta('F01 search 不返回禁读文件内容', async () => {
  const r = await tools.tools.search.run({ pattern: 'SECRET_TOKEN', path: '.' }, ro());
  assert.ok(r.ok, 'search 本身要能跑');
  assert.ok(!/SECRET_TOKEN=abc123/.test(r.out || ''), '禁读文件内容被 search 返回了：' + r.out);
});
t('F01 find 不列出禁读文件', () => {
  const r = tools.tools.find.run({ pattern: 'config.json', path: '.' }, ro());
  assert.ok(!/private/.test(r.out || ''), '禁读路径出现在 find 结果里：' + r.out);
});
await ta('F01 list_dir 隐藏禁读项', async () => {
  const r = await tools.tools.list_dir.run({ path: '.' }, ro());
  assert.ok(r.ok);
  assert.ok(!/private/.test(r.out || ''), '禁读目录出现在 list_dir 里：' + r.out);
  assert.ok(/note\.txt/.test(r.out || ''), '正常文件不该被藏起来');
});

// —— F02 恢复边界 ——
await ta('F02 路径被换成指向外部的硬链接时，恢复被拒且外部文件不变', async () => {
  const abs = path.join(WS, 'link.txt');
  fs.writeFileSync(abs, 'v1\n', 'utf8');
  const b1 = await tools.tools.edit_file.run({ path: 'link.txt', old: 'v1', new: 'v2' }, rw());
  assert.ok(b1.ok, 'edit 应该成功：' + b1.err);
  const id = b1.edit.id;
  // 用硬链接把工作区里的这个路径换成"外部同内容文件"
  const outFile = path.join(OUT, 'outside1.txt');
  fs.writeFileSync(outFile, 'v2\n', 'utf8');
  fs.rmSync(abs);
  try { fs.linkSync(outFile, abs); } catch { /* 卷不同就退化成 junction 用例 */ }
  const guest = (p2) => fsguard.checkWrite(p2, { base: WS, root: WS, denyAbs: [ DENY ], allowCreate: true });
  const r = snapshots.restore(WSID, id, abs, { root: WS, guard: guest });
  assert.ok(!r.ok, '这种路径必须恢复失败：' + JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(outFile, 'utf8'), 'v2\n', '工作区外的文件被改了');
});

await ta('F02 父目录被换成 junction 时，恢复被拒', async () => {
  const dir = path.join(WS, 'edir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A1\n', 'utf8');
  const b1 = await tools.tools.edit_file.run({ path: 'edir/a.txt', old: 'A1', new: 'A2' }, rw());
  assert.ok(b1.ok, b1.err);
  // 把 edir 换成指向外部的 junction
  fs.rmSync(dir, { recursive: true, force: true });
  const realOut = path.join(OUT, 'junction-target');
  fs.mkdirSync(realOut, { recursive: true });
  fs.writeFileSync(path.join(realOut, 'a.txt'), 'A2\n', 'utf8');
  let made = false;
  try { execFileSync('cmd', [ '/c', 'mklink', '/j', dir, realOut ], { stdio: 'ignore' }); made = true; } catch {}
  if (!made) { console.log('SKIP F02 junction（没有权限建联接）'); return; }
  const guest = (p2) => fsguard.checkWrite(p2, { base: WS, root: WS, denyAbs: [ DENY ], allowCreate: true });
  const r = snapshots.restore(WSID, b1.edit.id, path.join(dir, 'a.txt'), { root: WS, guard: guest });
  assert.ok(!r.ok, 'junction 路径必须拒绝恢复：' + JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(realOut, 'a.txt'), 'utf8'), 'A2\n', '外部文件被改写');
  try { fs.rmSync(dir, { recursive: false, force: true }); } catch {}
});

// —— F03 回收站目标 ——
await ta('F03 .trash 是 junction 时 remove 拒绝', async () => {
  const file = path.join(WS, 'del.txt');
  fs.writeFileSync(file, 'bye\n', 'utf8');
  const trash = path.join(WS, '.trash');
  const outside = path.join(OUT, 'trash-out');
  fs.mkdirSync(outside, { recursive: true });
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch {}
  let made = false;
  try { execFileSync('cmd', [ '/c', 'mklink', '/j', trash, outside ], { stdio: 'ignore' }); made = true; } catch {}
  if (!made) { console.log('SKIP F03 junction'); return; }
  const r = await tools.tools.remove.run({ path: 'del.txt' }, rw());
  assert.ok(!r.ok, '回收站是联接时必须拒绝：' + JSON.stringify(r));
  assert.ok(fs.existsSync(file), '原文件不该消失');
  try { fs.rmSync(trash, { recursive: false, force: true }); } catch {}
});

// —— F04 目录移动 / 复制 ——
await ta('F04 含禁读子文件的目录不能整体移动', async () => {
  const r = await tools.tools.move.run({ from: 'private', to: 'moved-private' }, rw());
  assert.ok(!r.ok, '含禁读后代的目录不该允许整体搬走：' + JSON.stringify(r));
});

// —— F05 授权固定 ——
await ta('F05 授权在第一次 await 之前固定（源码断言）', async () => {
  const src = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('async function replyNowInner');
  assert.ok(start > 0, '找不到 replyNowInner');
  // 2026-11-01：replyNowInner 前面又插了「说忘就忘」那一段，窗口放大到 24000 字符；
  // 这里只认「授权钉在第一次大脑调用之前」这个顺序，不认具体行号。
  const body = src.slice(start, start + 24000);
  const iPin = body.indexOf('const __taskPinned');
  // 2026-10-31：askBrain 多了第三个参数（真多轮 history），这里用正则认新签名，
  // 但"第一次大脑调用"这个锚点不能放宽——授权必须钉在它前面。
  const mAwait = body.match(/let r = await askBrain\(content, sid[,)]/);
  const iAwait = mAwait ? mAwait.index : -1;
  assert.ok(iPin > 0 && iAwait > 0, '找不到关键行');
  assert.ok(iPin < iAwait, '__taskPinned 必须在第一次 askBrain 之前');
  assert.ok(!/const __pinned = \(\(\) => \{\s*try \{ const ws = grants\.active/.test(src), '旧写法应已删除');
});
t('F05 旧授权在停止后失效', () => {
  const KEY2 = 'local:2';
  const w2 = path.join(TMP, 'ws2');
  fs.mkdirSync(w2, { recursive: true });
  const o2 = grants.open({ convKey: KEY2, root: w2, readRoots: [ w2 ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
  const pin = { id: o2.state.id, epoch: o2.state.epoch };
  grants.stop(KEY2, 'test');
  const r = grants.requireCap(KEY2, 'fs:write', pin.epoch);
  assert.ok(!r.ok, '停止后旧 epoch 还能用');
});

// —— F06 附件范围 ——
t('F06 附件只认本次工作区根（不接受额外 readRoots）', () => {
  const src = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(/roots: \[ sc\.ws\.root \]/.test(src), '附件应只用工作区根');
});

// —— F07 编码 ——
t('F07 edit_file 拒绝 GBK 文件（不乱写）', () => {
  const gbk = path.join(WS, 'gbk.txt');
  fs.writeFileSync(gbk, Buffer.concat([ Buffer.from([ 0xd6, 0xd0, 0xce, 0xc4 ]), Buffer.from('value=1\n', 'latin1') ]));
  const before = fs.readFileSync(gbk);
  const r = tools.tools.edit_file.run({ path: 'gbk.txt', old: 'value=1', new: 'value=2' }, rw());
  assert.ok(!r.ok, 'GBK 文件应拒绝编辑：' + JSON.stringify(r));
  assert.ok(before.equals(fs.readFileSync(gbk)), '文件被写坏了');
});
await ta('F07 write_file 不覆盖非 UTF-8 文件', async () => {
  const gbk = path.join(WS, 'gbk2.txt');
  fs.writeFileSync(gbk, Buffer.from([ 0xd6, 0xd0, 0xce, 0xc4, 0x0a ]));
  const before = fs.readFileSync(gbk);
  const r = await tools.tools.write_file.run({ path: 'gbk2.txt', content: 'new\n' }, rw());
  assert.ok(!r.ok, '非 UTF-8 文件应拒绝整份覆盖');
  assert.ok(before.equals(fs.readFileSync(gbk)));
});

// —— F08 快照先落盘 ——
await ta('F08 索引写不进去时，文件不被改（先记 pending 再动手）', async () => {
  const idxDir = path.join(TMP, 'ledger', 'snapshots', WSID);
  fs.mkdirSync(idxDir, { recursive: true });
  const idx = path.join(idxDir, 'index.json');
  const bak = fs.existsSync(idx) ? fs.readFileSync(idx) : null;
  // 让 saveIndex 的 rename 失败：把 index.json 变成目录
  try { fs.rmSync(idx, { force: true }); } catch {}
  fs.mkdirSync(idx);
  const target = path.join(WS, 'safe.txt');
  fs.writeFileSync(target, 'orig\n', 'utf8');
  const r = await tools.tools.write_file.run({ path: 'safe.txt', content: 'changed\n' }, rw());
  assert.ok(!r.ok, '索引写不进去时应该失败：' + JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'orig\n', '文件不该被改');
  fs.rmSync(idx, { recursive: true, force: true });
  if (bak) fs.writeFileSync(idx, bak);
});

// —— F10 撤销总量 ——
await ta('F10 撤销超过上限时如实报剩余', async () => {
  const KEY3 = 'local:3';
  const w3 = path.join(TMP, 'ws3');
  fs.mkdirSync(w3, { recursive: true });
  const o3 = grants.open({ convKey: KEY3, root: w3, readRoots: [ w3 ], caps: [ 'fs:read', 'fs:write' ], timeoutMin: 30 });
  const sid = o3.state.id;
  const o3opts = { roots: [ w3 ], deny: [], base: w3, writeRoot: w3, wsId: sid };
  for (let i = 0; i < 4; i++) {
    const rr = await tools.tools.write_file.run({ path: 'f' + i + '.txt', content: 'x' + i }, o3opts);
    assert.ok(rr.ok, rr.err);
  }
  const u = snapshots.undoAll(sid, w3, 2);
  assert.ok(u.done.length <= 2, '不该超过 limit');
  assert.ok(typeof u.remaining === 'number' && u.remaining >= 1, '必须如实报剩余：' + JSON.stringify(u));
  assert.strictEqual(u.ok, false, '还有剩就不该说全部撤销完成');
});

// —— F11 工作区提示 ——
t('F11 workPrompt 用 active/alive 判定（源码断言）', () => {
  const src = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(!sc \|\| !sc\.active \|\| !sc\.ws\) return '';/.test(src), '应先判 sc.active');
  assert.ok(/sc\.ws\.alive === false/.test(src), '应判 alive');
});

// —— F12 附件解码 ——
t('F12 截断 PNG 被拒', () => {
  const good = makePng(32, 32);
  const cut = good.slice(0, 40);
  const f = path.join(WS, 'cut.png');
  fs.writeFileSync(f, cut);
  const r = attach.stage(f);
  assert.ok(!r.ok, '截断 PNG 应被拒：' + JSON.stringify(r));
});
t('F12 1×1 GIF 被拒', () => {
  const gif = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');
  const f = path.join(WS, 'tiny.gif');
  fs.writeFileSync(f, gif);
  const r = attach.stage(f);
  assert.ok(!r.ok, '1×1 GIF 应被拒：' + JSON.stringify(r));
});
t('F12 真 32×32 PNG 能过', () => {
  const f = path.join(WS, 'real.png');
  const buf = makePng(32, 32);
  fs.writeFileSync(f, buf);
  const r = attach.stage(f);
  assert.ok(r.ok, '正常图片不该被拒：' + (r.err || ''));
});

// —— 测试基础设施 / 口令 ——
t('run-tests 的锁用时间戳而不是 PID', () => {
  const src = fs.readFileSync(new URL('../run-tests.mjs', import.meta.url), 'utf8');
  assert.ok(!/Date\.now\(\) - old/.test(src), '锁还拿 PID 当时间戳');
});

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
