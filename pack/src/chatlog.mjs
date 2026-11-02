// 程序内聊天记录（App 通道）
// 与 QQ 通道共用同一份记忆与人格，但聊天记录单独一份，方便界面渲染与翻页。
// 数据：<data>\chat\<uin>.jsonl，每行一条：
//   { at, dir: 'in'|'out', type: 'text'|'image'|'voice'|'face'|'sticker'|'file', text?, file?, dur?, src: 'qq'|'app' }
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

const DIR = path.join(PATHS.data, 'chat');
const MEDIA = path.join(DIR, 'media');

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(MEDIA, { recursive: true });
}

function file(uin) {
  ensure();
  return path.join(DIR, `${uin}.jsonl`);
}

export function mediaDir() {
  ensure();
  return MEDIA;
}

// 把外部文件拷进 media 目录，返回可给前端用的相对名
export function stash(filePath, uin) {
  ensure();
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath) || '.bin';
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dst = path.join(MEDIA, name);
  try {
    fs.copyFileSync(filePath, dst);
    return name;
  } catch {
    return null;
  }
}

export function append(uin, msg) {
  if (!uin) return null;
  try {
    const row = {
      at: Date.now(),
      dir: msg.dir === 'out' ? 'out' : 'in',
      type: msg.type || 'text',
      src: msg.src || 'app',
      ...msg,
    };
    fs.appendFileSync(file(uin), JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch {
    return null;
  }
}

export function recent(uin, n = 200) {
  try {
    const f = file(uin);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function since(uin, atMs = 0) {
  return recent(uin, 500).filter((m) => m.at > Number(atMs || 0));
}

export function clear(uin) {
  try {
    fs.writeFileSync(file(uin), '', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export default { append, recent, since, clear, stash, mediaDir };
