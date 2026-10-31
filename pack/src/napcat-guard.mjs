// NapCat 守护（v2）
// 职责：盯着内核在不在线；掉线时判断是不是断网；只有确认“网通 + 内核死”才考虑重启。
// v2 原则（2026-10-25 断网弹窗事故后重写）：
//   1) 绝不再 spawn powershell / launcher.bat —— 那是弹窗风暴的根源
//   2) 断网时只标记状态，什么也不做
//   3) 重启只走「计划任务 QQBotNapCatCore」（管理员权限一次授权，之后静默），没有任务就只提示人工
//   4) 限流：5 分钟冷却 + 每小时最多 2 次
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PATHS, loadSetup } from './paths.mjs';
import * as settings from './settings.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const STATE = path.join(RQ, 'napcat-state.json');
const LOG = path.join(RQ, 'napcat-guard.log');
const LOCK = path.join(RQ, 'guard.pid');
const TASK_NAME = 'QQBotNapCatCore';
const SESSION = path.join(RQ, 'kernel-session.json'); // 最近一次在线 / 最近一次手动要求扫码的时间

const CHECK_MS = Number(process.env.GUARD_CHECK_MS || 20_000);
const QR_TTL_MS = Number(process.env.GUARD_QR_TTL_MS || 600_000); // 10 分钟才自动换码：换太勤会被 QQ 判成异常登录
const PORT_DOWN_MS = 10 * 60_000;  // 端口断 10 分钟才算真掉线（也别太勤重启）
const COOLDOWN_MS = 15 * 60_000; // 两次自动重启至少隔 15 分钟        
const MAX_PER_HOUR = 2; // 一小时最多自动重启 2 次（频繁重启会触发风控）

function qqOn() {
  try { const st = settings.load() || {}; return !(st.qq && st.qq.enabled === false); } catch { return true; }
}

// 自动动作总开关（设置 → 手机访问/AI 管家里的「允许自动重启」）：关掉后只记录状态，不重启、不换码
function autoOn() {
  try {
    const st = settings.load() || {};
    return !(st.guard && st.guard.auto === false);
  } catch {
    return true;
  }
}

// ---------- 单实例（跑在 Electron 主进程里时绝不 process.exit，否则整个 app 会被带走） ----------
let SKIP_START = false;
try {
  const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
  if (old && old !== process.pid) {
    process.kill(old, 0);            // 还活着就不要再起一个
    console.log('another guard alive:', old);
    SKIP_START = true;
  }
} catch {}
if (!SKIP_START) fs.writeFileSync(LOCK, String(process.pid), 'utf8');
const unlock = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
process.on('uncaughtException', (e) => { log('uncaught', e.message); });

let status = 'start';
let lastError = '';
let restarts = [];
let lastRestartAt = 0;
let downSince = 0;
let notLoggedSince = 0;
let needManual = false;
let netState = 'unknown';

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
}

function napcatQr() {
  try {
    const s = loadSetup() || {};
    const d = s.napcat && s.napcat.dir;
    return d ? path.join(d, 'cache', 'qrcode.png') : '';
  } catch { return ''; }
}
const qrMtime = () => { const p = napcatQr(); if (!p) return 0; try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

// ---------- 会话记忆：区分"内核本来在跑，掉线了"和"本次开机压根没登录过" ----------
function readSession() {
  try { return JSON.parse(fs.readFileSync(SESSION, 'utf8')) || {}; } catch { return {}; }
}
function patchSession(patch) {
  try { fs.writeFileSync(SESSION, JSON.stringify({ ...readSession(), ...patch }, null, 2), 'utf8'); } catch {}
}
const markOnline = () => patchSession({ lastOnlineAt: Date.now() });

// 自动拉起内核的两个条件（任一满足）：
//   a) 24 小时内在过线——说明它本来该在跑，掉线了才值得救
//   b) 30 分钟内用户主动点过「启动扫码 / 立即换一张」
// 都不满足就只是待命，绝不因为"打开软件"就把 QQ 内核拉起来弹登录。
function allowAutoStart() {
  const s = readSession();
  const now = Date.now();
  if (s.lastOnlineAt && now - s.lastOnlineAt < 24 * 3_600_000) return true;
  if (s.scanRequestedAt && now - s.scanRequestedAt < 30 * 60_000) return true;
  return false;
}

// 旧码清场：超过 QR_TTL 的 cache/qrcode.png 改名留档，免得控制台把两天前的码当当前码贴出来
function pruneQr(reason) {
  const p = napcatQr();
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs <= QR_TTL_MS) return false;
    const dst = p.replace(/\.png$/i, '.stale-' + st.mtimeMs + '.png');
    fs.renameSync(p, dst);
    log('清掉过期二维码（' + reason + '）→', path.basename(dst));
    return true;
  } catch { return false; }
}

function saveState(extra = {}) {
  try {
    fs.writeFileSync(STATE, JSON.stringify({
      status, net: netState, needManual, loggedIn: extra.loggedIn || null,
      restarts: restarts.length, lastRestartAt, qrAt: qrMtime(),
      lastError, pid: process.pid, at: Date.now(), ...extra,
    }, null, 2), 'utf8');
  } catch {}
}

// ---------- 端口探测（纯 node，不起任何子进程） ----------
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, '127.0.0.1');
  });
}
async function portsUp() {
  const [a, b] = await Promise.all([portOpen(3000), portOpen(3001)]);
  return a && b;
}

