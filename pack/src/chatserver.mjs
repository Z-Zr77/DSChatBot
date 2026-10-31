// 合并版：聊天界面用的本地后台（给界面提供接口，并转发给桥接的本地通道）
// 只做三件事：转发消息、存取头像、把她的语音/图片递出去。v1，故意保持小。
import * as workdialog from './workdialog.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PATHS } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 只在 %APPDATA%\DSChat 放一个指针文件（where.json），其余全部落在数据目录里：
//   <dataDir>\chat\config.json   设置
//   <dataDir>\chat\avatars\     头像
//   <dataDir>\chat\media\tmp    聊天附件
// 这样换电脑 / 换盘只要拷 data 一个文件夹。
const POINTER_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSChatBot');
const POINTER_FILE = path.join(POINTER_DIR, 'where.json');

const DEFAULTS = {
  bridgePort: 3098,
  dataDir: '',
  appExe: '',
  fontSize: 16,
  botName: '',
  topmost: false,
  opacity: 0.95,
  autoLaunch: false,
};

function dataRoot() {
  try {
    const j = JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8'));
    if (j && typeof j.dataDir === 'string' && j.dataDir.trim()) return path.resolve(j.dataDir.trim());
  } catch {}
  // 合并版：和桥接/控制台用同一个数据目录，避免两份真相
  return path.resolve(PATHS.data);
}
// DEFAULTS_FIXED_APPEXE：appExe 留空时用同目录的 DSChatBot.exe
function defaultAppExe() {
  if (process.env.QQBOT_APP_EXE) return process.env.QQBOT_APP_EXE;
  const exe = process.platform === 'win32' ? 'DSChatBot.exe' : 'DSChatBot';
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return path.join(base, exe);
}
function cfgFile() { return path.join(dataRoot(), 'chat', 'config.json'); }
function avDir() { return path.join(dataRoot(), 'chat', 'avatars'); }

function loadCfg() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch {}
  const cfg = { ...DEFAULTS, ...j };
  cfg.dataDir = dataRoot();
  if (!cfg.appExe) cfg.appExe = defaultAppExe();          // 以指针为准，避免两份真相
  return cfg;
}
// 改数据目录时：先把老目录整个拷过去、验完再切指针。
// 以前只写 APPDATA 的 where.json，桥接还看 data-location.txt，重启后两边指向不同目录（复查 F19）。
function migrateData(from, to) {
  if (!from || !to) return { ok: true, moved: 0 };
  const a = path.resolve(from), b = path.resolve(to);
  if (a.toLowerCase() === b.toLowerCase()) return { ok: true, moved: 0 };
  if (!fs.existsSync(a)) return { ok: true, moved: 0 };
  // 目标已经有 agent-home：那是另一套数据，绝不覆盖
  if (fs.existsSync(path.join(b, 'agent-home'))) return { ok: true, moved: 0, existed: true };
  try {
    fs.mkdirSync(b, { recursive: true });
    fs.cpSync(a, b, { recursive: true, force: true, errorOnExist: false });
    const must = ['agent-home', 'chat'].filter((d) => fs.existsSync(path.join(a, d)));
    const missing = must.filter((d) => !fs.existsSync(path.join(b, d)));
    if (missing.length) return { ok: false, err: '迁移后缺少 ' + missing.join('/') };
    return { ok: true, moved: must.length };
  } catch (e) { return { ok: false, err: '迁移失败：' + e.message }; }
}

// 桥接认的是 data-location.txt / QQBOT_DATA，和这里的 where.json 是两个真相，必须同步写
function writeLocation(dir) {
  try {
    const loc = PATHS.LOC_FILE;
    fs.mkdirSync(path.dirname(loc), { recursive: true });
    fs.writeFileSync(loc, path.resolve(dir), 'utf8');
  } catch {}
}

function saveCfg(cfg) {
  let oldDir = '';
  try { oldDir = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).dataDir || ''; } catch {}
  const changed = !!(oldDir && path.resolve(oldDir).toLowerCase() !== path.resolve(cfg.dataDir).toLowerCase());
  if (changed) {
    const mv = migrateData(oldDir, cfg.dataDir);
    if (!mv.ok) return { ok: false, err: mv.err };      // 迁移没成功就别切指针，免得两边都不完整
  }
  const dir = path.join(cfg.dataDir, 'chat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  try {
    fs.mkdirSync(POINTER_DIR, { recursive: true });
    fs.writeFileSync(POINTER_FILE, JSON.stringify({ dataDir: cfg.dataDir }, null, 2));
    if (changed) writeLocation(cfg.dataDir);           // 桥接下次启动按这个目录走
    if (changed) {
      // 端口可能被顺延，别再写死 3070
      const uiPort = Number(process.env.QQBOT_UI_PORT) || 3070;
      try { fetch(`http://127.0.0.1:${uiPort}/api/restart`, { method: 'POST' }).catch(() => {}); } catch {}
    }
  } catch {}
  return { ok: true };
}

