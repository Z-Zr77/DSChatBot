// 受控图片附件：[[附件: 路径]] 只发真图、只发工作区里的、会话停了不发、发失败明说不造假图
// 跑法：node pack/poc-attach-test.mjs（在仓库根）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-attach-'));
process.env.QQBOT_DATA = TMP;
process.env.QQBOT_API_FILE = path.join(TMP, 'api.json');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WS = path.join(TMP, 'workspace');
fs.mkdirSync(WS, { recursive: true });

// 真 PNG（1x1）、假 PNG（文本改了扩展名）、超大文件头
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(WS, 'shot.png'), PNG);
fs.writeFileSync(path.join(WS, 'not-image.png'), 'this is text, not an image');
fs.writeFileSync(path.join(WS, 'doc.txt'), 'hello');
fs.writeFileSync(path.join(WS, 'big.jpg'), Buffer.alloc(10 * 1024 * 1024 + 1024, 0xff));

const attach = await import(new URL('../src/attach.mjs', import.meta.url).href);
const grants = await import(new URL('../src/grants.mjs', import.meta.url).href);
const fsguard = await import(new URL('../src/fsguard.mjs', import.meta.url).href);

let pass = 0; let fail = 0;
function ta(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' → ' + (e && e.message)); }
}

ta('#1 按文件头认出真图（png/jpg/gif/webp/bmp）', () => {
  assert.equal(attach.sniff(PNG), 'png');
  assert.equal(attach.sniff(Buffer.from([ 0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0 ])), 'jpg');
  assert.equal(attach.sniff(Buffer.from('GIF89a______', 'latin1')), 'gif');
  const webp = Buffer.concat([ Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4) ]);
  assert.equal(attach.sniff(webp), 'webp');
  assert.equal(attach.sniff(Buffer.from([ 0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ])), 'bmp');
});

function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([ Buffer.from(type, 'latin1'), data ]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([ len, td, c ]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x60);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([ Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)) ]);
}
ta('#2 正常尺寸的 PNG 能暂存，落到受控目录、扩展名按内容给', () => {
  // 真 64×64 PNG（stage 现在会完整解码校验，改文件头糊不过去）
  fs.writeFileSync(path.join(WS, 'shot.png'), makePng(64, 64));
  const r = attach.stage(path.join(WS, 'shot.png'));
  assert.equal(r.ok, true, r.err);
  assert.equal(r.kind, 'png');
  assert.ok(fs.existsSync(r.file), '暂存文件应当存在');
  assert.ok(path.resolve(r.file).startsWith(path.resolve(attach.stageDir())), '暂存在受控目录');
  assert.match(r.sha, /^[0-9a-f]{12}$/);
});

ta('#2b 1×1 占位图（发出去一片空白）被拒，并说清原因', () => {
  fs.writeFileSync(path.join(WS, 'tiny.png'), PNG);
  const r = attach.stage(path.join(WS, 'tiny.png'));
  assert.equal(r.ok, false);
  assert.match(r.err, /占位图/);
  assert.match(r.err, /1×1/);
});

ta('#3 改了扩展名的文本：不当图片，按普通文件发（kind=file）', () => {
  const r = attach.stage(path.join(WS, 'not-image.png'));
  assert.equal(r.ok, true);
  assert.equal(r.isImage, false);
  assert.equal(r.kind, 'file');
  assert.ok(/^att-/.test(path.basename(r.file)));
});

ta('#4 超过 20MB 的文件被拒（图片另有 10MB 上限）', () => {
  const p = path.join(WS, 'huge.bin');
  fs.writeFileSync(p, Buffer.alloc(21 * 1024 * 1024, 1));
  const r = attach.stage(p);
  assert.equal(r.ok, false);
  assert.match(r.err, /文件太大了/);
  fs.rmSync(p, { force: true });
});

ta('#5 空文件 / 不存在 / 目录 都明确报错', () => {
  fs.writeFileSync(path.join(WS, 'empty.png'), '');
  const a = attach.stage(path.join(WS, 'empty.png'));
  const b = attach.stage(path.join(WS, 'nope.png'));
  const c = attach.stage(WS);
  assert.equal(a.ok, false); assert.match(a.err, /空的/);
  assert.equal(b.ok, false); assert.match(b.err, /不存在/);
  assert.equal(c.ok, false); assert.match(c.err, /不是一个文件/);
});

ta('#6 工作区外的路径在 fsguard 这一层就被拒（不发）', () => {
  const outside = path.join(TMP, 'secret.png');
  fs.writeFileSync(outside, PNG);
  const chk = fsguard.checkRead(outside, { base: WS, roots: [ WS ], denyAbs: [] });
  assert.equal(chk.ok, false);
  assert.match(chk.err, /不在允许范围/);
});

ta('#7 禁读清单里的图也发不了', () => {
  fs.mkdirSync(path.join(WS, 'private'), { recursive: true });
  const p = path.join(WS, 'private', 'id.png');
  fs.writeFileSync(p, PNG);
  const chk = fsguard.checkRead('private/id.png', { base: WS, roots: [ WS ], denyAbs: [ path.join(WS, 'private') ] });
  assert.equal(chk.ok, false);
});

