// 控制台：http://127.0.0.1:3070
// 只监听本机；改人格 / 记忆 / 表情包 / 兴趣 / 设置 / 看日志
import * as workdialog from './workdialog.mjs';
import * as daily from './daily.mjs';
import * as loops from './loops.mjs';
import * as life from './life.mjs';
import * as caps from './caps.mjs';
import * as plugins from './plugins.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import * as settings from './settings.mjs';
import * as scenes from './scenes.mjs';
import * as self from './self.mjs';
import * as apibrain from './apibrain.mjs';
import * as memory from './memory.mjs';
import * as lessons from './lessons.mjs';
import * as skills from './skills.mjs';
import * as budget from './budget.mjs';
import { looksVision, resolveVision } from './capability.mjs';
import { PATHS, loadSetup, saveSetup, APP, looksLikeNapCat, looksLikeSnowLuma, qqProtocolOf, qqClientDirOf, launcherNameIn, hasLauncher } from './paths.mjs';
import { testKey } from './brain.mjs';
import { ensurePersonaFile } from './persona-default.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const DIR = `${RQ}`;
const AGENT_HOME = `${RQ_AGENT}`;
const MEMDIR = path.join(AGENT_HOME, 'memory', 'people');
const MINDDIR = path.join(DIR, 'state');
const MEM_LOG = path.join(AGENT_HOME, 'memory', 'log');
const CHATDIR = path.join(DIR, 'chat');
const DIARYDIR = path.join(DIR, 'mind');
const NAMES = path.join(DIR, 'names.json');
const PERSONA = path.join(DIR, 'persona.md');
const NAPCAT_DIR = process.env.QQBOT_NAPCAT_DIR || (process.platform === 'win32' ? 'E:\\NapCat\\shell' : '/opt/napcat');
const QR_FILE = process.env.QQBOT_QR_FILE || path.join(NAPCAT_DIR, 'cache', 'qrcode.png');
const STICKERS = path.join(DIR, 'stickers');
const STICKER_META = path.join(DIR, 'stickers.json');
const INTERESTS = path.join(DIR, 'interests.json');
const PID = path.join(DIR, 'bridge.pid');
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(SRC_DIR, 'bridge.mjs');
const LOG = path.join(DIR, 'bridge.log');
const PORT = Number(process.env.QQBOT_UI_PORT || 3070);
const BIND_HOST = String(process.env.QQBOT_UI_HOST || '127.0.0.1');
// 桥接的本地通道（审批卡片、聊天转发都走它）
const LOCAL_URL = () => process.env.QQBOT_LOCAL_URL || 'http://127.0.0.1:3098';

// Node 这边的日志。以前重启桥接的几条提示直接写了 log(...)，
// 但 log 只存在于页面脚本里，Node 模式下没有 bridge.pid 时一按重启就报 log is not defined（复查 F21）。
function nlog(...a) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.map((x) => (x && x.message) || String(x)).join(' ') + '\n'); } catch {}
}

// 手机访问：把本机所有内网 IPv4 拼成可访问地址
function lanUrls() {
  const out = [];
  const nets = os.networkInterfaces();
  const bad = /^(169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (bad.test(n.address)) continue;
      if (/vmware|virtualbox|vethernet|hyper-v|loopback|tailscale|zerotier|tap|tun|wsl/i.test(name)) continue;
      out.push({ url: 'http://' + n.address + ':' + PORT, ip: n.address, name });
    }
  }
  // 真实网卡优先（虚拟网卡经常连不通手机），再看网段
  const VIRT = /vmware|virtualbox|vethernet|hyper-v|loopback|tailscale|zerotier|tap|tun|wsl/i;
  const rank = (x) => (VIRT.test(x.name) ? 100 : 0) + (x.ip.startsWith('192.168.') ? 0 : x.ip.startsWith('10.') ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b));
  return out.map((x) => x.url);
}

// ---- 音色包（内置 + 用户自加，存 data\voices.json）----
const BUILTIN_VOICES = [
  ['longwan_v2', 'B · 中文女声'],
  ['longxiaochun_v2', 'A · 温柔女声'],
  ['longshu_v2', 'D · 知性女声'],
  ['longanran', 'E · 台湾腔'],
  ['longyuan_v2', 'F · 甜美女声'],
  ['zhifeng_v2', 'G · 男声'],
];
const VOICES_FILE = path.join(DIR, 'voices.json');
function loadVoices() {
  const custom = readJSON(VOICES_FILE, []).filter(v => v && v.id);
  return {
    custom,
    list: BUILTIN_VOICES.map(([id, name]) => ({ id, name, builtin: true }))
      .concat(custom.map(v => ({ id: v.id, name: v.name || v.id, builtin: false }))),
  };
}

const readText = (p, d = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return d; } };
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');

function logTail(n = 60) {
  try {
    const lines = readText(LOG).split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

function alive() {
  try {
    const pid = Number(readText(PID).trim());
    if (!pid) return process.versions.electron ? { pid: process.pid, alive: true } : { pid: 0, alive: false };
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch { return { pid: 0, alive: false }; }
}

async function oneBot() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2500),
    });
    const j = await r.json();
    return j?.data || null;
  } catch { return null; }
}

function body(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
  });
}

const send = (res, code, obj) => {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(s);
};