const ping = async (cfg, ms = 1200) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.bridgePort}/ping`, { signal: ctrl.signal });
    const j = await r.json();
    return !!(j && j.ok);
  } catch { return false; } finally { clearTimeout(t); }
};

async function up(cfg, p, init) {
  const r = await fetch(`http://127.0.0.1:${cfg.bridgePort}${p}`, init);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { ok: r.ok, raw: txt }; }
}

// 发消息专用：她生成回复可能要几十秒（画图/自拍），必须给足超时，且失败要说清楚
async function upStrict(cfg, p, init, ms = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.bridgePort}${p}`, Object.assign({}, init, { signal: ctrl.signal }));
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = { ok: r.ok, raw: txt }; }
    if (!r.ok) return { ok: false, error: (j && (j.err || j.error || j.raw)) || ('HTTP ' + r.status), ...(j && typeof j === 'object' ? { conflict: !!j.conflict, diskSha: j.diskSha, expectSha: j.expectSha } : {}) };
    return j && typeof j === 'object' ? j : { ok: true };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '她那边超时没回（可能在画图/自拍），等会儿再试' : ('连不上后端：' + (e && e.message));
    return { ok: false, error: msg };
  } finally { clearTimeout(t); }
}

// 真实路径必须落在数据目录内（防 ../ 与符号链接越界）
function insideData(cfg, f) {
  try {
    const root = fs.realpathSync(cfg.dataDir);
    const real = fs.realpathSync(f);
    return real === root || real.startsWith(root + path.sep);
  } catch { return false; }
}

function mediaFile(cfg, name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || raw.includes(String.fromCharCode(0))) return null;
  // 绝对路径：规范化 + 真实路径后判包含关系
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith("/")) {
    if (!insideData(cfg, raw)) return null;
    return fs.existsSync(raw) ? raw : null;
  }
  // 相对路径：不许出现 ..；候选必须在数据目录内且是普通文件
  if (raw.split('/').includes('..')) return null;
  const base = path.join(cfg.dataDir, 'chat', 'media');
  const cand = [path.join(base, path.basename(raw)), path.join(cfg.dataDir, raw)];
  for (const f of cand) {
    if (!insideData(cfg, f)) continue;
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

function avatarFile(who) {
  const dir = avDir();
  try {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(who + '.')) return path.join(dir, f);
  } catch {}
  return null;
}

function svgAvatar(who) {
  const emo = who === 'me' ? '🧑' : '🐟';
  const bg = who === 'me' ? '#2c5cff' : '#1b2030';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="${bg}"/><text x="48" y="65" font-size="44" text-anchor="middle">${emo}</text></svg>`;
}

const send = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};

