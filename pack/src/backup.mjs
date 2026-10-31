// 备份：把她"学到的、改过的、记得的"定时复制一份出来。
// 只做复制 + 清单 + 保留份数，不做增量/压缩（数据量小，简单可靠优先）。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import * as settings from './settings.mjs';

const DATA = () => paths.PATHS.data;

// 每次备份都跳过的路径（相对 data），大件或可重建的
export const NORMAL_EXCLUDES = [
  'chat\\tmp',
  'chat/tmp',
  'work\\trash',
  'work/.trash',
  'drawn',
  'bridge.log',
  'napcat-guard.log',
  'napcat-console.log',
];
export const FULL_EXCLUDES = [ 'chat\\tmp', 'chat/tmp', 'work\\trash', 'work/.trash', 'bridge.log', 'napcat-guard.log', 'napcat-console.log' ];

function cfg() {
  let c = {};
  try { c = settings.load().backup || {}; } catch {}
  return {
    enabled: c.enabled !== false,
    dir: String(c.dir || ''),
    keep: Math.max(1, Math.min(50, Number(c.keep) || 7)),
    mode: c.mode === 'full' ? 'full' : 'normal',
    dailyHour: Math.max(0, Math.min(23, Number(c.dailyHour) || 4)),
  };
}

export function dirOf() {
  const c = cfg();
  if (process.env.QQBOT_BACKUP_DIR) return path.resolve(process.env.QQBOT_BACKUP_DIR);
  if (c.dir) return path.resolve(c.dir);
  // 默认放用户主目录下：不能放安装目录里——升级安装会把 INSTDIR 下的非程序文件清掉（2026-10-31 实测丢过两份备份）
  const home = process.env.USERPROFILE || process.env.HOME || path.dirname(DATA());
  return path.join(home, 'DSChatBot-backups');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  // 带毫秒：同一秒里连点两次「立刻备份」不会撞成同一个目录
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function isExcluded(rel, list) {
  const norm = rel.split(path.sep).join('/');
  return list.some((x) => {
    const e = x.split(path.sep).join('/');
    return norm === e || norm.startsWith(e.replace(/\/$/, '') + '/');
  });
}

function copyTree(srcRoot, dstRoot, list) {
  const stat = { files: 0, bytes: 0, skipped: [] };
  const walk = (rel) => {
    const from = path.join(srcRoot, rel);
    let ents = [];
    try { ents = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (isExcluded(r, list)) { stat.skipped.push(r.split(path.sep).join('/')); continue; }
      const abs = path.join(srcRoot, r);
      const to = path.join(dstRoot, r);
      if (ent.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(r); continue; }
      if (!ent.isFile()) { stat.skipped.push(r.split(path.sep).join('/')); continue; }
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
        stat.files++;
        stat.bytes += fs.statSync(to).size;
      } catch { stat.skipped.push(r.split(path.sep).join('/')); }
    }
  };
  walk('');
  return stat;
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += fs.statSync(f).size; } catch {} }
    }
  };
  walk(p);
  return total;
}

export function list() {
  const dir = dirOf();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^bk-\d{8}-\d{6}-\d{3}$/.test(n)); } catch { return []; }
  return names.sort().map((n) => {
    const full = path.join(dir, n);
    let man = null;
    try { man = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')); } catch {}
    return { name: n, dir: full, at: man ? man.at : fs.statSync(full).mtimeMs, mode: man ? man.mode : '?', files: man ? man.files : 0, bytes: man ? man.bytes : dirSize(full) };
  });
}

export function status() {
  const c = cfg();
  const all = list();
  const last = all[all.length - 1] || null;
  return {
    enabled: c.enabled,
    dir: dirOf(),
    keep: c.keep,
    mode: c.mode,
    count: all.length,
    bytes: all.reduce((s, x) => s + x.bytes, 0),
    lastAt: last ? last.at : 0,
    last: last ? { name: last.name, files: last.files, bytes: last.bytes, mode: last.mode } : null,
    recent: all.slice(-5).reverse(),
  };
}

export function prune(keep = null) {
  const c = cfg();
  const k = Math.max(1, Number(keep) || c.keep);
  const all = list();
  const drop = all.slice(0, Math.max(0, all.length - k));
  let removed = 0;
  for (const d of drop) {
    try { fs.rmSync(d.dir, { recursive: true, force: true }); removed++; } catch {}
  }
  return { removed, kept: all.length - removed, keep: k };
}

// reason: 'manual' | 'auto' | 'before-upgrade'
export function run(opts = {}) {
  const c = cfg();
  if (!c.enabled && opts.reason !== 'manual') return { ok: false, err: '备份已关闭（设置里 backup.enabled=false）' };
  const mode = opts.mode === 'full' || opts.mode === 'normal' ? opts.mode : c.mode;
  const data = DATA();
  if (!fs.existsSync(data)) return { ok: false, err: '数据目录不存在：' + data };
  // 自动备份必须等数据目录定位好（打包版启动早期可能还没解析到 C:DSChatBotdata），否则会备出 6 个文件的空包
  if (opts.reason !== 'manual' && !fs.existsSync(path.join(data, 'agent-home', 'memory'))) {
    return { ok: false, err: '数据目录还没就绪，这次自动备份跳过' };
  }
  const dir = dirOf();
  const name = 'bk-' + stamp(new Date(opts.now || Date.now()));
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(target, { recursive: true });
    const excludes = mode === 'full' ? FULL_EXCLUDES : NORMAL_EXCLUDES;
    const st = copyTree(data, target, excludes);
    const man = {
      at: Date.now(),
      name,
      mode,
      reason: String(opts.reason || 'manual'),
      appVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(paths.PATHS.app || '', 'package.json'), 'utf8')).version; } catch { return ''; } })(),
      dataDir: data,
      files: st.files,
      bytes: st.bytes,
      excludes,
      skipped: st.skipped.slice(0, 200),
    };
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(man, null, 2), 'utf8');
    const pr = prune(c.keep);
    return { ok: true, name, dir: target, files: st.files, bytes: st.bytes, mode, skipped: st.skipped.length, pruned: pr.removed, keep: pr.keep };
  } catch (e) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    return { ok: false, err: '备份失败：' + String((e && e.message) || e) };
  }
}

// 距上次备份超过 hours 小时才自动跑
export function due(hours = 20, now = Date.now()) {
  const s = status();
  if (!s.enabled) return false;
  if (!s.lastAt) return true;
  return now - s.lastAt >= Math.max(1, hours) * 3600e3;
}
