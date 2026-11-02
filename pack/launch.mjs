// 启动器：首次运行走向导 → 写配置 → 起 UI + 桥接。
// 开发模式（系统 node）：node launch.mjs
// 打包后（Electron）：由 electron/main.cjs 在主进程内 import 并调用 startAll()
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PATHS, DATA, APP, LOC_FILE, ensureDirs, loadSetup, saveSetup, isConfigured } from './src/paths.mjs';
import { testKey } from './src/brain.mjs';
import { ensurePersonaFile, setPersonaRelationship, cleanRelationship } from './src/persona-default.mjs';

const IS_ELECTRON = !!process.versions.electron;
const WIZARD_PORT = Number(process.env.QQBOT_WIZARD_PORT || 3071);
const UI_PORT = Number(process.env.QQBOT_UI_PORT || 3070);
const log = (...a) => console.log('[launch]', ...a);

// 手机访问：配置里开了 ui.lan 就监听 0.0.0.0，并保证有密码（没有就随机生成一个存进配置）
async function uiEnv() {
  try {
    const sm = await import(pathToFileURL(path.join(APP, 'src', 'settings.mjs')).href);
    const cfg = sm.load();
    const lan = !!(cfg.ui && cfg.ui.lan);
    if (!lan) return {};
    let pass = String((cfg.ui && cfg.ui.pass) || '');
    if (!pass) {
      pass = String(Math.floor(100000 + Math.random() * 900000));
      sm.patch({ ui: { pass } });
      log('已生成手机访问密码：', pass);
    }
    log('手机访问已开启（监听 0.0.0.0，需要密码）');
    return { QQBOT_UI_HOST: '0.0.0.0', QQBOT_UI_PASS: pass };
  } catch (e) {
    log('读取 ui 配置失败，按本机模式启动：', String(e && e.message));
    return {};
  }
}

// Electron 的 Node 20 没有全局 WebSocket，桥接（ws 客户端）会直接报 "WebSocket is not defined"。
// 用 ws 包里现成的实现补上全局，桥接代码不用改。
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const wsMod = await import('ws');
    globalThis.WebSocket = wsMod.WebSocket || wsMod.default;
    log('已注入 WebSocket（ws 包）');
  } catch (e) {
    log('注入 WebSocket 失败：', String(e && e.message || e));
  }
}

ensureDirs();

