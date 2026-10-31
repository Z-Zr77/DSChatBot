// 受控图片附件：她把自己磁盘上的图发给他。
// 关键约束（评审定的）：路径要过工作区读校验 + 会话授权/epoch；真图才发（按文件头，不看扩展名）；
// 大小上限；复制到受控暂存目录再发（原文件之后被删也不影响这一条）；发失败要明说，绝不改画一张假图。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PATHS } from './paths.mjs';

export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_BYTES = 10 * 1024 * 1024;

const STAGE = path.join(PATHS.data, 'chat', 'tmp');

// 只认这几种真图（按 magic bytes）
export function sniff(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head6 = buf.slice(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return '';
}

export const EXT_OF = { png: 'png', jpg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp' };

// PNG 尺寸（IHDR 就在固定位置）：用来拦掉 1x1 这类看着是图、发出去一片空白的占位图
export function pngSize(buf) {
  try {
    if (buf.length < 24) return null;
    if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

export const MIN_SIDE = 16;   // 任何一边小于 16px 的直接当占位图/空图

// 真正解码一遍：光看文件头等于没校验（截断的 PNG、1x1 GIF 都能骗过 sniff）
// PNG：必须 IEND 收尾、IDAT 能 inflate、边长必须能对上；其余格式至少校验长度与尺寸头
export function probe(buf, kind) {
  if (!buf || !kind) return null;
  if (kind === 'png') {
    if (buf.length < 33) return null;
    if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    const interlace = buf[28];
    if (!w || !h) return null;
    if (!buf.slice(-8, -4).equals(Buffer.from('IEND'))) return null;
    // IDAT 拼起来 inflate，长度必须和扫描行对得上（截断/坏 CRC 会在这里露馅）
    const chunks = [];
    let p = 8;
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.slice(p + 4, p + 8).toString('latin1');
      if (p + 12 + len > buf.length) return null;
      if (type === 'IDAT') chunks.push(buf.slice(p + 8, p + 8 + len));
      p += 12 + len;
      if (type === 'IEND') break;
    }
    if (!chunks.length) return null;
    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(chunks)); } catch { return null; }
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 0;
    if (!ch) return null;
    const perRow = Math.ceil((w * ch * bitDepth) / 8) + 1;
    if (!interlace && raw.length < perRow * h) return null;
    return { w, h };
  }
  if (kind === 'gif') {
    if (buf.length < 14) return null;
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    if (!w || !h) return null;
    if (buf[buf.length - 1] !== 0x3b) return null;   // GIF 必须以 0x3B 结束
    return { w, h };
  }
  if (kind === 'bmp') {
    if (buf.length < 30) return null;
    const w = buf.readInt32LE(18);
    const h = Math.abs(buf.readInt32LE(22));
    if (!w || !h) return null;
    return { w, h };
  }
  if (kind === 'jpg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        if (!w || !h) return null;
        if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) return null;   // 必须有 EOI
        return { w, h };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (kind === 'webp') {
    if (buf.length < 30) return null;
    const fmt = buf.slice(12, 16).toString('latin1');
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { w, h };
    }
    return null;
  }
  return null;
}



function rand(n = 5) {
  const s = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += s[b[i] % s.length];
  return out;
}

// 检查 + 暂存。absPath 已经由调用方过完工作区读校验（fsguard.checkRead）。
export function stage(absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch { return { ok: false, err: '这个文件不存在' }; }
  if (!st.isFile()) return { ok: false, err: '这不是一个文件' };
  if (st.size <= 0) return { ok: false, err: '这个文件是空的' };
  if (st.size > FILE_MAX_BYTES) return { ok: false, err: `文件太大了（${(st.size / 1048576).toFixed(1)}MB，最多 20MB）` };
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return { ok: false, err: '读不了这个文件：' + (e.message || e) }; }
  // 图片要按内容认 + 完整解码（占位图/截断图不发）；其他文件只做大小与读取校验
  const kind = sniff(buf);
  let outKind = 'file';
  if (kind) {
    if (st.size > MAX_BYTES) return { ok: false, err: `图太大了（${(st.size / 1048576).toFixed(1)}MB，最多 10MB）` };
    const dim = probe(buf, kind);
    if (!dim) return { ok: false, err: '这张图解不开（可能是截断/损坏的文件，或者只是改了扩展名），换一张真图' };
    if (dim.w < MIN_SIDE || dim.h < MIN_SIDE) {
      return { ok: false, err: '这张图是空的/占位图（只有 ' + dim.w + '×' + dim.h + '），发出去会是一片白，换一张真的' };
    }
    outKind = kind;
  }
  const ext = kind ? EXT_OF[kind] : (path.extname(absPath).toLowerCase().replace(/^\./, '').slice(0, 8) || 'bin');
  try {
    fs.mkdirSync(STAGE, { recursive: true });
    const name = `att-${Date.now()}-${rand()}.${ext}`;
    const dest = path.join(STAGE, name);
    fs.writeFileSync(dest, buf);
    return {
      ok: true, file: dest, kind: outKind, isImage: !!kind, size: st.size,
      origName: path.basename(absPath),
      sha: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12),
    };
  } catch (e) {
    return { ok: false, err: '暂存失败：' + (e.message || e) };
  }
}

export function stageDir() { return STAGE; }