const body = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length > 8 * 1024 * 1024) reject(new Error('too big')); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export function startServer(port = 3210) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
  // 写接口防跨站：带 Origin 时必须同源（否则别的网页能用你的浏览器改配置）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const o = req.headers.origin;
  const orgBad = o === 'null' || o === 'file://';
  if (orgBad) { res.writeHead(403, {'content-type':'application/json'}); return res.end(JSON.stringify({ ok:false, err:'cross-site blocked' })); }
    if (o) {
      try {
        if (new URL(o).host !== req.headers.host) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, err: 'cross-site blocked' }));
        }
      } catch {}
    }
  }
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      const cfg = loadCfg();
      try {
        if (p === '/' || p === '/index.html') {
          const rawHtml = fs.readFileSync(path.join(HERE, 'chatui.html'), 'utf8');
          const html = Buffer.from(rawHtml.replace('__WK_SCRIPT__', workdialog.bootstrap()), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(html);
        }

        // ---- 状态 ----
        if (p === '/api/state') {
          const on = await ping(cfg);
          return send(res, 200, { ok: true, bridge: on, cfg });
        }
        if (p === '/api/config') {
          if (req.method === 'POST') {
            const b = JSON.parse((await body(req)).toString('utf8') || '{}');
            const next = { ...cfg, ...b };
            const r = saveCfg(next);
            if (!r || r.ok === false) return send(res, 400, { ok: false, err: (r && r.err) || '保存失败' });
            return send(res, 200, { ok: true, cfg: next });
          }
          return send(res, 200, { ok: true, cfg });
        }

        // ---- 工作模式（聊天窗口顶部横幅也用这两个接口）----
        if (p === '/api/trace' && req.method === 'GET') {
    try {
      const r = await upStrict(cfg, '/trace' + (url.search || ''), { method: 'GET' });
      return send(res, 200, r);
    } catch (e) { return send(res, 502, JSON.stringify({ ok: false, err: String(e.message || e) })); }
  }
  if (p === '/api/work' && req.method === 'GET') {
          try { return send(res, 200, await up(cfg, '/work')); }
          catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
        }
        if (p === '/api/work/edits' && req.method === 'GET') {
          try {
            const q = url.searchParams.get('wsId') || '';
            return send(res, 200, await up(cfg, '/work/edits?wsId=' + encodeURIComponent(q)));
          } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
        }
        if (p === '/api/work/suggest' && req.method === 'GET') {
          try {
            const t = encodeURIComponent(url.searchParams.get('topic') || 'task');
            return send(res, 200, await up(cfg, '/work/suggest?topic=' + t));
          } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
        }
        if ((p === '/api/work/start' || p === '/api/work/stop' || p === '/api/work/touch' || p === '/api/work/mode' || p === '/api/work/restore' || p === '/api/work/undo') && req.method === 'POST') {
          try {
            const raw = (await body(req)).toString('utf8') || '{}';
            const r = await upStrict(cfg, p.slice(4), { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
            return send(res, 200, r);
          } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
        }

        // ---- 消息 ----
        if (p === '/api/msgs' || p === '/api/history') {
          const q = p === '/api/msgs'
            ? `/msgs?since=${encodeURIComponent(url.searchParams.get('since') || '0')}`
            : `/history?n=${encodeURIComponent(url.searchParams.get('n') || '60')}`;
          const r = await up(cfg, q);
          return send(res, 200, r);
        }
        if (p === '/api/send' && req.method === 'POST') {
          const b = JSON.parse((await body(req)).toString('utf8') || '{}');
          const payload = { text: String(b.text || '') };
          if (b.sticker) {
            const f2 = path.join(cfg.dataDir, 'stickers', path.basename(String(b.sticker)));
            if (!fs.existsSync(f2)) return send(res, 400, { ok: false, err: 'sticker not found' });
            payload.image = f2;
          }
          const r = await upStrict(cfg, '/say', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload),
          });
          return send(res, 200, r);
        }
        if (p === '/api/upload' && req.method === 'POST') {
          const buf = await body(req);
          if (!buf.length) return send(res, 400, { ok: false, err: '空文件' });
          const dir = path.join(cfg.dataDir, 'chat', 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          const kind = String(req.headers['x-kind'] || 'image').toLowerCase() === 'file' ? 'file' : 'image';
          const extHdr = String(req.headers['x-ext'] || '');
          const ext = /^\.[a-z0-9]{1,8}$/i.test(extHdr) ? extHdr.toLowerCase() : (kind === 'file' ? '.bin' : '.png');
          const name = `up-${Date.now()}${ext}`;
          const dest = path.join(dir, name);
          fs.writeFileSync(dest, buf);
          // x-caption 带不了中文（HTTP 头只能是 latin1），前端用 encodeURIComponent 传，这里解回来
          const rawCap = String(req.headers['x-caption'] || '');
          let cap = '';
          try { cap = rawCap ? decodeURIComponent(rawCap) : ''; } catch { cap = rawCap; }
          // 文件名同样只能 latin1，前端 encodeURIComponent
          const rawNameHdr = String(req.headers['x-name'] || '');
          let rawName = '';
          try { rawName = rawNameHdr ? decodeURIComponent(rawNameHdr) : ''; } catch { rawName = rawNameHdr; }
          const r = await upStrict(cfg, '/say', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(kind === 'file'
              ? { text: cap, file: dest, name: rawName }
              : { text: cap, image: dest }),
          });
          return send(res, 200, r);
        }

        // ---- 媒体 ----
        if (p === '/api/media') {
          const f = mediaFile(cfg, url.searchParams.get('f'));
          if (!f) return send(res, 404, { ok: false });
          const ext = path.extname(f).toLowerCase();
          const ct = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp'
            : ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : ext === '.silk' ? 'application/octet-stream' : 'image/jpeg';
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
          return res.end(fs.readFileSync(f));
        }

        // ---- 头像 ----
        if (p === '/api/search') {
          const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
          const lim = Math.min(200, Number(url.searchParams.get('n') || 50));
          if (!q) return send(res, 200, { ok: true, list: [] });
          const cdir = path.join(cfg.dataDir, 'chat');
          let lines = [];
          try {
            for (const nm of fs.readdirSync(cdir)) {
              if (!nm.endsWith('.jsonl')) continue;
              try { lines = lines.concat(fs.readFileSync(path.join(cdir, nm), 'utf8').split('\n').filter(Boolean)); } catch {}
            }
          } catch {}
          const hits = [];
          for (let i = lines.length - 1; i >= 0 && hits.length < lim; i--) {
            let m; try { m = JSON.parse(lines[i]); } catch { continue; }
            const t = String(m.text || '');
            if (t && t.toLowerCase().includes(q)) hits.push({ at: m.at, dir: m.dir, type: m.type, text: t });
          }
          return send(res, 200, { ok: true, list: hits });
        }

        if (p === '/api/stickers') {
          const dir = path.join(cfg.dataDir, 'stickers');
          let files = [];
          try { files = fs.readdirSync(dir).filter((x) => /\.(png|jpe?g|gif|webp)$/i.test(x)); } catch {}
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'stickers.json'), 'utf8')); } catch {}
          const list = files.map((x) => ({ file: x, name: (meta[x] && meta[x].name) || '', tags: (meta[x] && meta[x].tags) || '' }));
          return send(res, 200, { ok: true, list });
        }
        if (p.startsWith('/api/sticker/')) {
          const name = path.basename(decodeURIComponent(p.slice('/api/sticker/'.length)));
          const f2 = path.join(cfg.dataDir, 'stickers', name);
          if (!fs.existsSync(f2)) return send(res, 404, { ok: false });
          const ext = path.extname(f2).toLowerCase();
          const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
          return res.end(fs.readFileSync(f2));
        }

        if (p === '/api/avatar' || p.startsWith('/api/avatar/')) {
          const who = p === '/api/avatar' ? 'her' : (p.slice('/api/avatar/'.length).replace(/[^a-z]/g, '') || 'her');
          if (req.method === 'GET') {
            const f = avatarFile(who);
            if (f) {
              const ext = path.extname(f).toLowerCase();
              const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
              res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
              return res.end(fs.readFileSync(f));
            }
            res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
            return res.end(svgAvatar(who));
          }
          if (req.method === 'DELETE') {
            const f = avatarFile(who);
            if (f) { try { fs.unlinkSync(f); } catch {} }
            return send(res, 200, { ok: true });
          }
          if (req.method === 'POST') {
            const b = JSON.parse((await body(req)).toString('utf8') || '{}');
            const who2 = String(b.who || 'her').replace(/[^a-z]/g, '') || 'her';
            const mm = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([\s\S]+)$/i.exec(String(b.dataUrl || ''));
            if (!mm) return send(res, 400, { ok: false, err: '需要图片' });
            const buf = Buffer.from(mm[2], 'base64');
            if (buf.length > 3 * 1024 * 1024) return send(res, 400, { ok: false, err: '图太大（3MB 上限）' });
            fs.mkdirSync(avDir(), { recursive: true });
            for (const f of fs.readdirSync(avDir())) if (f.startsWith(who2 + '.')) fs.unlinkSync(path.join(avDir(), f));
            const ext = mm[1].toLowerCase() === 'jpeg' ? 'jpg' : mm[1].toLowerCase();
            fs.writeFileSync(path.join(avDir(), who2 + '.' + ext), buf);
            return send(res, 200, { ok: true });
          }
        }

        // ---- 把她叫起来（启动主程序） ----
        if (p === '/api/launch' && req.method === 'POST') {
          const exe = String(cfg.appExe || '');
          if (!exe || !fs.existsSync(exe)) return send(res, 400, { ok: false, err: '找不到主程序，去设置里填 DSChatBot.exe 的路径' });
          try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { return send(res, 500, { ok: false, err: e.message }); }
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 800));
            if (await ping(cfg)) return send(res, 200, { ok: true });
          }
          return send(res, 200, { ok: false, err: '启动后等不到桥接，可能她在启动中，稍等刷新' });
        }

        return send(res, 404, { ok: false });
      } catch (e) {
        return send(res, 500, { ok: false, err: e.message });
      }
    });

    const listen = (p0, retry = 0) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && retry < 8) return listen(p0 + 1, retry + 1);
        resolve({ port: 0, error: e.message });
      });
      server.listen(p0, '127.0.0.1', () => resolve({ port: p0, server }));
    };
    listen(port);
  });
}
