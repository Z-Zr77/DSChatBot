// 场景相册：她记住"某个地方长什么样"，下次直接发旧图，不重画
// 数据：data/scenes/index.json + data/scenes/<id>.jpg
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
import * as settings from './settings.mjs';

const DIR = path.join(PATHS.data, 'scenes');
const META = path.join(DIR, 'index.json');

function ensure() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(META, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function writeAll(list) {
  ensure();
  try { fs.writeFileSync(META, JSON.stringify(list, null, 2), 'utf8'); } catch {}
}

export function list() {
  return readAll().filter((x) => x && x.id && x.file);
}

// 名字模糊匹配：完全相等 > 互相包含 > 都有 2 个相同二字词
export function find(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const all = list();
  const exact = all.find((x) => x.name === n);
  if (exact) return exact;
  const part = all.find((x) => x.name.includes(n) || n.includes(x.name));
  if (part) return part;
  const grams = (s) => {
    const out = new Set();
    const t = String(s).replace(/[\s，。、的了在是我你他她]/g, '');
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const g = grams(n);
  let best = null; let bestScore = 0;
  for (const x of all) {
    const h = grams(x.name);
    let hit = 0;
    for (const w of g) if (h.has(w)) hit++;
    if (hit > bestScore) { bestScore = hit; best = x; }
  }
  return bestScore >= 2 ? best : null;
}

function nextId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function save({ name, buf, desc = '', ext = 'jpg' }) {
  ensure();
  const n = String(name || '').trim();
  if (!n) throw new Error('场景要有名字');
  const all = readAll();
  const old = find(n);
  const id = old ? old.id : nextId();
  const file = path.join(DIR, id + '.' + ext);
  fs.writeFileSync(file, buf);
  // 覆盖时把旧文件删掉（换名字/换扩展名的情况）
  if (old && old.file && path.resolve(old.file) !== path.resolve(file)) {
    try { fs.unlinkSync(old.file); } catch {}
  }
  const now = new Date().toISOString();
  const item = {
    id,
    name: n,
    desc: String(desc || '').slice(0, 400),
    file,
    createdAt: old ? old.createdAt || now : now,
    updatedAt: now,
    hits: old ? Number(old.hits || 0) + 1 : 0,
  };
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = item; else all.push(item);
  writeAll(all.slice(-200));
  return item;
}

export function touch(id) {
  const all = readAll();
  const it = all.find((x) => x.id === id);
  if (!it) return null;
  it.hits = Number(it.hits || 0) + 1;
  writeAll(all);
  return it;
}

export function remove(id) {
  const all = readAll();
  const it = all.find((x) => x.id === id);
  if (!it) return false;
  try { fs.unlinkSync(it.file); } catch {}
  writeAll(all.filter((x) => x.id !== id));
  return true;
}

export function fileOf(id) {
  const it = list().find((x) => x.id === id);
  return it ? it.file : '';
}

// 给模型看的一行清单：名字 + 最近一次更新时间（天）
export function brief(max = 12) {
  const all = list().slice(-max);
  if (!all.length) return '（还没有）';
  const day = (t) => {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
    return diff <= 0 ? '今天更新' : diff + ' 天前更新';
  };
  return all.map((x) => `${x.name}（${day(x.updatedAt)}）`).join('、');
}

const STYLES = {
  anime: '二次元动漫插画风格，线条干净、上色柔和。',
  semi: '日系轻小说插图风格，半写实，光影细腻但仍是插画。',
  real: '写实摄影风格，真实镜头质感与自然光，接近手机拍的照片。',
};

export function styleText(style) {
  return STYLES[style] || STYLES.anime;
}

// 她随手画一张给人看的东西（店面、街、物件、风景）：不要她本人，也不要人像特写；
// 远处路人和店主背影可以留，否则街景像空城。
export function plainScenePrompt(desc, style = 'anime') {
  const d = String(desc || '').trim().replace(/[。；;\s]+$/, '');
  const st = (() => {
    try {
      const p = settings.load();
      const custom = String((p.prompts || {}).style || '').trim();
      if (p.drawStyle === 'custom' && custom) return custom;
      return styleText(p.drawStyle || style);
    } catch { return styleText(style); }
  })();
  const tail = (() => {
    try { return String((settings.load().prompts || {}).scene || '').trim(); } catch { return ''; }
  })() || '环境细节要有生活痕迹（招牌、灯光、桌椅、杂物），构图自然，像随手拍的。';
  return [
    st,
    `画面内容：${d}。`,
    '只画这个场景本身：不要出现主要人物、不要人像特写、不要正面大脸；远处路人或店主背影可以有，但只能是模糊的背景。',
    tail,
    '禁止：人像特写、正面大脸、文字水印、边框、多格拼图、画中画、手机与屏幕。',
  ].filter(Boolean).join('');
}

// 场景照的提示词：不要人、不要文字，只要环境（文案可在控制台改）
export function scenePrompt(name, desc, style = 'anime') {
  const d = String(desc || '').trim();
  const st = (() => {
    try {
      const p = settings.load();
      const custom = String((p.prompts || {}).style || '').trim();
      if (p.drawStyle === 'custom' && custom) return custom;
      return styleText(p.drawStyle || style);
    } catch { return styleText(style); }
  })();
  const extra = (() => {
    try { const p = settings.load().prompts || {}; return { scene: p.scene, ban: p.sceneBan }; } catch { return {}; }
  })();
  const tail = String(extra.scene || '环境细节要有生活痕迹（家具、杂物、光源），构图自然，像随手拍的。');
  const ban = String(extra.ban || '禁止：人物、人脸、文字、水印、边框、多格拼图、画中画、手机与屏幕。');
  return [
    st,
    `画面内容：${String(name).replace(/[「」"]/g, '')}的实景。`,
    d ? d.replace(/[。；;\s]+$/, '') + '。' : '',
    tail,
    ban,
  ].filter(Boolean).join('');
}

// 正在生成时的占位（避免重复生成同一个场景）
export const pending = new Set();
