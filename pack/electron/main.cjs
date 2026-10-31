// Electron 主进程：窗口 + 托盘 + 拉起 launch.mjs（用它自己的 node 运行时）。
// 首次运行显示向导，配置完成后自动切到控制台。
const { app, BrowserWindow, shell, Menu, Tray, nativeImage, dialog, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const LOG = path.join(process.env.LOCALAPPDATA || APP_DIR, 'DSChatBot-main.log');
function logLine(...a) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\r\n'); } catch {} }
process.on('uncaughtException', (e) => logLine('uncaught', e && e.stack || String(e)));
process.on('unhandledRejection', (e) => logLine('unhandled', e && e.stack || String(e)));

const WIZARD = 'http://127.0.0.1:3071/';
const CONSOLE = 'http://127.0.0.1:3070/';

// 虚拟机/老显卡上 Chromium 的 GPU 合成经常直接黑屏（点一下输入框就白→黑），关掉硬件加速最稳。
// 想强制开启可以设 QQCHATBOT_GPU=1
if (process.env.QQCHATBOT_GPU !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
}

// 只允许一个实例，重复启动只是把已有窗口叫出来
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let win = null;
let tray = null;
let quitting = false;
let child = null;

function trayIconPath() {
  const p = path.join(APP_DIR, 'assets', 'tray.ico');
  return fs.existsSync(p) ? p : iconPath();
}

function iconPath() {
  const p = path.join(APP_DIR, 'assets', 'bot.ico');
  return fs.existsSync(p) ? p : null;
}

// 打包后 app 在 asar 内，子进程无法执行 asar 里的脚本 → 后端在主进程内直接跑
function startBackend() {
  process.env.QQBOT_ROOT = APP_DIR;
  process.env.QQBOT_IS_PACKAGED = '1';
  // 数据目录交给 src/paths.mjs 自己算（便携版=exe 旁、安装版=安装目录、没写权限时退到 %LOCALAPPDATA%）
  const url = require('node:url').pathToFileURL(path.join(APP_DIR, 'launch.mjs')).href;
  logLine('backend start; dataDir=' + dataDir());
  return import(url)
    .then((m) => m.startAll())
    .then(() => logLine('backend started'))
    .catch((e) => logLine('backend failed', (e && e.stack) || String(e)));
}

// 程序所在的“家目录”：便携版是 exe 所在目录，安装版是安装目录
function homeDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return app.isPackaged ? path.dirname(process.execPath) : APP_DIR;
}
// 与 src/paths.mjs 保持一致的规则：data-location.txt 指哪算哪，否则家目录下的 data
function dataDir() {
  const home = homeDir();
  try {
    const loc = fs.readFileSync(path.join(home, 'data-location.txt'), 'utf8').trim();
    if (loc) return loc;
  } catch {}
  // legacyDataCompat：老版本数据在 E:\QQChatBot\data，改名后继续沿用，避免丢记忆/密钥
  try {
    const legacy = 'E:\\QQChatBot\\data';
    if (fs.existsSync(path.join(legacy, 'config.json'))) return legacy;
  } catch {}
  const primary = path.join(home, 'data');
  if (fs.existsSync(primary)) return primary;
  // 安装到无写权限目录时后端会退到 %LOCALAPPDATA%
  const fallback = path.join(process.env.LOCALAPPDATA || home, 'DSChatBot', 'data');
  if (fs.existsSync(fallback)) return fallback;
  return primary;
}
function chatUrl() {
  try {
    const p = fs.readFileSync(path.join(dataDir(), 'chat-port.txt'), 'utf8').trim();
    if (p) return 'http://127.0.0.1:' + p + '/';
  } catch {}
  return 'http://127.0.0.1:3210/';
}