// ===== 危险操作授权码：删主人号这种不可逆动作，光点两下"确定"不够 =====
// 6 位码只活在内存里：5 分钟有效、用一次即废、不落盘。
// 不再存密码 —— 把"忘了密码"变成永久锁死是设计缺陷，不是安全。
const ownerUin = () => {
  try {
    const s = loadSetup();
    return String((s.qq && (s.qq.ownerUin || s.qq.master)) || '');
  } catch { return ''; }
};
// ===== 访问鉴权 v2：设备会话 + 网段白名单 + 失败限速 =====
const UI_PASS = String(process.env.QQBOT_UI_PASS || '');
const COOKIE_NAME = 'qqbot_auth';
const SESS_FILE = () => path.join(PATHS.data, 'auth-sessions.json');
const AUTH_LOG = () => path.join(PATHS.data, 'auth.log');

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const k = part.indexOf('=');
    if (k > 0 && part.slice(0, k).trim() === name) return decodeURIComponent(part.slice(k + 1).trim());
  }
  return '';
}
function ipOf(req) {
  let a = String((req.socket && req.socket.remoteAddress) || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}
function isLoopback(req) {
  const a = ipOf(req);
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function passNow() {
  try {
    const c = settings.load();
    if (c.ui && c.ui.pass) return String(c.ui.pass);
  } catch {}
  return UI_PASS;
}
// 网段白名单：本机 + Tailscale，其余按配置
function ip4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw == null ? 32 : bitsRaw);
  if (/^[0-9.]+$/.test(ip) && /^[0-9.]+$/.test(base)) {
    const a = ip4ToInt(ip), b = ip4ToInt(base);
    if (a == null || b == null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  return ip === base;
}
function allowCidrs() {
  const base = ['127.0.0.1/32', '::1/128', '100.64.0.0/10'];
  try {
    const c = settings.load();
    const extra = (c.ui && Array.isArray(c.ui.extraCidrs)) ? c.ui.extraCidrs : [];
    return base.concat(extra.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()));
  } catch { return base; }
}
function ipAllowed(req) {
  if (isLoopback(req)) return true;
  const ip = ipOf(req);
  return allowCidrs().some((c) => inCidr(ip, c));
}
// 失败限速
const FAILS = new Map();
function failState(ip) {
  const st = FAILS.get(ip) || { n: 0, until: 0 };
  if (st.until && st.until < Date.now()) { st.n = 0; st.until = 0; }
  return st;
}
function noteFail(ip) {
  const st = failState(ip);
  st.n += 1;
  if (st.n >= 5) { st.until = Date.now() + 15 * 60000; st.n = 0; }
  FAILS.set(ip, st);
  return st;
}
function lockedFor(ip) {
  const st = failState(ip);
  return st.until > Date.now() ? Math.ceil((st.until - Date.now()) / 60000) : 0;
}
// 会话持久化
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESS_FILE(), 'utf8')); } catch { return []; }
}
function saveSessions(list) {
  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(SESS_FILE(), JSON.stringify(list.slice(-20), null, 1));
  } catch {}
}
function sidOf(req) { return cookieOf(req, COOKIE_NAME); }
function sessionOf(req) {
  const sid = sidOf(req);
  if (!sid) return null;
  const list = loadSessions();
  const hit = list.find((x) => x.sid === sid);
  if (!hit) return null;
  if (hit.exp && hit.exp < Date.now()) return null;
  return hit;
}
function issueSession(req, days) {
  const sid = crypto.randomBytes(18).toString('hex');
  const list = loadSessions().filter((x) => x.sid !== sid);
  list.push({
    sid,
    ip: ipOf(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
    t: Date.now(),
    last: Date.now(),
    exp: days > 0 ? Date.now() + days * 86400000 : 0,
  });
  saveSessions(list);
  audit('login', req, 'ok');
  return { sid, days };
}
function audit(ev, req, note) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ev, ip: ipOf(req), note: note || '' }) + '\n';
    fs.appendFileSync(AUTH_LOG(), line);
  } catch {}
}
function authed(req) {
  // 本机（Electron 窗口 / 127.0.0.1）免密；Tailscale/局域网要密码 + 设备会话
  if (isLoopback(req)) return true;
  if (!ipAllowed(req)) return false;
  if (!passNow()) return true;
  return !!sessionOf(req);
}
const MOBILE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>大肥鱼</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;max-width:100vw;overflow-x:hidden;background:#0f1115;color:#e6e8ee;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui;overscroll-behavior-y:contain}
body{display:flex;flex-direction:column;padding-bottom:calc(64px + env(safe-area-inset-bottom));overflow-x:hidden;max-width:100vw}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:14px 16px 10px;background:linear-gradient(180deg,#0f1115 70%,rgba(15,17,21,0));backdrop-filter:blur(6px)}
header h1{margin:0;font-size:19px;font-weight:800;letter-spacing:.5px}
.dot{width:8px;height:8px;border-radius:50%;background:#8b93a3;flex:0 0 auto}
.dot.ok{background:#3ecf8e;box-shadow:0 0 10px #3ecf8e88}
.dot.bad{background:#ff6b6b}
main{flex:1;padding:0 14px 20px;overflow-x:hidden}
.tab{display:none}
.tab.on{display:block}
.card{background:#15181f;border:1px solid #232a35;border-radius:16px;padding:16px;margin-bottom:12px;max-width:100%;overflow-wrap:anywhere}
.card>h2{margin:0 0 8px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.dim{color:#8b93a3}
.hint{color:#8b93a3;font-size:12.5px;line-height:1.6;margin-top:8px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.big{font-size:17px;font-weight:700}
.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #1b2028;font-size:14px}
.kv>span{flex:1 1 auto;min-width:0}
.kv>b{flex:0 0 auto;max-width:60%;text-align:right;word-break:break-word}
.kv:last-child{border-bottom:0}
.kv b{font-weight:600;color:#aeb9cc}
button{font:inherit;border-radius:12px;border:1px solid #2a3140;background:#1b212c;color:#e6e8ee;padding:11px 16px;font-weight:600}
button.pri{background:linear-gradient(180deg,#6aa8ff,#4b8df0);color:#07111f;border-color:#7fb4ff}
button.dan{background:#3a2026;color:#ff9b9b;border-color:#542b32}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5}
input,textarea,select{width:100%;background:#0c0e12;border:1px solid #2a3140;color:#e6e8ee;border-radius:12px;padding:11px 12px;font:inherit;font-size:16px}
textarea{min-height:300px;line-height:1.75;font-family:ui-monospace,Consolas,monospace;font-size:14px}
img.qr,canvas.qr{width:min(86vw,300px);max-width:100%;border-radius:0;background:#fff;padding:18px;display:block;margin:10px auto;image-rendering:pixelated}
code{background:#0c0e12;border:1px solid #232a35;border-radius:8px;padding:2px 7px;font-size:13px;word-break:break-all}
.thumb{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.thumb img{width:100%;max-width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;border:1px solid #232a35}
nav{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;background:#0c0e12;border-top:1px solid #232a35;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
nav button{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:0;color:#8b93a3;font-size:10.5px;padding:6px 0;border-radius:12px;white-space:nowrap}
nav button .i{font-size:17px;line-height:1}
nav button.on{color:#6aa8ff}
nav button:active{background:#161b24}
button{touch-action:manipulation}
#toast{position:fixed;left:50%;transform:translate(-50%,10px);bottom:calc(84px + env(safe-area-inset-bottom));background:#16261c;color:#8ff0b6;border:1px solid #2b5a3c;padding:10px 18px;border-radius:12px;font-size:13.5px;opacity:0;transition:.2s;pointer-events:none;z-index:40}
#toast.on{opacity:1;transform:translate(-50%,0)}
#toast.bad{background:#2b1a1e;color:#ffb3b3;border-color:#5c2b33}


pre{background:#0c0e12;border:1px solid #232a35;border-radius:12px;padding:12px;font-size:12px;line-height:1.6;max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-word}

.chathead{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 8px;color:#cfd6e6;font-size:14px}
.chathead .ghost{font-size:12px;padding:4px 10px}
.chatwrap{display:flex;flex-direction:column;height:calc(100vh - 80px);max-width:900px;margin:0 auto}
.chatbox{flex:1;overflow-y:auto;padding:8px 4px 16px;display:flex;flex-direction:column;gap:10px}
.chatempty{color:#7a8394;text-align:center;margin-top:60px;font-size:14px}
.msg{display:flex;gap:8px;align-items:flex-start;max-width:86%}
.msg.out{align-self:flex-start}
.msg.in{align-self:flex-end;flex-direction:row-reverse}
.avatar{width:34px;height:34px;border-radius:50%;flex:0 0 34px;background:#1b2030;display:flex;align-items:center;justify-content:center;font-size:17px;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.avatar.big{width:56px;height:56px;flex:0 0 56px;border-radius:50%}
.bubble{padding:9px 13px;border-radius:14px;line-height:1.55;font-size:15px;word-break:break-word;white-space:pre-wrap}
.msg.out .bubble{background:#1f2637;color:#e6e9f0;border-top-left-radius:4px}
.msg.in .bubble{background:#2c5cff;color:#fff;border-top-right-radius:4px}
.bubble img{max-width:240px;border-radius:10px;display:block}
.bubble audio{max-width:240px;margin:2px 0}
.chatbar{display:flex;gap:8px;align-items:flex-end;padding:10px 0 4px;border-top:1px solid #232833}
.chatbar textarea{flex:1;resize:none;min-height:44px;max-height:140px;padding:10px 12px;border-radius:12px;background:#151a24;color:#e6e9f0;border:1px solid #263041;font-size:15px;font-family:inherit}
.chathint{color:#6b7385;font-size:12px;padding:2px 2px 8px;min-height:16px}
.msg .meta{font-size:11px;color:#6b7385;margin-top:3px}
@media (max-width:820px){.chatwrap{height:calc(100vh - 130px)}.msg{max-width:94%}}
</style></head><body>
<header><h1>大肥鱼</h1><span class="dot" id="dot"></span><span class="dim" id="hd" style="font-size:12.5px"></span></header>

<main>
  <div class="tab" id="t-chat">
    <div class="chatwrap">
      <div id="chatBox" class="chatbox"><div class="chatempty">还没聊过。说句话试试～</div></div>
      <div class="chatbar">
        <textarea id="chatIn" rows="1" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="pic" id="micBtn" onclick="micTap()" title="按住说话">🎤</button>
        <button class="pri" onclick="chatSend()">发送</button>
      </div>
      <div class="chathint" id="chatHint"></div>
    </div>
  </div>

  <div class="tab on" id="t-home">
    <div id="qrCard"></div>
    <div class="card" id="c-bridge">
      <h2>桥接</h2>
      <div class="kv"><span>状态</span><b id="bAlive">-</b></div>
      <div class="kv"><span>QQ</span><b id="bLogin">-</b></div>
      <div class="kv"><span>今天花了</span><b id="bCost">-</b></div>
      <div class="row" style="margin-top:12px"><button class="pri" onclick="restartBridge(this)">重启桥接</button></div>
    </div>
    <div class="card">
      <h2>她最近</h2>
      <div id="users"></div>
    </div>
  </div>

  <div class="tab" id="t-persona">
    <div class="card">
      <h2>人格</h2>
      <div class="hint">改完点保存，下一条消息就生效。</div>
      <textarea id="persona" spellcheck="false" style="margin-top:10px"></textarea>
      <div class="row" style="margin-top:12px"><button class="pri" onclick="savePersona(this)">保存人格</button></div>
    </div>
  </div>

  <div class="tab" id="t-mem">
    <div class="card">
      <h2>记忆</h2>
      <div id="mems"></div>
    </div>
  </div>

  <div class="tab" id="t-st">
    <div class="card">
      <h2>表情包 <span class="dim" id="stCount"></span></h2>
      <div class="hint">标签是她挑图用的关键词。</div>
      <div class="thumb" id="stThumb" style="margin-top:10px"></div>
    </div>
  </div>

  <div class="tab" id="t-set">
    <div class="card">
      <h2>账号</h2>
      <div class="kv"><span>主人 QQ</span><b><input id="sOwner" inputmode="numeric" style="text-align:right;padding:8px 10px"></b></div>
      <div class="row" style="margin-top:10px"><button class="pri" onclick="saveOwner(this)">保存主人</button></div>
    </div>
    <div class="card">
      <h2>大脑（API）</h2>
      <div class="hint">改完点保存，下一条消息生效；换供应商后点「重启桥接」。</div>
      <div style="margin-top:10px"><div class="dim" style="font-size:12.5px">接口地址</div><input id="sUrl"></div>
      <div style="margin-top:10px"><div class="dim" style="font-size:12.5px">模型</div><input id="sModel"></div>
      <div style="margin-top:10px"><div class="dim" style="font-size:12.5px">API Key（留空不改）</div><input id="sKey" type="password"></div>
      <div class="row" style="margin-top:12px"><button class="pri" onclick="saveBrainPage(this)">保存</button></div>
    </div>
    <div class="card">
      <h2>常驻</h2>
      <div class="kv"><span>开机自动启动（跟着系统起来，不用手动开）</span><b><input type="checkbox" id="sAuto" style="width:auto;transform:scale(1.3)"></b></div>
      <div class="row" style="margin-top:10px"><button class="pri" onclick="saveAuto(this)">保存</button></div>
    </div>
    <div class="card">
      <h2>允许她动电脑</h2>
      <div class="dim" style="margin-bottom:8px">默认关着：她只能聊天。打开后她才可以在你选的文件夹里读/改文件、跑命令；动手前会先问你。</div>
      <div class="row" style="gap:8px"><button class="pri" id="sToolsBtn" onclick="toggleWorkTools()">允许她动电脑</button><span class="dim" id="sToolsState">关着</span></div>
      <div class="dim" id="sToolsHint" style="margin-top:6px;font-size:12px"></div>
    </div>
    <div class="card">
      <h2>群聊</h2>
      <div class="kv"><span>在群里说话</span><b><input type="checkbox" id="sGEnabled" style="width:auto;transform:scale(1.3)"></b></div>
      <div class="kv"><span>只叫名字才理</span><b><input type="checkbox" id="sGNeedCall" style="width:auto;transform:scale(1.3)"></b></div>
      <div class="row" style="margin-top:12px"><button class="pri" onclick="saveGroup(this)">保存</button></div>
    </div>
  </div>

  <div class="tab" id="t-log">
    <div class="card">
      <h2>日志</h2>
      <div class="row" style="margin-bottom:10px"><button onclick="loadLog(this)">刷新</button></div>
      <pre id="log"></pre>
    </div>
  </div>
</main>

<nav>
  <button class="on" data-t="home" onclick="go('home',this)"><span class="i">◎</span>概览</button>
  <button data-t="persona" onclick="go('persona',this)"><span class="i">✎</span>人格</button>
  <button data-t="mem" onclick="go('mem',this)"><span class="i">✦</span>记忆</button>
  <button data-t="st" onclick="go('st',this)"><span class="i">☺</span>表情包</button>
  <button data-t="set" onclick="go('set',this)"><span class="i">⚙</span>设置</button>
  <button data-t="log" onclick="go('log',this)"><span class="i">≡</span>日志</button>
</nav>
<div id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
let PASS_TRIED = false;
function askPass(){
  // 页内浮层（不用 window.prompt：微信/QQ 内置浏览器会屏蔽）
  return new Promise((resolve) => {
    if (document.getElementById('pwLayer')) return resolve(false);
    const d = document.createElement('div');
    d.id = 'pwLayer';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px';
    d.innerHTML = '<div style="background:#15181f;border:1px solid #262b36;border-radius:16px;padding:20px;width:100%;max-width:340px">'
      + '<div style="font-size:16px;font-weight:600;margin-bottom:6px">输入控制台密码</div>'
      + '<div style="color:#8b93a1;font-size:13px;margin-bottom:12px">电脑上打开控制台不用这个密码。忘了的话，回到这台电脑上开控制台即可。</div>'
      + '<input id="pwIn" type="password" inputmode="numeric" autocomplete="current-password" placeholder="密码" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2b313d;background:#0f1217;color:#e6e9ef;font-size:16px">'
      + '<div id="pwErr" style="color:#e2777a;font-size:13px;height:18px;margin-top:6px"></div>'
      + '<button id="pwGo" style="width:100%;margin-top:8px;padding:12px;border:0;border-radius:10px;background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;font-size:15px">进入</button></div>';
    document.body.appendChild(d);
    const inp = d.querySelector('#pwIn'), btn = d.querySelector('#pwGo'), err = d.querySelector('#pwErr');
    inp.focus();
    const done = (ok) => { PASS_TRIED = true; d.remove(); resolve(ok); };
    const go = async () => {
      const p = inp.value.trim();
      if (!p) { err.textContent = '先输密码'; return; }
      btn.disabled = true; btn.textContent = '验证中…'; err.textContent = '';
      try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: p }) });
        if (r.ok) { done(true); return; }
        err.textContent = r.status === 401 ? '密码不对，再试一次' : ('连不上（' + r.status + '）');
      } catch (e) { err.textContent = '网络错误：' + e.message; }
      btn.disabled = false; btn.textContent = '进入'; inp.select();
    };
    btn.onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}
const api = async (p, o) => {
  let r = await fetch(p, o);
  if (r.status === 401) {
    const ok = PASS_TRIED ? false : await askPass();
    if (ok) r = await fetch(p, o);
  }
  if (r.status === 401) { toast('密码不对，或者没输', false); throw new Error('need-password') }
  const t = await r.text();
  try { return JSON.parse(t) } catch { return t }
};
let CHAT_SINCE = 0;
let CHAT_TIMER = null;
const chatEsc = (t) => String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const chatTime = (at) => { const d = new Date(at); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') };
function chatAdd_legacy(m, silent){
  const box = $('#chatBox'); if (!box) return;
  const e0 = box.querySelector('.chatempty'); if (e0) e0.remove();
  const isIn = m.dir === 'in';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isIn ? 'in' : 'out');
  let inner = '';
  if (m.type === 'image' && m.file) inner = '<img src="/api/chat/media/' + encodeURIComponent(m.file) + '">';
  else if (m.type === 'voice' && m.file) {
    inner = '<audio controls preload="none" src="/api/chat/media/' + encodeURIComponent(m.file) + '"></audio>';
    if (m.text) inner += '<div class="vtext" style="display:none;margin-top:6px;opacity:.85">' + chatEsc(m.text) + '</div>';
  }
  else if (m.type === 'face') inner = '<span style="font-size:20px">🙂</span>';
  else inner = chatEsc(m.text || '');
  wrap.innerHTML = '<div class="avatar">' + '<img src="/api/chat/avatar/' + (isIn ? 'me' : 'her') + '" alt="">' + '</div><div><div class="bubble">' + inner + '</div><div class="meta">' + chatTime(m.at) + '</div></div>';
  if (m.type === 'voice') {
    const b = wrap.querySelector('.bubble');
    b.title = '长按可以转文字';
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const vt = wrap.querySelector('.vtext');
      if (!vt) return toast('这条没存文字', false);
      vt.style.display = vt.style.display === 'none' ? 'block' : 'none';
    });
  }
  box.appendChild(wrap);
  if (!silent) box.scrollTop = box.scrollHeight;
}
async function chatLoadHistory_legacy(){
  try{
    const r = await api('/api/chat/history?n=80');
    if (!r || !r.ok || !Array.isArray(r.msgs)) return;
    const box = $('#chatBox'); if (!box) return;
    box.innerHTML = r.msgs.length ? '' : '<div class="chatempty">还没聊过。说句话试试～</div>';
    for (const m of r.msgs) chatAdd(m, true);
    box.scrollTop = box.scrollHeight;
    CHAT_SINCE = r.msgs.length ? r.msgs[r.msgs.length - 1].at : Date.now();
  }catch(e){}
}
async function chatPoll_legacy(){
  try{
    const r = await api('/api/chat/msgs?since=' + CHAT_SINCE);
    if (!r || !r.ok) { $('#chatHint').textContent = (r && r.err) ? r.err : ''; return; }
    $('#chatHint').textContent = '';
    for (const m of (r.msgs || [])) if (m.at > CHAT_SINCE) { chatAdd(m); CHAT_SINCE = m.at; if (m.dir === 'out') chatNotify(m.text || (m.type === 'image' ? '[图片]' : m.type === 'voice' ? '[语音]' : '')); }
  }catch(e){}
}
function chatBoot_legacy(){
  if (CHAT_TIMER) { chatPoll(); return; }
  chatLoadHistory();
  CHAT_TIMER = setInterval(() => { const t = document.getElementById('t-chat'); if (t && t.classList.contains('on')) chatPoll(); }, 1500);
  const ta = $('#chatIn');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
}
async function chatSend_legacy(){
  const ta = $('#chatIn');
  const text = (ta.value || '').trim();
  if (!text) return;
  ta.value = ''; ta.style.height = 'auto';
  chatAdd({ dir:'in', type:'text', text, at: Date.now(), src:'app' });
  $('#chatHint').textContent = '她想一下…';
  try{
    const r = await api('/api/chat/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    if (!r || !r.ok) $('#chatHint').textContent = (r && r.err) ? r.err : '发不出去';
  }catch(e){ $('#chatHint').textContent = '发不出去：' + e.message }
}

// —— 语音输入：录音成 16k 单声道 WAV，交给后端识别 ——
let MIC = { ctx: null, stream: null, chunks: [], recording: false, t0: 0 };
async function micStart(){
  if (MIC.recording) return;
  try {
    MIC.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    toast('没拿到麦克风权限：' + e.message, false); return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(MIC.stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  MIC.chunks = []; MIC.ctx = ctx; MIC.t0 = Date.now();
  proc.onaudioprocess = function(ev){
    if (!MIC.recording) return;
    MIC.chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  };
  src.connect(proc); proc.connect(ctx.destination);
  MIC.proc = proc; MIC.src = src;
  MIC.recording = true;
  document.getElementById('micBtn').textContent = '⏺';
  document.getElementById('micBtn').style.background = '#b23';
  document.getElementById('chatHint').textContent = '正在听…（再点一下结束）';
}
function micStop(){
  if (!MIC.recording) return null;
  MIC.recording = false;
  document.getElementById('micBtn').textContent = '🎤';
  document.getElementById('micBtn').style.background = '';
  try { MIC.proc.disconnect(); MIC.src.disconnect(); MIC.ctx.close(); } catch {}
  try { MIC.stream.getTracks().forEach(t => t.stop()); } catch {}
  const n = MIC.chunks.reduce((a, c) => a + c.length, 0);
  if (!n) return null;
  const pcm = new Float32Array(n);
  let off = 0;
  for (const c of MIC.chunks) { pcm.set(c, off); off += c.length; }
  return wavFromFloat(pcm, MIC.ctx ? MIC.ctx.sampleRate : 48000, 16000);
}
function wavFromFloat(input, inRate, outRate){
  // 线性重采样到 16k，再封 WAV（16bit 单声道）
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const buf = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = input[Math.floor(i * ratio)] || 0;
    buf[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const bytes = new Uint8Array(44 + buf.length * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) bytes[o + i] = str.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + buf.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, buf.length * 2, true);
  for (let i = 0; i < buf.length; i++) dv.setInt16(44 + i * 2, buf[i], true);
  return new Blob([bytes], { type: 'audio/wav' });
}
async function micTap(){
  if (MIC.recording) {
    const blob = micStop();
    const secs = ((Date.now() - MIC.t0) / 1000);
    if (!blob || secs < 0.4) { document.getElementById('chatHint').textContent = ''; toast('太短了，再说一次', false); return; }
    document.getElementById('chatHint').textContent = '识别中…';
    try {
      const r = await api('/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
      const t = (r && r.text) ? String(r.text).trim() : '';
      if (!t) { document.getElementById('chatHint').textContent = ''; toast((r && r.err) ? ('没听清：' + r.err) : '没听清', false); return; }
      const ta = document.getElementById('chatIn');
      ta.value = (ta.value ? ta.value + ' ' : '') + t;
      ta.focus();
      document.getElementById('chatHint').textContent = '';
      toast('已转成文字，确认后发送', true);
    } catch (e) { document.getElementById('chatHint').textContent = ''; toast('识别失败：' + e.message, false); }
  } else {
    micStart();
  }
}
async function testNotify_legacy(btn){
  const old = btn.textContent; btn.disabled = true; btn.textContent = '发送中…';
  try {
    await saveCfg(true);
    const r = await api('/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(r && r.ok ? '已发出，看看手机' : ('没发出去：' + ((r && r.err) || '未知')), !!(r && r.ok));
  } catch (e) { toast('失败：' + e.message, false); }
  btn.disabled = false; btn.textContent = old;
}
function toast(m, ok){ const t=$('#toast'); t.textContent=m; t.className='on'+(ok?'':' bad'); clearTimeout(t._h); t._h=setTimeout(()=>t.className='',2200) }

function go(t, el){
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  $('#t-'+t).classList.add('on');
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  if (t==='log') loadLog();
  if (t==='chat') { try { history.replaceState(null,'','#chat') } catch {} }
  if (t==='chat') chatBoot();
  window.scrollTo({top:0});
}
// 深链：/m#chat 直接进聊天
try { if (location.hash === '#chat') { const b = document.querySelector('nav button[data-t=\"chat\"]'); if (b) go('chat', b); } } catch {}
let STATE = {};
function napcatGuide(S){
  if (!S || S.napcatReady) return '';
  const dir = (S && S.napcatDir) ? String(S.napcatDir) : '';
  return '<div class="hint">还没有二维码，多半是还没装好登录 QQ 用的小软件。先装电脑版 QQ，再下载 <b>NapCat</b>（<a href="https://github.com/NapNeko/NapCatQQ/releases" target="_blank" rel="noopener">去下载</a>）并解压。'
    + '解压后找到里面有 launcher.bat 的那一层文件夹，在控制台「QQ」页填上路径并保存，然后再点扫码。'
    + (dir ? '（现在找的是 <code>' + dir + '</code>，打开这个文件夹看看有没有 launcher.bat。）' : '（还没填文件夹。）')
    + '扫码用另一部手机上的小号；你自己的号填在「主人号」里，两个不要填成同一个。</div>';
}
function qrClosedCard(S){return '<div class="card"><div class="row" style="justify-content:space-between"><b>QQ 接入已关闭</b><button class="pri" onclick="qqStartScan(this)">启动扫码登录 QQ</button></div><div class="hint">聊天用 DSChat 就够，要用 QQ 时再点右边这个按钮，才会拉起内核并出码。</div>' + napcatGuide(S) + '</div>';}
function paintQr_legacy(S){
const box=$('#qrCard');
if (!S.qqEnabled) { box.innerHTML = qrClosedCard(S); return }
  if (S.login) { box.innerHTML=''; return }
  const qr=S.qr||{};
  const age = qr.exists ? Math.round((Date.now()-qr.at)/1000) : -1;
  const stale = age > 600 || age < 0; // 10 分钟视为过期；内核没跑=无码
if (stale) {
  box.innerHTML = '<div class="card"><div class="row" style="justify-content:space-between"><b>QQ 接入已开启，但没有有效二维码</b>'
    + '<button class="pri" onclick="qqStartScan(this)">启动扫码登录 QQ</button></div>'
    + '<div class="hint">当前守护状态：' + ((S.guard && S.guard.status) || '未知') + '。点上面按钮会拉起 QQ 内核并生成新码；出码后再点「立即换一张」可以强制换。</div>'
    + napcatGuide(S) + '</div>';
  return;
}
  box.innerHTML = '<div class="card"><h2>需要扫码登录</h2>'
    + '<div class="hint">用<b>另一台设备</b>上的手机 QQ（切到小号）扫这个码——同一台手机没法扫自己屏幕上的码。扫完在手机上点“确认登录”。'+(age>=0?'（'+age+' 秒前生成'+(stale?'，已过期，马上换新':'')+'）':'')+'</div>'
    + (qr.exists?'<canvas class="qr" id="qrc" style="'+(stale?'opacity:.35;filter:grayscale(1)':'')+'"></canvas>':'')
    + '<div class="row" style="margin-top:6px"><button class="pri" onclick="openQqLogin()">在 QQ 里打开登录链接</button></div>'
    + '<div class="hint">同一台手机没法用摄像头扫自己屏幕，QQ 也不允许截图/相册识别登录码。点上面这个按钮会直接唤起手机 QQ 的授权页（官方链接，等同扫码）。</div>'
    + '<div class="row" style="margin-top:6px"><button class="ghost" onclick="qrNow(this)">立即换一张</button>'
    + '<button class="ghost" onclick="qrHold(this)">暂停换码 5 分钟</button></div>'
    + '<div class="hint">要截图去 QQ 里扫，就先点「暂停换码」——否则它 3 分钟就把码换掉，你一扫就是过期。</div></div>';
  if (qr.exists) drawQrHi(qr.at);
}
function drawQrHi(ts){
  const cv = document.getElementById('qrc');
  if (!cv) return;
  const img = new Image();
  img.onload = function(){
    const SCALE = 4;
    cv.width = img.width * SCALE;
    cv.height = img.height * SCALE;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
  };
  img.src = '/qr.png?t=' + (ts || Date.now());
}

async function openQqLogin(){
  try{
    const r = await api('/api/qr/url');
    if (!r || !r.ok || !r.url) return toast('没拿到登录链接：' + ((r && r.err) || '未知原因'), false);
    location.href = r.url;
  }catch(e){ toast('打开失败：' + (e && e.message ? e.message : '网络错误'), false) }
}

async function qrHold(btn){
  btn.disabled = true; btn.textContent = '已暂停…';
  try{
    const r = await api('/api/qr/hold', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ minutes: 5 }) });
    toast('已暂停换码 ' + ((r && r.minutes) || 5) + ' 分钟，现在截图去扫', true);
  }catch(e){ toast('暂停失败：' + (e && e.message ? e.message : '网络错误'), false) }
  finally{ setTimeout(()=>{ btn.disabled=false; btn.textContent='暂停换码 5 分钟' }, 1200) }
}
async function qrNow(btn){
  btn.disabled=true; btn.textContent='正在换…';
  try{ await api('/api/qr/refresh',{method:'POST'}) }catch(e){}
  const old=(STATE.qr&&STATE.qr.at)||0;
  for(let i=0;i<20;i++){
    await new Promise(r=>setTimeout(r,1500));
    const st=await api('/api/state');
    if(st && st.qr && st.qr.at && st.qr.at!==old){ STATE=st; paintQr(st); toast('新码已生成',1); return }
  }
  btn.disabled=false; btn.textContent='立即换一张'; toast('还没出新码，等会再点');
}
async function restartBridge_legacy(btn){
  if(!(await askConfirm('确定重启桥接？', '重启桥接'))) return;
  btn.disabled=true; btn.textContent='重启中…';
  try{ await api('/api/restart',{method:'POST'}) }catch(e){}
  setTimeout(()=>{ btn.disabled=false; btn.textContent='重启桥接'; load(); },6000);
}
async function load(){
  const S = await api('/api/state'); if(!S||typeof S!=='object') return;
  STATE=S;
  $('#dot').className='dot '+((S.bridge&&S.bridge.alive)?'ok':'bad');
  $('#hd').textContent=(S.login?(S.login.nickname||S.login.user_id):'未登录');
  // 通道状态 ≠ 她的状态。她住在桥接进程里，QQ 只是三个入口之一：
  // 断了以后她照旧过日子、照旧主动开口，只是消息改走本地窗口 + Windows 通知。
  // 所以标题永远是她的名字，通道单独一行说清楚"这个入口通不通、断了多久"。
  const chTxt = (() => {
    const q = S.qqLive;
    if (!S.login && !q) return '未登录';
    const nm = S.login ? (S.login.nickname + '（' + S.login.user_id + '）') : '未登录';
    if (!q) return nm;
    const fmt = (sec) => sec >= 3600 ? (sec / 3600).toFixed(1) + ' 小时' : Math.max(1, Math.round(sec / 60)) + ' 分钟';
    // 通道可能不止一个：逐个说，只说没连上的那个，别把"出口堵了"说成"她出事了"
    if (Array.isArray(q.channels) && q.channels.length) {
      const down = q.channels.filter(c => !c.online);
      if (!down.length) return nm;
      return nm + ' · ' + down.map(c => c.label + ' 这个入口没连上（' + fmt(Number(c.downSec || 0)) + '）').join('、')
        + ' · 她还在跑，消息走本地窗口';
    }
    if (q.online) return nm;
    return 'QQ 这个入口没连上（' + fmt(Number(q.downSec || 0)) + '）· 她还在跑，消息改走本地窗口';
  })();
  $('#bAlive').textContent=(S.bridge&&S.bridge.alive)?('运行中 pid '+S.bridge.pid):'没在跑';
  if (!S.bridge) { $('#bAlive').textContent='读不到（可能要在电脑上看一眼）'; }
  $('#bLogin').textContent=chTxt;
  $('#bLogin').style.color=(S.qqLive && S.qqLive.online===false)?'#c08a2e':'';
  const b=S.budget||{};
  { const v=Number(b.today||0), m=Number(b.spent||0); $('#bCost').textContent='¥'+v.toFixed(2)+' / 本月 ¥'+m.toFixed(2) }
  // 扫码入口已删（改密码登录），这里不再画二维码；函数留着但没人调。
  if ($('#qrSlot')) paintQr(S);
  const minds=Array.isArray(S.minds)?S.minds:[];
  const ppl=minds.filter(function(m){ return m && /^[0-9]{5,12}$/.test(String(m.uin||'')) });
  $('#users').innerHTML = ppl.length ? ppl.slice(0,4).map(function(m){
    return '<div class="kv"><span>'+m.uin+'</span><b>心情 '+Math.round(m.mood||0)+' · 精力 '+Math.round(m.energy||0)+' · 亲密 '+Math.round(m.affinity||0)+'</b></div>';
  }).join('') : '<div class="hint">还没有人跟她聊过</div>';
  try{
    const n=await api('/api/net');
    if(n && n.lan){ $('#c-net').style.display=''; $('#netHint').innerHTML='地址：<code>'+((n.urls&&n.urls[0])||'')+'</code><br>访问密码：<code>'+(n.pass||'(未设置)')+'</code>'; }
  }catch(e){}
}
async function loadPersona_legacy(){
  const r=await api('/api/persona');
  $('#persona').value=(r&&r.text)||'';
}
async function savePersona_legacy(btn){
  btn.disabled=true; btn.textContent='保存中…';
  try{ await api('/api/persona',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:$('#persona').value})}); toast('已保存',1) }
  catch(e){ toast('保存失败') }
  btn.disabled=false; btn.textContent='保存人格';
}
function memSource(it){
  if (it && it.origin === 'chat') return '聊天抽取';
  if (it && it.origin === 'legacy') return '旧数据';
  if (it && it.src) return '聊天';
  return '手动/未知';
}
async function loadMem_legacy(){
  // 先问一下主人号（服务端 /api/memory 需要 uin，不带就返回空）
  let uin='';
  try{ const su=await api('/api/setup'); uin=(su&&su.qq&&(su.qq.ownerUin||su.qq.master))||''; }catch(e){}
  if(!uin){ try{ const st=await api('/api/state'); const ppl=(st&&st.people)||[]; uin=String(ppl.find(x=>/^[0-9]{5,12}$/.test(String(x)))||'') }catch(e){} }
  const r=await api('/api/memory'+(uin?('?uin='+encodeURIComponent(uin)):''));
  const items=(r&&r.items)||[];
  $('#mems').innerHTML = items.length ? items.slice(0,30).map(m=>'<div class="kv"><span>'+m.text+'</span><b class="dim">'+(m.kind==='core'?'核心':(m.fresh?'新':'旧'))+'</b></div>').join('') : '<div class="hint">还没有记忆</div>';
  try{
    const st=await api('/api/stickers');
    const list=(st&&st.items)||[];
    $('#stCount').textContent='共 '+list.length+' 张';
    $('#stThumb').innerHTML=list.slice(0,8).map(x=>'<img src="/sticker/'+encodeURIComponent(x.file)+'">').join('');
  }catch(e){}
}
async function loadLog_legacy(btn){
  if(btn){ btn.disabled=true; btn.textContent='读取中…' }
  const r=await api('/api/log');
  const lines=(r&&r.lines)||[];
  $('#log').textContent=lines.slice(-120).reverse().join(String.fromCharCode(10));
  if(btn){ btn.disabled=false; btn.textContent='刷新' }
}
async function loadSet(){
  try{
    const c = await api("/api/config");
    const su = await api("/api/setup").catch(function(){ return {} });
    const br = await api("/api/brain").catch(function(){ return {} });
    const q = function(id,v){ const el=document.getElementById(id); if(el) el.value = (v===undefined||v===null) ? "" : v };
    q("sOwner", (su && (su.ownerUin || (su.qq && su.qq.ownerUin))) || "");
    q("sUrl", br.baseUrl || ""); q("sModel", br.model || ""); q("sKey", "");
    q("sPass", (c.ui && c.ui.pass) || "");
    try { const au = await api("/api/autostart"); const ae = document.getElementById("sAuto"); if(ae) ae.checked = !!(au && au.on); } catch(e) {}
    const lan = document.getElementById("sLan"); if(lan) lan.checked = !!(c.ui && c.ui.lan);
    const ge = document.getElementById("sGEnabled"); if(ge) ge.checked = !(c.groups && c.groups.enabled === false);
    const gn = document.getElementById("sGNeedCall"); if(gn) gn.checked = !(c.groups && c.groups.needCall === false);
  }catch(e){ toast("读取设置失败：" + e.message, false) }
}
async function putCfg(mut){
  const c = await api("/api/config");
  mut(c);
  await api("/api/config", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(c) });
}
async function saveOwner_legacy(b){
  const v = document.getElementById("sOwner").value.trim();
  if(!/^[0-9]{5,12}$/.test(v)) return toast("主人 QQ 要填数字", false);
  b.disabled = true;
  try{ await api("/api/setup", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ ownerUin: v }) }); toast("已保存") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
}
async function saveBrainPage(b){
  const baseUrl = document.getElementById("sUrl").value.trim();
  const model = document.getElementById("sModel").value.trim();
  const key = document.getElementById("sKey").value.trim();
  if(!model) return toast("模型不能为空", false);
  b.disabled = true;
  try{ const r = await api("/api/brain", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ baseUrl: baseUrl, model: model, key: key }) }); toast("已保存，下一条消息生效") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
}
async function saveBrainCfgBox(b){
  // 「设置」面板里的那份用 br* 字段；t-set 页用的是 s* 字段。两处各存各的，别互相顶。
  const baseUrl = (document.getElementById("brUrl") || {}).value || "";
  const model = (document.getElementById("brModel") || {}).value || "";
  const key = (document.getElementById("brKey") || {}).value || "";
  const bu = baseUrl.trim(), mo = model.trim(), ky = key.trim();
  if(!mo) return toast("模型不能为空", false);
  if(b) b.disabled = true;
  try{
    await api("/api/brain", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ baseUrl: bu, model: mo, key: ky }) });
    const m = document.getElementById("brMsg"); if(m) m.textContent = "已保存，" + (ky ? "重启桥接后生效" : "下一条消息生效");
    toast("已保存 API" + (ky ? "，点「重启桥接」后生效" : ""));
  }catch(e){ toast("保存失败：" + (e.message || e), false) }
  finally{ if(b) b.disabled = false }
}
async function saveAuto(b){
  const el = document.getElementById("sAuto");
  const on = !!(el && el.checked);
  if(b) b.disabled = true;
  try{
    const r = await api("/api/autostart", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ on: on }) });
    if(!r || !r.ok) throw new Error((r && r.err) || "没设成功");
    if(el) el.checked = !!r.on;
    toast(r.on ? "以后开机自动启动" : "已关掉开机自启");
  }catch(e){ toast("设置失败：" + (e.message || e), false); try { el.checked = !on; } catch(_) {} }
  finally{ if(b) b.disabled = false }
}

async function saveNet(b){
  const lanEl=document.getElementById("sLan"); if(!lanEl){ toast("手机上不用改这项"); return; } const lan = lanEl.checked;
  const pass = document.getElementById("sPass").value.trim();
  b.disabled = true;
  try{ await putCfg(function(c){ c.ui = c.ui || {}; c.ui.lan = lan; if(pass) c.ui.pass = pass }); toast("已保存，重启程序后生效") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
}
async function resetToken(b){
  if(!(await askConfirm('重置后旧二维码全部失效，需要重新扫。继续？', '重置二维码'))) return;
  b.disabled = true;
  try{ await putCfg(function(c){ c.ui = c.ui || {}; c.ui.qrToken = "" }); toast("已重置，重启程序后生成新码") }
  catch(e){ toast("失败：" + e.message, false) }
  finally{ b.disabled = false }
}
async function saveGroup(b){
  const en = document.getElementById("sGEnabled").checked;
  const nc = document.getElementById("sGNeedCall").checked;
  b.disabled = true;
  try{ await putCfg(function(c){ c.groups = c.groups || {}; c.groups.enabled = en; c.groups.needCall = nc }); toast("已保存") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
}
// 旧 tab 版控制台的启动与轮询已废弃（新版在 loadState / loadCfg 那条线上）
</script></body></html>`;

function qrToken() {
  try {
    const c = settings.load();
    let t = String((c.ui && c.ui.qrToken) || '');
    if (!t || t.length < 8) {
      t = crypto.randomBytes(9).toString('hex');
      settings.patch({ ui: { qrToken: t } });
    }
    return t;
  } catch { return ''; }
}
const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 控制台</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d11;color:#e6e9ef;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.b{width:min(92vw,340px);background:#12151b;border:1px solid #232833;border-radius:14px;padding:22px}
h1{font-size:17px;margin:0 0 14px}input{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #2b313d;background:#0f1217;color:#e6e9ef;font-size:16px}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:9px;background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;font-size:15px}
p{color:#8b93a1;font-size:12px;margin:10px 0 0}</style></head>
<body><form class="b" onsubmit="return go(event)"><h1>输入控制台密码</h1>
<input id="p" type="password" autocomplete="current-password" placeholder="密码" autofocus>
<button>进入</button><div id="m" style="color:#e2777a;font-size:13px;margin-top:8px;min-height:18px"></div>
<p>这个密码只管「手机 / 局域网其它设备」打开控制台。电脑上直接打开不需要输。<br>忘了密码：回到这台电脑上打开控制台即可（本机不用这个密码）。</p></form>
<script>async function go(e){e.preventDefault();const p=document.getElementById('p').value;
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:p})});
const btn=document.querySelector('button'),msg=document.getElementById('m');
btn.disabled=true;btn.textContent='验证中…';
try{
  if(r.ok){location.href='/'}
  else if(r.status===401){msg.textContent='密码不对，再试一次';msg.style.color='#e2777a'}
  else {msg.textContent='连不上，稍后再试';msg.style.color='#e2777a'}
}catch(err){msg.textContent='网络错误：'+err.message;msg.style.color='#e2777a'}
btn.disabled=false;btn.textContent='进入';document.getElementById('p').select();
return false}</script></body></html>`;

async function restartBridge() {
  const { pid } = alive();
  // 打包版（Electron）：bridge 与 ui 在同一个主进程里，pid 就是当前进程 → 整体重启，绝不 kill 自己
  if (!pid || pid === process.pid) {
    if (process.versions.electron) {
      try {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const { app } = req('electron');
        setTimeout(() => { try { app.relaunch(); app.exit(0); } catch {} }, 400);
        return true;
      } catch (e) { nlog('[restart] electron relaunch 失败', e.message); }
    }
    if (process.versions.electron) {
      nlog('[restart] 桥接与界面同进程，无法单独重启；请整体重启程序');
      return false;
    }
    nlog('[restart] 没有 bridge.pid，直接拉起桥接');
  }
  if (pid) { try { process.kill(pid); } catch {} }
  await new Promise((r) => setTimeout(r, 1200));
  try { fs.unlinkSync(PID); } catch {}
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: path.dirname(SRC_DIR),
    env: { ...process.env, QQBOT_DATA: RQ, QQBOT_IS_PACKAGED: process.env.QQBOT_IS_PACKAGED || "0" },
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // 公网/非白名单网段直接 403（连登录页都不给）
    if (!ipAllowed(req)) {
      return send(res, 403, '<!doctype html><meta charset="utf-8"><body style="background:#0f1115;color:#e6e8ee;font:16px/1.7 sans-serif;padding:48px"><h2>403</h2><p>这台设备所在网段不被允许访问。</p><p style="color:#8b93a3">允许的网段：' + allowCidrs().join(' , ') + '</p></body>');
    }

    // 写接口防跨站：带 Origin 时必须同源（防别的网页用你的浏览器改配置）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const org = req.headers.origin;
  const orgBad = org === 'null' || org === 'file://';
      if (org) {
        let ok = false;
        try { const o = new URL(org); ok = (o.host === String(req.headers.host || '')); } catch {}
        if (!ok || orgBad) return send(res, 403, { ok: false, err: 'cross-site blocked' });
      }
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = ipOf(req);
      const lock = lockedFor(ip);
      if (lock) return send(res, 429, { ok: false, err: '密码错太多次，' + lock + ' 分钟后再试' });
      const b = await body(req);
      const pass = passNow();
      const given = String((b && b.pass) || '');
      const ok = !pass || given === pass;
      if (!ok) {
        noteFail(ip);
        audit('login', req, 'fail');
        return send(res, 401, { ok: false, err: '密码不对' });
      }
      const days = (b && b.remember) ? 30 : 7;
      const { sid } = issueSession(req, days);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': COOKIE_NAME + '=' + encodeURIComponent(sid) + '; Path=/; Max-Age=' + (days * 86400) + '; SameSite=Lax; HttpOnly',
      });
      return res.end('{"ok":true}');
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const sid = sidOf(req);
      if (sid) saveSessions(loadSessions().filter((x) => x.sid !== sid));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': COOKIE_NAME + '=; Path=/; Max-Age=0' });
      return res.end('{"ok":true}');
    }

    {
      const qt = String(url.searchParams.get('t') || '');
      if (qt && qrToken() && qt === qrToken() && !authed(req)) {
        const { sid } = issueSession(req, 30);
        res.writeHead(302, {
          'Set-Cookie': COOKIE_NAME + '=' + encodeURIComponent(sid) + '; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly',
          Location: p + '?s=1',
        });
        return res.end();
      }
    }
    if (p === '/login' || (!authed(req) && p === '/')) return send(res, 200, LOGIN_HTML);
    if (!authed(req)) {
      return p.startsWith('/api/') ? send(res, 401, { ok: false, err: '需要登录' }) : send(res, 200, LOGIN_HTML);
    }

    if (p === '/api/auth/devices') {
      const list = loadSessions().map((x) => ({ sid: String(x.sid).slice(0, 8), ip: x.ip, ua: x.ua, t: x.t, last: x.last, cur: x.sid === sidOf(req) }));
      return send(res, 200, { ok: true, list });
    }
    if (p === '/api/auth/revoke' && req.method === 'POST') {
      const b = await body(req);
      const short = String((b && b.sid) || '');
      if (!short) return send(res, 400, { ok: false, err: 'sid?' });
      const keep = loadSessions().filter((x) => !String(x.sid).startsWith(short));
      saveSessions(keep);
      audit('revoke', req, short);
      return send(res, 200, { ok: true });
    }

    if (p === '/') return send(res, 200, HTML.replace('__WK_SCRIPT__', workdialog.bootstrap())
      .replace('__CONSOLE_LAYOUT__', () => fs.readFileSync(path.join(SRC_DIR, 'console-layout.js'), 'utf8'))
      .replace('__CONSOLE_STYLE__', () => fs.readFileSync(path.join(SRC_DIR, 'console-layout.css'), 'utf8')));

    if (p === '/api/app/restart' && req.method === 'POST') {
      send(res, 200, { ok: true, restarting: true });
      setTimeout(() => {
        try {
          if (process.versions && process.versions.electron) {
            const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
            spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
          }
        } catch {}
        try { process.exit(0); } catch {}
      }, 400);
      return;
    }
    if (p === '/api/qr/hold' && req.method === 'POST') {
    // 留时间给用户截图→开 QQ→扫；这段时间守护不换码
    const b = await body(req).catch(() => ({}));
    const minutes = Math.min(30, Math.max(1, Number(b.minutes) || 5));
    const until = Date.now() + minutes * 60 * 1000;
    try {
      fs.mkdirSync(PATHS.data, { recursive: true });
      fs.writeFileSync(path.join(PATHS.data, 'qr-hold.json'), JSON.stringify({ until }), 'utf8');
    } catch (e) { return send(res, 500, { ok: false, err: String(e.message || e) }); }
    return send(res, 200, { ok: true, minutes, until });
  }

  if (p === '/api/plugins' && req.method === 'GET') {
    try {
      const setup = loadSetup();
      const items = plugins.list(setup).map((m) => ({ ...m, missing: plugins.missing(m, setup) }));
      return send(res, 200, { ok: true, items });
    } catch (e) { return send(res, 500, { ok: false, err: String(e.message || e) }); }
  }

  if (p === '/api/plugins/toggle' && req.method === 'POST') {
    try {
      const b = await body(req);
      const id = String(b.id || '').trim();
      if (!id) return send(res, 400, { ok: false, err: '没有说要改哪个插件' });
      const cur = loadSetup();
      const st = { ...((cur.plugins || {})[id] || {}) };
      st.enabled = b.enabled !== false;
      saveSetup({ plugins: { ...(cur.plugins || {}), [id]: st } });
      return send(res, 200, { ok: true, id, enabled: st.enabled, needRestart: true });
    } catch (e) { return send(res, 500, { ok: false, err: String(e.message || e) }); }
  }

  // 一键接上：从 SnowLuma 自己的 config/onebot_<uin>.json 里读端口和两个 token。
  // 用户不该手抄这些东西 —— 之前就是抄错一个 token，401 查了半小时。
  if (p === '/api/qq/attach' && req.method === 'POST') {
    try {
      const setup = loadSetup();
      const dir = String((setup.snowluma && setup.snowluma.dir) || '');
      if (!dir) return send(res, 200, { ok: false, err: '先在下面填 SnowLuma 的文件夹（里面要有 launcher.bat）' });
      const cdir = path.join(dir, 'config');
      let file = '';
      try {
        const cand = fs.readdirSync(cdir).filter((f) => /^onebot_.*\.json$/i.test(f));
        if (cand.length) file = path.join(cdir, cand[0]);
      } catch {}
      if (!file) return send(res, 200, { ok: false, err: '这个文件夹里没有 config/onebot_*.json：SnowLuma 还没登录过，或者文件夹指错了' });
      let conf = {};
      try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return send(res, 200, { ok: false, err: '读不了 ' + path.basename(file) + '：' + String(e.message || e) }); }
      const nets = conf.networks || {};
      const ws = (nets.wsServers || [])[0] || {};
      const http = (nets.httpServers || [])[0] || {};
      if (!ws.port) return send(res, 200, { ok: false, err: '这个配置里没有开 WS 服务端：去 SnowLuma 面板把 OneBot 的 WS 开起来' });
      const patch = {
        qq: { protocol: 'snowluma' },
        onebot: {
          wsUrl: '',
          wsPort: Number(ws.port) || 3001,
          httpPort: Number(http.port) || 3000,
          accessToken: String(ws.accessToken || ''),
          httpToken: String(http.accessToken || ''),
        },
      };
      saveSetup(patch);
      let restarted = false;
      try { await fetch('http://127.0.0.1:' + (setup.ui && setup.ui.port || 3070) + '/api/restart', { method: 'POST' }); restarted = true; } catch {}
      return send(res, 200, {
        ok: true, restarted,
        ws: patch.onebot.wsPort, http: patch.onebot.httpPort,
        hasToken: !!patch.onebot.accessToken,
        from: path.basename(file),
      });
    } catch (e) {
      return send(res, 500, { ok: false, err: String(e.message || e) });
    }
  }

  if (p === '/api/qr/refresh' && req.method === 'POST') {
      const setup = (() => { try { return loadSetup(); } catch { return {}; } })();
      const protocol = qqProtocolOf(setup);
      if (protocol === 'snowluma') {
        const dir = String((setup.snowluma && setup.snowluma.dir) || '');
        const launcher = launcherNameIn(dir);
        if (!dir || !launcher) {
          return send(res, 200, { ok: false, mode: 'snowluma', err: '还没填好 SnowLuma 文件夹（里面要有 launcher.bat 或 launcher.sh）' });
        }
        try {
          if (process.platform === 'win32' && launcher.endsWith('.bat')) {
            spawn('cmd.exe', ['/c', 'launcher.bat'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false }).unref();
          } else {
            spawn('bash', [path.join(dir, launcher)], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
          }
        } catch (e) {
          return send(res, 200, { ok: false, mode: 'snowluma', err: '拉起 SnowLuma 失败：' + String((e && e.message) || e).slice(0, 200) });
        }
        try {
          const f = path.join(RQ, 'kernel-session.json');
          let prev = {};
          try { prev = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
          fs.writeFileSync(f, JSON.stringify({ ...prev, scanRequestedAt: Date.now(), protocol: 'snowluma' }, null, 2), 'utf8');
        } catch {}
        return send(res, 200, { ok: true, mode: 'snowluma', refreshing: true, webui: 'http://127.0.0.1:5099' });
      }
      // NapCat：杀掉内核 → 用计划任务重新拉起（重启后会写一张新码）
      send(res, 200, { ok: true, mode: 'napcat', refreshing: true });
      const sh = (cmd, args) => new Promise((r) => {
        try { execFile(cmd, args, { windowsHide: true, timeout: 20000 }, () => r()); } catch { r(); }
      });
      (async () => {
        // 只杀 NapCat 自己的进程树（/T 连带它拉起的那个 QQ 实例），不碰用户自己开的 QQ
        await sh('taskkill.exe', ['/F', '/IM', 'NapCatWinBootMain.exe', '/T']);
        await sh('taskkill.exe', ['/F', '/IM', 'NapCatWinBoot.exe', '/T']);
        await new Promise((r) => setTimeout(r, 1000));
        await sh('schtasks.exe', ['/run', '/tn', 'QQBotNapCatCore']);
        // 告诉守护：这是用户主动要的扫码，30 分钟内允许它自动拉起内核
        try {
          const f = path.join(RQ, 'kernel-session.json');
          let prev = {};
          try { prev = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
          fs.writeFileSync(f, JSON.stringify({ ...prev, scanRequestedAt: Date.now(), protocol: 'napcat' }, null, 2), 'utf8');
        } catch {}
      })();
      return;
    }
    if (p === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        name: '大肥鱼 · 控制台', short_name: '大肥鱼', start_url: '/m', scope: '/',
        display: 'standalone', background_color: '#0b0d11', theme_color: '#0b0d11',
      }));
    }
    if (p === '/m' || p === '/mobile') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache' });
      return res.end(MOBILE_HTML);
    }
    if (p === '/') {
      const ua = String(req.headers['user-agent'] || '');
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);   // 手机浏览器直接进手机页
      if (isMobile) { res.writeHead(302, { Location: '/m' }); return res.end(); }
    }
    if (p === '/api/net') {
      const cfg = settings.load();
      return send(res, 200, {
        lan: BIND_HOST === '0.0.0.0',
        pending: !!(cfg.ui && cfg.ui.lan) && BIND_HOST !== '0.0.0.0',
        bind: BIND_HOST,
        port: PORT,
        passSet: !!(process.env.QQBOT_UI_PASS || (cfg.ui && cfg.ui.pass)),
        pass: String(process.env.QQBOT_UI_PASS || (cfg.ui && cfg.ui.pass) || ''),
        urls: BIND_HOST === '0.0.0.0' ? lanUrls() : [],
        local: 'http://127.0.0.1:' + PORT,
      });
    }
    if (p === '/api/net/qr' && req.method === 'GET') {
      const host = (url.searchParams.get('u') || '') || (BIND_HOST === '0.0.0.0' ? (lanUrls()[0] || '') : '');
      if (!host) return send(res, 400, { ok: false, err: '没有内网地址' });
      const tk = qrToken();
      const qTarget = String(host).replace(/\/+$/, '') + '/m' + (tk ? ('?t=' + encodeURIComponent(tk)) : '');
      try {
        const buf = await QRCode.toBuffer(qTarget, { width: 320, margin: 1, color: { dark: '#0b1220', light: '#ffffff' } });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) {
        return send(res, 500, { ok: false, err: String(e && e.message) });
      }
    }

    // 自检：换电脑、重装、第一次用之前，先看这十项有没有坏（2026-11-01）
    if (p === '/api/doctor') {
      const items = [];
      const add = (id, level, label, detail, fix) => items.push({ id, level, label, detail: String(detail || ''), fix: String(fix || '') });
      try {
        const su = loadSetup() || {}; const a = su.api || {};
        const hasKey = !!String(a.key || '').trim();
        add('api', hasKey ? 'ok' : 'fail', '大模型接口',
          hasKey ? (a.model || '（没写模型）') + ' @ ' + (a.baseUrl || '默认地址') + ' · key 尾号 ' + String(a.key).slice(-4) : '还没有 API Key',
          hasKey ? '' : '去「模型页」填一个 key，再点「测试连接」');
      } catch { add('api', 'fail', '大模型接口', '读不到 setup.json', '去「模型页」把 API 重填一次'); }
      try {
        const probe = path.join(DIR, '.doctor-probe');
        fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
        add('data', 'ok', '数据目录可写', DIR, '');
      } catch (e) { add('data', 'fail', '数据目录不可写', String((e && e.message) || e), '磁盘满或没有写权限：' + DIR); }
      try {
        const t = readText(PERSONA);
        const n = t.trim().length;
        add('persona', n > 100 ? 'ok' : 'fail', '她的人设', n > 100 ? n + ' 字' : '没有人设或太短（' + n + ' 字）',
          n > 100 ? '' : '去「她」页写两句，或点「用图片自动生成描述」');
      } catch { add('persona', 'fail', '她的人设', '读不到 persona.md', '去「她」页保存一次'); }
      const a2 = alive();
      add('bridge', a2.alive ? 'ok' : 'fail', '桥接进程', a2.alive ? 'pid ' + a2.pid : '没在跑', a2.alive ? '' : '点「重启桥接」');
      try {
        const r = await fetch(LOCAL_URL() + '/ping', { signal: AbortSignal.timeout(1200) });
        add('local', r.ok ? 'ok' : 'warn', '本地通道 3098', r.ok ? '在听' : 'HTTP ' + r.status, r.ok ? '' : '重启桥接');
      } catch { add('local', 'fail', '本地通道 3098', '连不上', '重启桥接；一直不行就看日志'); }
      try {
        const r = await fetch(LOCAL_URL() + '/qq', { signal: AbortSignal.timeout(1200) });
        const j = await r.json();
        const ch = (j.channels || []).find((x) => x.id === 'qq') || j;
        add('qq', ch.online ? 'ok' : 'warn', 'QQ 通道（可选）', ch.online ? '已连上' : '没连上',
          ch.online ? '' : '不影响她用：QQ 没连时消息走本地窗口。要连就去「QQ」页扫码');
      } catch { add('qq', 'warn', 'QQ 通道（可选）', '查不到状态', '不影响使用'); }
      try {
        const files = fs.existsSync(MEMDIR) ? fs.readdirSync(MEMDIR) : [];
        add('memory', 'ok', '记忆库',
          files.filter((f) => f.endsWith('.json') && !f.includes('.archive.')).length + ' 个人 · '
          + files.filter((f) => f.includes('.archive.')).length + ' 份长期档案', '');
      } catch { add('memory', 'warn', '记忆库', '读不到目录', '不影响使用'); }
      try {
        const su = loadSetup() || {}; const w = su.work || {};
        const on = w.toolsEnabled === true;
        add('work', on ? 'ok' : 'warn', '动手能力', on ? '已允许（' + (w.execMode || 'ask') + '）' : '关着，她现在只能聊天',
          on ? '' : '要用就去「模型页」底部打开「允许她动电脑」，再「进入工作模式」选文件夹');
      } catch { add('work', 'warn', '动手能力', '读不到设置', '去「模型页」看一下'); }
      try {
        const st2 = fs.statfsSync ? fs.statfsSync(DIR) : null;
        const freeMB = st2 ? Math.round((st2.bfree * st2.bsize) / 1048576) : null;
        add('disk', (freeMB === null || freeMB > 500) ? 'ok' : 'warn', '磁盘空间', freeMB === null ? '查不到' : '剩 ' + freeMB + ' MB',
          (freeMB !== null && freeMB <= 500) ? '空间不多：她的画和备份会占地方' : '');
      } catch { add('disk', 'ok', '磁盘空间', '查不到（不影响）', ''); }
      try { add('version', 'ok', '版本', (readJSON(path.join(APP, 'package.json'), {}) || {}).version || '未知', ''); }
      catch { add('version', 'ok', '版本', '未知', ''); }
      return send(res, 200, { ok: !items.some((i) => i.level === 'fail'), at: Date.now(), items });
    }

    // 她在过日子：当前日程 / 今天发生的事 / 她手上还没做完的事。
    // 只报事实，第一屏用它替代 pid 和端口。
    if (p === '/api/her') {
      const d = daily.today();
      const mk = ownerUin();
      const hm = daily.nowHM();
      let plan = null, evs = [], lp = [];
      try { plan = daily.loadPlan(d); } catch {}
      try { evs = life.loadEvents(d); } catch {}
      try { lp = loops.open(mk); } catch {}
      const cur = plan ? daily.currentItem(plan) : null;
      const nxt = plan ? daily.nextItem(plan) : null;
      const past = (evs || []).filter((e) => e && e.at && e.at <= hm).slice(-2);
      return send(res, 200, {
        date: d,
        now: hm,
        doing: cur ? { at: cur.at, place: cur.place || '', what: cur.what } : null,
        next: nxt ? { at: nxt.at, what: nxt.what } : null,
        events: past.map((e) => ({ at: e.at, what: e.what })),
        loops: (lp || []).slice(0, 2).map((x) => ({ text: x.text, dueAt: x.dueAt || 0, kind: x.kind })),
        diary: (() => { try { const j = daily.lastJournal(); return j ? { date: j.date, text: String(j.text || '').slice(0, 1200) } : null; } catch { return null; } })(),
      });
    }
    if (p === '/api/state') {
      const a = alive();
      const QQE = (() => { try { const s2 = settings.load(); return !(s2.qq && s2.qq.enabled === false); } catch { return true; } })();
      // QQ 到底连没连上，只有桥接知道（NapCat 的 get_login_info 掉线时还会回缓存，不能信）
      let qqLive = null;
      try {
        const r = await fetch(LOCAL_URL() + '/qq', { signal: AbortSignal.timeout(700) });
        if (r.ok) qqLive = await r.json();
      } catch {}
      const login = await oneBot();
      const people = fs.existsSync(MEMDIR) ? fs.readdirSync(MEMDIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : [];
      const minds = fs.existsSync(MINDDIR) ? fs.readdirSync(MINDDIR).filter((f) => f.endsWith('.json')).map((f) => ({ uin: f.replace('.json', ''), ...readJSON(path.join(MINDDIR, f), {}) })) : [];
      const st = readJSON(STICKER_META, []);
      let kernel = [];
      try {
        const cl = path.join(DIR, 'napcat-console.log');
        if (fs.existsSync(cl)) kernel.push(...readText(cl).split(/\r?\n/).filter(Boolean).slice(-90));
      } catch {}
      try {
        const d = path.join(NAPCAT_DIR, 'logs');
        let newest = null;
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f); const s = fs.statSync(fp);
          if (s.isFile() && (!newest || s.mtimeMs > newest.m)) newest = { fp, m: s.mtimeMs };
        }
        if (newest) kernel.push('--- NapCat 文件日志 ---', ...readText(newest.fp).split(/\r?\n/).filter(Boolean).slice(-60));
      } catch {}
      let ncDir = NAPCAT_DIR;
      let qqProtocol = 'napcat';
      let snowlumaDir = '';
      let setup3 = {};
      try {
        setup3 = loadSetup();
        if (setup3.napcat && setup3.napcat.dir) ncDir = String(setup3.napcat.dir);
        qqProtocol = qqProtocolOf(setup3);
        snowlumaDir = String((setup3.snowluma && setup3.snowluma.dir) || '');
      } catch {}
      const ncReady = looksLikeNapCat(ncDir);
      const slReady = looksLikeSnowLuma(snowlumaDir);
      // NapCat 二维码文件：仅 napcat 协议读本地 png；SnowLuma 的码在 5099 网页里
      let qr = { exists: false, at: 0 };
      if (qqProtocol !== 'snowluma') {
        try {
          const qrPath = process.env.QQBOT_QR_FILE || path.join(ncDir, 'cache', 'qrcode.png');
          const s = fs.statSync(qrPath);
          qr = { exists: true, at: s.mtimeMs, path: qrPath };
        } catch {}
      }
      let snowlumaWebui = false;
      if (qqProtocol === 'snowluma') {
        try {
          const r = await fetch('http://127.0.0.1:5099/', { method: 'GET', signal: AbortSignal.timeout(1200) });
          snowlumaWebui = !!(r && (r.ok || r.status < 500));
        } catch {}
      }
      return send(res, 200, {
        qqEnabled: QQE,
        napcatDir: ncDir,
        napcatReady: ncReady,
        snowlumaReady: slReady,
        qqProtocol,
        snowlumaDir,
        snowlumaWebui,
        bridge: a, login, people, minds, qqLive,
        names: readJSON(NAMES, {}),
        ownerUin: ownerUin(),
        qqName: (() => { try { return String(loadSetup().qq?.name || ''); } catch { return ''; } })(),
        guard: readJSON(path.join(DIR, 'napcat-state.json'), {}),
        kernel,
        qr,
        proactive: readJSON(path.join(DIR, 'proactive.json'), {}),
        config: settings.load(),
        budget: budget.snapshot(),
        counts: { stickers: Array.isArray(st) ? st.length : 0, memories: people.length },
        log: logTail(60),
        seen: readText(path.join(DIR, 'life-seen.jsonl')).split(/\r?\n/).filter(Boolean).slice(-12).reverse(),
      });
    }

    if (p === '/favicon.ico' || p === '/icon.png') {
      const f = p === '/icon.png' ? path.join(DIR, 'assets', 'bot.png') : path.join(DIR, 'assets', 'bot.ico');
      if (!fs.existsSync(f)) return send(res, 404, 'no');
      res.writeHead(200, { 'Content-Type': p === '/icon.png' ? 'image/png' : 'image/x-icon', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(f));
    }

    if (p === '/api/qr/url') {
      // 把二维码图片解回官方授权链接：同一台手机扫不了自己屏幕，但可以直接打开链接唤起 QQ
      try {
        if (!fs.existsSync(QR_FILE)) return send(res, 200, { ok: false, err: '还没有二维码' });
        const png = PNG.sync.read(fs.readFileSync(QR_FILE));
        const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        if (!code || !code.data) return send(res, 200, { ok: false, err: '二维码没解出来' });
        return send(res, 200, { ok: true, url: code.data, at: fs.statSync(QR_FILE).mtimeMs });
      } catch (e) {
        return send(res, 200, { ok: false, err: String(e.message || e) });
      }
    }

    if (p === '/qr.png') {
      if (!fs.existsSync(QR_FILE)) return send(res, 404, 'no');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(QR_FILE));
    }

    if (p === '/api/self') {
      if (req.method === 'GET') return send(res, 200, self.info());
      const b = await body(req);
      const d = self.setDesc(b.desc);
      return send(res, 200, { ok: true, desc: d });
    }
    if (p === '/api/self/ref') {
      if (req.method === 'GET') {
        const f = self.refFile();
        if (!f) return send(res, 404, 'no');
        const ext = path.extname(f).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(f));
      }
      const b = await body(req);
      const m = String(b.dataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
      if (!m) return send(res, 400, { ok: false, err: '只收 png/jpg/webp' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) return send(res, 400, { ok: false, err: '图太大（>8MB）' });
      const name = self.setRef(buf, m[1].toLowerCase().replace('jpeg', 'jpg'));
      return send(res, 200, { ok: true, file: name });
    }
    if (p === '/api/self/describe' && req.method === 'POST') {
      try {
        const f = self.refFile();
        if (!f) return send(res, 400, { ok: false, err: '先上传一张参考图' });
        const vc = settings.load().vision || {};
        const api0 = loadSetup().api || apibrain.load() || {};
        let aliKey = '';
        try { const kp = path.join(PATHS.data, 'aliyun.key'); if (fs.existsSync(kp)) aliKey = String(fs.readFileSync(kp, 'utf8')).trim(); } catch {}
        const chosen = resolveVision(api0, vc, aliKey || process.env.DASHSCOPE_API_KEY || '', (settings.load().fallback || {}).vision !== false);
        if (chosen.mode === 'none') return send(res, 400, { ok: false, err: '请先在「模型页」的看图里配置可用模型' });
        const { baseUrl, model, key } = chosen;
        const ext = path.extname(f).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const b64 = fs.readFileSync(f).toString('base64');
        const r = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 400,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: '用中文详细描述这个角色的外形，供以后画图时保持一致：发色与发型、瞳色、服装与配饰、用户设定的特殊特征（如有）。只输出描述本身，160 字以内，不要解释。' },
                { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
              ],
            }],
          }),
        });
        const j = await r.json();
        const text = String(j?.choices?.[0]?.message?.content || '').trim();
        if (!text) return send(res, 502, { ok: false, err: '模型没返回内容（可能这个模型不支持看图）' });
        return send(res, 200, { ok: true, desc: text, model });
      } catch (e) {
        return send(res, 500, { ok: false, err: (e && e.message) || String(e) });
      }
    }
    if (p === '/api/persona') {
      if (req.method === 'GET') {
        try {
          const su = loadSetup() || {};
          ensurePersonaFile(PERSONA, { name: (su.qq || {}).name, age: (su.qq || {}).age, city: (su.qq || {}).city, persona: (su.qq || {}).persona });
        } catch {}
        return send(res, 200, { text: readText(PERSONA) });
      }
      const b = await body(req);
      fs.writeFileSync(PERSONA, String(b.text || ''), 'utf8');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/consolidate') {
  const uin = String(url.searchParams.get('uin') || '').trim();
  if (!memory.validUin(uin)) return send(res, 400, { ok: false, error: 'uin required' });
  try { return send(res, 200, { ok: true, uin, ...memory.consolidate(uin) }); }
  catch (e) { return send(res, 500, { ok: false, error: e.message }); }
}
  // 记忆银河：一次给全所有人的记忆（星图按人分簇用）
  if (p === '/api/memory/galaxy' && req.method === 'GET') {
    try {
      const st = loadSetup();
      const owner = String((st.qq || {}).ownerUin || '').trim();
      const dir = path.join(RQ_AGENT, 'memory', 'people');
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.bak')); } catch {}
      let names = {};
      try { names = JSON.parse(fs.readFileSync(path.join(RQ, 'names.json'), 'utf8')) || {}; } catch {}
      const people = [];
      for (const f of files) {
        const uin = f.replace(/\.json$/, '');
        if (!memory.validUin(uin)) continue;
        const items = memory.list(uin) || [];
        if (!items.length && uin !== owner) continue;
        const nm = names[uin] && names[uin].name ? String(names[uin].name) : '';
        people.push({ uin, name: nm || (uin === 'local' ? '本机（还没填 QQ）' : uin), isOwner: !!owner && uin === owner, items });
      }
      people.sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || b.items.length - a.items.length);
      return send(res, 200, { ok: true, owner, people, total: people.reduce((n, x) => n + x.items.length, 0) });
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }

  if (p === '/api/memory') {
      if (req.method === 'GET') {
        // 不带 uin 时退回主人号；全新安装还没填主人号，记忆就记在 local 名下
        let uin = String(url.searchParams.get('uin') || '').trim();
        if (!uin) { try { uin = String((loadSetup().qq || {}).ownerUin || '').trim() || 'local'; } catch { uin = 'local'; } }
        return send(res, 200, { uin, items: memory.list(uin) });
      }
      const b = await body(req);
            if (req.method === 'POST') {
        memory.remember(b.uin, b.text, { core: !!b.core });
        return send(res, 200, { ok: true, items: memory.list(b.uin) });
      }
      if (req.method === 'DELETE') {
        memory.forget(b.uin, Number(b.index));
        return send(res, 200, { ok: true, items: memory.list(b.uin) });
      }
      if (req.method === 'PUT') {
        memory.update(b.uin, Number(b.index), { text: b.text, kind: b.kind, w: b.w, touch: b.touch });
        return send(res, 200, { ok: true, items: memory.list(b.uin) });
      }
    }

    // 经验库（她自己从对话里学到的"这么说他受用"）+ 技能记录（工具成败）
    if (p === '/api/lessons') {
      const uin = String(url.searchParams.get('uin') || '');
      if (req.method === 'GET') return send(res, 200, { ok: true, uin, stats: lessons.stats(uin), items: lessons.list(uin) });
      const b = await body(req);
      const u = String(b.uin || uin);
      if (req.method === 'DELETE') {
        const n = lessons.remove(u, b.id);
        return send(res, 200, { ok: true, removed: n, stats: lessons.stats(u), items: lessons.list(u) });
      }
      if (req.method === 'POST' && b.clear) {
        lessons.reset(u);
        return send(res, 200, { ok: true, stats: lessons.stats(u), items: [] });
      }
      return send(res, 400, { ok: false, err: 'bad-request' });
    }
    if (p === '/api/skills') {
      const uin = String(url.searchParams.get('uin') || '');
      if (req.method === 'GET') return send(res, 200, { ok: true, uin, stats: skills.stats(uin), items: skills.list(uin).slice(-40) });
      const b = await body(req);
      const u = String(b.uin || uin);
      if (req.method === 'DELETE') return send(res, 200, { ok: true, removed: skills.remove(u, b.at), stats: skills.stats(u) });
      if (req.method === 'POST' && b.clear) { skills.reset(u); return send(res, 200, { ok: true, stats: skills.stats(u), items: [] }); }
      return send(res, 400, { ok: false, err: 'bad-request' });
    }

    // 审批：她要跑命令时，桥接在 3098 挂一张待办卡片，这里转发给控制台
    if (p === '/api/approvals' && req.method === 'GET') {
      try {
        const r = await fetch(LOCAL_URL() + '/approvals');
        return send(res, 200, await r.json());
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/approve' && req.method === 'POST') {
      const b = await body(req);
      try {
        const r = await fetch(LOCAL_URL() + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, ok: !!b.ok }) });
        return send(res, 200, await r.json());
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }

    // 工作模式：进入/停止/续期/建议路径，全部转发给桥接（3098）；这里不自己判权限
    if (p === '/api/backup' && req.method === 'GET') {
      try { const r = await fetch(LOCAL_URL() + '/backup'); return send(res, 200, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/backup/run' && req.method === 'POST') {
      try {
        const raw = await body(req).catch(() => ({}));
        const r = await fetch(LOCAL_URL() + '/backup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw || {}) });
        return send(res, 200, await r.json());
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/work/dirs' && req.method === 'GET') {
    try { const r = await fetch(LOCAL_URL() + '/work/dirs' + (url.search || '')); return send(res, 200, await r.json()); }
    catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
  }
  if (p === '/api/work' && req.method === 'GET') {
      try { const r = await fetch(LOCAL_URL() + '/work'); return send(res, 200, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/work/suggest' && req.method === 'GET') {
      const q = new URL('http://x' + req.url).searchParams.get('topic') || '';
      try { const r = await fetch(LOCAL_URL() + '/work/suggest?topic=' + encodeURIComponent(q)); return send(res, 200, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if ((p === '/api/work/start' || p === '/api/work/stop' || p === '/api/work/touch' || p === '/api/work/mode' || p === '/api/work/tools' || p === '/api/work/pick-dir' || p === '/api/work/restore' || p === '/api/work/undo') && req.method === 'POST') {
      const b = await body(req);
      const to = LOCAL_URL() + p.replace('/api', '');
      try { const r = await fetch(to, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return send(res, r.status, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }

    // 删除某个号的全部记忆（先改名成 .deleted-<时间> 备份，不直接删）+ 一键清理空记忆
    if (p === '/api/memory/person' && req.method === 'POST') {
      const b = await body(req);
      const ts = new Date().toISOString().replace(/:/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
      const dropOne = (uin) => {
        const moved = [];
        const scan = (dir, prefix) => {
          try {
            if (!fs.existsSync(dir)) return;
            for (const f of fs.readdirSync(dir)) {
              if (!f.startsWith(prefix) || f.includes('.deleted-')) continue;
              const from = path.join(dir, f);
              try { fs.renameSync(from, from + '.deleted-' + ts); moved.push(f); } catch {}
            }
          } catch {}
        };
        scan(MEMDIR, uin + '.');
        scan(MEM_LOG, uin + '.');
        scan(CHATDIR, uin + '.');
        scan(MINDDIR, uin + '.');
        scan(DIARYDIR, uin + '-');
        try {
          const names = readJSON(NAMES, {});
          if (names[uin]) { delete names[uin]; writeJSON(NAMES, names); moved.push('names.json'); }
        } catch {}
        return moved;
      };
      const listPeople = () => fs.existsSync(MEMDIR) ? fs.readdirSync(MEMDIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
      const OWNER = ownerUin();
      if (b.empty) {
        const removed = [];
        for (const u of listPeople()) {
          if (OWNER && String(u) === OWNER) continue;   // 主人号永远不进"清空记忆"的批量里
          let n = 0;
          try { n = memory.list(u).length; } catch {}
          if (n === 0) { dropOne(u); removed.push(u); }
        }
        return send(res, 200, { ok: true, removed, people: listPeople().filter((u) => !removed.includes(u)) });
      }
      if (!memory.validUin(b.uin)) return send(res, 400, { ok: false, err: 'uin 不合法' });
      // 主人号：必须手打一遍 uin + 一次性授权码，两道都对才动
      if (OWNER && String(b.uin) === OWNER) {
        if (String(b.confirmUin || '') !== String(b.uin)) {
          return send(res, 400, { ok: false, code: 'confirm-uin', err: '要把主人号的 uin 完整打一遍才算确认' });
        }
      }
      return send(res, 200, { ok: true, uin: b.uin, moved: dropOne(b.uin) });
    }

    if (p === '/api/stickers') {
      if (req.method === 'GET') return send(res, 200, { items: readJSON(STICKER_META, []) });
      const b = await body(req);
      const list = readJSON(STICKER_META, []);
      if (req.method === 'POST') {
        const it = list.find((x) => x.file === b.file);
        if (it) it.tag = b.tag;
        writeJSON(STICKER_META, list);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const it = list.find((x) => x.file === b.file);
        const next = list.filter((x) => x.file !== b.file);
        writeJSON(STICKER_META, next);
        if (it) { try { fs.unlinkSync(path.join(STICKERS, it.file)); } catch {} }
        return send(res, 200, { ok: true });
      }
    }

    if (p.startsWith('/drawn/')) {
      const f = path.basename(decodeURIComponent(p.slice(7)));
      const full = path.join(PATHS.data, 'drawn', f);
      if (!fs.existsSync(full)) return send(res, 404, 'no');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }

    if (p.startsWith('/sticker/')) {
      const f = path.basename(decodeURIComponent(p.slice(9)));
      const full = path.join(STICKERS, f);
      if (!fs.existsSync(full)) return send(res, 404, 'no');
      const ext = path.extname(f).toLowerCase();
      const type = ext === '.gif' ? 'image/gif' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type });
      return res.end(fs.readFileSync(full));
    }

    if (p === '/api/interests') {
      if (req.method === 'GET') return send(res, 200, readJSON(INTERESTS, {}));
      const b = await body(req);
      writeJSON(INTERESTS, b);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/config') {
      if (req.method === 'GET') return send(res, 200, settings.load());
      const b = await body(req);
      settings.save(b);
      return send(res, 200, { ok: true, config: settings.load() });
    }

    if (p === '/api/prompts/defaults') {
      const D = settings.DEFAULTS || {};
      return send(res, 200, { prompts: D.prompts || {}, drawStyle: D.drawStyle || 'anime' });
    }

    if (p === '/api/scenes') {
      if (req.method === 'GET') return send(res, 200, { items: scenes.list().map((x) => ({ id: x.id, name: x.name, desc: x.desc, at: x.updatedAt, hits: x.hits })) });
      if (req.method === 'DELETE') {
        const b = await body(req);
        const ok = scenes.remove(String(b.id || ''));
        return send(res, ok ? 200 : 404, { ok });
      }
    }

    if (p.startsWith('/scene/')) {
      const id = decodeURIComponent(p.slice(7));
      const fp = scenes.fileOf(id);
      if (fp && fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return fs.createReadStream(fp).pipe(res); }
      return send(res, 404, { ok: false });
    }

    if (p === '/api/voice') {
      const v = await import('./voice.mjs');
      return send(res, 200, { info: v.voiceInfo(), cfg: settings.load().tts || {} });
    }

    if (p === '/api/voices') {
      if (req.method === 'GET') { const v = loadVoices(); return send(res, 200, { list: v.list, custom: v.custom }); }
      const cur = loadVoices();
      if (req.method === 'POST') {
        const b = await body(req);
        const id = String(b.id || '').trim();
        const name = String(b.name || '').trim() || id;
        if (!/^[\w.\-]{2,64}$/.test(id)) return send(res, 400, { ok: false, err: 'ID 只能用字母数字下划线点横线（2-64 位）' });
        if (cur.list.some(x => x.id === id)) return send(res, 409, { ok: false, err: '这个音色 ID 已经有了' });
        writeJSON(VOICES_FILE, cur.custom.concat([{ id, name }]));
        return send(res, 200, { ok: true, list: loadVoices().list });
      }
      if (req.method === 'DELETE') {
        const id = String(url.searchParams.get('id') || '');
        const custom = cur.custom.filter(v => v.id !== id);
        if (custom.length === cur.custom.length) return send(res, 400, { ok: false, err: '内置音色不能删（或者没找到）' });
        writeJSON(VOICES_FILE, custom);
        const cfg = settings.load();
        if (cfg.tts && cfg.tts.voiceId === id) { cfg.tts.voiceId = ''; settings.save(cfg); }
        return send(res, 200, { ok: true, list: loadVoices().list });
      }
      return send(res, 405, { ok: false, err: 'method not allowed' });
    }

    if (p === '/api/draw/test' && req.method === 'POST') {
      try {
        const b = await body(req).catch(() => ({}));
        const d = await import('./draw.mjs');
        const r = await d.selfTest(String((b && b.prompt) || '一只蓝色小鲸鱼女仆，Q版卡通，白色背景').slice(0, 200));
        send(res, 200, r);
      } catch (e) { console.error('[draw/test]', (e && e.stack) || e); send(res, 500, { ok: false, err: (e && e.message) || String(e) }); }
      return;
    }
    if (p === '/api/draw/info') {
      try { const d = await import('./draw.mjs'); send(res, 200, d.info()); } catch (e) { send(res, 500, { err: e.message }); }
      return;
    }

    // 看图能力自检：大脑模型能不能看图？不能的话有没有兜底？
    if (p === '/api/vision/info') {
      try {
        const cfgS = settings.load(), brainApi = loadSetup().api || {};
        let aliKey = '';
        try { aliKey = String(fs.readFileSync(path.join(PATHS.data, 'aliyun.key'), 'utf8')).trim(); } catch {}
        aliKey = aliKey || process.env.DASHSCOPE_API_KEY || '';
        const chosen = resolveVision(brainApi, cfgS.vision || {}, aliKey, (cfgS.fallback || {}).vision !== false);
        const notes = {
          brain: '大脑支持看图，图片跟随大脑；单独接口保留供切回纯文本大脑时使用',
          custom: '大脑不能看图，使用单独配置的视觉接口',
          fallback: '大脑不能看图，已启用百炼视觉兜底',
          none: '大脑不能看图，请配置一个视觉接口'
        };
        send(res, 200, { mode: chosen.mode, model: chosen.model, note: notes[chosen.mode], brainModel: brainApi.model, brainOk: looksVision(brainApi.model), aliok: !!aliKey });
      } catch (e) { send(res, 500, { err: (e && e.message) || String(e) }); }
      return;
    }

    // 模型候选：能拉就拉（OpenAI 兼容的 /models），拉不到就给一份内置清单
    if (p === '/api/models/probe' && req.method === 'POST') {
      try {
        const b = await body(req).catch(() => ({}));
        const kind = String((b && b.kind) || 'chat');
        const cfg = settings.load();
        const brain = loadSetup().api || {};
        let base = String((b && b.baseUrl) || '').replace(/\/+$/, '');
        let key = String((b && b.key) || '');
        // 语音识别：填了 OpenAI 兼容地址就真拉 /models，没填给内置清单
        if (kind === 'asr' && !String((b && b.baseUrl) || '').trim()) {
          return send(res, 200, { ok: true, ids: ['whisper-1', 'gpt-4o-transcribe', 'FunAudioLLM/SenseVoiceSmall'], from: '内置清单（ASR）' });
        }
        // 语音：没填地址就走内置清单；填了第三方网关就去真拉
        if (kind === 'tts' && !String((b && b.baseUrl) || '').trim()) {
          return send(res, 200, { ok: true, ids: ['cosyvoice-v2', 'cosyvoice-v3-plus', 'cosyvoice-v1'], from: '内置清单（百炼 TTS）' });
        }
        // 看图：没单独配地址时，桥接会自动用百炼的 qwen3-vl-plus，这里也给视觉候选
        if (kind === 'vision' && !(cfg.vision && cfg.vision.baseUrl)) {
          return send(res, 200, { ok: true, ids: ['qwen3-vl-plus', 'qwen-vl-max', 'glm-4v', 'doubao-1-5-vision-pro-32k-250115'], from: '内置清单（留空时自动用百炼 qwen3-vl-plus）' });
        }
        if (!base && kind === 'draw') {
          const prov = String((cfg.draw && cfg.draw.provider) || 'auto').toLowerCase();
          if (prov === 'ark' || prov === 'volc' || prov === 'volcengine' || /^(doubao|seedream|ep-)/i.test(String((cfg.draw && cfg.draw.model) || ''))) base = 'https://ark.cn-beijing.volces.com/api/v3';
          else if (prov === 'dashscope') base = 'https://dashscope.aliyuncs.com';
        }
        if (!base) {
          if (kind === 'vision') base = (cfg.vision && cfg.vision.baseUrl) || brain.baseUrl || '';
          else if (kind === 'draw') base = (cfg.draw && cfg.draw.baseUrl) || '';
          else base = brain.baseUrl || '';
        }
        if (!key) {
          if (kind === 'asr') key = (cfg.asr && cfg.asr.key) || brain.key || '';
          else if (kind === 'vision') key = (cfg.vision && cfg.vision.key) || brain.key || '';
          else if (kind === 'draw') key = (cfg.draw && cfg.draw.key) || '';
          else key = brain.key || '';
        }
        // 画图：火山方舟其实有 GET /models（返回账号可见的模型目录，带 domain 字段），
        // 能查到就按 ImageGeneration 过滤出真 ID；阿里云没这个接口，用内置清单。
        if (kind === 'draw') {
          const nowModel = String((cfg.draw && cfg.draw.model) || '');
          let isArk = /volces\.com|ark/i.test(base)
            || ['ark', 'volc', 'volcengine'].includes(String((cfg.draw && cfg.draw.provider) || '').toLowerCase())
            || /^(doubao|seedream|seedance|ep-|ark-)/i.test(nowModel);
          if (!isArk && !String((b && b.baseUrl) || '').trim() && !(cfg.draw && cfg.draw.baseUrl)) {
            // 没配地址、模型也看不出是哪家：只要本地有 ark key 就先当火山
            try { isArk = !!readJSON ? fs.existsSync(path.join(DIR, 'ark.key')) : false; } catch {}
          }
          if (isArk) {
            let k2 = key;
            if (!k2) { try { k2 = fs.readFileSync(path.join(DIR, 'ark.key'), 'utf8').trim(); } catch {} }
            if (k2) {
              try {
                const ar = await fetch('https://ark.cn-beijing.volces.com/api/v3/models', {
                  headers: { Authorization: 'Bearer ' + k2 }, signal: AbortSignal.timeout(12000),
                });
                const aj = await ar.json().catch(() => ({}));
                const arr = Array.isArray(aj.data) ? aj.data : [];
                const ids = arr
                  .filter(m => String(m.domain || '') === 'ImageGeneration')
                  .map(m => String(m.id || ''))
                  .filter(Boolean);
                if (ids.length) {
                  return send(res, 200, { ok: true, ids, from: '火山方舟 /models（ImageGeneration）' });
                }
              } catch {}
            }
            return send(res, 200, {
              ok: true,
              ids: ['doubao-seedream-4-0-20260415', 'doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128'],
              from: '内置清单（火山：查不到目录时用这串，控制台里能复制准确 ID）',
            });
          }
          return send(res, 200, { ok: true, ids: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wan2.2-t2i-flash', 'wanx-v1'], from: '内置清单（阿里云万相）' });
        }
        // 火山方舟没有公开的 /models，直接给已知清单
        if (/volces\.com|ark/i.test(base)) {
          const list = [
            'doubao-seedream-5-0-flash-250828',
            'doubao-seedream-4-0-250828',
            'doubao-seedream-3-0-t2i-250415',
            'doubao-seed-1-6-250615',
            'doubao-1-5-vision-pro-32k-250115',
          ];
          return send(res, 200, { ok: true, ids: list, from: '内置清单（火山，控制台里有准确 ID 就手填 / ep-…）' });
        }
        if (!base) return send(res, 200, { ok: false, err: '没有可用的接口地址' });
        const url = base + (/\/v\d+\/?$/.test(base) ? '/models' : '/v1/models');
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        let r;
        try {
          r = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: ctl.signal });
        } finally { clearTimeout(timer); }
        const txt = await r.text();
        if (!r.ok) {
          // 阿里云百炼的 tts/画图没有 /models，这里给清单兜底
          if (kind === 'tts') return send(res, 200, { ok: true, ids: ['cosyvoice-v2', 'cosyvoice-v3-plus', 'cosyvoice-v1'], from: '内置清单（百炼 TTS）' });
          if (kind === 'draw') return send(res, 200, { ok: true, ids: ['wanx2.1-t2i-turbo', 'wan2.2-t2i-flash', 'wanx-v1'], from: '内置清单（百炼画图）' });
          return send(res, 200, { ok: false, err: 'HTTP ' + r.status + ' ' + txt.slice(0, 120) });
        }
        let j = {};
        try { j = JSON.parse(txt); } catch {}
        const ids = (j.data || j.models || j.body?.data || []).map(x => x.id || x.name || x.model).filter(Boolean);
        send(res, 200, { ok: ids.length > 0, ids, err: ids.length ? '' : '接口没返回模型列表' });
      } catch (e) {
        send(res, 200, { ok: false, err: (e && e.message) || String(e) });
      }
      return;
    }

    if (p === '/api/voice/test' && req.method === 'POST') {
      const t0 = Date.now();
      try {
        const b = await body(req).catch(() => ({}));
        const text = String((b && b.text) || '这是试听，我是大肥鱼。').slice(0, 120);
        const v = await import('./voice.mjs');
        const tts = v.ttsCfg ? v.ttsCfg() : {};
        if (b && b.voiceId) { const cfg = settings.load(); cfg.tts = cfg.tts || {}; cfg.tts.voiceId = String(b.voiceId); settings.save(cfg); }
        const wav = await v.ttsPreview(text);
        const rate = wav.readUInt32LE(24) || 24000;
        return send(res, 200, {
          ok: true, ms: Date.now() - t0, provider: tts.provider || 'aliyun',
          voiceId: v.voiceInfo ? v.voiceInfo().voiceId : '',
          bytes: wav.length, secs: Math.round((wav.length - 44) / (rate * 2) * 10) / 10,
          wav: wav.toString('base64'),
        });
      } catch (e) {
        return send(res, 200, { ok: false, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 300) });
      }
    }

    if (p === '/api/setup') {
      const s = loadSetup();
      if (req.method === 'GET') {
        return send(res, 200, {
          ownerUin: String(s.qq?.ownerUin || s.qq?.master || ''),
          uin: String(s.qq?.uin || ''),
          name: String(s.qq?.name || ''),
          protocol: s.qq?.protocol === 'napcat' ? 'napcat' : 'snowluma',
          napcatDir: String(s.napcat?.dir || ''),
          snowlumaDir: String(s.snowluma?.dir || ''),
          dataDir: PATHS.data,
          locFile: PATHS.locFile || '',
          keySet: !!(s.api && s.api.key),
          introDone: !!(s.intro && s.intro.done),
        });
      }
      const b = await body(req);
      const patch = { qq: {} };
      // 协议端选择与路径记在 setup；扫码/拉起按 qq.protocol 分流（见 /api/qr/refresh）。
      if (b.protocol !== undefined) {
        patch.qq.protocol = String(b.protocol) === 'snowluma' ? 'snowluma' : 'napcat';
      }
      if (b.clientDir !== undefined) {
        const dir = String(b.clientDir || '').trim().slice(0, 400);
        const protocol = patch.qq.protocol || (s.qq && s.qq.protocol === 'napcat' ? 'napcat' : 'snowluma');
        if (protocol === 'snowluma') patch.snowluma = { ...(s.snowluma || {}), dir };
        else patch.napcat = { dir };
      }
      if (b.onebot !== undefined) {
        const ob = b.onebot || {};
        patch.onebot = { ...(s.onebot || {}) };
        if (ob.wsUrl !== undefined) patch.onebot.wsUrl = String(ob.wsUrl || '').trim().slice(0, 200);
        if (ob.accessToken !== undefined) patch.onebot.accessToken = String(ob.accessToken || '').trim().slice(0, 200);
        if (ob.httpToken !== undefined) patch.onebot.httpToken = String(ob.httpToken || '').trim().slice(0, 200);
        if (ob.wsPort !== undefined) patch.onebot.wsPort = Number(ob.wsPort) || 3001;
      }
      if (b.ownerUin !== undefined) {
        const owner = String(b.ownerUin || '').replace(/\D/g, '').slice(0, 12);
        patch.qq.ownerUin = owner; patch.qq.master = owner;
      }
      if (b.name !== undefined) patch.qq.name = String(b.name || '').trim().slice(0, 24);
      if (b.introDone !== undefined) patch.intro = { ...(s.intro || {}), done: !!b.introDone };
      saveSetup(patch);
      return send(res, 200, { ok: true, ownerUin: patch.qq.ownerUin || '', name: patch.qq.name || '' });
    }

    // 能力探测：五盏灯里"语音/识别"两盏不按配置字段判，按这台机器真能不能跑。
    if (p === '/api/caps') {
      try {
        const r = await caps.caps(settings.load());
        return send(res, 200, r);
      } catch (e) {
        return send(res, 200, { err: String(e && e.message || e) });
      }
    }

    if (p === '/api/open-wizard' && req.method === 'POST') {
      try {
        const pf = path.join(PATHS.data, 'notify.port');
        let port = 0;
        try { port = parseInt(String(fs.readFileSync(pf, 'utf8') || '').trim(), 10); } catch {}
        if (port) {
          const j = await new Promise((resolve, reject) => {
            const rq = http.request({
              host: '127.0.0.1', port, path: '/open-wizard', method: 'POST', timeout: 4000,
            }, (rs) => {
              let buf = '';
              rs.on('data', (c) => { buf += c; });
              rs.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({ ok: false }); } });
            });
            rq.on('error', reject);
            rq.on('timeout', () => rq.destroy(new Error('超时')));
            rq.end();
          });
          if (j && j.ok) return send(res, 200, { ok: true, switched: true });
        }
      } catch {}
      try {
        const { pathToFileURL } = await import('node:url');
        const m = await import(pathToFileURL(path.join(APP, 'launch.mjs')).href);
        const pending = m && m.startWizard ? m.startWizard() : Promise.resolve();
        pending.catch(() => {});
        const url = 'http://127.0.0.1:' + (Number(process.env.QQBOT_WIZARD_PORT) || 3071) + '/';
        const t0 = Date.now();
        let up = false;
        while (Date.now() - t0 < 8000) {
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout(700) });
            if (r.ok) { up = true; break; }
          } catch {}
          await new Promise((r) => setTimeout(r, 250));
        }
        return send(res, 200, up ? { ok: true, url } : { ok: false, err: '向导没起来' });
      } catch (e) {
        return send(res, 200, { ok: false, err: String((e && e.message) || e).slice(0, 160) });
      }
    }

    if (p === '/api/open-data' && req.method === 'POST') {
      try {
        spawn('explorer.exe', [PATHS.data], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true, dir: PATHS.data });
      } catch (e) {
        return send(res, 200, { ok: false, err: String((e && e.message) || e).slice(0, 200) });
      }
    }

    if (p === '/api/autostart') {
      try {
        const pf = path.join(PATHS.data, 'notify.port');
        const port = parseInt(String(fs.readFileSync(pf, 'utf8') || '').trim(), 10);
        if (!port) return send(res, 200, { ok: false, err: '主程序还没起本地服务，重启一次程序再试' });
        const call = (method, payload) => new Promise((resolve, reject) => {
          const bodyStr = payload ? JSON.stringify(payload) : '';
          const rq = http.request({
            host: '127.0.0.1', port, path: '/autostart', method, timeout: 4000,
            headers: bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {},
          }, (rs) => {
            let buf = '';
            rs.on('data', (c) => { buf += c; });
            rs.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { reject(new Error('返回不是 JSON')); } });
          });
          rq.on('error', reject);
          rq.on('timeout', () => rq.destroy(new Error('超时')));
          if (bodyStr) rq.write(bodyStr);
          rq.end();
        });
        if (req.method === 'GET') {
          const j = await call('GET');
          return send(res, 200, { ok: true, on: !!(j && j.on) });
        }
        // 注意：body() 返回的是已经解析好的对象，不是字符串
        const raw = await body(req);
        const want = !!(raw && raw.on);
        const j2 = await call('POST', { on: want });
        return send(res, 200, { ok: !!(j2 && j2.ok), on: !!(j2 && j2.on) });
      } catch (e) {
        return send(res, 200, { ok: false, err: String((e && e.message) || e).slice(0, 120) });
      }
    }

    if (p === '/api/brain') {
      const s = loadSetup();
      if (req.method === 'GET') {
        const k = s.api?.key || '';
        return send(res, 200, {
          baseUrl: s.api?.baseUrl || '', model: s.api?.model || '',
          keySet: !!k, keyMask: k ? k.slice(0, 6) + '…' + k.slice(-4) : '',
        });
      }
      const b = await body(req);
      const cur = s.api || {};
      const patch = { api: { baseUrl: String(b.baseUrl || cur.baseUrl || ''), model: String(b.model || cur.model || '') } };
      const nk = String(b.key || '').trim();
      if (nk) patch.api.key = nk;
      saveSetup(patch);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/brain/models' && req.method === 'POST') {
      const b = await body(req);
      const s = loadSetup();
      const baseUrl = String(b.baseUrl || '').trim() || s.api?.baseUrl || '';
      const key = String(b.key || '').trim() || s.api?.key || '';
      if (!baseUrl || !key) return send(res, 200, { ok: false, err: '先填接口地址和 key' });
      try {
        const r = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
          headers: { Authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(20000),
        });
        const txt = await r.text();
        if (!r.ok) return send(res, 200, { ok: false, err: 'HTTP ' + r.status + ' ' + txt.slice(0, 160) });
        const j = JSON.parse(txt);
        const models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        return send(res, 200, { ok: true, models });
      } catch (e) {
        return send(res, 200, { ok: false, err: String(e.message || e).slice(0, 160) });
      }
    }

    if (p === '/api/brain/test' && req.method === 'POST') {
      const b = await body(req);
      const s = loadSetup();
      const key = String(b.key || '').trim() || s.api?.key || '';
      const baseUrl = String(b.baseUrl || '').trim() || s.api?.baseUrl || '';
      const model = String(b.model || '').trim() || s.api?.model || '';
      return send(res, 200, await testKey({ baseUrl, key, model }));
    }

    if (p === '/api/budget') {      if (req.method === 'GET') return send(res, 200, budget.snapshot());
      const b = await body(req);
      if (b.action === 'reset') budget.reset();
      if ('actual' in b) budget.setActual(b.actual);
      return send(res, 200, budget.snapshot());
    }

    if (p === '/api/restart' && req.method === 'POST') {
      await restartBridge();
      return send(res, 200, { ok: true });
    }

    // —— 聊天头像 ——
    if (p === '/api/chat/avatar' || p.startsWith('/api/chat/avatar/')) {
      const who = (p === '/api/chat/avatar' ? 'her' : (p.slice('/api/chat/avatar/'.length).replace(/[^a-z]/g, '') || 'her'));
      const dir = path.join(PATHS.data, 'chat', 'avatars');
      const findFile = () => { try { for (const fn0 of fs.readdirSync(dir)) if (fn0.startsWith(who + '.')) return path.join(dir, fn0); } catch {} return null; };
      if (req.method === 'GET') {
        const file = findFile();
        if (file) {
          const e2 = path.extname(file).toLowerCase();
          const ct = e2 === '.png' ? 'image/png' : e2 === '.webp' ? 'image/webp' : e2 === '.gif' ? 'image/gif' : 'image/jpeg';
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
          return res.end(fs.readFileSync(file));
        }
        const emo = who === 'me' ? '🧑' : '🐟';
        const bg = who === 'me' ? '#2c5cff' : '#1b2030';
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="68" height="68"><rect width="68" height="68" rx="34" fill="' + bg + '"/><text x="34" y="46" font-size="32" text-anchor="middle">' + emo + '</text></svg>';
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
        return res.end(svg);
      }
      if (req.method === 'DELETE') {
        const file = findFile();
        if (file) { try { fs.unlinkSync(file); } catch {} }
        return send(res, 200, { ok: true, cleared: who });
      }
      if (req.method === 'POST') {
        const b = await body(req).catch(() => ({}));
        const who2 = (String(b.who || '').replace(/[^a-z]/g, '') || 'her');
        const mm = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(String(b.dataUrl || ''));
        if (!mm) return send(res, 400, { ok: false, err: '给一张 png/jpg/webp/gif' });
        const buf = Buffer.from(mm[2], 'base64');
        if (buf.length > 3 * 1024 * 1024) return send(res, 400, { ok: false, err: '图太大（上限 3MB）' });
        fs.mkdirSync(dir, { recursive: true });
        for (const fn0 of fs.readdirSync(dir)) if (fn0.startsWith(who2 + '.')) fs.unlinkSync(path.join(dir, fn0));
        const ext = mm[1].toLowerCase() === 'jpeg' ? 'jpg' : mm[1].toLowerCase();
        fs.writeFileSync(path.join(dir, who2 + '.' + ext), buf);
        return send(res, 200, { ok: true, who: who2, bytes: buf.length });
      }
      return send(res, 405, { ok: false });
    }
    // ---------- 语音输入：WAV -> 文字（云端优先，本地兜底） ----------
    if (p === '/api/asr' && req.method === 'POST') {
      try {
        const chunks = [];
        await new Promise((resolve) => { req.on('data', (c) => chunks.push(c)); req.on('end', resolve); });
        const buf = Buffer.concat(chunks);
        if (!buf.length) return send(res, 200, { ok: false, err: '没有音频' });
        if (buf.length > 12 * 1024 * 1024) return send(res, 200, { ok: false, err: '音频太大' });
        const b64 = buf.toString('base64');
        // 云端：阿里云 qwen3-asr-flash（OpenAI 兼容端点，实测可用）
        let key = '';
        try { key = String((settings.load().asr || {}).key || ''); } catch {}
        if (!key) { try { key = fs.readFileSync(PATHS.data + '\\aliyun.key', 'utf8').trim(); } catch {} }
        if (key) {
          const ac = (settings.load().asr || {});
          const base = String(ac.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
          const model = String(ac.model || 'qwen3-asr-flash');
          const body = {
            model,
            messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + b64, format: 'wav' } }] }],
          };
          const r = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
          });
          const t = await r.text();
          if (r.status === 200) {
            let j = null; try { j = JSON.parse(t); } catch {}
            const txt = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
            if (txt.trim()) return send(res, 200, { ok: true, text: txt.trim(), by: 'cloud' });
          }
        }
        // 本地：Python ASR（第一次要下模型，可能很慢）
        const dir = PATHS.data + '\\chat\\tmp';
        fs.mkdirSync(dir, { recursive: true });
        const tmp = dir + '\\asr-' + Date.now() + '.wav';
        fs.writeFileSync(tmp, buf);
        try {
          const voice = await import('./voice.mjs');
          const asr = new voice.Asr(() => {});
          const r = await asr.transcribe(tmp);
          if (!r || r.error) return send(res, 200, { ok: false, err: (r && r.error) || '识别失败' });
          return send(res, 200, { ok: true, text: String(r.text || '').trim(), by: 'local' });
        } finally { try { fs.unlinkSync(tmp); } catch {} }
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }

    // ---------- 推送自检 ----------
    if (p === '/api/notify/test') {
      try {
        const notify = await import('./notify.mjs');
        const r = await notify.push('大肥鱼', '测试推送：收到说明通道通了 ' + new Date().toLocaleTimeString('zh-CN'));
        return send(res, 200, (r && r.ok) ? { ok: true } : { ok: false, err: (r && r.err) || ('status ' + (r && r.status)) });
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }

    if (p === '/api/chat/upload' && req.method === 'POST') {
      try {
        const chunks = [];
        await new Promise((resolve) => { req.on('data', (c) => chunks.push(c)); req.on('end', resolve); });
        const buf = Buffer.concat(chunks);
        if (!buf.length) return send(res, 200, { ok: false, err: '空文件' });
        const ct = String(req.headers['content-type'] || 'image/png').split(';')[0];
        const ext = ct === 'image/jpeg' ? '.jpg' : ct === 'image/gif' ? '.gif' : ct === 'image/webp' ? '.webp' : '.png';
        const cap = String(req.headers['x-caption'] || '').slice(0, 200);
        const dir = PATHS.data + '\\chat\\tmp';
        fs.mkdirSync(dir, { recursive: true });
        const tmp = dir + '\\up-' + Date.now() + ext;
        fs.writeFileSync(tmp, buf);
        const LOCAL = process.env.QQBOT_LOCAL_URL || 'http://127.0.0.1:3098';
        const r = await fetch(LOCAL + '/say', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cap || '', image: tmp }),
        });
        return send(res, 200, await r.json());
      } catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }

    // ---------- 程序内聊天（转发到 bridge 本地通道 3098） ----------
    if (p.startsWith('/api/chat/')) {
      const LOCAL = process.env.QQBOT_LOCAL_URL || 'http://127.0.0.1:3098';
      const sub = p.slice('/api/chat'.length);
      try {
        if (sub === '/send' && req.method === 'POST') {
          const b = await body(req);
          const r = await fetch(LOCAL + '/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
          return send(res, 200, await r.json());
        }
        if (sub === '/msgs') {
          const r = await fetch(LOCAL + '/msgs?since=' + (url.searchParams.get('since') || 0));
          return send(res, 200, await r.json());
        }
        if (sub === '/history') {
          const r = await fetch(LOCAL + '/history?n=' + (url.searchParams.get('n') || 80));
          return send(res, 200, await r.json());
        }
        if (sub === '/proactive') {
          // 3098 的 /proactive 现在只收 POST（GET 能被站外页面顺手触发）
          fetch(LOCAL + '/proactive', { method: 'POST' }).catch(() => {});
          return send(res, 200, { ok: true });
        }
        if (sub.startsWith('/media/')) {
          const r = await fetch(LOCAL + sub);
          if (!r.ok) return send(res, 404, { ok: false });
          res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
          return res.end(Buffer.from(await r.arrayBuffer()));
        }
      } catch (e) {
        return send(res, 200, { ok: false, err: '本地通道不可用：' + e.message });
      }
      return send(res, 404, { ok: false });
    }

    if (p === '/api/log') return send(res, 200, { lines: logTail(200) });

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

const HTML = String.raw`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/icon.png"><title>大肥鱼 · 控制台</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0d11">
<link rel="manifest" href="/manifest.webmanifest">
<script>
(function(){
  try{
    /* 手机浏览器页已下线，不再做跳转 */
  }catch(e){}
})();
</script>
<style>
:root{--bg:#0a0c10;--card:#12161d;--card2:#161b24;--line:#1f2530;--line2:#2a3140;--fg:#e8ebf2;--dim:#8d95a6;--acc:#4d7cfe;--acc2:#7c9cff;--ok:#42c88a;--warn:#e0b45e;--bad:#f0666e;--r:14px;--r2:10px}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg) radial-gradient(1100px 520px at 18% -12%,#151d2c 0%,rgba(10,12,16,0) 60%) no-repeat fixed;color:var(--fg);font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;display:flex;height:100vh;overflow:hidden;-webkit-font-smoothing:antialiased}
  .wz-mask{ position:fixed; inset:0; background:rgba(6,10,18,.72); display:flex; align-items:center; justify-content:center; z-index:99; }
  .wz-box{ width:min(560px,92vw); max-height:90vh; overflow:auto; background:#111823; border:1px solid #22303f; border-radius:14px; padding:20px 22px 18px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .wz-t{ font-size:19px; font-weight:700; color:#e8eef6; }
  .wz-d{ font-size:12.5px; color:#8b9bad; margin:6px 0 14px; }
  .wz-l{ display:block; font-size:12.5px; color:#9fb0c2; margin-bottom:10px; }
  .wz-l input,.wz-l select{ display:block; width:100%; margin-top:5px; background:#0d1420; border:1px solid #22303f; border-radius:9px; color:#e8eef6; padding:8px 10px; font-family:inherit; font-size:13px; }
  .wz-btns{ display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; }
  .wz-log{ margin-top:12px; max-height:190px; overflow:auto; font-size:12.5px; line-height:1.7; }
  .wz-line{ color:#9fb0c2; }
  .wz-line.bad{ color:#e2776b; }
  .wz-line.her{ color:#8fd0a0; }
  .wz-adv{ margin:0 0 10px; color:#9fb0c2; font-size:12.5px; }
  .wz-adv summary{ cursor:pointer; margin-bottom:8px; }
nav{width:212px;flex:0 0 212px;height:100vh;padding:14px 12px 18px;border-right:1px solid var(--line);background:linear-gradient(180deg,#0e1218,#0a0c10 65%);display:flex;flex-direction:column;gap:3px;overflow-y:auto;scrollbar-width:thin}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.brand .logo{width:34px;height:34px;flex:0 0 34px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:19px;line-height:1;background:linear-gradient(160deg,#1e2a40,#111620);border:1px solid var(--line2);box-shadow:0 6px 14px -10px #000}
.brand b{display:block;font-size:14.5px;letter-spacing:.3px}
.brand i{display:block;font-style:normal;font-size:10.5px;color:var(--dim);margin-top:1px;letter-spacing:.5px}
nav button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:0;color:var(--dim);padding:9px 10px;border-radius:10px;cursor:pointer;font:inherit;font-size:13.5px;transition:background .14s,color .14s}
nav button .i{font-size:15px;width:18px;text-align:center;opacity:.85}
nav button:hover{background:#12161d;color:#c9d2e3}
nav button.on{background:linear-gradient(90deg,rgba(77,124,254,.20),rgba(77,124,254,.04));color:#fff;box-shadow:inset 2px 0 0 var(--acc)}
nav button.on .i{color:var(--acc2);opacity:1}
main{flex:1;min-width:0;height:100vh;overflow-y:auto;overflow-x:hidden;padding:0 0 48px;scrollbar-width:thin;scroll-padding-top:86px}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:18px 30px 12px;margin-bottom:4px;background:linear-gradient(180deg,var(--bg) 0,var(--bg) 74%,rgba(10,12,16,.86) 92%,rgba(10,12,16,0));backdrop-filter:blur(6px);border-bottom:1px solid rgba(31,37,48,.6)}
.topbar h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.2px}
.topbar .sub{margin:3px 0 0;color:var(--dim);font-size:12.5px}
.wrap{max-width:1120px;margin:0 auto;padding:10px 30px 0}
section{display:none;scroll-margin-top:86px}
.paneh{font-size:12px;letter-spacing:1px;color:#7b8496;font-weight:600;margin:22px 0 8px;padding:0 2px;text-transform:uppercase}
section>.paneh:first-child{margin-top:2px}
.recent{max-height:300px;overflow:auto;margin:8px 0 0;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;color:#9aa4b8}
section.on{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.02),0 10px 30px -26px #000}
.card > b:first-child{font-size:13.5px;letter-spacing:.2px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tag{background:#1a2130;color:#a9b6cc;border-radius:6px;padding:1px 7px;font-size:12px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.dim{color:var(--dim)}
p.dim{font-size:12.5px;line-height:1.65;margin:6px 0 12px;color:var(--dim)}
textarea,input,select{background:#0b0e13;border:1px solid var(--line);color:var(--fg);border-radius:var(--r2);padding:8px 11px;font:inherit;width:100%;transition:border-color .14s,box-shadow .14s}
input,select{height:36px;padding:0 11px}
input[type=checkbox],input[type=radio]{height:15px;width:15px;accent-color:var(--acc);padding:0}
textarea{min-height:420px;resize:vertical;line-height:1.7;font-family:Consolas,"Microsoft YaHei",monospace;font-size:13px}
#sfDesc{min-height:0;height:170px}
#personaText{min-height:0}
input:focus,select:focus,textarea:focus{outline:0;border-color:#3b5c9e;box-shadow:0 0 0 3px rgba(77,124,254,.16)}
button{font:inherit}
button.btn,button.ghost,button.danger,button.primary{height:36px;padding:0 14px;border-radius:var(--r2);border:1px solid transparent;cursor:pointer;font-weight:600;font-size:13.5px;line-height:1;transition:filter .14s,background .14s,border-color .14s;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
button.btn,button.primary{background:linear-gradient(180deg,#5b8bff,#3f6df5);color:#fff;border-color:#5b8bff;box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 6px 16px -14px #3f6df5}
button.btn:hover,button.primary:hover{filter:brightness(1.08)}
button.ghost{background:#151a23;color:#cfd7e6;border-color:var(--line2)}
button.ghost:hover{background:#1a2130;color:#fff}
button.danger{background:#2a161c;color:#ff9ba1;border-color:#4a2229}
button.danger:hover{background:#351a21}
button:active{transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed}
.sw{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.sw input{width:15px;height:15px;accent-color:var(--acc);cursor:pointer;height:15px}
.cardhead{display:flex;align-items:center;gap:10px;margin:0 0 10px;flex-wrap:wrap}
.cardhead h2{margin:0;font-size:15px}
.cardhead .spacer{flex:1}
.hint{color:var(--dim);font-size:12px;line-height:1.55}
.gr{display:grid;grid-template-columns:190px minmax(0,300px) minmax(0,1fr);gap:8px 18px;align-items:center;padding:11px 0;border-bottom:1px dashed #181d26}
.gr:last-child{border-bottom:0}
.gr .lbl{color:var(--dim);font-size:13px}
.gr input[type=number]{width:96px}
.gr select{width:180px}
.gr.wide{grid-template-columns:190px minmax(0,1fr) 200px;align-items:start}
.gr.wide textarea{min-height:74px;width:100%}
.gr.wide .lbl{padding-top:8px}
.gr.note{grid-template-columns:190px minmax(0,1fr)}
.gr.note .hint{grid-column:2/3}
.sect{display:flex;align-items:center;gap:10px;margin:24px 0 8px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;font-weight:600;letter-spacing:.5px;color:#9fb0cc}
/* 模型页：五盏灯 + 三个折叠组。字段还是那些，只是不再一次全摊开 */
#cfgBox details.cfgrp{margin:20px 0 0;border-top:1px solid var(--line);padding-top:14px}
#cfgBox details.cfgrp>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:10px;font-size:15px;font-weight:600;color:var(--fg);padding:2px 0}
#cfgBox details.cfgrp>summary::-webkit-details-marker{display:none}
#cfgBox details.cfgrp>summary::before{content:'▸';color:var(--dim);font-size:12px}
#cfgBox details.cfgrp[open]>summary::before{content:'▾'}
#cfgBox details.cfgrp>summary .dim{font-weight:400;font-size:12px}
.sect:first-of-type{margin-top:12px;padding-top:0;border-top:0}
.sect:after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--line),rgba(31,37,48,0))}
.prow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:9px 0;border-bottom:1px dashed #181d26;font-size:13px}
.prow:last-child{border-bottom:0}
.prow b{font-weight:600;color:#cfd8ea}
#cfgBox h4.sect{font-weight:600}
#toast{position:fixed;right:24px;bottom:24px;z-index:9999;padding:10px 16px;border-radius:11px;font-size:13px;font-weight:600;max-width:380px;
  background:#10231a;color:#8ff0b6;border:1px solid #2b5a3c;box-shadow:0 12px 30px rgba(0,0,0,.5);
  opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s;pointer-events:none}
#toast.on{opacity:1;transform:translateY(0)}
#toast.bad{background:#26161a;color:#ffb3b3;border-color:#5c2b33}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.4px;text-transform:uppercase;background:#0e1218;border-bottom:1px solid var(--line2);padding:9px 10px;white-space:nowrap}
td{text-align:left;padding:10px;border-bottom:1px solid #171c25;vertical-align:middle}
tbody tr:hover td, tr:hover td{background:#151a22}
pre{background:#0b0e13;border:1px solid var(--line);border-radius:12px;padding:13px 14px;overflow:auto;font-size:12px;line-height:1.6;max-height:520px;white-space:pre-wrap;word-break:break-word;color:#c7d0e2}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:12px}
.st{background:#0b0e13;border:1px solid var(--line);border-radius:12px;padding:9px;text-align:center;transition:border-color .14s}
.st:hover{border-color:var(--line2)}
.st img{width:100%;height:88px;object-fit:contain}
.st input{margin-top:7px;text-align:center;font-size:12px;padding:0 6px;height:30px}
.bar{height:6px;background:#0b0e13;border-radius:3px;overflow:hidden;width:90px;display:inline-block;vertical-align:middle}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#4d7cfe,#7c9cff)}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.toolbar > b{font-size:13.5px;margin-right:2px}
.toolbar .spacer{flex:1 1 0;min-width:0}
.w200{width:200px}
.warnchip{color:#e8c27a;background:#241d10;border:1px solid #453819;border-radius:999px;padding:3px 10px;font-size:12px;white-space:nowrap}
#memTable td .btn,#memTable td .danger{height:32px;padding:0 10px;font-size:12.5px;border-radius:8px}
.tip{margin:0 0 10px;font-size:12.5px}
.tip summary{cursor:pointer;color:var(--dim);list-style:none;display:inline-block;user-select:none}
.tip summary::-webkit-details-marker{display:none}
.tip summary:before{content:'?';display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid var(--line2);font-size:10px;color:var(--dim);margin-right:6px;vertical-align:-2px}
.tip[open] summary{color:#c9d2e3}
.tip p{margin:8px 0 0;padding:10px 12px;background:#0d1117;border:1px solid var(--line);border-radius:10px}
.addbar{display:flex;align-items:center;gap:10px;background:#0d1117;border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:0 0 14px}
.addbar input{flex:1;min-width:0;background:#0b0e13}
.addbar .sw{flex:0 0 auto;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line2);color:var(--dim);background:#0d1117;white-space:nowrap}
.pill.ok{color:#7fe0a9;border-color:#1f4634;background:#0f1d17}
.pill.warn{color:#e6c07b;border-color:#4a3a18;background:#211a0d}
.qrbox{display:flex;align-items:center;justify-content:center;margin:16px 0 12px}
#qrImg{width:220px;display:block;border-radius:14px;background:#fff;padding:8px}
.qrempty{display:none;width:100%;max-width:520px;padding:28px 18px;border:1px dashed var(--line2);border-radius:14px;text-align:center;color:var(--dim);font-size:13px;line-height:1.75}
.priceline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.pricechip{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;padding:4px 10px;border-radius:999px;background:#0d1117;border:1px solid var(--line);color:#c9d2e3}
.pricechip b{font-weight:550;color:var(--dim);font-size:11.5px}
.pricechip i{font-style:normal;color:#6f7a8d;font-size:11px}
.empty{padding:34px 18px;border:1px dashed var(--line2);border-radius:14px;text-align:center;color:var(--dim);font-size:13px;line-height:1.8}
.dd{display:none;position:absolute;top:100%;left:0;right:0;z-index:30;background:#171a21;border:1px solid var(--line);border-radius:10px;margin-top:6px;max-height:240px;overflow:auto;box-shadow:0 10px 28px rgba(0,0,0,.5)}
.dd.on{display:block}
.dd .mi{padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #20242e}
.dd .mi:hover{background:#20242e}
.dd .mi:last-child{border-bottom:0}
/* ===== 手机 / 窄屏 ===== */
@media (max-width: 820px){
  html,body{max-width:100%;overflow-x:hidden}
  body{display:block;height:auto;overflow-y:auto;font-size:14px}
  nav{position:sticky;top:0;z-index:50;display:flex;flex-direction:row;align-items:center;width:100%;box-sizing:border-box;height:auto;max-height:none;flex:0 0 auto;overflow-x:auto;overflow-y:hidden;gap:6px;border-right:0;border-bottom:1px solid var(--line);padding:10px 12px;white-space:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  nav::-webkit-scrollbar{display:none}
  nav .brand{padding:0 6px 0 0;font-size:16px;flex:0 0 auto;border:0;margin:0}
  nav button{display:inline-block;width:auto;flex:0 0 auto;border-radius:999px;padding:8px 14px;font-size:14px;text-align:center;line-height:1.2}
  main{padding:14px 12px 28px;height:auto;max-width:none;width:auto;overflow:visible;box-sizing:border-box}
  header{position:static;padding:0}
  .card{padding:16px;border-radius:14px;margin-bottom:14px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word}
  .card h2{margin-top:0}
  .grid2,.grid3{grid-template-columns:1fr !important;gap:12px !important}
  .gr{grid-template-columns:1fr !important;row-gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}
  .gr:last-child{border-bottom:0}
  .gr .lbl{font-size:14px;font-weight:600;opacity:.95}
  .gr .hint{font-size:12.5px;line-height:1.5;margin-top:2px}
  .gr input,.gr select,.gr textarea{width:100% !important;box-sizing:border-box}
  input,select,textarea{font-size:16px} /* 防止 iOS 聚焦时放大 */
  .row{flex-wrap:wrap;gap:10px;align-items:center}
  .row > .btn,.row > .ghost,.row > .danger{flex:0 0 auto}
  img{max-width:100%;height:auto}
  code{overflow-wrap:anywhere;word-break:break-all}
  table{font-size:13px;width:100%;display:block;overflow-x:auto}
  pre{font-size:12px;max-height:45vh;white-space:pre-wrap;word-break:break-word;overflow-x:auto}
  h1{font-size:17px}
  h2{font-size:15px}
  .hint{font-size:12.5px}
}
@media (max-width: 480px){
  main{padding:10px 10px 24px}
  .card{padding:14px}
  nav{padding:8px 10px}
  nav button{padding:7px 12px;font-size:13.5px}
}

.chatwrap{display:flex;flex-direction:column;height:calc(100vh - 40px);max-width:900px;margin:0 auto;padding:8px 0}
.chatbox{flex:1;overflow-y:auto;padding:6px 2px 14px;display:flex;flex-direction:column;gap:10px;min-height:200px}
.chatempty{color:#7a8394;text-align:center;margin-top:50px;font-size:14px}
.msg{display:flex;gap:8px;align-items:flex-start;max-width:86%}
.msg.out{align-self:flex-start}
.msg.in{align-self:flex-end;flex-direction:row-reverse}
.avatar{width:34px;height:34px;border-radius:50%;flex:0 0 34px;background:#1b2030;display:flex;align-items:center;justify-content:center;font-size:17px;overflow:hidden}
.bubble{padding:9px 13px;border-radius:14px;line-height:1.55;font-size:15px;word-break:break-word;white-space:pre-wrap}
.msg.out .bubble{background:#1f2637;color:#e6e9f0;border-top-left-radius:4px}
.msg.in .bubble{background:#2c5cff;color:#fff;border-top-right-radius:4px}
.bubble img{max-width:240px;border-radius:10px;display:block}
.bubble audio{max-width:240px;margin:2px 0}
.chatbar{display:flex;gap:8px;align-items:flex-end;padding:10px 0 4px;border-top:1px solid #232833}
.chatbar textarea{flex:1;resize:none;min-height:44px;max-height:140px;padding:10px 12px;border-radius:12px;background:#151a24;color:#e6e9f0;border:1px solid #263041;font-size:15px;font-family:inherit}
.chatbar .pic{flex:0 0 auto;min-height:44px;padding:0 14px;border-radius:12px;background:#1f2637;color:#cfd6e4;border:1px solid #2a3444;font-size:14px;cursor:pointer}
.chatbar .pri{flex:0 0 auto;min-height:44px;padding:0 18px;border-radius:12px;background:#2c5cff;color:#fff;border:0;font-size:15px;cursor:pointer}
.chathint{color:#6b7385;font-size:12px;padding:2px 2px 8px;min-height:16px}
.msg .meta{font-size:11px;color:#6b7385;margin-top:3px}
.code-big{font:700 26px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:6px;color:#e2b25a;background:#0f1217;border:1px solid #2b313d;border-radius:10px;padding:6px 12px;display:inline-block}

/* Warm console surfaces, aligned with the companion chat. */
:root{color-scheme:dark;--bg:#1b181a;--card:#272124;--card2:#32282d;--line:#44363e;--line2:#644953;--fg:#f5ecef;--dim:#c0adb5;--acc:#bc607b;--acc2:#f0a9bd;--ok:#8bd1a7;--warn:#ebc486;--bad:#f596a2;--r:18px;--r2:11px}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;background:var(--bg) radial-gradient(1000px 600px at 40% -15%,#402831 0%,transparent 70%) no-repeat fixed;font-size:14px}
*{scrollbar-width:thin;scrollbar-color:#6b4f5b transparent}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:#6b4f5b;border-radius:8px}::-webkit-scrollbar-track{background:transparent}
nav{background:linear-gradient(180deg,#292025,#201a1e);padding-top:22px;gap:5px}.brand{padding-bottom:20px;margin-bottom:12px}.brand .logo{background:linear-gradient(145deg,#66404e,#382830);border-color:#815464;border-radius:13px}.brand i{font-size:11px;color:var(--dim)}
nav button{padding:11px 12px;color:#c6b4bc}nav button:hover{background:#3b2a32;color:#fff0f5}nav button.on{background:linear-gradient(90deg,#bc607b33,#bc607b0d);color:#ffe6ef;box-shadow:inset 3px 0 0 var(--acc2)}
.topbar{padding-top:24px;padding-bottom:18px;background:#1b181af2;border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.topbar h1{font-size:23px}.topbar .sub{font-size:13px}.wrap{padding-top:20px}.paneh{color:#d4b9c5;font-size:13px;letter-spacing:.5px;margin-bottom:12px}
.card{padding:22px;margin-bottom:18px;box-shadow:0 6px 22px #00000018,inset 0 1px 0 #ffffff05}.card>b:first-child{font-size:15px}.cardhead{margin-bottom:14px}.cardhead h2{font-size:16px}
p.dim,.hint,.tip,.recent{font-size:13px;line-height:1.75}.recent{color:#cbb6c1}.tag{background:#47313d;color:#f1c5d5;border-radius:7px;padding:3px 8px}
input,select,textarea{background:#201a1e;border-color:#59424d;color:var(--fg)}input,select{height:40px}textarea{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-size:14px}input::placeholder,textarea::placeholder{color:#b39ba7;opacity:1}
input:focus,select:focus,textarea:focus{border-color:#e59bb3;box-shadow:0 0 0 3px #e59bb31c}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--acc2);outline-offset:3px}
button.btn,button.primary{background:linear-gradient(180deg,#bc607b,#a54c67);border-color:#ce7d95;color:#fff5f8;box-shadow:0 3px 10px #0002}button.btn,button.ghost,button.primary,button.danger{min-height:38px}button.ghost{background:#372831;color:#edd6e0;border-color:#6b4a5a}button.ghost:hover{background:#4b3340}button.danger{background:#40252e;color:#ffb7c1;border-color:#854453}button:disabled{opacity:.5}
.gr,.prow{padding-top:14px;padding-bottom:14px;border-bottom-color:var(--line)}.sect{color:#e3c4d2}.prow b{color:#f1dbe6}.gr .lbl{color:#d0b9c5}
th{background:#30232b;color:#dcc4d0;font-size:12px;padding:12px;text-align:left}td{padding:13px 12px;border-bottom-color:var(--line)}tbody tr:hover td,tr:hover td{background:#35272f}pre,.st,.tip p,.addbar,.pill,.pricechip{background:#211b1f;border-color:var(--line);color:#d8c2cf}pre{font-size:13px}.addbar input{background:#1b161a}.pricechip i{color:var(--dim)}.bar{background:#44313c}.bar i{background:linear-gradient(90deg,var(--acc),var(--acc2))}
.empty,.qrempty{background:linear-gradient(145deg,#34252d66,#211b1f66);padding:38px 24px;color:var(--dim)}.dd{background:#30232b;border-color:var(--line2)}.dd .mi{padding:12px;border-bottom-color:var(--line)}.dd .mi:hover{background:#49303e}
.wz-mask{background:#171216cf;backdrop-filter:blur(8px)}.wz-box{background:var(--card);border-color:var(--line2);border-radius:22px;padding:28px}.wz-t{color:var(--fg)}.wz-d,.wz-l,.wz-line{color:var(--dim);font-size:13px}.wz-l input,.wz-l select{background:#201a1e;border-color:var(--line2);color:var(--fg);padding:10px}
.chatempty,.chathint,.msg .meta{color:var(--dim)}.msg .meta{font-size:12px}.avatar{background:#4b303d}.bubble{padding:12px 16px;border-radius:18px;line-height:1.75;box-shadow:0 3px 10px #0002}.msg.out .bubble{background:#362831;color:var(--fg)}.msg.in .bubble{background:#a54c67;color:#fff5f8}.chatbar{border-color:var(--line)}.chatbar textarea{background:#272024;border-color:var(--line2);color:var(--fg)}.chatbar .pic{background:#392a33;color:#ecd5e0;border-color:var(--line2)}.chatbar .pri{background:#a54c67}.code-big{background:#30242a;border-color:var(--line2)}
@media(max-width:820px){nav{padding:10px 12px}.brand{padding-bottom:0;margin-bottom:0}.topbar{padding:16px 12px}.topbar h1{font-size:21px}.wrap{padding:12px 0 0}.card{padding:18px}textarea,input,select{font-size:16px}.gr .hint{font-size:13px}.wz-box{max-height:90dvh;overflow:auto}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;scroll-behavior:auto!important}}
/* 控制台阅读节奏：保留现有控件与行为 */
.topbar{padding-top:22px;padding-bottom:18px;align-items:center}
.topbar h1{font-size:24px;line-height:1.35}.topbar .sub{font-size:13px;line-height:1.7;max-width:68ch}
.wrap{padding-top:20px}.card{padding:22px;margin-bottom:18px}.card h2{margin:0 0 14px;font-size:17px;line-height:1.5}
.paneh{font-size:13px;letter-spacing:.4px;margin-top:28px;margin-bottom:12px}
.recent{line-height:1.85;word-break:normal;overflow-wrap:anywhere}textarea{line-height:1.8}
.empty,.qrempty{line-height:1.9;max-width:100%;overflow-wrap:anywhere}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--acc2);outline-offset:3px}
@media(max-width:900px){.wrap{padding:16px 18px 0}.topbar{padding:18px}.card{padding:18px}.topbar h1{font-size:21px}}
__CONSOLE_STYLE__
</style></head><body>
<nav>
  <div class="brand"><span class="logo">🐟</span><div><b>大肥鱼</b><i>DSCHAT CONSOLE</i></div></div>
  <button data-t="overview" class="on"><span class="i">◎</span>她</button>
  <button data-t="qq"><span class="i">◉</span>QQ</button>
  <button data-t="log"><span class="i">≡</span>日志</button>
  <button data-t="her"><span class="i">✎</span>人设</button>
  <button data-t="money"><span class="i">￥</span>花费</button>
  <button data-t="config"><span class="i">⚙</span>模型</button>
</nav>
<main>
<div id="apBox" style="display:none;position:fixed;top:14px;right:16px;width:390px;max-height:72vh;overflow:auto;background:#101a2b;border:1px solid #3d5a86;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);z-index:60;color:#dbe6fa"></div>
<div class="topbar"><div><h1 id="pgTitle">概览</h1><p class="sub" id="pgSub">她连上没有、今天花了多少、要不要重启</p></div></div>
<div class="wrap">
<section id="overview" class="on">
  <div id="herCard"></div>
  <div class="card"><div class="toolbar"><b>最近发生的事</b><span class="spacer"></span>
    <button class="ghost" onclick="goPage('log')">看全部 →</button></div>
    <div id="recentSummary" class="recent">读取中…</div></div>
</section>

<section id="qq">
  <p class="dim" id="qqOwnerHint" style="display:none;margin:0 0 10px">还没有填「你的 QQ」：现在聊天记录挂在 local 这个身份下，她认得的是"本地窗口里的你"。填上之后才分得清谁是谁。</p>
  <div class="card">
    <div class="toolbar"><b id="plgName">QQ 通道</b><span class="spacer"></span><span id="plgState" class="dim">检查中…</span></div>
    <p class="dim" id="plgDesc" style="margin:6px 0 10px"></p>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <button class="btn" id="plgToggle" onclick="togglePlugin('qq')">启用</button>
      <button class="ghost" onclick="openSnowLuma()">打开它的面板</button>
      <button class="btn ghost" onclick="attachOnebot(this)">一键接上（自动读端口和 token）</button>
      <span class="dim" id="attachHint"></span>
    </div>
    <p class="dim" style="margin:10px 0 0">她不负责登录 QQ：登录交给 SnowLuma 这类协议网关，她只连一个地址。网关挂了，她照常在本地窗口跟你说话。</p>
  </div>
  <details class="cfgrp">
    <summary>高级：手动填 ws 地址和 token</summary>
    <div class="cfgrpbody">
      <p class="dim" style="margin:0 0 8px">一般用不着。SnowLuma 的 token 在它的 <code>config/onebot_*.json</code> 里（ws 和 http 是两个不同的 token）。</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <input id="obUrl" placeholder="ws 地址（留空 = ws://127.0.0.1:3001）" style="flex:1;min-width:220px">
        <input id="obToken" placeholder="ws access token" style="flex:1;min-width:180px">
        <input id="obHttpToken" placeholder="http access token" style="flex:1;min-width:180px">
        <button class="btn ghost" onclick="saveOnebot()">保存</button>
      </div>
      <p class="dim" id="obHint" style="margin:8px 0 0"></p>
    </div>
  </details>
  <div id="statusBox" style="display:none"></div>
  <div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><b>你的 QQ（主人号）</b>
      <button class="btn" onclick="saveOwner()">保存</button></div>
    <div class="dim" style="margin:6px 0 8px">填你自己平时用的号，不是她登录的那个小号。只有这个号能让她动电脑、看她的记忆。</div>
    <div class="row" style="gap:10px">
      <input id="ownerInput" inputmode="numeric" placeholder="例如 123456789" style="max-width:260px">
      <span class="dim" id="ownerHint"></span>
    </div>
  </div>
</section>

<section id="log">
  <div class="card"><div class="toolbar"><b>最近发生的事</b><span class="spacer"></span><button class="ghost" onclick="loadRecent()">刷新</button></div>
    <div id="recentPre" class="recent">读取中…</div></div>
  <div class="card"><div class="toolbar"><b>运行日志</b><span class="spacer"></span><button class="ghost" onclick="loadLog()">刷新</button></div>
    <pre id="logPre">读取中…</pre></div>
  <details class="card"><summary>QQ 内核日志</summary><pre id="kernelLog">暂无日志</pre></details>
</section>

<section id="her">
  <p class="dim" style="margin:0 0 4px">她记得你的事 → <a href="#memory" onclick="goPage('memory');return false" style="color:#7fb2ff">记忆</a></p>
  <h3 class="paneh">人物形象</h3>
<div class="pane" id="persona">
  <div class="card"><div class="row" style="justify-content:space-between"><b>人物形象</b>
    <span class="dim" id="sfState"></span></div>
    <p class="dim">上传参考图后自动描述样貌。检查并保存描述后，画图和自拍会沿用这些特征。</p>
    <div class="row" style="align-items:flex-start;gap:16px">
      <div style="flex:0 0 auto">
        <div id="sfPreview" class="dim" style="width:200px;height:200px;border:1px dashed #333a45;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden">还没有图</div>
        <input type="file" id="sfFile" accept="image/*" style="display:none" onchange="uploadRef(this)">
        <div class="row" style="margin-top:8px"><button class="btn" onclick="document.getElementById('sfFile').click()">上传参考图</button></div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="row" style="margin-bottom:6px"><b style="font-size:13px">长相描述</b>
          <button class="ghost" onclick="describeRef()">用图片自动生成描述</button>
          <button class="btn" onclick="saveSelf()">保存描述</button></div>
        <textarea id="sfDesc" placeholder="按你的人设填写外形、发型、服装等；留空不预设外貌。" style="height:170px"></textarea>
      </div>
    </div>
  </div>
<div class="card"><div class="row" style="justify-content:space-between"><b>人格提示词</b>
    <div class="row"><span class="dim" id="pState"></span><button class="btn" onclick="savePersona()">保存</button></div></div>
    <p class="dim">改完保存，下一条消息就生效（不用重启）。相处关系也写在这里，单独一行「关系/身份：朋友」。</p>
    <textarea id="personaText" style="height:320px"></textarea></div>
</div>
<div class="pane" id="stickers">
  <details class="cfgrp" style="margin-top:18px"><summary>表情包<span class="dim">她会按情绪挑着发；不发也不影响聊天</span></summary>
  <div class="card"><div class="row" style="justify-content:space-between"><b>表情包库</b><span class="dim" id="skCount"></span></div>
    <p class="dim">标签是给她看的关键词：她会按情绪挑。改完自动保存。</p>
    <div class="grid" id="skGrid"></div></div>
  </details>
</div>
</section>

<section id="memory">
  <div class="toolbar">
    <label for="memOwnerSel">谁是主人</label>
    <select id="memOwnerSel" class="w200" onchange="setOwnerFromGalaxy(this.value)"></select>
    <span class="hint" id="memOwnerHint">选中的人会被标成 👑</span>
    <span class="spacer"></span><span class="dim" id="memGalaxyStats"></span>
  </div>
  <!-- 「记住了谁」下线：点星图里的簇就能看那个人的记忆。这两个元素留给列表编辑用，隐藏 -->
  <div style="display:none"><select id="memWho" onchange="loadMem()"></select><span id="memOwnerTag"></span></div>
  <div class="tabs" role="tablist" aria-label="记忆内容">
    <button id="tab-mem" role="tab" aria-selected="true" aria-controls="memPane" onclick="memoryTab('memPane')">记忆</button>
  </div>
  <div id="memPane" role="tabpanel" aria-labelledby="tab-mem">
    <div class="card">
      <div class="toolbar"><b>记忆关系</b><span class="spacer"></span><button class="ghost" id="memViewBtn" onclick="toggleMemoryView()">列表编辑</button></div>
      <div id="memGraphView">
        <div class="toolbar"><span class="hint">拖动节点或空白处 · 滚轮缩放 · 点击节点查看详情</span><span class="spacer"></span>
          <button class="ghost" aria-label="放大图谱" onclick="zoomMemory(1.25)">＋</button><button class="ghost" aria-label="缩小图谱" onclick="zoomMemory(0.8)">－</button><button class="ghost" onclick="fitMemory()">适应画布</button></div>
        <div class="graph-frame">
          <canvas id="memCanvas" hidden></canvas>
          <aside id="memPeople" class="card" hidden></aside>
          <svg id="memGraph" viewBox="0 0 1000 600" aria-label="记忆关系图"></svg>
          <div id="memGraphEmpty" class="graph-empty dim"></div>
          <aside id="memDetail" class="card" hidden><button class="ghost" onclick="closeMemoryDetail()">关闭详情</button><p id="memDetailText"></p><p id="memDetailMeta" class="dim"></p><button class="btn" onclick="editSelectedMemory()">编辑这条</button></aside></div>
        <p class="hint">大节点为核心记忆。实线：旧说法 → 修正；虚线：原因 → 结果。只显示已记录的关系，无关系的节点独立显示。</p>
      </div>
      <div id="memListView" hidden>
        <div class="toolbar"><button class="danger" onclick="dropPerson()">删除这个号</button><button class="ghost" onclick="pruneEmpty()">清理空记忆</button></div>
        <p class="dim">主人号要删的话，得把 QQ 号完整打一遍。</p>
        <div class="addbar"><input id="memText" placeholder="要记住的事"><label class="sw"><input type="checkbox" id="memCore">核心</label><button class="btn" onclick="addMem()">添加</button></div>
        <p class="hint">基础权重 0.1–3；事实 45 天、琐事 14 天减半；核心不衰减。改完点「存」。</p>
        <table id="memTable"></table>
      </div>
    </div>
  </div>
</section>

<section id="money">
<div class="pane" id="budget">
  <div class="card"><div class="row" style="justify-content:space-between"><b>本月花费</b>
    <button class="ghost btn" onclick="loadBudget()">刷新</button></div>
    <div id="budBox"></div></div>
  <div class="card"><b>对账</b>
    <p class="dim">本地是按 token / 字符数估的，和阿里云、DeepSeek 的真实账单会有 10~20% 偏差。把真实月账单填进来，就能看到差多少。</p>
    <div class="row"><span class="dim">本月实际（元）</span><input id="actual" type="number" step="0.01" style="width:140px">
      <button class="btn" onclick="saveActual()">保存</button></div>
    <div id="diffBox" class="dim" style="margin-top:8px"></div>
  </div>
  <div class="card"><b>熔断设置</b>
    <p class="dim">改完要重启桥接才生效；重启后从这个数继续算。</p>
    <div class="row"><span class="dim">月度预算</span><input id="bCap" type="number" style="width:110px">
      <span class="dim">再多花</span><input id="bExtra" type="number" style="width:90px"><span class="dim">元就通知并停止</span></div>
    <div class="row" style="margin-top:10px"><label class="dim"><input type="checkbox" id="bEnabled" style="width:auto"> 启用熔断</label>
      <button class="btn" onclick="saveBudgetCfg()">保存</button></div>
    <div class="row" style="margin-top:10px"><button class="danger btn" onclick="resetBudget()">本月清零重算</button></div>
  </div>
</div>
</section>

<section id="config">
  <div class="card" id="cfgBox"></div>
<div class="pane" id="interests">
  <details class="cfgrp" style="margin-top:18px"><summary>上网兴趣<span class="dim">她自己在网上翻东西时按这个找；不填就按默认</span></summary>
  <div class="card"><div class="row" style="justify-content:space-between"><b>她感兴趣的事</b><button class="btn" onclick="saveInterests()">保存</button></div>
    <p class="dim">每行一条；她上网时按这些找东西看。</p>
    <textarea id="intTopics" style="min-height:160px"></textarea>
    <div class="row" style="margin-top:10px"><span class="dim">兴趣浏览每天最多</span><input id="intMax" type="number" style="width:90px"><span class="dim">次</span></div>
    <div class="row" style="margin-top:10px"><span class="dim">最近看到</span></div>
    <div id="seenBox" class="dim" style="font-size:12px;line-height:1.7"></div></div>
  </details>
</div>
  <div id="advShell" style="margin-top:22px"></div>
</section>

<section id="theme">
  <div class="card"><div class="toolbar"><b>控制台主题</b><span class="spacer"></span><button class="ghost" onclick="resetTheme()">恢复默认</button></div>
    <p class="dim">保存在当前浏览器；导出主题可带到另一台电脑。</p>
    <div class="gr"><label for="themePreset">预设</label><select id="themePreset" onchange="chooseTheme(this.value)"><option value="night">深海蓝</option><option value="warm">暖色</option><option value="light">浅色</option></select></div>
    <div class="theme-colors" id="themeColors"></div>
    <div class="gr"><label for="themeRadius">圆角</label><input id="themeRadius" type="range" min="0" max="24" oninput="saveTheme()"><span id="themeRadiusValue" class="hint"></span></div>
    <div class="gr"><label for="themeDensity">密度</label><select id="themeDensity" onchange="saveTheme()"><option value="compact">紧凑</option><option value="normal">标准</option><option value="relaxed">宽松</option></select></div>
    <div class="gr"><label for="themeFont">字体</label><select id="themeFont" onchange="saveTheme()"><option value="system">系统字体</option><option value="serif">衬线</option><option value="mono">等宽</option></select></div>
  </div>
  <div class="card"><label for="themeCss"><b>自定义 CSS</b></label><p class="dim">应用后即时预览，可随时恢复默认。</p>
    <textarea id="themeCss" spellcheck="false" placeholder="例如：.brand b { letter-spacing: 2px; }" style="min-height:180px"></textarea>
    <div class="toolbar" style="margin-top:12px"><button class="btn" onclick="saveTheme()">应用 CSS</button><span id="themeMessage" class="hint" role="status"></span></div></div>
  <div class="card"><div class="toolbar"><b>导入 / 导出</b><span class="spacer"></span><button class="ghost" onclick="document.getElementById('themeFile').click()">导入主题</button><button class="btn" onclick="exportTheme()">导出主题</button></div>
    <input id="themeFile" type="file" accept=".json,application/json" hidden onchange="importTheme(this)"></div>
</section>
</div>
</main>
<script>__WK_SCRIPT__</script>
<script>
const $ = (s) => document.querySelector(s);
__CONSOLE_LAYOUT__
const PG = {
  overview: ['她', '她现在在干什么、最近说了什么、怎么跟她说句话'],
  qq: ['QQ', '登录 QQ、掉线原因、要不要重启桥接'],
  log: ['日志', '最近发生的事与运行记录 —— 她没回你的时候来这儿看'],
  her: ['人设', '人物形象、人格提示词、表情包；她记得的事也在这里'],
  memory: ['记忆', '她记住的人、事、约定'],
  money: ['花费', '上限、本月用量、钱花在哪种消息上'],
  config: ['模型', '五类能力：大脑、语音、识别、画图、看图'],
  theme: ['主题', '预设、颜色、圆角密度、字体与自定义 CSS']
};
const PAGE_LOAD = {
  overview: () => { loadState(); loadRecent(); },
  qq: () => { loadState(); loadQqGuide(); paintOwnerHint(); qqLoginPaintSteps(); qqLoginRefresh(); },
  log: () => { loadLog(); loadRecent(); },
  her: () => { loadPersona(); loadSelf(); loadStickers(); },
  memory: () => loadMem(),
  money: () => loadBudget(),
  config: () => { loadCfg(); loadInterests(); refreshCaps(); },
  theme: () => loadThemeForm()
};
const ALIAS = { status: 'overview', persona: 'her', stickers: 'her', interests: 'config', budget: 'money', groups: 'config', settings: 'config' };
function goPage(t) {
  const b = document.querySelector('nav button[data-t="' + t + '"]');
  if (b && b.onclick) { b.onclick(); return; }
  // 有些页没有一级入口（比如主题，一年点一次）：直接从设置里的链接切过去
  const sec = document.getElementById(t);
  if (!sec) return;
  document.querySelectorAll('nav button').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll('section').forEach((x) => x.classList.remove('on'));
  sec.classList.add('on');
  setPageTitle(t);
  try { history.replaceState(null, '', '#' + t); } catch (e) {}
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.scrollTop = 0;
  try { (PAGE_LOAD[t] || function () {})(); } catch (e) {}
}
function setPageTitle(t) {
  const p = PG[t] || [t, ''];
  const h = document.getElementById('pgTitle'), s = document.getElementById('pgSub');
  if (h) h.textContent = p[0];
  if (s) s.textContent = p[1];
}
let S = {};
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  const target = b.dataset.t;
  // 没保存就切走：把输入框还原成上次保存的值
  if (__dirty && document.querySelector('nav button.on')?.dataset.t === 'config') {
    clearDirty();
    loadCfg().then(() => toast('没保存，已还原成上次的设置', true)).catch(() => {});
  }
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('section').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); $('#' + b.dataset.t).classList.add('on');
  setPageTitle(b.dataset.t);
  history.replaceState(null, '', '#' + target);
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.scrollTop = 0;
  try { (PAGE_LOAD[b.dataset.t] || function(){})(); } catch (e) {}
  if (b.dataset.t === 'chat') chatBoot();
    if (document.getElementById('avBtn') && !document.getElementById('avBtn').onclick) document.getElementById('avBtn').onclick = () => openAvatars();
});
// 深链：#memory / #config … 直接打开对应页（也方便截图核对）
// 注意要等整段脚本执行完（__dirty 在下面才初始化），所以放到下一个 tick
setTimeout(() => {
  try {
    setPageTitle('overview');
    let h = (location.hash || '').replace('#', '');
    // 支持「打开 …/#doctor 就直接跑一遍自检」——出问题时把这条链接发给人就行
    if (h === 'doctor' || h === 'check') { try { runDoctor(); } catch (e) {} return; }
    if (h && ALIAS[h]) h = ALIAS[h];
    if (!h || !PG[h]) return;
    const btn = document.querySelector('nav button[data-t="' + h + '"]');
    if (btn) { if (!btn.classList.contains('on')) btn.click(); }
    else goPage(h);   // 没有一级入口的页面（记忆/主题）：用兜底切过去
  } catch {}
}, 0);
let CHAT_SINCE = 0;
let CHAT_TIMER = null;
const chatEsc = (t) => String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const chatTime = (at) => { const d = new Date(at); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') };
function chatAdd(m, silent){
  const box = document.getElementById('chatBox'); if (!box) return;
  const e0 = box.querySelector('.chatempty'); if (e0) e0.remove();
  const isIn = m.dir === 'in';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isIn ? 'in' : 'out');
  let inner = '';
  if (m.type === 'image' && m.file) inner = '<img src="/api/chat/media/' + encodeURIComponent(m.file) + '">';
  else if (m.type === 'voice' && m.file) {
    inner = '<audio controls preload="none" src="/api/chat/media/' + encodeURIComponent(m.file) + '"></audio>';
    if (m.text) inner += '<div class="vtext" style="display:none;margin-top:6px;opacity:.85">' + chatEsc(m.text) + '</div>';
  }
  else if (m.type === 'face') inner = '<span style="font-size:20px">🙂</span>';
  else inner = chatEsc(m.text || '');
  wrap.innerHTML = '<div class="avatar">' + '<img src="/api/chat/avatar/' + (isIn ? 'me' : 'her') + '" alt="">' + '</div><div><div class="bubble">' + inner + '</div><div class="meta">' + chatTime(m.at) + '</div></div>';
  if (m.type === 'voice') {
    const b = wrap.querySelector('.bubble');
    b.title = '长按/右键可以转文字';
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const vt = wrap.querySelector('.vtext');
      if (!vt) return toast('这条没存文字', false);
      vt.style.display = vt.style.display === 'none' ? 'block' : 'none';
    });
  }
  box.appendChild(wrap);
  if (!silent) box.scrollTop = box.scrollHeight;
}
async function chatLoadHistory(){
  try{
    const r = await api('/api/chat/history?n=80');
    if (!r || !r.ok || !Array.isArray(r.msgs)) return;
    const box = document.getElementById('chatBox'); if (!box) return;
    box.innerHTML = r.msgs.length ? '' : '<div class="chatempty">还没聊过。说句话试试～</div>';
    for (const m of r.msgs) chatAdd(m, true);
    box.scrollTop = box.scrollHeight;
    CHAT_SINCE = r.msgs.length ? r.msgs[r.msgs.length - 1].at : Date.now();
  }catch(e){}
}
async function chatPoll(){
  try{
    const r = await api('/api/chat/msgs?since=' + CHAT_SINCE);
    if (!r || !r.ok) { document.getElementById('chatHint').textContent = (r && r.err) ? r.err : ''; return; }
    document.getElementById('chatHint').textContent = '';
    for (const m of (r.msgs || [])) if (m.at > CHAT_SINCE) { chatAdd(m); CHAT_SINCE = m.at; }
  }catch(e){}
}
function chatBoot(){
  if (CHAT_TIMER) { chatPoll(); return; }
  chatLoadHistory();
  CHAT_TIMER = setInterval(() => { const t = document.getElementById('chat'); if (t && t.classList.contains('on')) chatPoll(); }, 1500);
  const ta = document.getElementById('chatIn');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
}
function chatNotify(text){
  try{
    if (!document.hidden) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') new Notification('大肥鱼', { body: String(text).slice(0, 80), silent: false });
    else if (Notification.permission !== 'denied') Notification.requestPermission();
  }catch(e){}
}
function chatPickFile(){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    chatAdd({ dir:'in', type:'text', text:'（发了一张图片：' + f.name + '）', at: Date.now(), src:'app' });
    document.getElementById('chatHint').textContent = '她在看图…';
    try{
      const buf = await f.arrayBuffer();
      const r = await fetch('/api/chat/upload', { method:'POST', headers:{ 'Content-Type': f.type || 'image/png' }, body: buf }).then(x => x.json());
      document.getElementById('chatHint').textContent = (r && r.ok) ? '' : ((r && r.err) || '图片没发出去');
    }catch(e){ document.getElementById('chatHint').textContent = '图片没发出去：' + e.message }
  };
  inp.click();
}
async function chatSend(){
  const ta = document.getElementById('chatIn');
  const text = (ta.value || '').trim();
  if (!text) return;
  ta.value = ''; ta.style.height = 'auto';
  chatAdd({ dir:'in', type:'text', text, at: Date.now(), src:'app' });
  document.getElementById('chatHint').textContent = '她想一下…';
  try{
    const r = await api('/api/chat/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    if (!r || !r.ok) document.getElementById('chatHint').textContent = (r && r.err) ? r.err : '发不出去';
  }catch(e){ document.getElementById('chatHint').textContent = '发不出去：' + e.message }
}

const api = async (u, o) => (await fetch(u, o)).json();
let __dirty = false;

// 「发一条测试推送」：调用主程序的系统通知服务（原来是空按钮）
async function testNotify(btn){
  const old = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  try {
    const r = await api('/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(r && r.ok ? '已发出，看看右下角' : ('没发出去：' + ((r && r.err) || '未知原因')), !!(r && r.ok));
  } catch (e) { toast('失败：' + (e.message || e), false); }
  if (btn) { btn.disabled = false; btn.textContent = old; }
}
let __toastTimer = null;function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  if (!t) return;
  if (msg === undefined || msg === null || msg === '') msg = ok ? '好了' : '出错了（没有具体原因）';
  else if (typeof msg !== 'string') msg = String(msg);
  t.textContent = msg;
  t.className = 'on' + (ok ? '' : ' bad');
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => { t.className = ''; }, ok ? 2200 : 4200);
}
// 任何表单改动都记为"脏"，切页面时如果没保存就还原成上次保存的值
function markDirty() { __dirty = true; document.body.dataset.dirty = '1'; }
function clearDirty() { __dirty = false; delete document.body.dataset.dirty; }
document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('#cfgBox')) markDirty(); }, true);
document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('#cfgBox')) markDirty(); }, true);

function togglePass(){
  const b = document.getElementById('passBox');
  if (!b) return;
  const on = b.dataset.on === '1';
  b.textContent = on ? '••••••' : (b.dataset.pw || '');
  b.dataset.on = on ? '0' : '1';
}
async function appRestart(){
  toast('正在重启程序…', true);
  try { await api('/api/app/restart', { method: 'POST' }); } catch {}
}
async function renderNet(){
  const box = $('#netBox');
  if (!box) return;
  let n = {};
  try { n = await api('/api/net'); } catch {}
  if (!n) return;
  if (n.pending) {
    box.innerHTML = '<div class="card" style="border-color:#e0a020"><b>手机访问</b> <span style="color:#e0a020">已勾选，但还没生效</span>'
      + '<div class="dim" style="margin-top:6px">监听地址要重启程序才会变。点右边按钮重启（会自动重新打开），或者托盘右键「退出」再双击图标。</div>'
      + '<div class="row" style="margin-top:10px"><button class="btn" onclick="appRestart()">重启程序</button>'
      + '<span class="dim" style="margin-left:10px">重启后这一页会断开几秒，重新打开即可</span></div></div>';
    return;
  }
  if (!n.lan) {
    box.innerHTML = '<div class="card"><b>手机访问</b> <span class="dim">未开启</span>'
      + '<div class="dim" style="margin-top:6px">想让手机浏览器打开这个控制台：在配置里打开手机访问，然后重启程序。手机要和这台电脑连同一个 Wi-Fi。</div></div>';
    return;
  }
  const u = (n.urls && n.urls[0]) || '';
  box.innerHTML = '<div class="card" style="border-color:#2f6f9f"><b>手机访问</b> <span class="ok">已开启</span>'
    + '<div class="dim" style="margin-top:6px">手机连同一个 Wi-Fi，扫码或直接输入地址；会先要求输入密码。</div>'
    + (u ? '<div class="row" style="margin-top:10px;align-items:center;gap:16px">'
        + '<img src="/api/net/qr?u=' + encodeURIComponent(u) + '" style="width:180px;height:180px;border-radius:10px;background:#fff;padding:6px">'
        + '<div><div style="font-size:16px"><code>' + esc(u) + '</code></div>'
        + '<div class="dim" style="margin-top:6px">本机仍可用 <code>' + esc(n.local || '') + '</code></div>'
        + (n.pass ? '<div style="margin-top:6px">访问密码：<code id="passBox" style="font-size:16px" data-pw="' + esc(n.pass) + '">••••••</code>'
        + ' <button class="ghost btn" style="padding:2px 10px;font-size:12px" onclick="togglePass()">显示</button></div>' : '')
    + (n.urls.filter(x => x !== u).length ? '<div class="dim" style="margin-top:6px">如果上面那个打不开，再试：<br>' + n.urls.filter(x => x !== u).map(x => '<code>' + esc(x) + '</code>').join('<br>') + '</div>' : '')
        + '</div></div>'
      : '<div class="dim" style="margin-top:6px">没找到内网地址，检查一下网络连接。</div>')
    + '</div>';
}
async function qqStartScan(){
  try{
    await api('/api/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ qq: { enabled: true } }) });
    const r = await api('/api/qr/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (r && r.ok === false) { alert(r.err || '启动扫码失败'); return; }
    if (r && r.mode === 'snowluma') {
      toast('已尝试拉起 SnowLuma，请到登录页扫码', true);
      for (let i=0;i<12;i++){
        await new Promise(r=>setTimeout(r,1500));
        const st=await api('/api/state');
        if (st && st.snowlumaWebui) break;
      }
      await loadState();
      try { window.open('http://127.0.0.1:5099', 'snowluma_webui'); } catch (e) {}
      return;
    }
    for (let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1500)); const st=await api('/api/state'); if(st && st.qr && st.qr.exists){ break; } }
    await loadState();
  }catch(e){ alert('启动扫码失败：' + (e && e.message || e)); }
}

async function loadBackup(){
  try {
    const r = await api('/api/backup');
    const box = document.getElementById('bkInfo');
    if (!box) return;
    if (!r || r.ok === false) { box.textContent = '读不到备份状态：' + ((r && r.err) || ''); return; }
    const mb = (n) => (Math.round(Number(n || 0) / 1048576 * 10) / 10) + ' MB';
    const at = r.lastAt ? new Date(r.lastAt).toLocaleString('zh-CN', { hour12: false }) : '还没有备份过';
    box.innerHTML = '上次：' + esc(at) + ' · 共 ' + (r.count || 0) + ' 份 · ' + mb(r.bytes)
      + '<br><span style="opacity:.75">' + esc(r.dir || '') + '</span>'
      + (r.enabled ? '' : '<br><span style="color:#e0a030">备份已关闭（设置 backup.enabled=false）</span>');
  } catch (e) {
    const box = document.getElementById('bkInfo');
    if (box) box.textContent = '读不到备份状态：' + String(e && e.message || e);
  }
}
// 概览下面那些"偶尔才看一眼"的东西：备份、授权码、人物卡片、QQ 内核日志。
// 收起来不是藏，是因为它们每次都在，会把"她连上没有"挤出屏幕。
function toggleAdv(force){
  const box = $('#advBox'), btn = $('#advBtn');
  if (!box || !btn) return;
  const open = (force === undefined) ? (box.style.display === 'none') : !!force;
  box.style.display = open ? '' : 'none';
  document.querySelectorAll('.advonly').forEach((n) => { n.style.display = open ? '' : 'none'; });
  btn.textContent = open ? '收起' : '更多：自检、让她动电脑、备份、授权码、人物';
  try { localStorage.setItem('advOpen', open ? '1' : '0'); } catch (e) {}
}
// 两个入口（控制台 / 聊天窗）同时开着时，一边收起、另一边要跟着收
try {
  window.addEventListener('storage', (ev) => {
    if (ev && ev.key === 'advOpen') { try { toggleAdv(ev.newValue === '1'); } catch (e) {} }
  });
} catch (e) {}

async function runDoctor(){
  // 概览是异步渲染的：从 #doctor 直接进来时盒子还没建好，等它一下
  let box = $('#doctorBox');
  for (let i = 0; i < 24 && !box; i++) { await new Promise(function(r){ setTimeout(r, 250); }); box = $('#doctorBox'); }
  if (!box) return;
  box.innerHTML = '<div class="dim">正在检查…</div>';
  try {
    const r = await api('/api/doctor');
    const items = (r && r.items) || [];
    box.innerHTML = items.map(function(it){
      const cls = it.level === 'ok' ? 'ok' : (it.level === 'warn' ? 'warn' : 'bad');
      const mark = it.level === 'ok' ? '✓' : (it.level === 'warn' ? '!' : '✗');
      return '<div class="prow"><span class="' + cls + '">' + mark + '</span><b>' + esc(it.label) + '</b>'
        + '<span class="dim">' + esc(it.detail || '') + '</span></div>'
        + (it.fix ? '<div class="dim" style="font-size:12px;margin:-4px 0 6px 22px">→ ' + esc(it.fix) + '</div>' : '');
    }).join('') + (function(){
      const warns = items.filter(function(x){ return x.level === 'warn'; }).length;
      if (!r || !r.ok) return '<div class="bad" style="margin-top:8px">有硬伤，先按上面的 → 修掉，不然她跑不起来。</div>';
      if (warns) return '<div class="dim" style="margin-top:8px">没有硬伤。上面带 ! 的 ' + warns + ' 项不是报错：QQ 是可选的，动手能力默认关着。</div>';
      return '<div class="dim" style="margin-top:8px">全部正常。</div>';
    })();
  } catch (e) {
    box.innerHTML = '<div class="bad">检查失败：' + esc(String((e && e.message) || e)) + '</div>';
  }
}

async function runBackup(full){
  toast(full ? '开始完整备份（含她的画和聊天图）…' : '开始备份…');
  const r = await api('/api/backup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: full ? 'full' : 'normal' }) });
  if (r && r.ok) toast('备份好了：' + r.files + ' 个文件 · ' + (Math.round(r.bytes / 1048576 * 10) / 10) + ' MB');
  else toast('备份失败：' + ((r && r.err) || '未知原因'));
  loadBackup();
}
async function loadState(){
  S = await api('/api/state');
  const b = S.bridge, l = S.login, c = S.config;
  const minds = S.minds.map(m => {
    const nm = ((S.names || {})[m.uin] || {}).name || '';
    return '<div class="card"><div class="toolbar"><b>' + (nm ? esc(nm) : m.uin) + '</b>'
      + (nm ? '<span class="dim">' + m.uin + '</span>' : '')
      + '<span class="spacer"></span>'
      + '<span class="pill">情绪 ' + Math.round(m.mood || 0) + '</span>'
      + '<span class="pill">精力 ' + Math.round(m.energy || 0) + '</span>'
      + '<span class="pill">亲密 ' + Math.round(m.affinity || 0) + '</span></div>'
      + '<div class="dim" style="font-size:12.5px">他上次说话 ' + ago(m.lastUserAt) + ' · 我上次主动 ' + ago(m.lastMineAt) + '</div></div>';
  }).join('');
  // 今天的主动消息：把 {uin:{lastMineAt,lastUserAt,...}} 摊成可读行
  const proObj = (S.proactive && typeof S.proactive === 'object') ? S.proactive : {};
  const proKeys = Object.keys(proObj).filter(k => /^[0-9]{5,12}$/.test(k));
  const proHtml = proKeys.length ? '<div style="margin-top:8px">' + proKeys.map(u => {
    const v = proObj[u] || {};
    const nm = ((S.names || {})[u] || {}).name || '';
    const bits = [];
    if (v.lastMineAt) bits.push('我上次主动 ' + ago(v.lastMineAt));
    if (v.lastUserAt) bits.push('他上次说话 ' + ago(v.lastUserAt));
    return '<div class="prow"><b>' + (nm ? esc(nm) + ' ' : '') + u + '</b><span class="dim">'
      + (bits.length ? bits.join(' · ') : '今天还没有记录') + '</span></div>';
  }).join('') + '</div>' : '<div class="empty" style="margin-top:10px;padding:22px 16px">今天还没有主动消息。<br>有新的主动消息时，会显示在这里。</div>';
  // 控制台里点「跟她说话」：把聊天窗叫到前台（已经开着就聚焦，不重复开）
  window.openChatWindow = function openChatWindow(){ try { window.open('http://127.0.0.1:3210', 'dschat_chat'); } catch (e) { location.href = 'http://127.0.0.1:3210'; } };
  // 第一屏先放她，不放仪表盘：她叫什么、在不在、今天说了几句、怎么直接找她。
  (async function paintHer(){
    const el = $('#herCard');
    if (!el) return;
    const name = (S && S.qqName) || (l && l.nickname) || '她';
    const alive = !!(b && b.alive);
    const lines = (S.log || []).filter(x => /-> reply /.test(x));
    const last = lines.length ? lines[lines.length - 1] : '';
    const said = last ? (last.split('|').pop() || '').trim().slice(0, 46) : '';
    const chatting = l ? 'QQ 上也能找她' : '现在只在电脑上说得了话';
    el.innerHTML = '<div class="card">'
      + '<div class="row" style="justify-content:space-between;align-items:center">'
      + '<div><b style="font-size:19px">' + esc(name) + '</b>'
      + '<span class="pill" style="margin-left:10px">' + (alive ? '在' : '没在跑') + '</span></div>'
      + '<button class="btn" onclick="openChatWindow()">跟她说话</button></div>'
      + '<div class="dim" style="margin-top:10px">'
      + (said ? '她最近说：「' + esc(said) + (said.length >= 46 ? '…' : '') + '」' : (alive ? '她还什么都没说，进去打个招呼。' : '桥接没在跑 —— 上面点「重启桥接」。'))
      + '</div>'
      + '<div id="herDay"></div>'
      + '<div class="dim" style="margin-top:6px;font-size:12.5px">'
      + '记忆里 ' + S.counts.memories + ' 个人' + (S.budget ? ' · 本月花了 ￥' + S.budget.spent.toFixed(2) + ' / ' + S.budget.cap : '') + ' · ' + chatting
      + '</div></div>';

    try {
      const H = await api('/api/her');
      const slot = $('#herDay');
      if (!slot || !H) return;
      const rows = [];
      if (H.doing) rows.push('现在 ' + H.doing.at + (H.doing.place ? ' ' + H.doing.place : '') + '｜' + H.doing.what);
      if (H.next) rows.push('下一件 ' + H.next.at + '｜' + H.next.what);
      if (H.events && H.events.length) rows.push('刚发生：' + H.events.map(function (e) { return e.at + ' ' + e.what; }).join('；'));
      if (H.diary && H.diary.text) {
        const brief = H.diary.text.replace(/\s+/g, ' ').slice(0, 54);
        rows.push('<details><summary>她 ' + H.diary.date + ' 写的日记：「' + esc(brief) + (H.diary.text.length > 54 ? '…' : '') + '」</summary><pre style="white-space:pre-wrap;margin:8px 0 0">' + esc(H.diary.text) + '</pre></details>');
      }
      if (H.loops && H.loops.length) rows.push('她还没做完：' + H.loops.map(function (l) { return String(l.text).slice(0, 20); }).join('；'));
      slot.innerHTML = rows.map(function (t) {
        const html = String(t).indexOf('<details>') === 0;
        return '<div class="dim" style="margin-top:6px;font-size:12.5px">' + (html ? t : esc(t)) + '</div>';
      }).join('');
    } catch (e) {}
  })();
  $('#statusBox').innerHTML =
    '<div class="card"><div class="row"><b>桥接</b>' + (b.alive ? '<span class="ok">运行中 pid ' + b.pid + '</span>' : '<span class="bad">没在跑</span>')
    + '<b style="margin-left:16px">QQ</b>' + (l ? '<span class="ok">' + l.nickname + '（' + l.user_id + '）</span>' : '<span class="bad">未登录</span>')
    + '<button class="ghost btn" style="margin-left:auto" onclick="restart()">重启桥接</button></div>'
    + (S.budget ? '<div class="dim" style="margin-top:8px">本月 ￥' + S.budget.spent.toFixed(2) + ' / ' + S.budget.cap + '</div>' : '') + '</div>'
    + '<div id="advBox" style="display:none">'
    + '<div class="card"><div class="row" style="justify-content:space-between"><b>自检</b>'
    + '<button class="ghost btn" onclick="runDoctor()">检查一下</button></div>'
    + '<div class="dim" style="margin-top:6px">第一次用、换电脑、重装之后点一下：最基础的那几项有没有坏。只读检查，不改任何东西。</div>'
    + '<div id="doctorBox" style="margin-top:8px"></div></div>'
    + '<div class="card" id="workCard"><div class="row" style="justify-content:space-between"><b>是否允许动本地电脑文件</b>'
    + '<span id="workBadge" class="pill">未开启</span></div>'
    + '<div class="dim" id="workInfo" style="margin-top:6px">默认关闭。开启后仍需选择文件夹，并按会话权限操作。</div>'
    + '<div id="workEdits" style="margin-top:10px"></div>'
    + '<div class="dim" id="workToolsHint" style="margin-top:6px;font-size:12px"></div>'
    + '<div class="row" style="margin-top:10px;gap:8px"><button class="btn" onclick="openWorkDialog()">选择文件夹</button>'
    + '<button class="ghost btn" id="sToolsBtn" onclick="toggleWorkTools()">允许动本地文件</button><span id="sToolsState" class="dim"></span><span id="sToolsHint" class="hint"></span>'
    + '<button class="ghost btn" id="workStop" onclick="stopWork()" style="display:none">停止工作会话</button></div></div>'
    + '<div class="card"><div class="row" style="justify-content:space-between"><b>备份</b>'
    + '<button class="btn" onclick="runBackup()">立刻备份</button>'
    + '<div class="dim" id="bkInfo" style="margin-top:6px">读取中…</div>'
    + '<div class="dim" style="margin-top:4px;font-size:12px">记忆/配置/聊天记录/她的画，复制一份到数据目录外面。默认保留 7 份，每天凌晨自动一次。</div></div>'

    + minds
    + '<div class="card"><b>今天的主动消息</b>' + proHtml + '</div>'
    + '</div>'
    ;
  $('#kernelLog').textContent = (S.kernel || []).slice().reverse().join('\n') || '暂无 QQ 内核日志';
  // qqSummary 随扫码入口一起下线了（改密码登录）：有就写，没有就跳过。
  // 少了这层保护，loadState 会在 "Cannot set properties of null" 上直接中断，
  // 后面的卡片全都不渲染——控制台看起来像白屏。
  { const qs = $('#qqSummary'); if (qs) qs.textContent = l ? 'QQ 已登录' : (S.qqEnabled === false ? 'QQ 接入未开启' : '未登录'); }
  paintQr(S, l);
  paintOwnerField();
  try {
    // 「自检 / 让她动电脑 / 备份 / 授权码 / 人物」是运维，不属于第一屏；统一放到模型页底部。
    const shell = document.getElementById('advShell'), box = document.getElementById('advBox'), btn = document.getElementById('advBtn');
    if (shell && box) { shell.appendChild(box); if (btn) shell.appendChild(btn); }
  } catch (e) {}
  try { toggleAdv(localStorage.getItem('advOpen') === '1'); setTimeout(loadRecent, 30); } catch (e) {}
  loadBackup();
  try { loadWork(); } catch (e) {}
  if (!l) { clearTimeout(window.__qrT); window.__qrT = setTimeout(loadState, 4000); }
  const who = $('#memWho');
  if (who && S.people) {
    const cur = who.value, nms = S.names || {}, OWN = String(S.ownerUin || '');
    // local = 还没填主人 QQ 时本机窗口用的身份，也要能选，否则新装的用户看到的永远是空
    const list = S.people.filter(u => /^[0-9]{5,12}$/.test(String(u)) || String(u) === 'local');
    who.innerHTML = list.map(u => '<option value="' + u + '">' + (String(u) === 'local' ? '本机（还没填 QQ）' : u)
      + (String(u) === OWN ? '（主人号）' : (nms[u] && nms[u].name ? '（' + esc(nms[u].name) + '）' : '')) + '</option>').join('');
    if (list.indexOf(cur) >= 0) who.value = cur;
    // 下拉刚填好时，记忆页可能已经用空值跑过一次了——这里补一次真正的加载
    try {
      const sec = document.getElementById('memory');
      if (sec && sec.classList.contains('on')) loadMem();
    } catch (e) {}
  }
  paintOwnerTag(S);
  // 记忆页：如果打开时人员列表还没回来（表格是空占位），补一次
  const mt = $('#memTable');
  if (mt && /还没有任何人/.test(mt.textContent)) loadMem();
}
// 选中的是不是主人号：是就把红色提醒亮出来，按钮文案也换掉
function paintOwnerField(){
  const el = $('#ownerInput');
  if (!el) return;
  if (!el.value) el.value = String((S && S.ownerUin) || '');
  const hint = $('#ownerHint');
  if (hint) hint.textContent = S && S.ownerUin ? '现在是她认的那个号' : '还没设：她不知道谁是主人';
}
let QQ_DIRS = { napcat: '', snowluma: '' };
function qqGuideHtml(protocol) {
  if (protocol === 'snowluma') {
    return '<ol style="margin:8px 0 0 1.2em;padding:0">'
      + '<li><b>先装电脑版 QQ。</b>到 <a href="https://im.qq.com/pcqq" target="_blank" rel="noopener">QQ 官网</a> 下载安装。建议另开一个小号给她登录，不要用你平时聊天的大号。</li>'
      + '<li><b>下载 SnowLuma 并解压。</b>到 <a href="https://github.com/SnowLuma/SnowLuma/releases" target="_blank" rel="noopener">SnowLuma 的发布页</a> 下完整包（文件名里带 win-x64 或 linux-x64，不要下带 lite 的，除非电脑里已经有 Node.js 22 以上）。解压到一个找得到的地方。</li>'
      + '<li><b>把文件夹指过来。</b>打开解压出来的文件夹，Windows 里要能看到 launcher.bat，Linux 是 launcher.sh。把这一层的路径填到下面，点「保存协议和路径」。不要填到上一层，也不要填进里面的子文件夹。</li>'
      + '<li><b>用它自己的页面登录。</b>保存路径后点「启动 QQ，去登录」，这里会尝试拉起 launcher。浏览器打开 <code>http://127.0.0.1:5099</code>（也可点本页「打开登录页」），密码在启动时那个黑窗口里。在那个网页里用账号密码登录（QQ 自带的登录页），之后本页的状态会变成「已登录」。</li>'
      + '<li><b>填你自己的 QQ 号。</b>扫码的是她用的小号。往下翻到「你的 QQ（主人号）」，填你自己的号。两个号不要相同。</li>'
      + '</ol>'
      + '<p style="margin:8px 0 0">一直没有码：先确认文件夹里有 launcher、点过扫码或手动跑过 launcher、5099 那个网页打得开，扫的是网页上的码。</p>';
  }
  return '<ol style="margin:8px 0 0 1.2em;padding:0">'
    + '<li><b>先装电脑版 QQ。</b>到 <a href="https://im.qq.com/pcqq" target="_blank" rel="noopener">QQ 官网</a> 下载安装。建议另开一个小号给她登录，不要用你平时聊天的大号。</li>'
    + '<li><b>下载 NapCat 并解压。</b>NapCat 是免费的小软件，负责帮这里连上 QQ。到 <a href="https://github.com/NapNeko/NapCatQQ/releases" target="_blank" rel="noopener">NapCat 的发布页</a> 下载带 Shell 的压缩包，解压到一个找得到的地方。</li>'
    + '<li><b>把文件夹指过来。</b>打开解压出来的文件夹，确认这一层里有 launcher.bat（Windows）。把这一层的路径填到下面，点「保存协议和路径」。不要填到上一层，也不要填进 cache。</li>'
    + '<li><b>扫码登录。</b>点「扫码登录 QQ」，内核起来后会出一张码；用另一台手机上的 QQ（切到小号）扫，扫完在手机上点「确认登录」。勾上「记住登录」，之后开机会自动登回去。</li>'
    + '<li><b>填你自己的 QQ 号。</b>扫码的是她用的小号。往下翻到「你的 QQ（主人号）」，填你自己的号。两个号不要相同。</li>'
    + '</ol>'
    + '<p style="margin:8px 0 0">一直拉不起来：多半是第 3 步的文件夹不对，或者 NapCat 没跑起来。打开那个文件夹看有没有 launcher.bat；没有就退回上一层，或重新解压。改完路径要点保存，再点「扫码登录 QQ」。QQ 电脑版也要先装好。还不行就点「QQ 接入向导」，它会检查 QQ 和这个文件夹。</p>';
}
function paintQqGuide() {
  const sel = document.getElementById('qqProtocol');
  const protocol = sel && sel.value === 'snowluma' ? 'snowluma' : 'napcat';
  const dir = document.getElementById('qqClientDir');
  if (dir && document.activeElement !== dir) dir.value = QQ_DIRS[protocol] || '';
  if (dir) dir.placeholder = protocol === 'snowluma' ? 'SnowLuma 文件夹，里面要有 launcher.bat 或 launcher.sh' : 'NapCat 文件夹，里面要有 launcher.bat';
  const body = document.getElementById('qqGuideBody');
  if (body) body.innerHTML = qqGuideHtml(protocol);
  const hint = document.getElementById('qqClientHint');
  if (!hint) return;
  const ready = protocol === 'snowluma' ? !!(S && S.snowlumaReady) : !!(S && S.napcatReady);
  if (protocol === 'snowluma') {
    hint.textContent = ready
      ? '已认出 SnowLuma 文件夹。保存后点「启动 QQ，去登录」会尝试拉起 launcher；如果它自带登录页，去 http://127.0.0.1:5099 用账号密码登。'
      : '保存后会检查这个文件夹是否有 launcher。点「启动 QQ，去登录」会尝试拉起；登录请打开 http://127.0.0.1:5099 。';
  } else {
    hint.textContent = '保存后，本页会到这个文件夹里找 launcher.bat。找不到就拉不起内核，也就没法登录。';
  }
}
async function loadQqGuide() {
  try {
    const s = await api('/api/setup');
    QQ_DIRS.napcat = (s && s.napcatDir) || '';
    QQ_DIRS.snowluma = (s && s.snowlumaDir) || '';
    const obUrl = document.getElementById('obUrl');
    const obTok = document.getElementById('obToken');
    if (obUrl && document.activeElement !== obUrl) obUrl.value = (s && s.onebot && s.onebot.wsUrl) || '';
    if (obTok && document.activeElement !== obTok) obTok.value = (s && s.onebot && s.onebot.accessToken) || '';
    const obH = document.getElementById('obHttpToken');
    if (obH && document.activeElement !== obH) obH.value = (s && s.onebot && s.onebot.httpToken) || '';
    const sel = document.getElementById('qqProtocol');
    if (sel) sel.value = s && s.protocol === 'snowluma' ? 'snowluma' : 'napcat';
    paintQqGuide();
  } catch (e) {}
}
async function loadPlugins(){
  try {
    const r = await api('/api/plugins');
    const qq = (r && r.items || []).find((x) => x.id === 'qq');
    if (!qq) return;
    const state = document.getElementById('plgState');
    const btn = document.getElementById('plgToggle');
    const desc = document.getElementById('plgDesc');
    if (desc && !desc.textContent) desc.textContent = qq.desc || '';
    if (state) {
      const missing = (qq.missing || []).length;
      state.textContent = (qq.enabled ? '已启用' : '未启用') + (missing ? ' · 还差 ' + missing + ' 项配置' : '');
      state.style.color = qq.enabled ? '#5ed37b' : '';
    }
    if (btn) btn.textContent = qq.enabled ? '停用' : '启用';
  } catch {}
}

async function togglePlugin(id){
  try {
    const r = await api('/api/plugins').catch(() => null);
    const cur = ((r && r.items) || []).find((x) => x.id === id);
    const next = !(cur && cur.enabled);
    await api('/api/plugins/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, enabled: next }) });
    toast(next ? '已启用，重启桥接后生效' : '已停用，重启桥接后生效', true);
    await loadPlugins();
  } catch (e) { toast('改不了插件状态：' + (e.message || e)); }
}

function openSnowLuma(){
  try { window.open('http://127.0.0.1:5099/', '_blank'); } catch (e) { toast('打不开面板，检查它有没有在跑'); }
}

async function attachOnebot(btn){
  const hint = document.getElementById('attachHint');
  if (btn) { btn.disabled = true; btn.textContent = '正在接…'; }
  try {
    const r = await api('/api/qq/attach', { method: 'POST' });
    if (!r || !r.ok) throw new Error((r && r.err) || '没接上');
    if (hint) hint.textContent = '接上了：ws ' + r.ws + ' / http ' + r.http + (r.hasToken ? ' · token 已带入' : '') + '，桥接重启中…';
    toast('接上了：ws ' + r.ws + ' / http ' + r.http, true);
    setTimeout(() => location.reload(), 2500);
  } catch (e) {
    if (hint) hint.textContent = '没接上：' + (e.message || e);
    toast('没接上：' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '一键接上（自动读端口和 token）'; }
  }
}

async function saveOnebot(){
  const url = (document.getElementById('obUrl') || {}).value || '';
  const tok = (document.getElementById('obToken') || {}).value || '';
  try {
    await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onebot: { wsUrl: url, accessToken: tok, httpToken: (document.getElementById('obHttpToken') || {}).value || '' } }) });
    toast('连接参数已保存；改完要重启桥接才生效', true);
  } catch (e) { toast('保存失败：' + (e.message || e)); }
}

async function saveQqClient() {
  const sel = document.getElementById('qqProtocol');
  const protocol = sel && sel.value === 'snowluma' ? 'snowluma' : 'napcat';
  const clientDir = String((document.getElementById('qqClientDir') || {}).value || '').trim();
  const r = await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: protocol, clientDir: clientDir }) });
  if (!r || r.ok === false) return toast((r && r.err) || '保存失败', false);
  QQ_DIRS[protocol] = clientDir;
  toast(protocol === 'snowluma' ? '已记下 SnowLuma 的文件夹' : '已记下 NapCat 的文件夹', true);
  paintQqGuide();
  try { await loadState(); } catch (e) {}
}
function qqNoQrHelp(S) {
  const protocol = (S && S.qqProtocol === 'snowluma') ? 'snowluma' : 'napcat';
  const dir = protocol === 'snowluma' ? String((S && S.snowlumaDir) || '') : String((S && S.napcatDir) || '');
  const where = dir ? ('现在填的文件夹是 ' + esc(dir) + '。') : '这一栏还是空的。';
  if (protocol === 'snowluma') {
    const ready = !!(S && S.snowlumaReady);
    const web = !!(S && S.snowlumaWebui);
    return '<div>SnowLuma 的登录码在网页 <b>http://127.0.0.1:5099</b>，不会出现在本页二维码框。'
      + where
      + (ready ? '文件夹看起来对。' : '文件夹还不像 SnowLuma（缺 launcher）。')
      + (web ? '登录页现在打得开。' : '登录页暂时还没通，可点「启动 QQ，去登录」让这里试着拉起，或自己先跑 launcher。')
      + ' <a href="http://127.0.0.1:5099" target="_blank" rel="noopener">打开登录页</a></div>';
  }
  return '<div>还没有二维码。按顺序检查：电脑版 QQ 装了没有；NapCat 解压了没有；下面的路径是不是「能看见 launcher.bat」的那一层。'
    + where + '改完要点「保存协议和路径」，再点「启动 QQ，去登录」。你自己的号填在再下面的「主人号」。</div>';
}
async function saveOwner(){
  const v = String(($('#ownerInput') || {}).value || '').trim();
  if (!/^[0-9]{5,12}$/.test(v)) return toast('QQ 号要填数字（5–12 位）', false);
  const r = await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerUin: v }) });
  if (!r || r.ok === false) return toast((r && r.err) || '保存失败', false);
  toast('已记下：主人号 ' + v, true);
  await loadState();
  paintOwnerField();
}
function paintOwnerTag(S){
  const own = String(((S || {}).ownerUin) || '');
  const cur = ($('#memWho') || {}).value || '';
  const tag = $('#memOwnerTag');
  if (tag) tag.style.display = own && cur === own ? '' : 'none';
  const btn = document.querySelector('button[onclick="dropPerson()"]');
  if (btn) btn.textContent = own && cur === own ? '删除主人号（要授权码）' : '删除这个号';
}
// 删除授权码：生成 / 渲染（状态页那个 6 位数字）

async function qrRefresh(){
  toast('正在换新码，约 5–15 秒…', true);
  let r = null;
  try { r = await api('/api/qr/refresh', { method: 'POST' }); } catch {}
  if (r && r.ok === false) { toast(r.err || '换码失败', false); return; }
  if (r && r.mode === 'snowluma') {
    toast('已尝试拉起 SnowLuma，请到 5099 登录页扫码', true);
    for (let i = 0; i < 10; i++) {
      await new Promise(rr => setTimeout(rr, 1200));
      try {
        const st = await api('/api/state');
        paintQr(st, st.login);
        if (st && st.snowlumaWebui) { toast('登录页已通', true); return; }
      } catch {}
    }
    toast('登录页还没通，可点「打开登录页」或再试一次', false);
    return;
  }
  let last = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const st = await api('/api/state');
      const at = (st && st.qr && st.qr.at) || 0;
      if (at && at !== last) { paintQr(st, st.login); toast('新码已生成', true); return; }
      last = at;
    } catch {}
  }
  toast('还没出新码，等一下再点一次', false);
}
async function openQqWizard(){
  toast('正在打开 QQ 向导…', true);
  try {
    const r = await api('/api/open-wizard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r && r.url) {
      try { const w = window.open(r.url, 'dschat_wizard'); if (!w) location.href = r.url; } catch (e) { location.href = r.url; }
      return;
    }
    if (r && r.switched) { toast('向导已打开', true); return; }
    toast((r && r.err) || '向导没打开', false);
  } catch (e) { toast('向导没打开：' + String((e && e.message) || e), false); }
}
function paintQr(S, l){
  // 扫码入口已下线（0.7.8 改密码登录）：容器不在了就直接返回，
  // 否则 loadState 会在这里抛 null，整页后面的卡片都画不出来。
  const slot = $('#qrSlot');
  if (!slot) return;
  slot.hidden = !__qrOpen;
  if (S && S.qqEnabled === false) { slot.innerHTML = '<div class="card">'
      + '<div class="toolbar"><b>扫码登录 QQ</b><span class="pill">已关闭</span><span class="spacer"></span>'
      + '<button class="btn" onclick="qqStartScan()">启动扫码登录 QQ</button></div>'
      + '<p class="dim" style="margin:0">QQ 接入未开启。点击启动后拉起内核并获取二维码。</p></div>';
    slot.dataset.built=''; return; }
  if (l) { slot.innerHTML = '<div class="card dim">QQ 已登录。要重装路径或重新扫码，点这一页的「QQ 接入向导」，或托盘里的同一项。</div>';  slot.dataset.built = ''; slot.dataset.at = ''; return; }
  if (S && S.qqProtocol === 'snowluma') {
    const ready = !!S.snowlumaReady;
    const web = !!S.snowlumaWebui;
    slot.innerHTML = '<div class="card">'
      + '<div class="toolbar"><b>扫码登录 QQ（SnowLuma）</b>'
      + '<span class="pill ' + (web ? 'ok' : (ready ? 'warn' : '')) + '">' + (web ? '登录页已通' : (ready ? '等待登录页' : '路径未就绪')) + '</span>'
      + '<span class="spacer"></span>'
      + '<button class="btn" onclick="qqStartScan()">拉起并打开登录页</button></div>'
      + '<p class="dim" style="margin:0 0 8px">SnowLuma 的二维码在它自己的网页里，本页<strong>不会</strong>显示本地二维码图。点上面按钮会尝试启动 launcher，然后打开登录页。</p>'
      + '<div class="row" style="gap:10px;margin-bottom:8px">'
      + '<a class="btn" href="http://127.0.0.1:5099" target="_blank" rel="noopener">打开登录页 http://127.0.0.1:5099</a></div>'
      + '<div class="dim">' + qqNoQrHelp(S) + '</div></div>';
    slot.dataset.built = '';
    slot.dataset.at = '';
    return;
  }
  if (slot.dataset.built !== '1') {
    slot.innerHTML = '<div class="card">'
      + '<div class="toolbar"><b>扫码登录 QQ</b><span class="pill" id="qrPill"></span><span class="spacer"></span>'
      + '<button class="ghost btn" onclick="qrRefresh()">立即换一张</button></div>'
      + '<div class="qrbox"><img id="qrImg" alt="QQ 登录二维码"><div id="qrPh" class="qrempty"></div></div>'
      + '<p class="dim" id="qrMeta" style="margin:0 0 6px"></p>'
      + '<p class="dim" style="margin:0">用手机 QQ 切到小号扫码，扫完在手机上点「确认登录」。二维码过期会自动换，这一块自己更新，不会整页刷新。</p>'
      + '<p class="dim" style="margin:6px 0 0;font-size:12px">手机上显示的登录地是这台电脑的网络出口（用了代理/热点就可能不是你在的城市），不是账号被盗。</p>'
      + '</div>';
    slot.dataset.built = '1';
    slot.dataset.at = '';
  }
  const meta = $('#qrMeta'), img = $('#qrImg'), ph = $('#qrPh'), pill = $('#qrPill');
  const G = S.guard || {};
  const qr = S.qr || {};
  const AGE = qr.exists ? Math.round((Date.now() - qr.at) / 1000) : -1;
  const ST = { online: '已登录', 'waiting-scan': '等你扫码', 'qr-expired': '二维码过期，正在换', offline: '内核没响应', idle: '待命（没让启动内核）', 'net-down': '网络断了，先不动', cooling: '换码太频繁，稍等', 'no-qr': '还没出码', 'need-manual': '需要手动重启内核', restarting: '正在重启内核', giving: '正在换码' }[G.status] || '未连接';
  const stale = AGE < 0 || AGE > 600; // 和守护的 QR_TTL_MS 一致：超过 10 分钟的码一律不信
  if (pill) {
    const good = G.status === 'online' || (G.status === 'waiting-scan' && !stale);
    const warn = G.status === 'cooling' || G.status === 'net-down' || (G.status === 'qr-expired') || (G.status === 'no-qr') || stale;
    pill.className = 'pill ' + (good ? 'ok' : warn ? 'warn' : '');
    pill.textContent = ST;
  }
  const bits = [];
  bits.push(AGE >= 0 ? '二维码 ' + fmtAge(AGE) + '前生成' : '还没有二维码');
  if (G.restarts) bits.push('已自动换码 ' + G.restarts + ' 次');
  if (AGE >= 0 && stale) bits.push('<span style="color:#e6c07b">已失效，这张别扫</span>');
  meta.innerHTML = bits.join(' · ');
  const at = String(qr.at || '');
  if (qr.exists && !stale) {
    img.style.display = '';
    ph.style.display = 'none';
    if (slot.dataset.at !== at) { img.src = '/qr.png?t=' + at; slot.dataset.at = at; }
  } else {
    img.style.display = 'none';
    if (slot.dataset.at) { img.removeAttribute('src'); slot.dataset.at = ''; }
    ph.style.display = 'block';
    if (AGE >= 0) {
      ph.innerHTML = '这张码是 ' + fmtAge(AGE) + '前生成的，早就失效了，扫也没用。点右上「立即换一张」重新出码。'
        + '<div style="margin-top:8px">' + qqNoQrHelp(S) + '</div>';
    } else {
      ph.innerHTML = qqNoQrHelp(S);
    }
  }
}

const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmtAge = (s) => s < 60 ? s + ' 秒' : s < 3600 ? Math.round(s / 60) + ' 分钟' : s < 86400 ? (s / 3600).toFixed(1) + ' 小时' : Math.round(s / 86400) + ' 天';
const ago = (t) => {
  if (!t) return '还没';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
};

async function restart(){ if(!(await askConfirm('重启桥接？正在生成的消息会丢。', '重启桥接'))) return; await api('/api/restart',{method:'POST'}); setTimeout(loadState, 2500); }

async function loadSelf(){
  const r = await api('/api/self');
  $('#sfDesc').value = r.desc || '';
  $('#sfState').textContent = r.hasRef ? ('已上传参考图 · ' + Math.round((r.refBytes||0)/1024) + ' KB') : '还没有参考图';
  $('#sfPreview').innerHTML = r.hasRef
    ? '<img src="/api/self/ref?t=' + (r.refAt||0) + '" style="width:200px;height:200px;object-fit:cover;border-radius:10px">'
    : '还没有图';
}
async function saveSelf(){
  const desc = $('#sfDesc').value;
  const r = await api('/api/self', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ desc }) });
  $('#sfState').textContent = r.ok ? '描述已保存（下一条消息生效）' : '保存失败';
  if (r.ok) setTimeout(loadSelf, 600);
}
function uploadRef(input){
  const f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { $('#sfState').textContent = '图太大了（>8MB）'; return; }
  const fr = new FileReader();
  fr.onload = async () => {
    $('#sfState').textContent = '上传中…';
    const r = await api('/api/self/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: fr.result }) });
    $('#sfState').textContent = r.ok ? '参考图已保存' : ('失败：' + (r.err || ''));
    if (r.ok) { await loadSelf(); await describeRef(); }
  };
  fr.readAsDataURL(f);
  input.value = '';
}
async function describeRef(){
  $('#sfState').textContent = '正在看图生成描述…';
  const r = await api('/api/self/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) { $('#sfState').textContent = '失败：' + (r.err || ''); return; }
  $('#sfDesc').value = r.desc;
  $('#sfState').textContent = '已填好描述，确认后点「保存描述」';
}
async function loadPersona(){ const r = await api('/api/persona'); $('#personaText').value = r.text; $('#pState').textContent = r.text.length + ' 字'; }
async function savePersona(){ await api('/api/persona',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:$('#personaText').value})}); $('#pState').textContent = '已保存 · 下一条生效'; }

function galaxyPerson(uin) {
  const p = (GALAXY || []).find(x => String(x.uin) === String(uin));
  return p || null;
}
function showGalaxyPerson(uin) {
  GALAXY_SEL = String(uin || '');
  const p = galaxyPerson(GALAXY_SEL);
  const box = $('#memPeople');
  if (!box) return;
  if (!p) { box.hidden = true; box.innerHTML = ''; return; }
  const rows = (p.items || []).map(it =>
    '<div class="mem-row' + (it.stale ? ' stale' : '') + '">'
    + '<span class="mem-kind k-' + (it.kind || 'trivia') + '">'
    + (it.kind === 'core' ? '核心' : it.kind === 'important' ? '重要' : it.kind === 'fact' ? '事实' : '琐事') + '</span>'
    + '<span class="mem-txt">' + esc(it.text) + '</span>'
    + '<button class="ghost" data-uin="' + esc(String(p.uin)) + '" data-idx="' + Number(it.index) + '" onclick="forgetGalaxyFromBtn(this)">删</button>'
    + '</div>').join('');
  box.hidden = false;
  box.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center">'
    + '<b>' + (p.isOwner ? '👑 ' : '') + esc(p.name) + '</b>'
    + '<span class="dim">' + (p.items || []).length + ' 条</span></div>'
    + (p.isOwner ? '' : '<button class="ghost" style="margin:6px 0 4px" data-uin="' + esc(String(p.uin)) + '" onclick="ownerFromBtn(this)">设为主人</button>')
    + '<div class="mem-list">' + (rows || '<p class="dim">这个人还没有记忆</p>') + '</div>';
}
function ownerFromBtn(el) { const u = el && el.getAttribute && el.getAttribute('data-uin'); if (u) setOwnerFromGalaxy(u); }
async function forgetGalaxyFromBtn(el) {
  const uin = el && el.getAttribute ? el.getAttribute('data-uin') : '';
  const idx = Number(el && el.getAttribute ? el.getAttribute('data-idx') : -1);
  if (!uin || idx < 0) return;
  try {
    await api('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uin, index: idx }) });
    await loadMem(); showGalaxyPerson(uin);
  } catch (e) { toast('删除失败：' + e.message); }
}
document.addEventListener('click', (ev) => {
  const g = ev.target && ev.target.closest ? ev.target.closest('#memGraph .mem-cluster') : null;
  if (g) showGalaxyPerson(g.getAttribute('data-uin'));
}, true);

let GALAXY = [], GALAXY_SEL = '';
async function setOwnerFromGalaxy(uin){
  const v = String(uin || '').trim();
  try {
    await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerUin: v }) });
    toast(v ? '已把 ' + v + ' 设成主人' : '主人号清空了');
    await loadState();
    await loadMem();
  } catch (e) { toast('没存上：' + e.message); }
}

async function loadMem(){
  // 先试银河接口（所有人的记忆一次拿全，星图按人分簇）
  try {
    const g = await api('/api/memory/galaxy');
    if (g && Array.isArray(g.people)) {
      const flat = [];
      for (const p of g.people) {
        for (const it of (p.items || [])) flat.push(Object.assign({}, it, { _uin: String(p.uin), _isOwner: !!p.isOwner }));
      }
      GALAXY = g.people;
      renderMemoryGraph(flat);
      const sel = $('#memOwnerSel');
      if (sel) {
        const cur = String(g.owner || '');
        sel.innerHTML = '<option value="">还没设主人</option>' + g.people.map(p =>
          '<option value="' + p.uin + '"' + (p.uin === cur ? ' selected' : '') + '>' +
          (p.uin === 'local' ? '本机（还没填 QQ）' : esc(p.name) + '（' + p.uin + '）') + '</option>').join('');
      }
      const st = $('#memGalaxyStats');
      if (st) st.textContent = '共 ' + flat.length + ' 条 · ' + g.people.length + ' 个人';
      const wv = $('#memWho');
      if (wv && g.people.length) {
        wv.innerHTML = g.people.map(p => '<option value="' + p.uin + '">' + (p.uin === 'local' ? 'local' : esc(p.name)) + '</option>').join('');
        const pick = String(g.owner || '') || g.people[0].uin;
        if (pick) wv.value = pick;
      }
      return;
    }
  } catch (e) {}
  let uin = $('#memWho').value || (S.people && S.people[0]) || '';
  if (!uin && S && !S.ownerUin) uin = 'local';   // 全新安装：记忆记在 local 名下
  if (!uin) { $('#memTable').innerHTML = '<tr><td class="dim">还没有任何人的记忆</td></tr>'; renderMemoryGraph([]); return; }
  const r = await api('/api/memory?uin=' + uin);
  if ($('#memWho').value && $('#memWho').value !== uin) return;
  // 给她标上"这条是谁的、是不是主人"，星图靠这两个字段分簇和镀金
  try {
    const isOwner = String(uin) === String((S && S.ownerUin) || '');
    for (const it of (r.items || [])) { it._uin = String(uin); it._isOwner = isOwner; }
  } catch (e) {}
  renderMemoryGraph(r.items);
  $('#memTable').innerHTML = '<tr><th>内容</th><th>基础权重</th><th>当前强度</th><th>类型</th><th>来源</th><th></th></tr>' + r.items.map(it =>
    '<tr' + (it.stale ? ' style="opacity:.55"' : '') + '><td>' + esc(it.text)
    + (it.stale ? ' <span class="dim">（已被更正，不再用）</span>' : '')
    + (Array.isArray(it.supersedes) && it.supersedes.length ? ' <span class="dim">（更正了 ' + it.supersedes.length + ' 条旧说法）</span>' : '')
    + '</td>'
    + '<td><input type="number" step="0.1" min="0.1" max="3" value="' + it.w + '" id="w' + it.index + '" style="width:70px"' + (it.kind==='core'?' disabled':'') + '></td>'
    + '<td><span class="bar"><i style="width:' + Math.min(100, Math.round(it.score * 33)) + '%"></i></span> ' + it.score + '</td>'
    + '<td><select id="k' + it.index + '" style="width:80px">'
    + ['core','fact','trivia'].map(k => '<option value="' + k + '"' + (it.kind===k?' selected':'') + '>' + (k==='core'?'核心':k==='trivia'?'琐事':'事实') + '</option>').join('')
    + '</select></td>'
    + '<td class="dim" style="white-space:nowrap">' + memorySourceLabel(it) + '</td>'
    + '<td><button class="btn" onclick="saveMem(' + it.index + ')">存</button> <button class="danger btn" onclick="delMem(' + it.index + ')">删</button></td></tr>').join('');
}
async function saveMem(i){
  const uin = $('#memWho').value;
  await api('/api/memory',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({uin,index:i,w:$('#w'+i).value,kind:$('#k'+i).value,touch:true})});
  loadMem();
}
async function addMem(){
  const uin = $('#memWho').value, text = $('#memText').value.trim();
  if (!text) return;
  await api('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uin,text,core:$('#memCore').checked})});
  $('#memText').value=''; $('#memCore').checked=false; loadMem();
}
async function delMem(i){
  if(!(await askConfirm('删掉这条记忆？', '删除记忆'))) return;
  await api('/api/memory',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({uin:$('#memWho').value,index:i})});
  loadMem();
}
// 通用小弹层：Electron 里 window.prompt 不可用，危险操作自己画
function miniDialog(inner){
  if (inner === undefined || inner === null || inner === '') {
    inner = '<div style="font-size:15px;font-weight:600;margin-bottom:8px">这个面板没加载出来</div>'
      + '<div class="dim" style="margin-bottom:12px">页面脚本不完整（多半是这一版漏了资源）。可以去控制台「设置」看版本号，或者重启一次程序。</div>'
      + '<div class="row" style="justify-content:flex-end"><button class="btn" onclick="this.closest(\'div[style*=fixed]\').remove()">知道了</button></div>';
  }
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  d.innerHTML = '<div style="width:400px;max-width:92vw;background:#151a22;border:1px solid #7a3b3b;border-radius:12px;padding:18px;color:#e6e9ef;font-size:13.5px;line-height:1.6">' + inner + '</div>';
  document.body.appendChild(d);
  return d;
}
const dlgInput = 'width:100%;box-sizing:border-box;margin:5px 0 10px;padding:9px;border-radius:8px;border:1px solid #2b313d;background:#0f1217;color:#e6e9ef;font-size:14px';
// 允许她动电脑的总开关（按钮式：勾选框在 8 秒轮询重建时容易丢状态）
let __toolsOn = false;
function paintWorkTools(on) {
  __toolsOn = !!on;
  const pairs = [['#workToolsBtn', '#workToolsState'], ['#sToolsBtn', '#sToolsState']];
  for (const [bid, sid] of pairs) {
    const b = $(bid), st = $(sid);
    if (b) { b.textContent = on ? '已允许（点击关闭）' : '允许动本地文件'; b.setAttribute('aria-pressed', String(!!on)); }
    if (st) { st.style.color = on ? '#7ad48a' : ''; st.textContent = on ? '开着的' : '关着'; }
  }
}
async function toggleWorkTools() {
  return setWorkTools(!__toolsOn);
}
async function setWorkTools(on) {
  const boxes = ['#workToolsHint', '#sToolsHint'].map(function(k){return $(k);}).filter(Boolean);
  const box = boxes[0] || null;
  const setHint = function(txt, bad){ boxes.forEach(function(b){ b.style.color = bad ? '#f0666e' : ''; b.textContent = txt; }); };
  try {
    const r = await api('/api/work/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!on }) });
    if (r && r.ok && r.stillOn === !!on) {
      paintWorkTools(!!on);
      setHint((on ? '已允许' : '已关掉：她现在只能聊天') + '（存在 ' + (r.file || '配置文件') + '）', false);
      toast(on ? '已允许她动电脑' : '已关掉：她现在只能聊天');
    } else {
      paintWorkTools(!on);
      const why = (r && (r.err || ('保存后读回来是 ' + (r && r.stillOn)))) || '未知原因';
      setHint('没存上：' + why, true);
      toast('没保存成功：' + why, false);
    }
  } catch (e) {
    setHint('没存上：' + (e.message || e), true);
    toast('没保存成功：' + (e.message || e), false);
  }
}

// ---- 工作模式（首期只有文件能力：读 / 改 / 预览 / 恢复 / 停止） ----
// 进了工作模式却不知道说什么——第一次用的人卡在这里。
// 给三句"现在就能用"的例子，点一下直接发给她（走和聊天窗同一条路）。
function workExamplesHtml(idle){
  const rows = [
    ['看看这个目录里都有什么，挑三个文件说说它们是干嘛的', '只读，不会改东西'],
    ['把 笔记.txt 里的错别字改掉，改完告诉我改了哪几处', '改文件：动手前会问你'],
    ['查一下 Node 22 有什么值得注意的新特性，写进 调研.md', '要联网：在聊天窗顶部状态条里开了才行']
  ];
  if (idle) {
    return '<div style="margin-top:8px;opacity:.62">'
      + rows.map(function(r){
          return '<div class="row" style="gap:8px;align-items:center;margin:6px 0">'
            + '<button class="ghost btn" data-try="' + esc(r[0]) + '">' + esc(r[0]) + '</button>'
            + '<span class="dim" style="font-size:12px">' + esc(r[1]) + '</span></div>';
        }).join('') + '</div>';
  }
  return '<div style="margin-top:10px"><div class="dim" style="font-size:12px;margin-bottom:6px">不知道说什么？点一句试试：</div>'
    + rows.map(function(r){
        return '<div class="row" style="gap:8px;align-items:center;margin:6px 0">'
          + '<button class="ghost btn" data-try="' + esc(r[0]) + '">' + esc(r[0]) + '</button>'
          + '<span class="dim" style="font-size:12px">' + esc(r[1]) + '</span></div>';
      }).join('') + '</div>';
}

async function tryWork(text){
  if (!text) return;
  if (!WORK || !WORK.active) {
    toast('先点「进入工作模式」选一个文件夹，她才能动手');
    try { openWorkDialog(); } catch (e) {}
    return;
  }
  try {
    const r = await api('/api/chat/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: text }) });
    if (r && r.ok) toast('发出去了，去聊天窗看她怎么做', 'ok');
    else toast('发不出去：' + ((r && r.err) || '未知原因'), 'bad');
  } catch (e) { toast('发不出去：' + String((e && e.message) || e), 'bad'); }
}

let WORK = { active: false };

document.addEventListener('click', function (ev) {
  const b = ev.target && ev.target.closest ? ev.target.closest('button[data-try]') : null;
  if (b) { tryWork(b.getAttribute('data-try')); }
}, true);
async function loadWork(){
  try {
    const r = await api('/api/work');
    WORK = (r && r.work) || { active: false };
    const badge = $('#workBadge'), info = $('#workInfo'), stop = $('#workStop');
    if (!badge) return;
    paintWorkTools(!!(r && r.toolsEnabled === true));
    if (WORK.active) {
      const mins = Math.max(0, Math.round((WORK.leftMs || 0) / 60000));
      badge.textContent = '进行中';
      badge.style.color = '#7ad48a';
      badge.style.borderColor = '#2f6b3c';
      info.innerHTML = '工作目录：<code>' + esc(WORK.root) + '</code><br>能力：' + (WORK.caps || []).map(esc).join('、')
        + ' · 剩余 ' + mins + ' 分钟（只有你发消息/点按钮才续期）'
        + (WORK.inPlace ? '<br><b style="color:#e2b477">就地模式：改的是原文件</b>' : '');
      stop.style.display = '';
    } else {
      badge.textContent = '未开启';
      badge.style.color = '';
      badge.style.borderColor = '';
      info.innerHTML = '先开启允许动本地文件，再点「选择文件夹」设置范围和权限。';
      stop.style.display = 'none';
    }
    renderWorkEdits(WORK.active ? (r && r.edits) || [] : []);
  } catch (e) {}
}

// 这次会话里改过哪些文件：每条都能一键恢复（恢复前会先比哈希，冲突就拒绝）
function renderWorkEdits(list){
  const box = $('#workEdits');
  if (!box) return;
  if (!list || !list.length) { box.innerHTML = ''; return; }
  const rows = list.map((it) => {
    const t = new Date(it.at || Date.now());
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    const ACT_ZH = { create: '新建', overwrite: '覆盖', edit: '改了一段', mkdir: '建目录', move: '移动', copy: '复制', delete: '删到回收站', revert: '恢复' };
    const act = ACT_ZH[it.action] || '改动';
    return '<div class="row" style="gap:8px;align-items:center;margin:6px 0">'
      + '<span class="dim" style="width:44px">' + hh + '</span>'
      + '<span class="pill" style="font-size:11.5px">' + esc(act) + '</span>'
      + '<code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(it.rel) + '</code>'
      + '<button class="ghost btn" data-edit="' + esc(it.id) + '">恢复</button></div>';
  }).join('');
  box.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:4px">'
    + '<span class="dim">这次改过的文件（点恢复回到改之前；你自己又改过的话会拒绝覆盖）</span>'
    + '<button class="ghost btn" id="workUndoAll">撤销这次全部改动</button></div>' + rows;
  const allBtn = $('#workUndoAll');
  if (allBtn) {
    allBtn.onclick = async () => {
      if (!confirm('把这次会话里改过的 ' + list.length + ' 条改动逐条撤回？你自己后来又改过的文件会被跳过并说明。')) return;
      try {
        const r = await api('/api/work/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        if (r && r.ok) toast('已撤回 ' + r.undone + ' 条改动');
        else if (r && r.stoppedAt) alert('撤回到「' + r.stoppedAt + '」时停下了：' + ((r.done || []).filter((x) => !x.ok).map((x) => x.err).join('；') || '需要你手动看一眼') + '\n已撤回 ' + r.undone + ' 条。');
        else toast('没撤销成：' + ((r && r.err) || ''));
        loadState();
      } catch (e) { toast('没撤销成：' + String(e.message || e)); }
    };
  }
  box.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = async () => {
      const id = b.getAttribute('data-edit');
      if (!confirm('恢复这个文件到这次修改之前？')) return;
      try {
        const r = await api('/api/work/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        if (r && r.ok) { toast('已' + (r.action === 'removed' ? '删掉这个新建文件' : '恢复') + '：' + r.rel); }
        else if (r && r.conflict) { alert('这个文件在之后又被改过（磁盘 ' + r.diskSha + ' ≠ 当初写入 ' + r.expectSha + '），为了不覆盖你的改动，没有动它。'); }
        else toast('没恢复成：' + ((r && r.err) || ''));
        loadState();
      } catch (e) { toast('没恢复成：' + String(e.message || e)); }
    };
  });
}
async function openWorkDialog(){
  const d = miniDialog(window.__WK_INNER);
  window.__wkBind(d, {
    api, toast, source: 'console', onDone: () => loadWork(),
    sendText: async (text) => api('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
  });
}
async function stopWork(){
  if (!(await askConfirm('停止这次工作会话？她会立刻失去改文件的权限，挂着的等待审批也一起作废。', '停止工作会话'))) return;
  await api('/api/work/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  toast('已停止');
  loadWork();
}


// 主人号删除：手打一遍 uin 才算确认
function ownerConfirmDialog(uin){
  return new Promise((resolve) => {
    const d = miniDialog('<div style="font-size:16px;font-weight:700;color:#e2777a;margin-bottom:6px">删除主人号 ' + esc(uin) + '？</div>'
      + '<div style="color:#b9c0cc">这个号的记忆、聊天记录、日记、昵称会一起改名为 <code>.deleted-时间</code> 备份。<br>主人号删了要重新扫码、重新配，<b>再三确认</b>：</div>'
      + '<div style="color:#8b93a1;margin-top:10px;font-size:12.5px">① 把 uin 完整打一遍</div>'
      + '<input id="ockUin" placeholder="' + esc(uin) + '" style="' + dlgInput + '">'
      + '<div id="ockErr" style="color:#e2777a;font-size:12.5px;min-height:16px"></div>'
      + '<div class="row" style="justify-content:flex-end;gap:8px;margin-top:6px"><button class="btn" id="ockNo">取消</button><button class="danger btn" id="ockYes">确认删除</button></div>');
    const q = (s) => d.querySelector(s);
    const done = (v) => { d.remove(); resolve(v); };
    q('#ockNo').onclick = () => done(null);
    q('#ockYes').onclick = async () => {
      const u = q('#ockUin').value.trim();
      const errEl = q('#ockErr'), yes = q('#ockYes');
      errEl.textContent = '';
      if (u !== String(uin)) { errEl.textContent = 'uin 没打对，照上面那串数字完整打一遍'; q('#ockUin').focus(); return; }
      yes.disabled = true; yes.textContent = '删除中…';
      const r = await api('/api/memory/person', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, confirmUin: u }) });
      if (r && r.ok) { done(r); return; }
      yes.disabled = false; yes.textContent = '确认删除';
      errEl.textContent = (r && r.err) || '删除失败，等一下再试';
    };
    q('#ockUin').focus();
  });
}
// 自绘确认框：Electron 里 window.confirm 不可用（返回 false 后静默失败），一律走这个
function askConfirm(text, okText, danger){
  return new Promise((resolve) => {
    const d = miniDialog('<div style="font-size:15px;font-weight:600;margin-bottom:8px">' + esc(okText || '确认操作') + '</div>'
      + '<div style="color:#b9c0cc;white-space:pre-wrap">' + esc(text) + '</div>'
      + '<div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn" id="askNo">取消</button>'
      + '<button class="' + (danger === false ? 'primary' : 'danger btn') + '" id="askYes">' + esc(okText || '确认') + '</button></div>');
    const q = (s) => d.querySelector(s);
    const done = (v) => { d.remove(); resolve(v); };
    q('#askNo').onclick = () => done(false);
    q('#askYes').onclick = () => done(true);
    q('#askNo').focus();
  });
}
async function dropPerson(){
  const uin = $('#memWho').value;
  if (!uin) return;
  const OWN = String(((S || {}).ownerUin) || '');
  const isOwner = OWN && String(uin) === OWN;
  if (isOwner) {
    const r = await ownerConfirmDialog(uin);
    if (!r) return;
    toast('已删除主人号 ' + uin + '（' + ((r.moved || []).length) + ' 个文件）', true);
    await loadState(); loadMem(); return;
  }
  const ok = await askConfirm('删除 ' + uin + ' 的全部记录？\n记忆、聊天记录、日记、昵称会一起删掉。\n删之前会改名成 .deleted-时间戳 备份，反悔了还能从数据目录捞回来。', '删除 ' + uin);
  if (!ok) return;
  const r = await api('/api/memory/person', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin }) });
  toast(r && r.ok ? ('已删除 ' + uin + '（' + ((r.moved || []).length) + ' 个文件）') : ('失败：' + ((r && r.err) || '未知')), !!(r && r.ok));
  await loadState(); loadMem();
}
async function pruneEmpty(){
  if (!(await askConfirm('把所有"一条记忆都没有"的号清掉？（同样是改名备份，可恢复）', '清理空记忆'))) return;
  const r = await api('/api/memory/person', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ empty: true }) });
  const n = (r && r.removed || []).length;
  toast(n ? ('清掉 ' + n + ' 个空号：' + r.removed.join('、')) : '没有空记忆需要清理', true);
  await loadState(); loadMem();
}

// ---- 经验库（她的"学过") / 技能记录 / 审批卡片 ----
const BUCKET_ZH = { other:'其它', comfort:'安慰', food:'吃饭', photo:'拍照', night:'夜里', work:'工作', affection:'亲密', greet:'招呼', tease:'斗嘴' };
const fmtTime = (t) => { const d = new Date(Number(t) || 0); const p = (n) => String(n).padStart(2, '0'); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
async function delLesson(id){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  const r = await api('/api/lessons?uin=' + encodeURIComponent(uin), { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, id }) });
  toast(r && r.ok ? '已删掉一条' : ('失败：' + ((r && r.err) || '未知')), !!(r && r.ok));
}
async function clearLessons(){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  if (!(await askConfirm('把她的经验库清空？（不会动记忆和人设）', '清空经验库'))) return;
  const r = await api('/api/lessons?uin=' + encodeURIComponent(uin), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, clear: true }) });
  toast(r && r.ok ? '已清空' : '失败', !!(r && r.ok));
}
// 审批卡片上的两个按钮（原来只写了 onclick，函数根本没定义 → 点了没反应）
window.apDecide = async function apDecide(id, allow){
  try {
    const r = await api('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, allow: !!allow }) });
    toast(r && r.ok ? (allow ? '已同意' : '已拒绝') : ('没成功：' + ((r && r.err) || '桥接没响应')), !!(r && r.ok));
  } catch (e) { toast('没成功：' + e.message, false); }
  try { await pollApprovals(true); } catch (e) {}
};

async function pollApprovals(force){
  try {
    const r = await api('/api/approvals');
    const items = (r && r.items) || [];
    const box = $('#apBox');
    if (!box) return;
    if (!items.length) { if (__apIds) { __apIds = ''; box.style.display = 'none'; box.innerHTML = ''; } return; }
    const ids = items.map((x) => x.id).join(',');
    if (ids === __apIds && !force) return;
    __apIds = ids;
    box.style.display = 'block';
    // 真实参数叫 timeoutSec；生效值还要受 work.exec.timeoutMs 的 1–300 秒限制。
    // 没有这个字段就别编一个数出来——以前一律显示 60 秒，等于骗人。
    const cmdSec = (x) => {
      const a = (x && x.args) || {};
      const n = Number(a.timeoutSec);
      if (n > 0) return Math.min(300, Math.max(1, Math.round(n)));
      const ms = Number(x && x.timeoutMs);
      return ms > 0 ? Math.round(ms / 1000) : 0;
    };
    const cmdExtra = (x) => {
      const a = (x && x.args) || {};
      if (!Array.isArray(a.cmd)) return '';
      return Object.keys(a).filter((k) => k !== 'cmd').map((k) => k + '=' + JSON.stringify(a[k])).join(' · ');
    };
    box.innerHTML = '<div style="padding:11px 13px;border-bottom:1px solid #24304a;font-weight:600">她想执行命令，等你点头</div>'
      + items.map((x) =>
        '<div style="padding:11px 13px;border-bottom:1px solid #24304a">'
        + '<div class="dim" style="font-size:12px">' + esc(x.name) + ' · ' + fmtTime(x.at) + '</div>'
        + (x.name === 'run_cmd' && x.args && Array.isArray(x.args.cmd)
            ? '<div style="margin:6px 0 2px;font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#dfe9ff;background:#0b1523;padding:9px 10px;border-radius:8px;word-break:break-all">' + esc(x.args.cmd.join(' ')) + '</div>'
            : '')
        + (x.dir ? '<div class="dim" style="font-size:12px;margin-top:2px">在工作区里跑：' + esc(x.dir) + (x.mode ? ' · ' + esc(x.mode === 'workspace' ? '只能动这个文件夹' : x.mode === 'full' ? '不限制路径（慎用）' : '已关闭') : '') + '</div>' : '')
        + (x.name === 'run_cmd' && x.args && Array.isArray(x.args.cmd)
            ? '<div class="dim" style="font-size:12px;margin:4px 0 8px">这是要跑的命令全文；点「同意」才会执行' + (cmdSec(x) ? '，这次超时 ' + cmdSec(x) + ' 秒' : '') + (cmdExtra(x) ? ' · ' + esc(cmdExtra(x)) : '') + '</div>'
            : '<pre style="white-space:pre-wrap;word-break:break-all;margin:6px 0 8px;font-size:12px;color:#c9d6ee;background:#0b1523;padding:8px;border-radius:8px">' + esc(JSON.stringify(x.args || {}, null, 1)) + '</pre>')
        + '<div class="row" style="justify-content:flex-end;gap:8px">'
        + '<button class="btn" onclick="apDecide(\'' + esc(x.id) + '\',false)">拒绝</button>'
        + '<button class="btn" style="background:#2f6fd0;color:#fff;border-color:#2f6fd0" onclick="apDecide(\'' + esc(x.id) + '\',true)">同意</button>'
        + '</div></div>').join('');
  } catch {}
}
setInterval(() => pollApprovals(false), 2500);

async function loadStickers(){
  const r = await api('/api/stickers');
  const own = r.items.filter(i => i.from === 'user').length;
  $('#skCount').textContent = r.items.length + ' 张（其中她自己从聊天里收了 ' + own + ' 张）';
  const badge = (f) => f === 'user' ? '她自己收的' : (f === 'web' ? '网页抓的' : (f || '未知来源'));
  $('#skGrid').innerHTML = r.items.length ? r.items.map(it =>
    '<div class="st"><img src="/sticker/' + encodeURIComponent(it.file) + '"><div class="dim" style="font-size:12px;margin:4px 0">' + esc(badge(it.from)) + '</div><input value="' + esc(it.tag||'') + '" onchange="tagSticker(\'' + it.file.replace(/'/g,"\\'") + '\',this.value)">'
    + '<button class="danger btn" style="margin-top:6px;width:100%" onclick="delSticker(\'' + it.file.replace(/'/g,"\\'") + '\')">删除</button></div>').join('')
    : '<div class="empty" style="grid-column:1/-1">还没有表情包。<br>她在聊天里收到图会自动收进这里，收进来后可以给每张填标签（按情绪挑），改完自动保存。</div>';
}
async function tagSticker(file, tag){ await api('/api/stickers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file,tag})}); }
async function delSticker(file){ if(!(await askConfirm('删除这张表情包？', '删除表情包'))) return; await api('/api/stickers',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({file})}); loadStickers(); }

async function loadInterests(){
  const r = await api('/api/interests');
  $('#intTopics').value = (r.topics||[]).join('\n');
  $('#intMax').value = r.maxPerDay || 4;
  const st = await api('/api/state');
  $('#seenBox').innerHTML = (st.seen||[]).map(esc).join('<br>') || '（还没有）';
}
async function saveInterests(){
  await api('/api/interests',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    topics: $('#intTopics').value.split('\n').map(s=>s.trim()).filter(Boolean),
    maxPerDay: Number($('#intMax').value)||4,
    minGapMs: 7200000,
  })});
  alert('已保存');
}

const BRAIN_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'] },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
  { id: 'moonshot', label: 'Moonshot（Kimi）', base: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-auto', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'dashscope', label: '阿里云百炼（通义）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-flash'] },
  { id: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'] },
  { id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  { id: 'custom', label: '自定义（OpenAI 兼容）', base: '', models: [] },
];
const VISION_PRESETS = [
  { id: 'brain', label: '跟随大脑', base: '', models: [] },
  { id: 'dashscope', label: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus'] },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'volc', label: '火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-1-5-vision-pro-32k-250115'] },
  { id: 'custom', label: '自定义（OpenAI 兼容）', base: '', models: [] },
];
function normBase(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }
function presetById(list, id) {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return list[list.length - 1];
}
function presetFor(list, base, emptyId) {
  const b = normBase(base);
  if (!b) {
    for (let i = 0; i < list.length; i++) if (list[i].id === (emptyId || list[0].id)) return list[i];
    return list[0];
  }
  for (let i = 0; i < list.length; i++) if (list[i].base && normBase(list[i].base) === b) return list[i];
  for (let i = 0; i < list.length; i++) if (list[i].id === 'custom') return list[i];
  return list[list.length - 1];
}
function escAttr(s) { return esc(String(s == null ? '' : s)).replace(/"/g, '&quot;'); }
function fillPresetList(id, models) {
  const dl = document.getElementById(id);
  if (!dl) return;
  dl.innerHTML = (models || []).map(function (m) { return '<option value="' + escAttr(m) + '"></option>'; }).join('');
}
function providerOptions(selectId, list, currentId, onchangeName) {
  const opts = list.map(function (p) {
    return '<option value="' + p.id + '"' + (p.id === currentId ? ' selected' : '') + '>' + esc(p.label) + '</option>';
  }).join('');
  return '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">供应商</span><select id="' + selectId + '" style="max-width:320px" onchange="' + onchangeName + '()">' + opts + '</select></div>';
}
function customUrlBlock(advId, inner, open) {
  return '<details class="wz-adv" id="' + advId + '"' + (open ? ' open' : '') + '><summary>自定义接口地址</summary>' + inner + '</details>';
}
function applyListedProvider(selectId, urlSel, advId, listId, modelSel, list) {
  const sel = document.getElementById(selectId);
  const url = typeof urlSel === 'string' ? document.querySelector(urlSel) : urlSel;
  const adv = document.getElementById(advId);
  const model = typeof modelSel === 'string' ? document.querySelector(modelSel) : modelSel;
  const p = presetById(list, sel && sel.value);
  if (p.id === 'custom') { if (adv) adv.open = true; }
  else {
    if (url) url.value = p.base;
    if (adv) adv.open = false;
  }
  fillPresetList(listId, p.models);
  if (model && p.models.length && !String(model.value || '').trim()) model.value = p.models[0];
}
function applyBrainProvider() {
  applyListedProvider('brProvider', document.getElementById('brUrl'), 'brUrlAdv', 'dlBrain', document.getElementById('brModel'), BRAIN_PRESETS);
}
function applyVisionProvider() {
  applyListedProvider('viProvider', '[data-p="vision.baseUrl"]', 'viUrlAdv', 'dlVision', '[data-p="vision.model"]', VISION_PRESETS);
}
function fallbackModels(kind) {
  if (kind === 'chat') return (presetById(BRAIN_PRESETS, (document.getElementById('brProvider') || {}).value) || {}).models || [];
  if (kind === 'vision') return (presetById(VISION_PRESETS, (document.getElementById('viProvider') || {}).value) || {}).models || [];
  if (kind === 'tts') return ['cosyvoice-v2', 'cosyvoice-v3-plus', 'cosyvoice-v1'];
  if (kind === 'asr') return ['whisper-1', 'gpt-4o-transcribe'];
  if (kind === 'draw') return ['doubao-seedream-4-0-20260415', 'wanx2.1-t2i-turbo', 'wan2.2-t2i-flash'];
  return [];
}
async function loadCfg(){
  const c = await api('/api/config');
  const br = await api('/api/brain');
  const vi = await api('/api/voice').then(r => (r && r.info) || {}).catch(() => ({}));
  const dInfo = await api('/api/draw/info').catch(() => ({}));
  const num = (label, path, v, step=1, hint='') => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><input type="number" step="' + step + '" value="' + v + '" data-p="' + path + '" style="width:110px"><span class="dim">' + hint + '</span></div>';
  const tim = (label, path, v) => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><input type="time" step="60" value="' + v + '" data-p="' + path + '" style="width:120px"><span class="dim">24 小时制</span></div>';
  const cb = (label, path, on, hint = '') => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><label class="dim"><input type="checkbox" data-cb="' + path + '"' + (on ? ' checked' : '') + ' style="width:auto"> ' + (hint || '开启') + '</label></div>';
  $('#cfgBox').innerHTML = '<div class="row" style="justify-content:space-between"><b>设置</b><span><span class="dim" id="cfgMsg" style="margin-right:10px"></span><button class="ghost" onclick="restartBridgeClick()">重启桥接</button><button class="btn" onclick="saveCfg()">保存</button></span></div>'
    + '<p class="dim">改完点保存就生效，不用退出程序。只有换模型供应商这类情况才需要点「重启桥接」。</p>'
    + (function lamps(){
        const row = (label, ok, what, target, id) => '<div class="row" id="' + (id || '') + '" style="justify-content:space-between;margin:6px 0">'
          + '<span>' + label + '</span>'
          + '<span class="' + (ok ? 'ok' : 'bad') + '" style="margin-left:auto">' + (ok ? '✓ ' : '✗ ') + what + '</span>'
          + '<a href="javascript:void 0" data-g="' + target + '" onclick="openCfgGroup(this.dataset.g)" style="margin-left:14px;color:#7fb2ff">' + (ok ? '改' : '去配') + '</a></div>';
        return '<div class="card" style="margin-bottom:18px"><b>五类能力</b>'
          + '<div class="dim" style="margin:6px 0 10px">灯绿了就能用；红了点右边去配。其余设置都收在下面，用不着可以不管。</div>'
          + row('大脑（说话）', !!(br && br.keySet), (br && br.model) || '没配', 'gBrain')
          + row('语音（发语音条）', !!(c.tts && (c.tts.key || c.tts.voiceId)), (c.tts && (c.tts.model || c.voiceName || c.voice)) || '没配', 'gMedia', 'lampTts')
          + row('语音识别（听你说）', !!(c.asr && (c.asr.key || c.asr.provider)), (c.asr && (c.asr.model || c.asr.provider)) || '没配', 'gMedia', 'lampAsr')
          + row('画图（她画画）', !!(c.draw && c.draw.keySet !== false && (c.draw && c.draw.key)), (dInfo && dInfo.model) || '没配', 'gMedia')
          + row('看图（她看照片）', !!(dInfo && dInfo.hasRef) || !!((c.vision && c.vision.key)) || !!(vi && (vi.aliok || vi.brainOk)), (dInfo && dInfo.refModel) || '能看', 'gMedia')
          + '</div>';
      })()
    + (function () {
        const cur = presetFor(BRAIN_PRESETS, br.baseUrl || '');
        const shown = String(br.baseUrl || '').trim() || cur.base || BRAIN_PRESETS[0].base;
        return '<details class="cfgrp" id="gBrain" open><summary>大脑（API）<span class="dim">说话靠这个；换供应商后要点重启桥接</span></summary>'
          + providerOptions('brProvider', BRAIN_PRESETS, cur.id, 'applyBrainProvider')
          + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input id="brKey" type="password" placeholder="' + (br.keySet ? '已保存 ' + br.keyMask + '（留空不改）' : 'sk-…') + '" style="flex:1"></div>'
          + customUrlBlock('brUrlAdv', '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input id="brUrl" value="' + escAttr(shown) + '" style="flex:1" placeholder="https://api.example.com/v1"></div><p class="dim" style="margin:0 0 6px 210px">选上面的供应商会填官方地址。要走自己的网关，展开这里改。保存的仍是地址、模型和 Key。</p>', cur.id === 'custom')
          + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input id="brModel" list="dlBrain" value="' + escAttr(br.model || '') + '" style="flex:1"><button class="ghost" data-kind="chat" onclick="pullModels(this.dataset.kind)">拉取目录</button><datalist id="dlBrain"></datalist></div>'
          + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim"></span><button class="ghost" onclick="testBrain()">测试连接</button><button class="btn" onclick="saveBrainPanel(this)">保存 API</button><span class="dim" id="brMsg"></span></div>'
          + '<p class="dim" style="margin:0 0 6px 210px">改完 API 后要点「重启桥接」才用新配置。拉不到目录时用这份预设，也可以手填模型名。</p>'
          + '</details>';
      })()
    + '<details class="cfgrp" id="gMedia"><summary>语音与画图<span class="dim">她不说话、画得不像，或者想换服务商时才动</span></summary>'
    + '<h4 class="sect">语音（TTS）</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">供应商</span><select data-p="tts.provider" style="width:240px"><option value="aliyun"' + ((c.tts&&c.tts.provider==='aliyun')?' selected':'') + '>阿里云 CosyVoice</option><option value="openai"' + ((c.tts&&c.tts.provider==='openai')?' selected':'') + '>OpenAI 兼容 /audio/speech</option><option value="edge"' + ((c.tts&&c.tts.provider==='edge')?' selected':'') + '>Edge-TTS（免费兜底）</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="tts.key" type="password" placeholder="' + (vi.keySet ? '已保存 ' + vi.keyMask + '（留空不改）' : 'sk-…（阿里云百炼）') + '" style="flex:1"></div>'
    + customUrlBlock('ttsUrlAdv', '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="tts.baseUrl" value="' + escAttr((c.tts && c.tts.baseUrl) || '') + '" style="flex:1" placeholder="留空=官方地址；第三方网关填到 /v1 结尾"></div>', !!((c.tts && c.tts.baseUrl)))
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="tts.model" list="dlTts" value="' + escAttr((c.tts&&c.tts.model)||'cosyvoice-v2') + '" style="width:260px"><button class="ghost" onclick="pullModels(\'tts\')">拉取目录</button><span class="dim" id="tmMsg">可下拉选，也可手填</span><datalist id="dlTts"></datalist></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">音色包</span><select id="voiceSel" style="width:260px"></select>'
    + '<button class="ghost" onclick="previewVoice()">试听</button><span class="dim" id="vMsg"></span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">新增音色包</span><input id="vNewName" placeholder="名称，如 甜妹" style="width:150px"><input id="vNewId" placeholder="音色 ID，如 longxin_v2" style="width:200px">'
    + '<button class="ghost" onclick="addVoice()">添加</button><button class="ghost danger" onclick="delVoice()">删除选中</button></div>'
    + '<p class="dim" style="margin:0 0 6px 210px">音色包存在 data\\voices.json，内置的不让删；试听会用当前选中的音色现场合成一句。</p>'
    + '<h4 class="sect">语音识别（ASR）</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">供应商</span><select data-p="asr.provider" style="width:280px"><option value="local"' + (((c.asr && c.asr.provider) || 'local') === 'local' ? ' selected' : '') + '>本机模型（faster-whisper，免费但吃内存）</option><option value="openai"' + ((c.asr && c.asr.provider) === 'openai' ? ' selected' : '') + '>OpenAI 兼容接口（/audio/transcriptions）</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="asr.key" type="password" placeholder="本机模型可留空；云端接口再填" style="flex:1"></div>'
    + customUrlBlock('asrUrlAdv', '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="asr.baseUrl" value="' + escAttr((c.asr && c.asr.baseUrl) || '') + '" style="flex:1" placeholder="选 OpenAI 兼容时再填，如 https://api.openai.com/v1"></div>', !!((c.asr && c.asr.baseUrl)))
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="asr.model" list="dlAsr" value="' + escAttr((c.asr && c.asr.model) || '') + '" style="width:260px" placeholder="留空 = whisper-1"><button class="ghost" onclick="pullModels(\'asr\')">拉取目录</button><span class="dim" id="amMsg">可下拉选，也可手填</span><datalist id="dlAsr"></datalist></div>'
    + '<h4 class="sect">画图</h4>'
    + cb('允许她自己画图', 'draw.enabled', !(c.draw && c.draw.enabled === false), '聊天时她会用 [[画:…]] 亲手画一张发给你')
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">供应商</span><select data-p="draw.provider" style="width:320px"><option value="auto"' + (((c.draw && c.draw.provider) || 'auto') === 'auto' ? ' selected' : '') + '>自动（看地址判断）</option><option value="ark"' + ((c.draw && c.draw.provider) === 'ark' ? ' selected' : '') + '>火山方舟 Seedream（支持参考图）</option><option value="dashscope"' + ((c.draw && c.draw.provider) === 'dashscope' ? ' selected' : '') + '>阿里云百炼·万相（异步，纯文字）</option><option value="openai"' + ((c.draw && c.draw.provider) === 'openai' ? ' selected' : '') + '>OpenAI 兼容 /images/generations</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="draw.key" type="password" placeholder="' + (dInfo.keySet ? ('已保存 ' + (dInfo.keyMask || '') + '（留空不改）') : '留空 = 用 data\\aliyun.key 或 data\\ark.key') + '" style="flex:1"></div>'
    + customUrlBlock('drawUrlAdv', '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="draw.baseUrl" value="' + escAttr((c.draw && c.draw.baseUrl) || '') + '" style="flex:1" placeholder="留空=各家默认：火山 https://ark.cn-beijing.volces.com/api/v3 / 阿里云 https://dashscope.aliyuncs.com"></div>', !!((c.draw && c.draw.baseUrl)))
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="draw.model" list="dlDraw" value="' + escAttr((c.draw && c.draw.model) || '') + '" style="width:300px" placeholder="留空用默认"><button class="ghost" onclick="pullModels(\'draw\')">拉取目录</button><span class="dim" id="dmMsg">可下拉选，也可手填 / ep- 接入点</span><datalist id="dlDraw"></datalist></div>'
    + '<div class="row" style="margin:-2px 0 6px 210px"><span id="dKey" class="dim">检查中…</span></div>'
    + cb('画她时带上参考图', 'draw.ref', !(c.draw && c.draw.ref === false), '火山 Seedream 会按「她的样子」锁人物；阿里云不支持')
    + cb('OpenAI 网关也带图', 'draw.sendRef', !!(c.draw && c.draw.sendRef), '多数网关不支持，会报错，默认关')
    + cb('他要照片时别一直拒', 'draw.ownerPush', !!(c.draw && c.draw.ownerPush), '勾上=可以嫌烦但第二次就拍；不勾=完全看她心情（默认）')
    + num('每天最多画', 'draw.perDay', (c.draw && c.draw.perDay) || 3, 1, '张')
    + num('接着上一张的窗口', 'draw.keepMin', (c.draw && c.draw.keepMin) ?? 120, 0, '分钟')
    + '<div class="row" style="margin:0 0 6px"><span style="width:210px" class="dim"></span><span class="dim">这段时间内再拍，会沿用上一张的环境（只换姿势）；她换了地方或超时就算新场景。0 = 从不接着上一张。可在场景里写「还在」「继续」强制接上。</span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim"></span><button class="ghost" onclick="testDraw()">试画一张</button><span class="dim" id="dMsg"></span></div>'
    + '<div id="dOut"></div>'
    + '<h4 class="sect">看图</h4>'
    + '<p class="dim" style="margin:0 0 6px 210px" id="vInfo">检查中…</p>'
    + '<div id="visionFields">'
    + (function () {
        const cur = presetFor(VISION_PRESETS, (c.vision && c.vision.baseUrl) || '', 'brain');
        return providerOptions('viProvider', VISION_PRESETS, cur.id, 'applyVisionProvider')
          + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="vision.key" type="password" placeholder="留空 = 用大脑的 key" style="flex:1"></div>'
          + customUrlBlock('viUrlAdv', '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="vision.baseUrl" value="' + escAttr((c.vision && c.vision.baseUrl) || '') + '" style="flex:1" placeholder="留空 = 用大脑的地址"></div>', cur.id === 'custom')
          + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="vision.model" list="dlVision" value="' + escAttr((c.vision && c.vision.model) || '') + '" style="width:260px" placeholder="留空 = 用大脑的模型"><button class="ghost" onclick="pullModels(\'vision\')">拉取目录</button><span class="dim" id="vmMsg">可下拉选，也可手填</span><datalist id="dlVision"></datalist></div>';
      })()
    + '</div>'
    + '</details>'
    + '<details class="cfgrp" id="gAuto"><summary>主动性<span class="dim">她会不会主动找你、会不会自己上网看东西</span></summary>'
    + '<h4 class="sect">主动消息</h4>'
    + cb('启用 *', 'proactive.enabled', !(c.proactive && c.proactive.enabled === false), '她会主动找你说话')
    + cb('早上加一次', 'proactive.morningBoost', !(c.proactive && c.proactive.morningBoost === false), '起床时段更容易冒泡')
    + num('每天最多', 'proactive.maxPerDay', c.proactive.maxPerDay, 1, '次')
    + num('同一人最少间隔', 'proactive.minGapMin', c.proactive.minGapMin, 5, '分钟')
    + num('你说话后多久才可能', 'proactive.quietMin', c.proactive.quietMin, 5, '分钟')
    + tim('活跃开始', 'proactive.activeFrom', c.proactive.activeFrom)
    + tim('活跃结束', 'proactive.activeTo', c.proactive.activeTo)
    + '<p class="dim" style="margin:0 0 6px 210px">结束早于开始 = 跨夜（比如 10:00 → 04:00）</p>'
    + num('开口概率', 'proactive.chance', c.proactive.chance, 0.05, '0–1')
    + '<h4 class="sect">上网</h4>'
    + cb('启用 *', 'browse.enabled', !(c.browse && c.browse.enabled === false), '真的联网搜（阿里云百炼 enable_search），刷到有意思的会跟你提一句；没有 key 就自动跳过')
    + num('每天最多次数', 'browse.perDay', c.browse.perDay, 1, '次')
    + tim('最早', 'browse.fromTime', c.browse.fromTime)
    + tim('最晚', 'browse.toTime', c.browse.toTime)
    + '</details>'
    + '<p class="dim" style="margin:16px 0 0">界面配色、圆角、字体 → <a href="#theme" style="color:#7fb2ff;opacity:.55">控制台主题（一般用不上）</a></p>';
  fillPresetList('dlBrain', presetFor(BRAIN_PRESETS, br.baseUrl || '').models);
  fillPresetList('dlVision', presetFor(VISION_PRESETS, (c.vision && c.vision.baseUrl) || '', 'brain').models);
  await loadVoiceOptions(((c.tts && c.tts.voiceId) || c.voice || ''));
  paintKeyStatus();
  paintVision();
}

// 「五盏灯」右边那个链接：把对应的折叠组展开并滚过去
function openCfgGroup(id) {
  const d = document.getElementById(id);
  if (!d) return;
  d.open = true;
  try { d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { d.scrollIntoView(); }
}

// 看图这块：大脑能看图就不用配；看不了就用百炼兜底；都没有才标红让用户填
async function paintVision(){
  const el = $('#vInfo');
  if (!el) return;
  try {
    const i = await api('/api/vision/info');
    const fields = $('#visionFields');
    fields.hidden = !!i.brainOk;
    fields.querySelectorAll('input,button').forEach(el => { el.disabled = !!i.brainOk; });
    const tag = i.mode === 'custom' ? '【已单独配置】' : i.mode === 'brain' ? '【大脑自带】' : i.mode === 'fallback' ? '【自动兜底】' : '【需要配置】';
    el.textContent = tag + ' ' + (i.note || '') + (i.model ? '（当前用：' + i.model + '）' : '');
    el.style.color = i.mode === 'none' ? '#e5a13a' : i.mode === 'fallback' ? '#9ab0cc' : '#6fcf7f';
  } catch (e) { el.textContent = '读取失败：' + (e.message || e); }
}

// 画图那块显示 key 到底有没有生效（输入框 > data\ark.key / aliyun.key > 沿用大脑）
async function paintKeyStatus(){
  const el = $('#dKey');
  if (!el) return;
  try {
    const i = await api('/api/draw/info');
    const m = i.mode || i.provider || '?';
    if (!i.keySet) {
      el.textContent = '未生效：输入框空着，也没有 data\\ark.key / data\\aliyun.key';
      el.style.color = '#e5a13a';
      return;
    }
    el.textContent = '已生效 ' + (i.keyMask || '') + ' · 后端 ' + m + ' · 模型 ' + (i.model || '-') + (i.hasRef ? ' · 有参考图' : ' · 无参考图');
    el.style.color = '#6fcf7f';
  } catch (e) {
    el.textContent = '读取失败：' + (e.message || e);
  }
}

// 音色包：下拉 + 增删
async function loadVoiceOptions(cur) {
  const sel = $('#voiceSel');
  if (!sel) return;
  try {
    const r = await api('/api/voices');
    sel.innerHTML = (r.list || []).map(v =>
      '<option value="' + v.id + '"' + (v.id === cur ? ' selected' : '') + '>' +
      (v.builtin ? '' : '★ ') + v.name + '（' + v.id + '）</option>').join('');
    if (!(r.list || []).some(v => v.id === cur)) {
      sel.insertAdjacentHTML('afterbegin', '<option value="' + cur + '" selected>' + cur + '</option>');
    }
    sel.dataset.custom = (r.custom || []).map(v => v.id).join(',');
  } catch (e) { $('#vMsg').textContent = '音色列表读取失败：' + (e.message || e); }
}
async function previewVoice() {
  const sel = $('#voiceSel');
  const msg = $('#vMsg');
  msg.textContent = '合成中…';
  try {
    const r = await api('/api/voice/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: sel ? sel.value : '', text: '这是试听，我是大肥鱼。' }),
    });
    if (!r.ok) { msg.textContent = '失败：' + (r.err || ''); return; }
    msg.textContent = '播放中（' + (r.secs || '?') + ' 秒，' + (r.provider || '') + '）';
    const a = new Audio('data:audio/wav;base64,' + r.wav);
    a.onended = () => { msg.textContent = '播放完毕（' + (r.secs || '?') + ' 秒）'; };
    a.onerror = () => { msg.textContent = '浏览器没能播放这段音频'; };
    await a.play().catch(e => { msg.textContent = '浏览器拦了自动播放：' + e.message; });
  } catch (e) { msg.textContent = '失败：' + (e.message || e); }
}
async function addVoice() {
  const name = ($('#vNewName').value || '').trim();
  const id = ($('#vNewId').value || '').trim();
  const msg = $('#vMsg');
  if (!id) { msg.textContent = '音色 ID 不能空'; return; }
  const r = await api('/api/voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }) });
  if (!r.ok) { msg.textContent = '添加失败：' + (r.err || ''); return; }
  $('#vNewName').value = ''; $('#vNewId').value = '';
  msg.textContent = '已添加 ' + id + '（记得点保存）';
  await loadVoiceOptions(id);
}
async function delVoice() {
  const sel = $('#voiceSel');
  const id = sel ? sel.value : '';
  const custom = (sel && sel.dataset.custom ? sel.dataset.custom.split(',') : []);
  if (!custom.includes(id)) { $('#vMsg').textContent = '内置音色不能删（★ 才是自加的）'; return; }
  if (!(await askConfirm('确定删除音色包 ' + id + '？', '删除音色包'))) return;
  const r = await api('/api/voices?id=' + encodeURIComponent(id), { method: 'DELETE' });
  $('#vMsg').textContent = r.ok ? ('已删除 ' + id) : ('删除失败：' + (r.err || ''));
  await loadVoiceOptions('');
}
async function openData(){
  const r = await api('/api/open-data', { method: 'POST' });
  if (!r.ok) alert('打开失败：' + (r.err || '未知原因'));
}

// 从服务端拉模型候选，填进 datalist（下拉可选，也能手填）
async function pullModels(kind){
  const cfg = { chat: { msg: '#brMsg', dl: '#dlBrain', model: 'brModel', base: 'brUrl', key: 'brKey' },
                draw: { msg: '#dmMsg', dl: '#dlDraw', model: 'draw.model', base: 'draw.baseUrl', key: 'draw.key' },
                vision: { msg: '#vmMsg', dl: '#dlVision', model: 'vision.model', base: 'vision.baseUrl', key: 'vision.key' },
                asr: { msg: '#amMsg', dl: '#dlAsr', model: 'asr.model', base: 'asr.baseUrl', key: 'asr.key' },
                tts: { msg: '#tmMsg', dl: '#dlTts', model: 'tts.model', base: 'tts.baseUrl', key: 'tts.key' } }[kind];
  if (!cfg) return;
  const box = cfg.msg ? document.querySelector(cfg.msg) : null;
  const dl = cfg.dl ? document.querySelector(cfg.dl) : null;
  const val = p => { const el = document.querySelector('[data-p="' + p + '"]') || document.getElementById(p); return el ? el.value.trim() : ''; };
  if (box) box.textContent = '拉取中…';
  try {
    const body = { kind, baseUrl: cfg.base ? val(cfg.base) : '', key: cfg.key ? val(cfg.key) : '' };
    const r = await api('/api/models/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let ids = (r.ids || []).slice();
    let note = '';
    if (!ids.length) {
      const fb = fallbackModels(kind);
      if (fb.length) { ids = fb; note = '接口没返回目录，先用预设，也可以手填'; }
    }
    if (dl && dl.tagName === 'DATALIST') dl.innerHTML = ids.map(id => '<option value="' + escAttr(id) + '"></option>').join('');
    if (box) box.textContent = ids.length ? (note || ('拉到 ' + ids.length + ' 个，点输入框下拉选' + (r.from ? '（' + r.from + '）' : ''))) : ('没拉到：' + (r.err || '空') + '。可以手填模型名');
    const target = document.querySelector('[data-p="' + cfg.model + '"]') || document.getElementById(cfg.model);
    if (ids.length && target) showModelMenu(target, ids);
    if (ids.length === 1 && target && !target.value.trim()) target.value = ids[0];
  } catch (e) { if (box) box.textContent = '拉取失败：' + (e.message || e); }
}
async function saveBrainPanel(){
  const body = { baseUrl: $('#brUrl').value.trim(), model: $('#brModel').value.trim(), key: $('#brKey').value.trim() };
  const r = await api('/api/brain', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) { $('#brMsg').textContent = '已保存。重启桥接后生效。'; $('#brKey').value = ''; }
  else $('#brMsg').textContent = '保存失败：' + (r.error || '');
}
async function testDraw(){
  const m = $('#dMsg'); const out = $('#dOut');
  if (!m) return;
  m.textContent = '画中…（最长约 1 分钟）';
  try {
    const r = await api('/api/draw/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) { m.textContent = '失败：' + (r.err || ''); return; }
    m.textContent = '成功 ' + Math.round((r.ms || 0) / 1000) + ' 秒 · ' + (r.model || '');
    const name = String(r.file || '').split(/[\\/]/).pop();
    out.innerHTML = '<img src="/drawn/' + encodeURIComponent(name) + '?t=' + Date.now() + '" style="max-width:360px;border-radius:8px;margin:8px 0 8px 210px">';
  } catch (e) { m.textContent = '失败：' + (e.message || e); }
}
let _modelMenu = null;
let _menuHandler = null;
function closeModelMenu(){
  if (_modelMenu) { _modelMenu.remove(); _modelMenu = null; }
  if (_menuHandler) { document.removeEventListener('mousedown', _menuHandler, true); _menuHandler = null; }
}
function showModelMenu(input, ids){
  closeModelMenu();
  const r = input.getBoundingClientRect();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:9999;background:#1b2029;border:1px solid #333a46;border-radius:8px;'
    + 'box-shadow:0 10px 30px #0009;max-height:280px;overflow:auto;padding:4px 0;'
    + 'left:' + r.left + 'px;top:' + (r.bottom + 2) + 'px;min-width:' + Math.max(240, r.width) + 'px';
  box.innerHTML = ids.map(id => '<div class="mi" style="padding:7px 12px;cursor:pointer;font-size:13px">' + id + '</div>').join('');
  box.querySelectorAll('.mi').forEach(d => {
    d.onmouseenter = () => { d.style.background = '#2a3342'; };
    d.onmouseleave = () => { d.style.background = 'transparent'; };
    d.onclick = () => { input.value = d.textContent; closeModelMenu(); };
  });
  document.body.appendChild(box);
  _modelMenu = box;
  _menuHandler = e => { if (_modelMenu && _modelMenu.contains(e.target)) return; closeModelMenu(); };
  setTimeout(() => document.addEventListener('mousedown', _menuHandler, true), 0);
}

async function testBrain(){
  const msg = $('#brMsg');
  msg.textContent = '测试中…';
  try {
    const body = { baseUrl: $('#brUrl').value.trim(), model: $('#brModel').value.trim(), key: $('#brKey').value.trim() };
    const r = await api('/api/brain/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const said = r.reply || r.text || '';
    msg.textContent = r.ok ? ('连接成功' + (said ? '，模型回了一句：' + String(said).slice(0, 40) : '（模型回了空内容）')) : ('连不上：' + (r.err || '未知错误'));
  } catch (e) { msg.textContent = '测试失败：' + (e.message || e); }
}
async function resetPrompts() {
  try {
    const d = await api('/api/prompts/defaults');
    const set = (p, v) => { const el = document.querySelector('[data-p="' + p + '"]'); if (el) el.value = v || ''; };
    for (const k of ['style', 'selfie', 'selfieFull', 'selfieBan', 'ref', 'scene', 'sceneBan']) set('prompts.' + k, (d.prompts || {})[k]);
    set('drawStyle', d.drawStyle || 'anime');
    markDirty();
    toast('已填回默认文案，记得点保存', true);
  } catch (e) { toast('取默认值失败：' + e.message, false); }
}

function openAvatars(){
  const btn = document.querySelector('nav button[data-t="set"]') || document.querySelector('button[data-t="set"]');
  if (btn) btn.click();
  setTimeout(() => { const el = document.getElementById('avHer'); if (el) el.scrollIntoView({ block: 'center' }); }, 150);
}
function pickAvatar(who){
  const f0 = document.getElementById('avFile');
  f0.value = '';
  f0.onchange = () => {
    const file = f0.files && f0.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = async () => {
      const r = await api('/api/chat/avatar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who, dataUrl: fr.result }) });
      if (r && r.ok) { document.getElementById(who === 'me' ? 'avMe' : 'avHer').src = '/api/chat/avatar/' + who + '?t=' + Date.now(); toast('头像已换'); }
      else toast('换头像失败：' + ((r && r.err) || ''));
    };
    fr.readAsDataURL(file);
  };
  f0.click();
}
async function clearAvatar(who){
  await api('/api/chat/avatar/' + who, { method: 'DELETE' }).catch(() => ({}));
  document.getElementById(who === 'me' ? 'avMe' : 'avHer').src = '/api/chat/avatar/' + who + '?t=' + Date.now();
  toast('已恢复默认');
}
async function saveCfg(){
  const c = await api('/api/config');
  document.querySelectorAll('#cfgBox [data-cb]').forEach(el => {
    const parts = el.dataset.cb.split('.');
    let o = c; for (let i=0;i<parts.length-1;i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length-1]] = el.checked;
  });
  document.querySelectorAll('#cfgBox [data-p]').forEach(el => {
    if (el.disabled) return;
    let v = el.type === 'number' ? Number(el.value) : el.value;
    if (el.tagName === 'TEXTAREA' && /^talk\./.test(el.dataset.p)) {
      v = String(el.value).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    }
    if (el.type === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return; // 空值或非法时间就不覆盖
    }
    if (/\.key$/.test(el.dataset.p) && !String(v).trim()) return; // 任何 key 留空=不改
    const parts = el.dataset.p.split('.');
    let o = c; for (let i=0;i<parts.length-1;i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length-1]] = v;
  });
  const sel = $('#voiceSel');
  if (sel && sel.value) { c.tts = c.tts || {}; c.tts.voiceId = sel.value; }
  let r;
  try {
    r = await api('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : '网络错误'), false);
    return;
  }
  if (!r || !r.ok) { toast('保存失败，看日志页', false); return; }
  clearDirty();
  const tip = '已保存，下一条消息就生效';
  for (const sel of ['#cfgMsg', '#gMsg']) {
    const m = document.querySelector(sel);
    if (m) { m.textContent = tip; m.style.color = '#7ee2a8'; setTimeout(() => { m.textContent = ''; }, 6000); }
  }
  toast('已保存 ✓');
}
async function restartBridgeClick(){
  const m = $('#cfgMsg');
  const say = (t, c) => { if (m) { m.textContent = t; m.style.color = c; } };
  say('正在重启桥接…', '#d7a35c');
  try { await api('/api/restart', { method: 'POST' }); } catch {}
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const st = await api('/api/state');
      if (st && st.bridge && st.bridge.alive) { say('桥接已重启（pid ' + st.bridge.pid + '）', '#7ee2a8'); return; }
    } catch {}
  }
  say('桥接没起来，去「日志」页看看', '#e2777a');
}
async function loadLog(){
  try {
    const r = await api('/api/log'); $('#logPre').textContent = (r.lines || []).slice().reverse().join('\n') || '暂无运行日志';
    const state = await api('/api/state'); $('#kernelLog').textContent = (state.kernel || []).slice().reverse().join('\n') || '暂无 QQ 内核日志';
  } catch (e) { $('#logPre').textContent = '读取失败：' + e.message; }
}
async function loadRecent(){
  const el = document.getElementById('recentPre');
  if (!el) return;
  try {
    const r = await api('/api/log');
    const lines = (r && r.lines) || [];
    const recent = lines.slice(-20).reverse().map(humanLog);
    el.textContent = recent.join('\n') || '还没有运行记录';
    $('#recentSummary').textContent = recent.slice(0, 3).join('\n') || '还没有运行记录';
  } catch (e) { el.textContent = '读不到日志：' + e.message; }
}

const LV = ['正常', '降耗（停自主浏览，主动 1 条/天）', '停语音条', '只被动回复、话更短', '已通知并停止'];
const PRICE_LBL = { inputPerM: ['输入', '/百万 token'], cacheHitPerM: ['缓存命中', '/百万 token'], outputPerM: ['输出', '/百万 token'], ttsPerKChar: ['语音合成', '/千字符'], asrPerSec: ['语音识别', '/秒'], visionPerCall: ['看图', '/次'] };
function priceChips(p){
  if (!p) return '';
  const parts = Object.keys(PRICE_LBL).filter(k => p[k] != null).map(k => {
    const [name, unit] = PRICE_LBL[k];
    return '<span class="pricechip"><b>' + name + '</b> ￥' + p[k] + ' <i>' + unit + '</i></span>';
  });
  return '<span class="dim" style="font-size:12px">计价单价</span> ' + (parts.join('') || '<span class="dim">（默认值）</span>');
}

async function loadBudget(){
  const b = await api('/api/budget');
  const pct = Math.min(100, b.cap ? b.spent / b.cap * 100 : 0);
  const names = { chat: '对话', tts: '语音合成', asr: '语音识别', vision: '看图', draw: '画图' };
  const rows = Object.entries(b.byKind).map(([k, v]) => '<tr><td>' + (names[k] || k) + '</td><td>￥' + v.toFixed(4) + '</td></tr>').join('');
  $('#budBox').innerHTML =
    '<div class="row" style="margin:8px 0"><b style="font-size:22px">￥' + b.spent.toFixed(2) + '</b>'
    + '<span class="bar"><i style="width:' + pct + '%"></i></span>'
    + '<span class="dim">预算 ' + b.cap + ' 元 · 停止线 ' + b.stopAt + ' 元</span></div>'
    + '<div class="dim">今天 ￥' + b.today.toFixed(4) + ' · 本月调用 ' + b.calls + ' 次 · 状态：' + (LV[b.level] || b.level) + '</div>'
    + '<table style="margin-top:10px"><tr><th>项目</th><th>本月</th></tr>' + rows + '</table>'
    + '<div class="priceline">' + priceChips(b.prices) + '</div>';
  $('#bCap').value = b.cap;
  $('#bExtra').value = b.notifyExtra;
  $('#bEnabled').checked = b.enabled !== false;
  $('#actual').value = b.actual ?? '';
  $('#diffBox').textContent = b.actual
    ? '实际 ￥' + b.actual + ' / 本地估算 ￥' + b.spent.toFixed(2) + '（估算偏高 ' + (b.spent - b.actual).toFixed(2) + ' 元）'
    : '';
}
async function saveActual(){
  const v = $('#actual').value;
  await api('/api/budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actual: v === '' ? null : Number(v) }) });
  loadBudget();
}
async function saveBudgetCfg(){
  const c = await api('/api/config');
  c.budget.monthlyCap = Number($('#bCap').value);
  c.budget.notifyExtra = Number($('#bExtra').value);
  c.budget.enabled = $('#bEnabled').checked;
  await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
  loadBudget();
}
async function resetBudget(){
  if (!(await askConfirm('把本月已花金额清零？', '金额清零'))) return;
  await api('/api/budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
  loadBudget();
}

// 密码登录：把三步写给人看，并盯着"内核 → QQ 窗口 → 已登录"三个阶段。
const QQ_STAGE_TXT = { idle: '未开始', booting: '内核起来了，等扫码', login: '内核起来了，等扫码', online: '已登录' };
async function qqLoginRefresh(){
  try {
    // 已经有码就顺手画出来（旧码也算，扫之前一直有效）
    const s2 = await api('/api/state').catch(function(){ return null; });
    if (s2 && s2.qr && s2.qr.exists && $('#qrSlot')) { __qrOpen = true; paintQr(s2); }
    const st = await api('/api/qq/login/status').catch(function(){ return null; });
    const el = document.getElementById('qqLoginStage');
    if (el && st && st.ok) {
      el.textContent = QQ_STAGE_TXT[st.stage] || st.stage;
      el.className = st.stage === 'online' ? 'ok' : 'dim';
    }
    return st;
  } catch (e) { return null; }
}
async function qqScanNow(btn){
  const msg = document.getElementById('qqLoginMsg');
  if (btn) { btn.disabled = true; btn.textContent = '正在拉起内核…'; }
  if (msg) msg.textContent = '';
  // 关键：paintQr 会按 __qrOpen 决定显不显示二维码区，默认是关的。
  __qrOpen = true;
  try {
    await api('/api/qr/refresh', { method: 'POST' }).catch(function(){});
    // 内核起来后码会写进 cache/qrcode.png，轮询等它出；一有就画
    for (let i = 0; i < 24; i++) {
      const st = await api('/api/state').catch(function(){ return null; });
      if (st && st.qr && st.qr.exists) { STATE = st; if ($('#qrSlot')) paintQr(st); break; }
      await new Promise(function(r){ setTimeout(r, 1500); });
    }
    if (msg) msg.textContent = '码在上面，扫一下就行';
  } catch (e) { if (msg) msg.textContent = String(e.message || e); }
  if (btn) { btn.disabled = false; btn.textContent = '扫码登录 QQ'; }
  qqLoginRefresh();
}
async function qqLoginStartUnused(btn){
  const msg = document.getElementById('qqLoginMsg');
  if (btn) { btn.disabled = true; btn.textContent = '正在拉起…'; }
  if (msg) msg.textContent = '';
  try {
    const r = await api('/api/qq/login/start', { method: 'POST' }).catch(function(e){ return { ok:false, err:String(e.message||e) }; });
    if (r && r.ok === false) { if (msg) msg.textContent = r.err || '拉不起来'; }
    else if (msg) msg.textContent = 'QQ 窗口应该在屏幕上了，去那儿点「账号密码登录」';
  } catch (e) { if (msg) msg.textContent = String(e.message || e); }
  if (btn) { btn.disabled = false; btn.textContent = '启动 QQ，去登录'; }
  qqLoginRefresh();
}
async function qqLoginAttach(btn){
  const msg = document.getElementById('qqLoginMsg');
  if (btn) { btn.disabled = true; btn.textContent = '正在接上…'; }
  if (msg) msg.textContent = '正在拉起内核，等它复用 QQ 的登录态…';
  try {
    const r = await api('/api/qq/login/attach', { method: 'POST' }).catch(function(e){ return { ok:false, err:String(e.message||e) }; });
    if (msg) msg.textContent = (r && r.ok !== false) ? (r.stage === 'online' ? '接上了' : '内核起来了，可能还要等十几秒') : (r.err || '接不上');
  } catch (e) { if (msg) msg.textContent = String(e.message || e); }
  if (btn) { btn.disabled = false; btn.textContent = '登录好了，接上她'; }
  qqLoginRefresh();
}
function qqLoginPaintSteps(){
  const box = document.getElementById('qqLoginSteps');
  if (!box || box.childElementCount) return;
  const steps = [
    '点「打开 QQ」——会开出电脑版 QQ 的登录窗口（这个号真正的客户端）。',
    '在窗口里用账号密码登录，勾上「记住密码 / 自动登录」；手机弹「是否本人登录」就点「是我本人」。',
    '登录好之后点「接上她」——她在后台连上这个 QQ，以后开机自动登录，不用再输密码。',
  ];
  box.innerHTML = steps.map(function(t){ return '<li>' + t + '</li>'; }).join('');
}

// 没填主人号时，QQ 页顶部常驻一行提示——不然"她把你记成 local"这件事用户永远不知道。
async function paintOwnerHint(){
  try {
    const el = document.getElementById('qqOwnerHint');
    if (!el) return;
    const su = await api('/api/setup').catch(function(){ return null; });
    const has = !!(su && String(su.ownerUin || '').trim());
    el.style.display = has ? 'none' : '';
  } catch (e) {}
}

// 五盏灯里的语音/识别：先按配置画，随后拿真实探测结果更正。
// 起因：全新机器上没配语音，灯却是绿的；她真去发语音时报 edge-tts 9009（没有 Python）。
async function refreshCaps(){
  try {
    const r = await api('/api/caps').catch(function(){ return null; });
    if (!r || r.err) return;
    const paint = function(id, st){
      const el = document.getElementById(id);
      if (!el || !st) return;
      const span = el.querySelector('span:nth-child(2)');
      const link = el.querySelector('a');
      if (span) {
        span.className = st.ok ? 'ok' : 'bad';
        span.textContent = (st.ok ? '✓ ' : '✗ ') + (st.label || '');
        span.title = st.why || '';
      }
      if (link) link.textContent = st.ok ? '改' : '去配';
    };
    paint('lampTts', r.tts);
    paint('lampAsr', r.asr);
  } catch (e) {}
}

// ===== 第一次见面（向导）=====
// 只在「没有 API Key」或「还没填你是谁」时出现一次，做完就不再打扰。
function wzEl(){ return $('#wz'); }
function wzSleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

async function maybeWizard(){
  try {
    const s = await api('/api/setup');
    const b = await api('/api/brain').catch(function(){ return null; });
    const keySet = !!(s && s.keySet) || !!(b && b.keySet);
    // 主人号可以留空（卡片上就写着可以留空），所以不拿它当门槛。
    // 以前的 bug：留空时这张卡每次打开都弹回来。
    if ((s && s.introDone) || keySet) return;
    const name0 = (s && s.name) ? s.name : '大肥鱼';
    const uin0 = (s && s.ownerUin) ? s.ownerUin : '';
    const box = document.createElement('div');
    box.id = 'wz'; box.className = 'wz-mask';
    box.innerHTML = ''
      + '<div class="wz-box">'
      + '  <div class="wz-t">第一次见面</div>'
      + '  <div class="wz-d">三步就能让她开口。做完了这张卡不会再出现。</div>'
      + '  <label class="wz-l">她叫什么<input id="wzName" value="' + esc(name0) + '" maxlength="24"></label>'
      + '  <label class="wz-l">你的 QQ（可以留空，留空就只在电脑上说）<input id="wzUin" value="' + esc(uin0) + '" placeholder="例如 123456789" inputmode="numeric"></label>'
      + '  <details class="wz-adv"><summary>高级</summary>'
      + '  <label class="wz-l">大脑地址<input id="wzBase" value="https://api.deepseek.com/v1"></label>'
      + '  <label class="wz-l">模型<input id="wzModel" value="deepseek-flash"></label>'
      + '  </details>'
      + '  <label class="wz-l">API Key（没有它她不会说话）<input id="wzKey" type="password" placeholder="sk-..."></label>'
      + '  <div class="wz-btns"><button class="pri btn" id="wzGo">保存，说第一句</button>'
      + '  <button class="ghost btn" id="wzSkip">去模型页自己填</button></div>'
      + '  <div id="wzLog" class="wz-log"></div>'
      + '</div>';
    document.body.appendChild(box);
    $('#wzSkip').onclick = async function(){
      box.remove();
      // 跳过也要落盘：不然下次打开控制台，这张卡又弹回来（全新机器实测过一次）。
      try { await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ introDone: true }) }); } catch (e) {}
      goPage('config');
    };
    $('#wzGo').onclick = wzSave;
    setTimeout(function(){ try { $('#wzName').focus(); } catch (e) {} }, 100);
  } catch (e) {}
}

function wzLine(text, cls){
  const log = $('#wzLog');
  if (!log) return;
  const d = document.createElement('div');
  d.className = 'wz-line ' + (cls || '');
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

async function wzSave(){
  const name = (($('#wzName') || {}).value || '').trim() || '大肥鱼';
  const uin = (($('#wzUin') || {}).value || '').replace(/\D/g, '').slice(0, 12);
  const key = (($('#wzKey') || {}).value || '').trim();
  const baseUrl = (($('#wzBase') || {}).value || '').trim() || 'https://api.deepseek.com/v1';
  const model = (($('#wzModel') || {}).value || '').trim() || 'deepseek-flash';
  if (!key) { wzLine('先填 API Key——没有它她不会说话。', 'bad'); return; }

  const go = $('#wzGo');
  if (go) { go.disabled = true; go.textContent = '正在保存…'; }
  wzLine('保存中…');
  try {
    const rs = await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, ownerUin: uin, introDone: true }) });
    if (rs && rs.ok === false) throw new Error(rs.err || '保存失败');
    const rb = await api('/api/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: baseUrl, model: model, key: key }) });
    if (rb && rb.ok === false) throw new Error(rb.err || '保存失败');
    wzLine('好了，正在让她重新起来…');
    await api('/api/restart', { method: 'POST' }).catch(function(){});
    let alive = false;
    for (let i = 0; i < 40; i++) {
      await wzSleep(1000);
      const st = await api('/api/state').catch(function(){ return null; });
      if (st && st.bridge && st.bridge.ok) { alive = true; break; }
    }
    if (!alive) { wzLine('桥接没起来：去「日志」页看看，或者点「重启桥接」。', 'bad'); if (go) { go.disabled = false; go.textContent = '再试一次'; } return; }
    wzLine('她起来了。跟她说第一句——');
    await api('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好呀，你好吗' }) });
    const seen = {};
    let got = false;
    for (let i = 0; i < 45 && !got; i++) {
      await wzSleep(1000);
      const m = await api('/api/chat/msgs?since=0').catch(function(){ return null; });
      const list = (m && (m.msgs || m.list)) || [];
      for (const it of list) {
        const k = String(it.at) + '|' + String(it.dir);
        if (seen[k] || !it.text) continue;
        seen[k] = 1;
        wzLine((it.dir === 'out' ? name + '：' : '你：') + it.text, it.dir === 'out' ? 'her' : '');
        if (it.dir === 'out') got = true;
      }
    }
    if (!got) {
      wzLine('她没说话：多半是 Key 不对或者地址错了。去「模型页」点「测试连接」看看。', 'bad');
      if (go) { go.disabled = false; go.textContent = '再试一次'; go.onclick = wzSave; }
      return;
    }
    wzLine('能回话就成了。接着去聊天窗跟她说吧。');
    if (go) { go.disabled = false; go.textContent = '打开聊天窗'; go.onclick = function(){
      const e = wzEl(); if (e) e.remove();
      const url = 'http://127.0.0.1:3210/';
      try { if (typeof openChatWindow === 'function') { openChatWindow(); return; } } catch (err) {}
      try { const w = window.open(url, 'dschat_chat'); if (!w) location.href = url; } catch (err2) { location.href = url; }
    }; }
    const skipDone = $('#wzSkip');
    if (skipDone) { skipDone.textContent = '留在控制台'; skipDone.onclick = function(){ const e = wzEl(); if (e) e.remove(); location.reload(); }; }
  } catch (e) {
    wzLine('出错了：' + String((e && e.message) || e), 'bad');
    if (go) { go.disabled = false; go.textContent = '再试一次'; go.onclick = wzSave; }
  }
}

loadState(); loadRecent(); loadPersona(); loadSelf(); loadCfg();
setTimeout(function(){ refreshCaps(); paintOwnerHint(); qqLoginPaintSteps(); qqLoginRefresh(); }, 800);
setTimeout(() => { maybeWizard(); }, 600);
setTimeout(() => { loadQqGuide(); }, 600);
setInterval(() => { if ($('#overview') && $('#overview').classList.contains('on')) { loadState(); loadRecent(); } }, 15000);

</script>  <div id="toast"></div>
</body></html>`;

server.listen(PORT, process.env.QQBOT_UI_HOST || '127.0.0.1', () => {
  console.log('[ui] http://127.0.0.1:' + server.address().port);
});