// ---------- 首次运行：准备默认人格与颜文字表 ----------
function seedDefaults(s) {
  ensurePersonaFile(PATHS.persona, s.qq || {});
  if (!fs.existsSync(PATHS.emoticons)) {
    const src = path.join(APP, 'src', 'emoticons.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, PATHS.emoticons);
  }
  if (!fs.existsSync(PATHS.stickersMeta)) fs.writeFileSync(PATHS.stickersMeta, '[]', 'utf8');
  if (!fs.existsSync(PATHS.interests)) fs.writeFileSync(PATHS.interests, JSON.stringify({ topics: [], updated: null }, null, 2), 'utf8');
}

// ---------- 环境探测 ----------
function portOpen(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

function regQQ() {
  return new Promise((resolve) => {
    const keys = [
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    ];
    const tryNext = (i) => {
      if (i >= keys.length) return resolve(null);
      execFile('reg', ['query', keys[i], '/v', 'UninstallString'], { windowsHide: true, timeout: 4000 }, (_e, stdout) => {
        const m = String(stdout || '').match(/REG_SZ\s+(.+?)\s*$/m);
        if (m) {
          const p = m[1].replace(/"/g, '').trim();
          const dir = path.dirname(p);
          if (fs.existsSync(dir)) return resolve({ dir, uninstall: p });
        }
        tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

// NapCat shell 目录：配置里记的 → 环境变量 → 常见盘符
function findNapCat() {
  const cands = [];
  const cfg = loadSetup().napcat?.dir;
  if (cfg) cands.push(cfg);
  if (process.env.QQBOT_NAPCAT_DIR) cands.push(process.env.QQBOT_NAPCAT_DIR);
  for (const d of ['D', 'E', 'C', 'F']) {
    cands.push(`${d}:\\NapCat\\shell`, `${d}:\\napcat\\shell`, `${d}:\\NapCatQQ\\shell`, `${d}:\\Program Files\\NapCat\\shell`);
  }
  const seen = new Set();
  for (const c of cands) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const launcher = path.join(c, 'launcher.bat');
    if (fs.existsSync(launcher)) return { dir: c, launcher, qr: path.join(c, 'cache', 'qrcode.png') };
  }
  // 只找到目录但没有 launcher.bat 也算“装了一半”
  for (const c of cands) {
    if (c && fs.existsSync(c)) return { dir: c, launcher: null, qr: path.join(c, 'cache', 'qrcode.png') };
  }
  return null;
}

async function onebotInfo(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/get_login_info`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    const j = await r.json();
    if (j?.retcode === 0 && j.data?.user_id) return { online: true, uin: String(j.data.user_id), nickname: j.data.nickname || '' };
    return { online: false };
  } catch { return { online: false }; }
}

async function scanEnv() {
  const s = loadSetup();
  const qq = await regQQ();
  const napcat = findNapCat();
  const [p3000, p3001] = await Promise.all([portOpen(s.onebot?.httpPort || 3000), portOpen(s.onebot?.wsPort || 3001)]);
  const onebot = p3000 ? await onebotInfo(s.onebot?.httpPort || 3000) : { online: false };
  const env = {
    node: process.versions.node,
    data: DATA,
    dataWritable: canWrite(DATA),
    qq, napcat, onebot,
    ports: { http: { port: s.onebot?.httpPort || 3000, open: p3000 }, ws: { port: s.onebot?.wsPort || 3001, open: p3001 } },
    configured: isConfigured(),
  };
  env.blockers = blockersOf(env, s);
  return env;
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.wtest');
    fs.writeFileSync(f, 'x');
    fs.unlinkSync(f);
    return true;
  } catch { return false; }
}

// 启动前必须先解决的问题（不解决不让继续，避免进到空控制台）
function blockersOf(env, s) {
  const out = [];
  if (!env.qq) out.push({ key: 'qq', label: '没装 QQ 客户端', fix: 'link', url: 'https://im.qq.com/pcqq/', hint: '装完点「重新检测」' });
  if (!env.napcat || !env.napcat.launcher) {
    out.push({ key: 'napcat', label: env.napcat ? 'NapCat 目录不完整（缺 launcher.bat）' : '没装 NapCat', fix: 'install-napcat', hint: '点下面按钮自动下载安装' });
  }
  if (!env.onebot || !env.onebot.online) out.push({ key: 'login', label: '小号还没登录 OneBot', fix: 'scan', hint: '用 NapCat 的 launcher.bat 启动并用小号扫码' });
  if (!s.api?.key) out.push({ key: 'key', label: '还没填大模型 API Key', fix: 'field', hint: '第 1 张卡片里填' });
  if (!s.api?.model) out.push({ key: 'model', label: '还没选模型', fix: 'field', hint: '第 1 张卡片里选' });
  if (!env.dataWritable) out.push({ key: 'data', label: '数据目录不可写：' + env.data, fix: 'datadir', hint: '把程序放到 D 盘或桌面再试' });
  return out;
}

// ---------- 一键装 NapCat ----------
const NAPCAT_DIR = path.join(process.env.LOCALAPPDATA || DATA, 'QQChatBot', 'napcat');

function findLauncher(dir) {
  let hit = null;
  const walk = (d, depth) => {
    if (hit || depth > 3) return;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isFile() && n.name.toLowerCase() === 'launcher.bat') { hit = p; return; }
    }
    for (const n of names) if (n.isDirectory()) walk(path.join(d, n.name), depth + 1);
  };
  walk(dir, 0);
  return hit;
}

function curlDownload(url, dest, timeoutSec) {
  return new Promise((resolve) => {
    try { fs.rmSync(dest, { force: true }); } catch {}
    const c = spawn('curl.exe', ['-L', '--fail', '--max-time', String(timeoutSec), '-o', dest, url,
      '-s', '-w', '%{http_code} %{size_download}'], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('error', () => resolve({ ok: false, err: '系统没有 curl' }));
    c.on('close', () => {
      const parts = out.trim().split(' ');
      const http = parts[0] || '0';
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      resolve({ ok: http === '200' && size > 200 * 1024, http, size, err: http === '200' ? '' : 'HTTP ' + http });
    });
  });
}

async function installNapCat() {
  fs.mkdirSync(NAPCAT_DIR, { recursive: true });
  const zip = path.join(NAPCAT_DIR, 'NapCat.Shell.zip');

  let tag = 'v4.18.41';
  try {
    const r = await fetch('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest', {
      headers: { 'User-Agent': 'QQChatBot' }, signal: AbortSignal.timeout(8000),
    });
    if (r.ok) { const j = await r.json(); if (j.tag_name) tag = j.tag_name; }
  } catch { log('查询最新版本失败，用内置版本', tag); }

  // 用系统 curl 下载：Node 的 fetch 在这类代理上会卡住读体，curl 快且能看进度
  const urls = [
    `https://github.com/NapNeko/NapCatQQ/releases/download/${tag}/NapCat.Shell.zip`,
    `https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/download/${tag}/NapCat.Shell.zip`,
    `https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/${tag}/NapCat.Shell.zip`,
  ];
  let err = '';
  for (const u of urls) {
    log('下载 NapCat:', u);
    const r = await curlDownload(u, zip, 240);
    if (r.ok) { err = ''; break; }
    err = r.err || ('HTTP ' + r.http);
    log('这个源不行：', err);
  }
  if (err) {
    return {
      ok: false,
      err: '下载失败：' + err + '。可以手动下载后用「NapCat shell 目录」指向它：' +
        `https://github.com/NapNeko/NapCatQQ/releases/download/${tag}/NapCat.Shell.zip`,
    };
  }
  const head = fs.readFileSync(zip).subarray(0, 2).toString('latin1');
  if (head !== 'PK') return { ok: false, err: '下载到的不是 zip（可能被拦截），文件：' + zip };


  const out = path.join(NAPCAT_DIR, 'shell');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const tarOk = await new Promise((resolve) => {
    const c = spawn('tar', ['-xf', zip, '-C', out], { windowsHide: true });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
  if (!tarOk) return { ok: false, err: '解压失败（系统缺少 tar？请手动解压 ' + zip + '）' };

  const launcher = findLauncher(out);
  if (!launcher) return { ok: false, err: '解压后没找到 launcher.bat，请手动检查 ' + out };

  const dir = path.dirname(launcher);
  const s = saveSetup({ napcat: { dir } });
  log('NapCat 装好了：', dir);
  return { ok: true, dir, version: tag, setup: s };
}


async function listModels(baseUrl, key) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, err: '先填接口地址' };
  try {
    const r = await fetch(base + '/models', {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, err: `HTTP ${r.status}` };
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter(Boolean).sort();
    return { ok: true, models: ids };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
}

// ---------- 向导 HTTP 服务 ----------
let wizardSrv = null; // 向导服务器（托盘里“设置向导”会在运行中再次拉起）
function startWizard() {
  if (wizardSrv) return Promise.resolve({ skip: false, already: true });
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      const body = async () => { let b = ''; for await (const c of req) b += c; try { return JSON.parse(b || '{}'); } catch { return {}; } };
      try {
        if (u.pathname === '/' || u.pathname === '/wizard') {
          const html = fs.readFileSync(path.join(APP, 'src', 'wizard.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
        }
        if (u.pathname === '/api/state') return json(200, { setup: loadSetup(), probe: await scanEnv(), dataDir: DATA, locFile: LOC_FILE });
        // 让用户挑数据目录：系统原生“选择文件夹”对话框（node / Electron 两种模式都能用）
        if (u.pathname === '/api/pickdir' && req.method === 'POST') return json(200, { dir: await pickFolder() });
        // 只记下来，等 finish 时再真的迁移（这样这次保存仍然写在旧目录）
        if (u.pathname === '/api/datadir' && req.method === 'POST') {
          const j = await body();
          const d = String(j && j.dir || '').trim();
          if (d && !path.isAbsolute(d)) return json(400, { ok: false, err: '必须是绝对路径，例如 D:\\qqbot-data' });
          pendingDir = d;
          return json(200, { ok: true, dir: d });
        }
        // 向导页用来“跳到控制台”：控制台端口由 startAll 写进 data\ui-port.txt
        if (u.pathname === '/api/console') {
          let port = 0;
          try { port = Number(fs.readFileSync(path.join(DATA, 'ui-port.txt'), 'utf8').trim()) || 0; } catch {}
          return json(200, { port });
        }
        if (u.pathname === '/api/scan') return json(200, await scanEnv());
        if (u.pathname === '/api/models' && req.method === 'POST') {
          const j = await body();
          return json(200, await listModels(j.baseUrl, j.key));
        }
        if (u.pathname === '/api/test' && req.method === 'POST') {
          const j = await body();
          return json(200, await testKey({ baseUrl: j.baseUrl, key: j.key, model: j.model }));
        }
        // 直接把 NapCat 缓存的二维码图片吐给页面
        if (u.pathname === '/qr.png') {
          const nc = findNapCat();
          const f = nc?.qr || (loadSetup().napcat?.dir ? path.join(loadSetup().napcat.dir, 'cache', 'qrcode.png') : '');
          if (f && fs.existsSync(f)) {
            const buf = fs.readFileSync(f);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
            return res.end(buf);
          }
          res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end('no qr');
        }
        if (u.pathname === '/api/install-napcat' && req.method === 'POST') {
          const r = await installNapCat();
          return json(r.ok ? 200 : 500, r);
        }
        if (u.pathname === '/api/open-data' && req.method === 'POST') {
          try { spawn('explorer.exe', [DATA], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {}
          return json(200, { ok: true, data: DATA });
        }
        if (u.pathname === '/api/save' && req.method === 'POST') {
          const j = await body();
          // 向导只负责 NapCat/QQ；API key、人格、主人号都搬到控制台里配，这里不强制校验
          const prev = loadSetup();
          const merged = {
            ...prev,
            ...j,
            api: (j.api && j.api.key) ? j.api : prev.api,
            qq: { ...prev.qq, ...(j.qq || {}) },
            napcat: { ...prev.napcat, ...(j.napcat || {}) },
          };
          if (j.qq?.relationship !== undefined) {
            const relationship = cleanRelationship(j.qq.relationship);
            const result = setPersonaRelationship(PATHS.persona, relationship, merged.qq);
            if (!result.ok) return json(400, result);
            merged.qq.relationship = relationship;
          }
          const s = saveSetup(merged);
          seedDefaults(s);
          return json(200, { ok: true, setup: s });
        }
        if (u.pathname === '/api/finish' && req.method === 'POST') {
          const j = await body();
          const skip = !!(j && j.skip);
          if (skip) log('用户选择稍后再说：进控制台，后台服务照常启动');
          moveDataDir();
          json(200, { ok: true, skip, dataDir: DATA });
          // 先让 startAll 继续跑，向导端口再留 6 秒：页面靠 /api/console 拿到控制台端口后自动跳过去
          setTimeout(() => { try { server.close(); wizardSrv = null; } catch {} }, 6000);
          resolve({ skip });
          return;
        }
        json(404, { ok: false, err: 'not found' });
      } catch (e) { json(500, { ok: false, err: String(e.message || e) }); }
    });
    wizardSrv = server;
    server.on('error', (e) => {
      // 端口已被占（比如向导已经开过一次）：当成“已经在跑”，直接返回
      log('向导端口占用：', String(e && e.message || e));
      wizardSrv = null;
      resolve({ skip: false, already: true });
    });
    server.listen(WIZARD_PORT, '127.0.0.1', () => {
      log('向导已启动：http://127.0.0.1:' + WIZARD_PORT);
      if (!IS_ELECTRON) {
        spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${WIZARD_PORT}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      }
    });
  });
}

// ---------- 起服务 ----------
// 3070 被占（比如开发版同时在跑）就顺延找一个空闲端口，并把实际端口写给窗口进程
function freePort(start) {
  if (start === WIZARD_PORT) start += 1; // 向导端口不参与挑选，避免自己撞自己
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.once('listening', () => s.close(() => resolve(start)));
    s.listen(start, '127.0.0.1');
  });
}

// 用户在向导里选的数据目录：只在 finish 时迁移一次（本次运行仍用旧目录，下次启动读 data-location.txt）
let pendingDir = '';
function moveDataDir() {
  if (!pendingDir) return;
  const target = path.resolve(pendingDir);
  pendingDir = '';
  if (target === path.resolve(DATA)) return;
  try {
    fs.mkdirSync(target, { recursive: true });
    const t = path.join(target, '.wtest');
    fs.writeFileSync(t, 'ok'); fs.unlinkSync(t);
  } catch (e) {
    log('数据目录不可写，保持原样：', target, String(e && e.message || e));
    return;
  }
  try {
    fs.cpSync(DATA, target, { recursive: true, force: true, errorOnExist: false });
    fs.writeFileSync(LOC_FILE, target, 'utf8');
    log('数据目录已改为', target, '（下次启动生效，本次仍用旧目录）');
  } catch (e) { log('数据目录迁移失败：', String(e && e.message || e)); }
}

// 系统原生“选择文件夹”对话框：PowerShell + FolderBrowserDialog，node / Electron 都能用
function pickFolder() {
  return new Promise((resolve) => {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$f.Description = "Select data folder"',
      '$f.ShowNewFolderButton = $true',
      'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true, timeout: 180000, maxBuffer: 1 << 20 },
      (e, out) => {
        const d = String(out || '').trim().split(/\r?\n/).pop() || '';
        resolve(d);
      });
  });
}

const children = [];
async function startService(file, extraEnv = {}) {
  const env = { ...process.env, QQBOT_DATA: DATA, QQBOT_IS_PACKAGED: IS_ELECTRON ? '1' : '0', ...extraEnv };
  if (IS_ELECTRON && !process.env.ELECTRON_RUN_AS_NODE) {
    // 打包后 app 在 asar 里，子进程跑不了 asar 内的文件 → 主进程内直接 import
    Object.assign(process.env, env);
    await import(pathToFileURL(path.join(APP, 'src', file)).href);
    return null;
  }
  const c = spawn(process.execPath, [path.join(APP, 'src', file)], { env, cwd: APP, stdio: 'inherit', windowsHide: false });
  c.on('exit', (code) => log(file, 'exited', code));
  children.push(c);
  return c;
}

export { scanEnv, blockersOf, installNapCat, canWrite, findLauncher, findNapCat, startWizard };export async function startAll() {
  let s = loadSetup();
  let skipped = false;
  // 首次运行不再卡在向导上：先把控制台/桥接/聊天窗起起来，引导放到控制台里做
  if (!isConfigured()) {
    log('首次运行：还没填模型密钥或 QQ 小号，先起界面，去控制台「设置」里填');
    if (process.env.QQBOT_WIZARD_ONLY === '1') { await startWizard(); return; }
  }
  seedDefaults(s);
  const uiPort = await freePort(Number(s.ui?.port || UI_PORT));
  try { fs.writeFileSync(path.join(DATA, 'ui-port.txt'), String(uiPort), 'utf8'); } catch {}
  log('控制台端口', uiPort);
  const brainReady = !!(s.api && s.api.key);
  const qqReady = !!(s.qq && s.qq.uin);
  log('大脑密钥', brainReady ? '已配置' : '还没填', '· QQ 小号', qqReady ? s.qq.uin : '还没填');
  await startService('ui.mjs', { QQBOT_UI_PORT: String(uiPort), ...(await uiEnv()) });
  await new Promise((r) => setTimeout(r, 800));
  // 桥接与聊天窗不再等 QQ 配好：只填了模型密钥也能进来本地聊、开工作模式
  await startService('bridge.mjs');
  // 聊天界面服务（合并版：和上面两个服务在同一个进程里）
  try {
    const cm = await import(pathToFileURL(path.join(APP, 'src', 'chatserver.mjs')).href);
    const want = Number(process.env.QQBOT_CHAT_PORT || 0) || 3210;
    const r = await cm.startServer(want);
    if (r && r.port) {
      try { fs.writeFileSync(path.join(DATA, 'chat-port.txt'), String(r.port), 'utf8'); } catch {}
      log('聊天服务端口', r.port);
    } else {
      log('聊天服务启动失败', (r && r.error) || 'unknown');
    }
  } catch (e) { log('聊天服务异常', String(e && e.message || e)); }

  // 内核守护：掉线时自动重启 NapCat（只走计划任务，不弹窗）——QQ 没配就不起
  if (!qqReady) { log('QQ 还没配置，跳过内核守护'); }
  else try {
    const g = await import(pathToFileURL(path.join(APP, 'src', 'napcat-guard.mjs')).href);
    if (g && g.startGuard) g.startGuard();
  } catch (e) { log('守护启动失败', String(e && e.message || e)); }
}

process.on('SIGINT', () => { for (const c of children) try { c.kill(); } catch {} process.exit(0); });
const IS_DIRECT = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_DIRECT) startAll().catch((e) => { console.error(e); process.exit(1); });