let cwin = null;
function openConsole() {
  if (cwin && !cwin.isDestroyed()) { cwin.show(); cwin.focus(); return; }
  cwin = new BrowserWindow({
    width: 1240, height: 880, minWidth: 900, minHeight: 600,
    title: 'DSChatBot 控制台', backgroundColor: '#0e1116', show: false,
    icon: iconPath() || undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  cwin.once('ready-to-show', () => cwin.show());
  cwin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  cwin.loadURL(consoleUrl()).catch(() => {});
}

function consoleUrl() {
  try {
    const p = fs.readFileSync(path.join(dataDir(), 'ui-port.txt'), 'utf8').trim();
    if (p) return 'http://127.0.0.1:' + p + '/';
  } catch {}
  return CONSOLE;
}

async function up(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function configured() {
  try {
    const r = await fetch('http://127.0.0.1:3071/api/state', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return !!j.configured;
  } catch { return true; }
}

function showWindow() {
  if (!win) return boot();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- 她主动说话时弹系统通知（桥接进程 POST 到这里） ----------
// 桥接跑在子进程里，拿不到 Electron 的 Notification，所以本地开一个小口子：
// 端口写进 <data>/notify.port，桥接读它后 POST /notify {title, body}。
let notifySrv = null;
function startNotifyServer() {
  if (notifySrv) return;
  const dir = dataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const portFile = path.join(dir, 'notify.port');
  notifySrv = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url || !req.url.startsWith('/notify')) { res.writeHead(404); res.end('no'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch {}
      const title = String(j.title || '她').slice(0, 80);
      const text = String(j.body || '').slice(0, 300);
      try {
        if (Notification.isSupported() && text) {
          const n = new Notification({ title, body: text, icon: iconPath() || undefined, silent: false });
          n.on('click', () => { try { showWindow(); if (win && !win.isDestroyed()) win.loadURL(chatUrl()).catch(() => {}); } catch {} });
          n.show();
          logLine('notify shown', title, text.slice(0, 40));
        }
      } catch (e) { logLine('notify failed', String(e && e.message || e)); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  notifySrv.on('error', (e) => logLine('notify server error', String(e && e.message || e)));
  notifySrv.listen(0, '127.0.0.1', () => {
    const port = notifySrv.address().port;
    try { fs.writeFileSync(portFile, String(port)); } catch {}
    logLine('notify server on', port);
  });
}

// ---------- 开机自启 ----------
function exePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}
function autoStartOn() {
  try {
    const s = app.getLoginItemSettings({ path: exePath() });
    return !!(s && s.openAtLogin);
  } catch { return false; }
}
function setAutoStart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: exePath(), args: [] });
    logLine('autostart', on ? 'on' : 'off', exePath());
    return true;
  } catch (e) { logLine('autostart failed', String(e)); return false; }
}

// ---------- 内核守护（计划任务） ----------
const CORE_TASK = 'QQBotNapCatCore';
function napcatDir() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir(), 'setup.json'), 'utf8'));
    const d = s && s.napcat && s.napcat.dir;
    return d && fs.existsSync(path.join(d, 'launcher.bat')) ? d : '';
  } catch { return ''; }
}
function sh(args) {
  return new Promise((resolve) => {
    try {
      require('node:child_process').execFile('schtasks.exe', args, { windowsHide: true, timeout: 20000 },
        (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || err || '') }));
    } catch (e) { resolve({ ok: false, err: String(e) }); }
  });
}
async function kernelRunning() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return !!(j && j.retcode === 0 && j.data && j.data.user_id);
  } catch { return false; }
}
async function restartKernel(interactive) {
  const q = await sh(['/query', '/tn', CORE_TASK]);
  if (!q.ok) {
    logLine('restart kernel: no task');
    if (interactive) await dialog.showMessageBox({ type: 'warning', title: '还没安装内核守护', message: '请先在托盘菜单里点「安装内核守护（一次授权）」，之后就能一键静默重启。' });
    return false;
  }
  const r = await sh(['/run', '/tn', CORE_TASK]);
  logLine('restart kernel', r.ok ? 'ok' : r.err.slice(0, 200));
  if (interactive && !r.ok) await dialog.showMessageBox({ type: 'error', title: '重启失败', message: r.err.slice(0, 300) });
  return r.ok;
}
function installCoreTask() {
  const d = napcatDir();
  if (!d) {
    dialog.showMessageBox({ type: 'warning', title: '找不到 NapCat', message: '先完成向导里的 NapCat 路径设置（目录里要有 launcher.bat）。' });
    return;
  }
  const vbs = path.join(dataDir(), 'napcat-core.vbs');
  const ps1 = path.join(dataDir(), 'install-core.ps1');
  fs.writeFileSync(vbs,
    'CreateObject("WScript.Shell").Run "cmd /c cd /d ""' + d + '"" && launcher.bat", 0, False\r\n', 'utf8');
  fs.writeFileSync(ps1,
    '$ErrorActionPreference = "Stop"\r\n' +
    'schtasks /create /tn "' + CORE_TASK + '" /tr "wscript.exe \\"' + vbs + '\\"" /sc once /st 00:00 /f /rl highest\r\n' +
    'if ($LASTEXITCODE -eq 0) { Write-Host "OK" } else { Write-Host "FAILED $LASTEXITCODE" }\r\n', 'utf8');
  try {
    require('node:child_process').execFile('powershell.exe',
      ['-NoProfile', '-Command', 'Start-Process powershell -Verb RunAs -ArgumentList \'-NoProfile\',\'-ExecutionPolicy\',\'Bypass\',\'-File\',\'' + ps1 + '\''],
      { windowsHide: true }, (e) => { if (e) logLine('install core task failed', String(e)); });
    logLine('install core task: prompted UAC; vbs=' + vbs);
  } catch (e) { logLine('install core task exec failed', String(e)); }
}