// ---------- 外网探测（TCP 连 443，不依赖 DNS 接口） ----------
function tcpProbe(host, port = 443, timeout = 4000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, host);
  });
}
async function netOK() {
  // 两个都试，任一通就算通（避免单点误判）
  const [a, b] = await Promise.all([tcpProbe('110.242.68.66'), tcpProbe('223.5.5.5')]);
  return a || b;
}

async function api(action) {
  try {
    const r = await fetch(`http://127.0.0.1:3000/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    return await r.json();
  } catch (e) { lastError = String(e.message || e); return null; }
}

async function loginInfo() {
  const j = await api('get_login_info');
  return j && j.retcode === 0 && j.data && j.data.user_id ? j.data : null;
}

// ---------- 重启：只通过计划任务，且严格限流 ----------
function hasTask() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/query', '/tn', TASK_NAME], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}
function runTask() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/run', '/tn', TASK_NAME], { windowsHide: true, timeout: 15000 }, (err, _o, errOut) => {
      if (err) log('schtasks /run 失败', String(errOut || err.message).trim().slice(0, 200));
      resolve(!err);
    });
  });
}

async function tryRestart(reason) {
  if (!qqOn()) { status = 'disabled'; needManual = false; lastError = 'QQ 接入已关闭（设置里可开启）'; saveState(); return; }
  if (!autoOn()) {
    status = 'manual';
    needManual = true;
    lastError = '自动重启已关闭（设置里可以打开）：' + reason;
    saveState();
    return;
  }
  if (!allowAutoStart()) {
    status = 'idle';
    needManual = false;
    lastError = '待命中，不会自动拉起内核：没有手动点过扫码，也不在近期在线过（' + reason + '）';
    saveState();
    return false;
  }
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 3_600_000);
  if (now - lastRestartAt < COOLDOWN_MS) return false;
  if (restarts.length >= MAX_PER_HOUR) {
    // 只在本小时窗口内退避；一小时过后 restarts 清空，自动恢复
    needManual = false;
    status = 'cooling';
    saveState();
    return false;
  }

  if (!(await hasTask())) {
    // 没有计划任务：绝不 spawn，只标记需要人工
    if (!needManual) log('需要人工重启：没找到计划任务', TASK_NAME, '（', reason, '）');
    needManual = true;
    status = 'need-manual';
    saveState();
    return false;
  }

  lastRestartAt = now;
  restarts.push(now);
  status = 'restarting';
  needManual = false;
  log('通过计划任务重启内核：', reason);
  saveState();
  await runTask();
  downSince = 0;
  notLoggedSince = 0;
  return true;
}

function holdUntil() {
  try {
    const f = path.join(PATHS.data, 'qr-hold.json');
    if (!fs.existsSync(f)) return 0;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Number(j.until) || 0;
  } catch { return 0 }
}

async function tick() {
  if (await loginInfo()) {
    if (status !== 'online') log('内核在线');
    status = 'online';
    markOnline();
    needManual = false;
    downSince = 0;
    notLoggedSince = 0;
    lastError = '';
    saveState();
    return;
  }

  const up = await portsUp();
  if (!up) {
    downSince = downSince || Date.now();
    netState = (await netOK()) ? 'up' : 'down';
    if (netState === 'down') {
      // 断网：只记录，什么都不做（断网时重启毫无意义，还会刷屏）
      status = 'net-down';
      saveState();
      return;
    }
    // 内核本来就不该在跑的时候（没人扫码、近期没在线），别装成"掉线了正在救"：
    // 直接报待命，省得控制台挂十分钟"内核没响应，正在重启"吓人。
    if (!qqOn()) {
      status = 'disabled'; needManual = false;
      lastError = 'QQ 接入已关闭（设置里可开启）';
      saveState(); return;
    }
    if (!autoOn()) {
      status = 'manual'; needManual = true;
      lastError = '自动重启已关闭（设置里可以打开）';
      saveState(); return;
    }
    if (!allowAutoStart()) {
      status = 'idle'; needManual = false;
      lastError = '待命中，不会自动拉起内核：没有手动点过扫码，也不在近期在线过';
      saveState(); return;
    }
    status = 'offline';
    saveState();
    if (Date.now() - downSince > PORT_DOWN_MS) {
      await tryRestart('端口持续不通');
    }
    return;
  }

  // 端口在、但没登上：要么等扫码，要么二维码废了
  downSince = 0;
  notLoggedSince = notLoggedSince || Date.now();
  const idle = Date.now() - notLoggedSince;
  const qrAge = qrMtime() ? Date.now() - qrMtime() : Infinity;
  if (Date.now() < holdUntil()) {
    status = 'waiting-scan';
    saveState();
    return;
  }
  if (qrAge <= QR_TTL_MS && idle <= QR_TTL_MS * 6) {
    status = qrMtime() ? 'waiting-scan' : 'no-qr';
    saveState();
    return;
  }
  netState = (await netOK()) ? 'up' : 'down';
  if (netState === 'down') { status = 'net-down'; saveState(); return; }
  status = 'qr-expired';
  pruneQr('决定换码');
  saveState();
  await tryRestart(`二维码已经 ${Math.round(Math.min(qrAge, idle * 2) / 1000)} 秒，没人扫，换一张`);
}

if (!SKIP_START) {
  log('guard v2 starting（分发版），pid', process.pid);
  pruneQr('启动自检');
  saveState();
  await tick();
  setInterval(() => { tick().catch((e) => { lastError = e.message; log('tick err', e.message); }); }, CHECK_MS);
}

// launch.mjs 里会 import 本模块并调用 startGuard()；此处为兼容导出
export function startGuard() {}