ta('#8 工作区内的相对路径能解析到绝对路径', () => {
  const chk = fsguard.checkRead('shot.png', { base: WS, roots: [ WS ], denyAbs: [] });
  assert.equal(chk.ok, true, chk.err);
  assert.equal(path.resolve(chk.abs), path.resolve(path.join(WS, 'shot.png')));
});

ta('#9 会话停掉之后，授权层不再放行（授权只在进程内，且 stopped 即失效）', () => {
  const KEY = 'local:123456789';
  const st = grants.open({ convKey: KEY, root: WS, readRoots: [ WS ], caps: [ 'fs:read' ], timeoutMin: 30 });
  assert.equal(st.ok, true, st.err);
  assert.equal(grants.active(KEY) && grants.active(KEY).root, WS);
  grants.stop(KEY, 'test');
  assert.equal(grants.active(KEY), null);
});

ta('#10 bridge：从正文里剥出附件标记、最多两个、并按顺序发送、失败不造假图', () => {
  const b = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  assert.ok(b.includes('attachSpecs.push'), '没解析 [[附件]]');
  assert.ok(b.includes('attachSpecs: attachSpecs.slice(0, 2)'), '附件数量没设上限');
  assert.ok(b.includes("for (const a of (ex.attachSpecs || [])) await sendAttachment(conv, a, __pinned)"), '没派发附件（要带上本次任务固定的授权）');
  assert.ok(b.includes('async function sendAttachment(conv, spec, pinned = null)'), '缺 sendAttachment');
  assert.ok(b.includes('fsguard.checkRead(raw'), '附件路径没走工作区读校验');
  assert.ok(b.includes('attach.stage(chk.abs)'), '附件没走暂存');
  assert.ok(b.includes("'这张图我没发成：'"), '失败时要明确告诉他');
  assert.ok(b.includes('ATTACH_PROMPT'), '缺发图能力的提示词');
  // 附件分支里不能再出现"画一张"的兜底
  const fn = b.slice(b.indexOf('async function sendAttachment'), b.indexOf('async function sendFace'));
  assert.ok(!/sendDrawing|sendSelfie/.test(fn), '附件失败时绝不能改去画图');
});

ta('#11 提示词只在有工具权限时给，且写明"别假装发了"', () => {
  const b = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  const i = b.indexOf('const ATTACH_PROMPT');
  const seg = b.slice(i, i + 700);
  assert.match(seg, /\[\[附件: 相对路径\]\]/);
  assert.match(seg, /真图/);
  assert.match(seg, /别假装发了/);
  const p = b.indexOf('ATTACH_PROMPT ]');
  assert.ok(p > 0 && b.indexOf('[ workPrompt(conv), wp,') > 0, 'ATTACH_PROMPT 没进提示词');
});


ta('#13 普通文件（PDF/文本等）可以暂存，标记 isImage=false 且保留原名', () => {
  const p = path.join(WS, '报告.pdf');
  fs.writeFileSync(p, Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n', 'latin1'));
  const r = attach.stage(p);
  assert.equal(r.ok, true);
  assert.equal(r.isImage, false);
  assert.equal(r.origName, '报告.pdf');
  assert.ok(/^att-.*\.pdf$/i.test(path.basename(r.file)));
});

ta('#14 非图片走 file 段，图片走 image 段（bridge 源码断言）', () => {
  const src = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  assert.ok(/staged\.isImage[\s\S]{0,140}type: 'image'/.test(src), '图片要发 image 段');
  assert.ok(/type: 'file', data: \{ file: url, name:/.test(src), '其他文件要发 file 段');
  assert.ok(/t === 'file'/.test(src), '聊天记录要支持 file 类型');
});

ta('#15 聊天窗：按钮叫「附件」、任意文件可选、带上 x-kind / x-name', () => {
  const ui = fs.readFileSync(path.join(SRC, 'chatui.html'), 'utf8');
  assert.ok(ui.includes('📎 附件'), '按钮文案');
  assert.ok(!ui.includes('accept="image/*"'), '不能再限制成只选图片');
  assert.ok(ui.includes("'x-kind'"), '上传要带 x-kind');
  assert.ok(ui.includes("'x-name'"), '上传要带原文件名');
  assert.ok(ui.includes("m.type === 'file'"), '聊天窗要能显示文件消息');
  assert.ok(ui.includes('20 * 1024 * 1024'), '普通文件上限 20MB');
});

ta('#16 服务端：x-kind=file 时 /say 带 file+name，不走 describeBuffer', () => {
  const srv = fs.readFileSync(path.join(SRC, 'chatserver.mjs'), 'utf8');
  assert.ok(/x-kind/.test(srv), '要读 x-kind');
  assert.ok(/\{ text: cap, file: dest, name: rawName \}/.test(srv), '要转发 file 与 name');
  const bs = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  assert.ok(/b\.file/.test(bs) && /我发来一个文件/.test(bs), '/say 要有文件分支');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