// ---------- 退出时停不停内核 ----------
// 默认停：不留后台。NapCat 是计划任务独立拉起的，不在这条进程树里，
// 所以光 kill(child) 关不掉它，得 /end 计划任务 + 结束它自己的进程树（/T 连带它拉起的 QQ）。
function quitPrefsPath() { return path.join(dataDir(), 'quit-prefs.json'); }
function stopKernelOnQuit() {
  try { return JSON.parse(fs.readFileSync(quitPrefsPath(), 'utf8')).stopKernelOnQuit !== false; } catch { return true; }
}
function setStopKernelOnQuit(on) {
  try { fs.writeFileSync(quitPrefsPath(), JSON.stringify({ stopKernelOnQuit: !!on }, null, 2), 'utf8'); logLine('quit pref stopKernel', !!on); } catch (e) { logLine('save quit pref failed', String(e)); }
}
function stopKernelSync() {
  const cp = require('node:child_process');
  const run = (cmd, args) => { try { cp.execFileSync(cmd, args, { windowsHide: true, timeout: 6000, stdio: 'ignore' }); return true; } catch (e) { logLine('stop kernel:', cmd, args.join(' '), String((e && e.message) || e).slice(0, 120)); return false; } };
  run('schtasks.exe', ['/end', '/tn', CORE_TASK]);
  for (const name of ['NapCatWinBootMain.exe', 'NapCatWinBoot.exe']) run('taskkill.exe', ['/IM', name, '/T', '/F']);
}

// 随时打开设置向导（配置页）：万一要改 NapCat 路径、重新扫码
async function openWizard() {
  try {
    const url = require('node:url').pathToFileURL(path.join(APP_DIR, 'launch.mjs')).href;
    const m = await import(url);
    if (m && m.startWizard) await m.startWizard();
  } catch (e) { logLine('open wizard failed', (e && e.stack) || String(e)); }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (await up(WIZARD)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (win && !win.isDestroyed()) { win.show(); win.focus(); win.loadURL(WIZARD).catch(() => {}); }
}

function buildTray() {
  const ip = trayIconPath();
  const img = ip ? nativeImage.createFromPath(ip) : nativeImage.createEmpty();
  try {
    tray = new Tray(img);
  } catch (e) {
    logLine('tray failed', e && e.message || String(e));
    return;
  }
  tray.setToolTip('大肥鱼 · DSChatBot');
  const auto = { label: '开机自动启动', type: 'checkbox', checked: autoStartOn(), click: (item) => setAutoStart(item.checked) };
  const menu = Menu.buildFromTemplate([
    { label: '打开聊天', click: () => showWindow() },
    { label: '打开控制台', click: () => openConsole() },
    { label: '设置向导（改 NapCat / 重新扫码）', click: () => openWizard() },
    { type: 'separator' },
    auto,
    { label: '重启 QQ 内核', click: () => restartKernel(true) },
    { label: '退出时同时停 QQ 内核', type: 'checkbox', checked: stopKernelOnQuit(), click: (item) => setStopKernelOnQuit(item.checked) },
    { label: '安装内核守护（一次授权）', click: () => installCoreTask() },
    { type: 'separator' },
    {
      label: '重启桥接', click: async () => {
        try { await fetch(consoleUrl() + 'api/restart', { method: 'POST' }); } catch (e) { logLine('restart failed', String(e)); }
      },
    },
    { label: '打开数据目录', click: () => shell.openPath(dataDir()) },
    { type: 'separator' },
    { label: '重启程序', click: () => { quitting = true; app.relaunch(); app.exit(0); } },
        { type: 'separator' },
        { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}


// 启动时把聊天端保存的偏好真正应用（置顶 / 透明度 / 开机自启）
async function applyWindowPrefs(win) {
  try {
    const r = await fetch('http://127.0.0.1:3210/api/state', { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    const cfg = (j && j.cfg) || {};
    if (cfg.topmost === true) win.setAlwaysOnTop(true);
    const op = Number(cfg.opacity);
    if (op >= 0.5 && op <= 1) win.setOpacity(op);
    // 启动时不再改写系统自启项（以前会被配置覆盖托盘里的手动开关）
  logLine('autoLaunch skipped on boot; use tray toggle');
    logLine('window prefs applied', JSON.stringify({ topmost: cfg.topmost, opacity: cfg.opacity, autoLaunch: cfg.autoLaunch }));
  } catch (e) { logLine('window prefs failed', String(e && e.message || e)); }
}

async function boot() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 600,
    title: '大肥鱼 · DSChatBot', backgroundColor: '#0e1116', show: false,
    icon: iconPath() || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 点 X = 收到托盘，不退出
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  // 页面加载失败（端口还没起来）时自动重试几次，避免留一片黑
  let failRetry = 0;
  win.webContents.on('did-fail-load', (ev, code, desc, url) => {
    logLine('load failed', code, desc, url);
    if (failRetry++ > 8 || !/127\.0\.0\.1/.test(String(url || ''))) return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url).catch(() => {}); }, 900);
  });
  win.webContents.on('did-finish-load', () => { failRetry = 0; });
  // 渲染进程挂掉（显存/驱动问题）时自动重载，而不是留个黑窗口
  win.webContents.on('render-process-gone', (ev, d) => {
    logLine('render gone', d && d.reason);
    if (win.isDestroyed()) return;
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 800);
  });
  win.on('unresponsive', () => { logLine('window unresponsive'); try { win.webContents.reload(); } catch {} });

  startBackend().catch((e) => console.error(e));
  setTimeout(() => { if (win && !win.isDestroyed()) applyWindowPrefs(win); }, 6000);

  const t0 = Date.now();
  let mode = null;
  while (Date.now() - t0 < 60000) {
    if (await up(consoleUrl())) { mode = 'console'; break; }
    if (await up(WIZARD)) { mode = 'wizard'; break; }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!mode) { win.loadURL('data:text/html,<h2 style="font-family:sans-serif;padding:40px">后端启动失败，请查看控制台输出</h2>'); return; }
  if (mode === 'wizard') { await win.loadURL(WIZARD); }
  else {
    // 默认进聊天界面；聊天服务还没起来就先等一会儿，等不到再退回控制台
    const t1 = Date.now();
    let landed = false;
    while (Date.now() - t1 < 20000) {
      if (await up(chatUrl())) { await win.loadURL(chatUrl()).catch(() => {}); landed = true; break; }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!landed) await win.loadURL(consoleUrl()).catch(() => {});
  }

  let timer = setInterval(async () => {
    if (mode !== 'wizard') return;
    // 向导里的“稍后再说”也会起控制台：只要控制台能响应了，就把窗口切过去
    if (!(await up(consoleUrl()))) return;
    clearInterval(timer);
    mode = 'console';
    await win.loadURL(consoleUrl());
  }, 1200);
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  if (!gotLock) return; // 已有实例在跑，直接退出
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('local.dschatbot');
  logLine('ready');
  buildTray();
  try { startNotifyServer(); } catch (e) { logLine('notify server boot failed', String(e && e.message || e)); }
  return boot();
}).then(() => logLine('boot done')).catch((e) => logLine('boot failed', e && e.stack || String(e)));

// 窗口全关也不退出，留在托盘
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  if (child) { try { child.kill(); } catch {} }
  try { if (stopKernelOnQuit()) { logLine('quit: stopping kernel'); stopKernelSync(); } else logLine('quit: keeping kernel (pref off)'); } catch (e) { logLine('quit stop kernel failed', String(e)); }
  if (tray) { try { tray.destroy(); } catch {} }
});
