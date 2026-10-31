// 控制台：http://127.0.0.1:3070
// 只监听本机；改人格 / 记忆 / 表情包 / 兴趣 / 设置 / 看日志
import * as workdialog from './workdialog.mjs';
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
import { PATHS, loadSetup, saveSetup } from './paths.mjs';
import { testKey } from './brain.mjs';
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
const DEL_CODE_TTL_MS = 5 * 60_000;
let delCode = '';
let delCodeExp = 0;
let delCodeTries = 0;
function issueDelCode() {
  delCode = String(Math.floor(100000 + Math.random() * 900000));
  delCodeExp = Date.now() + DEL_CODE_TTL_MS;
  delCodeTries = 0;
  return { code: delCode, left: Math.round(DEL_CODE_TTL_MS / 1000) };
}
function delCodeState() {
  const left = delCodeExp - Date.now();
  if (!delCode || left <= 0) { delCode = ''; return { active: false, code: '', left: 0 }; }
  return { active: true, code: delCode, left: Math.ceil(left / 1000) };
}
function checkDelCode(input) {
  const st = delCodeState();
  if (!st.active) return { ok: false, code: 409, err: '授权码没生成或已过期。去「状态」页点「生成删除授权码」，5 分钟内有效。' };
  if (String(input || '').trim() !== delCode) {
    delCodeTries++;
    if (delCodeTries >= 5) { delCode = ''; delCodeTries = 0; return { ok: false, code: 429, err: '输错 5 次，授权码已作废，重新生成一个' }; }
    return { ok: false, code: 403, err: '授权码不对（还能试 ' + (5 - delCodeTries) + ' 次）' };
  }
  delCode = ''; delCodeTries = 0;   // 一次性：用过即废
  return { ok: true };
}

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
      <div class="row" style="margin-top:12px"><button class="pri" onclick="saveBrain(this)">保存</button></div>
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
      + '<div style="color:#8b93a1;font-size:13px;margin-bottom:12px">电脑端「状态 → 手机访问」里能看到这个密码</div>'
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
function chatAdd(m, silent){
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
async function chatLoadHistory(){
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
async function chatPoll(){
  try{
    const r = await api('/api/chat/msgs?since=' + CHAT_SINCE);
    if (!r || !r.ok) { $('#chatHint').textContent = (r && r.err) ? r.err : ''; return; }
    $('#chatHint').textContent = '';
    for (const m of (r.msgs || [])) if (m.at > CHAT_SINCE) { chatAdd(m); CHAT_SINCE = m.at; if (m.dir === 'out') chatNotify(m.text || (m.type === 'image' ? '[图片]' : m.type === 'voice' ? '[语音]' : '')); }
  }catch(e){}
}
function chatBoot(){
  if (CHAT_TIMER) { chatPoll(); return; }
  chatLoadHistory();
  CHAT_TIMER = setInterval(() => { const t = document.getElementById('t-chat'); if (t && t.classList.contains('on')) chatPoll(); }, 1500);
  const ta = $('#chatIn');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
}
async function chatSend(){
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
async function testNotify(btn){
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
function qrClosedCard(){return '<div class="card"><div class="row" style="justify-content:space-between"><b>QQ 接入已关闭</b><button class="pri" onclick="qqStartScan(this)">启动扫码登录 QQ</button></div><div class="hint">聊天用 DSChat 就够，要用 QQ 时再点右边这个按钮，才会拉起内核并出码。</div></div>';}
function paintQr(S){
const box=$('#qrCard');
if (!S.qqEnabled) { box.innerHTML = qrClosedCard(); return }
  if (S.login) { box.innerHTML=''; return }
  const qr=S.qr||{};
  const age = qr.exists ? Math.round((Date.now()-qr.at)/1000) : -1;
  const stale = age > 600 || age < 0; // 10 分钟视为过期；内核没跑=无码
if (stale) {
  box.innerHTML = '<div class="card"><div class="row" style="justify-content:space-between"><b>QQ 接入已开启，但没有有效二维码</b>'
    + '<button class="pri" onclick="qqStartScan(this)">启动扫码登录 QQ</button></div>'
    + '<div class="hint">当前守护状态：' + ((S.guard && S.guard.status) || '未知') + '。点上面按钮会拉起 QQ 内核并生成新码；出码后再点「立即换一张」可以强制换。</div></div>';
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
async function restartBridge(btn){
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
  $('#bAlive').textContent=(S.bridge&&S.bridge.alive)?('运行中 pid '+S.bridge.pid):'没在跑';
  if (!S.bridge) { $('#bAlive').textContent='读不到（可能要在电脑上看一眼）'; }
  $('#bLogin').textContent=S.login?(S.login.nickname+'（'+S.login.user_id+'）'):'未登录';
  const b=S.budget||{};
  { const v=Number(b.today||0), m=Number(b.spent||0); $('#bCost').textContent='¥'+v.toFixed(2)+' / 本月 ¥'+m.toFixed(2) }
  paintQr(S);
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
async function loadPersona(){
  const r=await api('/api/persona');
  $('#persona').value=(r&&r.text)||'';
}
async function savePersona(btn){
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
async function loadMem(){
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
async function loadLog(btn){
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
async function saveOwner(b){
  const v = document.getElementById("sOwner").value.trim();
  if(!/^[0-9]{5,12}$/.test(v)) return toast("主人 QQ 要填数字", false);
  b.disabled = true;
  try{ await api("/api/setup", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ ownerUin: v }) }); toast("已保存") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
}
async function saveBrain(b){
  const baseUrl = document.getElementById("sUrl").value.trim();
  const model = document.getElementById("sModel").value.trim();
  const key = document.getElementById("sKey").value.trim();
  if(!model) return toast("模型不能为空", false);
  b.disabled = true;
  try{ const r = await api("/api/brain", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ baseUrl: baseUrl, model: model, key: key }) }); toast("已保存，下一条消息生效") }
  catch(e){ toast("保存失败：" + e.message, false) }
  finally{ b.disabled = false }
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
load(); loadPersona(); loadMem(); loadSet();
setInterval(()=>{ if($('#t-home').classList.contains('on')) load() }, 5000);
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
<p>这个密码只管「手机 / 局域网其它设备」打开控制台。电脑上直接打开不需要输。<br>忘了密码：在电脑端「设置 → 手机访问」里能看到或直接清空重设。</p></form>
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

    if (p === '/') return send(res, 200, HTML.replace('__WK_SCRIPT__', workdialog.bootstrap()));

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

  if (p === '/api/qr/refresh' && req.method === 'POST') {
      // 手动换码：杀掉内核 → 用计划任务重新拉起（NapCat 重启后会写一张新码）
      send(res, 200, { ok: true, refreshing: true });
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
          fs.writeFileSync(f, JSON.stringify({ ...prev, scanRequestedAt: Date.now() }, null, 2), 'utf8');
        } catch {}
      })();
      return;
    }
    if (p === '/manifest.webmanifest') { send(res, 410, 'gone'); return; }
  if (false) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        name: '大肥鱼 · 控制台', short_name: '大肥鱼', start_url: '/m', scope: '/',
        display: 'standalone', background_color: '#0b0d11', theme_color: '#0b0d11',
      }));
    }
    if (p === '/m' || p === '/mobile') { send(res, 410, '手机端请使用 DSChat App（浏览器页面已下线）'); return; }
  if (false) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache' });
      return res.end(MOBILE_HTML);
    }
    if (p === '/') {
      const ua = String(req.headers['user-agent'] || '');
      const isMobile = false;   // 手机端走 DSChat App，浏览器不再跳 /m
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
    if (p === '/api/state') {
      const a = alive();
      const QQE = (() => { try { const s2 = settings.load(); return !(s2.qq && s2.qq.enabled === false); } catch { return true; } })();
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
      let qr = { exists: false, at: 0 };
      try { const s = fs.statSync(QR_FILE); qr = { exists: true, at: s.mtimeMs }; } catch {}
      return send(res, 200, {
        qqEnabled: QQE,
        bridge: a, login, people, minds,
        names: readJSON(NAMES, {}),
        ownerUin: ownerUin(),
        delCode: delCodeState().active,
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
        const api0 = apibrain.load() || {};
        let aliKey = '';
        try { const kp = path.join(PATHS.data, 'aliyun.key'); if (fs.existsSync(kp)) aliKey = String(fs.readFileSync(kp, 'utf8')).trim(); } catch {}
        const autoBase = String(vc.baseUrl || api0.baseUrl || '').replace(/\/+$/, '');
        const useAli = !vc.baseUrl && !vc.model && !!aliKey && (!autoBase || /deepseek\.com/i.test(autoBase));
        const baseUrl = useAli ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : (autoBase || 'https://api.deepseek.com/v1');
        const model = useAli ? 'qwen3-vl-plus' : String(vc.model || api0.model || 'deepseek-chat');
        const key = useAli ? aliKey : String(vc.key || api0.key || '');
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
                { type: 'text', text: '用中文详细描述这个角色的外形，供以后画图时保持一致：发色与发型、瞳色、服装与配饰、特殊特征（尾巴、耳鳍、裙摆花纹等）。只输出描述本身，160 字以内，不要解释。' },
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
      if (req.method === 'GET') return send(res, 200, { text: readText(PERSONA) });
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
  if (p === '/api/memory') {
      if (req.method === 'GET') {
        const uin = url.searchParams.get('uin');
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
    if (p === '/api/work' && req.method === 'GET') {
      try { const r = await fetch(LOCAL_URL() + '/work'); return send(res, 200, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/work/suggest' && req.method === 'GET') {
      const q = new URL('http://x' + req.url).searchParams.get('topic') || '';
      try { const r = await fetch(LOCAL_URL() + '/work/suggest?topic=' + encodeURIComponent(q)); return send(res, 200, await r.json()); }
      catch (e) { return send(res, 200, { ok: false, err: String(e.message || e) }); }
    }
    if ((p === '/api/work/start' || p === '/api/work/stop' || p === '/api/work/touch' || p === '/api/work/mode' || p === '/api/work/tools' || p === '/api/work/restore' || p === '/api/work/undo') && req.method === 'POST') {
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
        const chk = checkDelCode(b.code);
        if (!chk.ok) return send(res, chk.code, { ok: false, code: chk.code === 409 ? 'need-code' : 'bad-code', err: chk.err });
      }
      return send(res, 200, { ok: true, uin: b.uin, moved: dropOne(b.uin) });
    }

    // 删除授权码：只放内存，5 分钟 TTL，一次性
    if (p === '/api/delcode') {
      if (req.method === 'POST') {
        const c = issueDelCode();
        return send(res, 200, { ok: true, active: true, code: c.code, left: c.left });
      }
      if (req.method !== 'GET') return send(res, 405, { ok: false, err: '方法不对' });
      return send(res, 200, { ok: true, ...delCodeState() });
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
        const cfgS = settings.load();
        const vc = cfgS.vision || {};
        const brainApi = loadSetup().api || {};
        const { looksVision } = await import('./capability.mjs');
        const custom = !!(vc.baseUrl || vc.model);
        const brainOk = looksVision(brainApi.model);
        let aliok = false;
        try { aliok = !!String(fs.readFileSync(path.join(PATHS.data, 'aliyun.key'), 'utf8')).trim(); } catch {}
        let mode, model, note;
        if (custom) {
          mode = 'custom'; model = vc.model || '(沿用大脑)';
          note = '已单独配置，图片都走这个模型';
        } else if (brainOk) {
          mode = 'brain'; model = brainApi.model;
          note = '大脑模型本身支持看图，不用再配';
        } else if (aliok) {
          mode = 'fallback'; model = 'qwen3-vl-plus';
          note = '大脑模型 ' + (brainApi.model || '') + ' 看不了图，会自动用百炼 qwen3-vl-plus（用的是 data\\aliyun.key）';
        } else {
          mode = 'none'; model = '';
          note = '大脑模型 ' + (brainApi.model || '') + ' 不支持图片输入，也没有百炼 key —— 这里必须填一个能看图的模型';
        }
        send(res, 200, { mode, model, note, brainModel: brainApi.model, aliok });
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
          dataDir: PATHS.data,
          locFile: PATHS.locFile || '',
        });
      }
      const b = await body(req);
      const owner = String(b.ownerUin || '').replace(/\D/g, '').slice(0, 12);
      saveSetup({ qq: { ownerUin: owner, master: owner } });
      return send(res, 200, { ok: true, ownerUin: owner });
    }

    if (p === '/api/open-data' && req.method === 'POST') {
      try {
        spawn('explorer.exe', [PATHS.data], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true, dir: PATHS.data });
      } catch (e) {
        return send(res, 200, { ok: false, err: String((e && e.message) || e).slice(0, 200) });
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
</style></head><body>
<nav>
  <div class="brand"><span class="logo">🐟</span><div><b>大肥鱼</b><i>DSCHAT CONSOLE</i></div></div>
  <button data-t="status" class="on"><span class="i">◎</span>状态</button>
  <button data-t="persona"><span class="i">✎</span>人格</button>
  <button data-t="memory"><span class="i">✦</span>记忆</button>
  <button data-t="stickers"><span class="i">☺</span>表情包</button>
  <button data-t="interests"><span class="i">✧</span>兴趣</button>
  <button data-t="budget"><span class="i">￥</span>预算</button>
  <button data-t="groups"><span class="i">☰</span>群聊</button>
  <button data-t="config"><span class="i">⚙</span>设置</button>
  <button data-t="log"><span class="i">≡</span>日志</button>
</nav>
<main>
<div id="apBox" style="display:none;position:fixed;top:14px;right:16px;width:390px;max-height:72vh;overflow:auto;background:#101a2b;border:1px solid #3d5a86;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);z-index:60;color:#dbe6fa"></div>
<div class="topbar"><div><h1 id="pgTitle">状态</h1><p class="sub" id="pgSub">连接、二维码与今天的用量</p></div></div>
<div class="wrap">
<section id="status" class="on"><div id="qrSlot"></div><div id="statusBox"></div></section>
<section id="persona">
  <div class="card"><div class="row" style="justify-content:space-between"><b>她的样子</b>
    <span class="dim" id="sfState"></span></div>
    <p class="dim">放一张她的图（三视图最好），再写一段长相描述。她会知道自己长什么样；自己画图、发“自拍”时都按这段描述出图。</p>
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
        <textarea id="sfDesc" placeholder="例：蓝发及腰的少女，鲸鱼耳鳍，深蓝女仆裙配白色围裙，围裙上有黑色小鲸鱼图案，背后一条深蓝鲸尾，蓝色眼睛。" style="height:170px"></textarea>
      </div>
    </div>
  </div>
  <div class="card"><b>称呼门槛</b>
<p class="dim">她叫你亲昵称呼时，亲密度低于这个数就只记一笔日志（不拦）。到线后才算自然。</p>
<div class="row"><label>亲密度门槛</label><input type="number" min="0" max="100" data-p="addr.ownerCloseAt"><span class="dim">0-100</span></div></div>
<div class="card"><div class="row" style="justify-content:space-between"><b>persona.md</b>
    <div class="row"><span class="dim" id="pState"></span><button class="btn" onclick="savePersona()">保存</button></div></div>
    <p class="dim">改完保存，下一条消息就生效（不用重启）。</p>
    <textarea id="personaText" style="height:320px"></textarea></div>
</section>
<section id="memory">
  <div class="card"><div class="toolbar">
    <b>记忆</b><select id="memWho" class="w200" onchange="loadMem();paintOwnerTag(S)"></select>
    <span class="warnchip" id="memOwnerTag" style="display:none">主人号 · 删除要授权码</span>
    <span class="spacer"></span>
    <button class="danger btn" onclick="dropPerson()">删除这个号</button>
    <button class="btn" onclick="pruneEmpty()">清理空记忆</button>
  </div>
    <p class="dim" style="margin:0 0 10px">删主人号要用「状态」页的一次性授权码：6 位数字、5 分钟有效、用一次即废 —— 忘了也不会把自己锁在外面。</p>
    <details class="tip"><summary>强度是怎么算的？</summary><p class="dim">基础权重 0.1–3，新记忆从 1 起步，被提到 +0.5（封顶 3）。当前强度 = 权重 × 0.5^(未提及天数 / 半衰期)：事实 45 天、琐事 14 天减半；核心恒为 99、不衰减。改完点「存」，下一条消息生效。</p></details>
    <div class="addbar">
      <input id="memText" placeholder="要记住的事（例：他下周三面试）">
      <label class="sw"><input type="checkbox" id="memCore"> 核心</label>
      <button class="btn" onclick="addMem()">添加</button></div>
    <table id="memTable"></table></div>
  <div class="card"><div class="row" style="justify-content:space-between"><b>她学到的（经验库）</b>
    <span class="dim" id="lsStat"></span>
    <span class="spacer"></span>
    <button class="btn" onclick="loadLessons()">刷新</button>
    <button class="danger btn" onclick="clearLessons()">清空</button></div>
    <p class="dim">他夸一句、还是嫌烦，都会记一条。下次遇到类似的场景，她照着"受用"的那次说；不相干的不硬套。</p>
    <div id="lsList" class="dim">还没有学到东西（他夸她一次，这里就会出现）</div></div>
  <div class="card"><div class="row" style="justify-content:space-between"><b>技能记录（工具用得怎么样）</b>
    <span class="dim" id="skStat2"></span>
    <span class="spacer"></span>
    <button class="btn" onclick="loadSkills()">刷新</button></div>
    <p class="dim">她调过的工具、成没成、错在哪。失败过的，下次会换个法子。</p>
    <div id="skList" class="dim">还没有调用记录</div></div>
</section>
<section id="stickers">
  <div class="card"><div class="row" style="justify-content:space-between"><b>表情包库</b><span class="dim" id="skCount"></span></div>
    <p class="dim">标签是给她看的关键词：她会按情绪挑。改完自动保存。</p>
    <div class="grid" id="skGrid"></div></div>
</section>
<section id="groups">
  <div class="card">
    <div class="cardhead">
      <h2>群聊</h2>
      <span id="gMsg" class="hint"></span>
      <span class="spacer"></span>
      <button class="primary" onclick="saveCfg()">保存</button>
    </div>
    <p class="dim" style="margin:0 0 8px">她在群里怎么说话。改完点保存，下一条群消息就生效。</p>

    <div class="gr"><span class="lbl">启用群聊</span>
      <label class="sw"><input type="checkbox" data-cb="groups.enabled" checked><span>在群里说话</span></label>
      <span class="hint"></span></div>

    <div class="gr"><span class="lbl">只认叫名字</span>
      <label class="sw"><input type="checkbox" data-cb="groups.needCall" checked><span>要叫她或 @ 她才理</span></label>
      <span class="hint">关掉 = 群里说什么都可能接</span></div>

    <div class="gr"><span class="lbl">她叫什么</span>
      <input data-p="names" placeholder="大肥鱼,肥鱼,小鱼,鱼宝">
      <span class="hint">群里叫这些名字都算叫她（人格里写的名字会自动认）</span></div>

    <div class="gr"><span class="lbl">对群友</span>
      <select data-p="groups.spicy"><option value="0">温和</option><option value="1">正常</option><option value="2">毒舌</option></select>
      <span class="hint">对主人永远温柔，这里只对群里其他人</span></div>

    <div class="gr"><span class="lbl">续聊窗口</span>
      <input type="number" data-p="groups.followMin">
      <span class="hint">分钟。叫过她之后，这个群还能接着聊多久；0 = 每条都要叫</span></div>

    <div class="gr"><span class="lbl">续聊她自己定</span>
      <label class="sw"><input type="checkbox" data-cb="groups.followAuto"><span>接不接由她判断</span></label>
      <span class="hint">关掉 = 窗口内每句都回</span></div>

    <div class="gr"><span class="lbl">连着发时等几秒</span>
      <input type="number" step="1" min="0" max="60" data-p="groups.joinSec">
      <span class="hint">对方连发几条时先攒一下，让她当一段话回（0 = 一条一句）</span></div>

    <div class="gr"><span class="lbl">一轮最多合并</span>
      <input type="number" step="1" min="1" max="20" data-p="groups.maxJoin">
      <span class="hint">条，攒满就不等了，马上处理</span></div>

    <div class="gr"><span class="lbl">被叫时补上文</span>
      <input type="number" step="1" min="0" max="30" data-p="groups.recallCount">
      <span class="hint">条。隔太久没聊时，把前面这些条群消息也给她看，别让她接不上话（0 = 不补）</span></div>
    <div class="gr"><span class="lbl">发言间隔</span>
      <input type="number" data-p="groups.gapSec">
      <span class="hint">秒。她说完一句后，至少隔这么久才接下一句</span></div>

    <div class="gr"><span class="lbl">一轮最多说</span>
      <input type="number" data-p="groups.maxChain">
      <span class="hint">句，说满自动重新开一轮（防刷屏）</span></div>

    <div class="gr"><span class="lbl">群聊每天最多花</span>
      <input type="number" data-p="groups.dayCap">
      <span class="hint">元（0 = 不限）</span></div>

    <div class="gr"><span class="lbl">群聊每月最多花</span>
      <input type="number" data-p="groups.monthCap">
      <span class="hint">元（0 = 不限）</span></div>

    <div class="gr note"><span class="lbl">额度用完了</span>
      <span class="hint">只在群里回 @ 和点名的，其他一律不吭声；私聊不受影响。两个额度和「预算」页共用一个池子，这里只是给群聊单独设上限。</span></div>

    <div class="gr"><span class="lbl">群聊已花</span>
      <span id="gSpent" class="hint">—</span><span class="hint"></span></div>

    <div class="gr wide"><span class="lbl">白名单</span>
      <textarea data-p="groups.allow" rows="3" placeholder="一行一个，也可以用逗号 / 空格隔开；留空 = 所有群都行"></textarea>
      <span class="hint">只在这些群说话</span></div>

    <div class="gr wide"><span class="lbl">群黑名单</span>
      <textarea data-p="groups.block" rows="3" placeholder="一行一个群号，也可以用逗号 / 空格隔开"></textarea>
      <span class="hint">这些群一律不理</span></div>

    <div class="gr wide"><span class="lbl">用户黑名单</span>
      <textarea data-p="blacklist.uins" rows="3" placeholder="一行一个 QQ 号，也可以用逗号 / 空格隔开"></textarea>
      <span class="hint">针对个人，不是群</span></div>

    <div class="gr"><span class="lbl">黑名单怎么处理</span>
      <select data-p="blacklist.mode"><option value="curse">骂回去</option><option value="ignore">完全不理会</option></select>
      <span class="hint">对上面这些人</span></div>

    <div class="gr"><span class="lbl">群里收表情包</span>
      <label class="sw"><input type="checkbox" data-cb="stickers.collectFromGroup"><span>别人发的也能收进她的库</span></label>
      <span class="hint"></span></div>
  </div>
</section>

<section id="interests">
  <div class="card"><div class="row" style="justify-content:space-between"><b>她感兴趣的事</b><button class="btn" onclick="saveInterests()">保存</button></div>
    <p class="dim">每行一条；她上网时按这些找东西看。</p>
    <textarea id="intTopics" style="min-height:160px"></textarea>
    <div class="row" style="margin-top:10px"><span class="dim">每天最多看</span><input id="intMax" type="number" style="width:90px"><span class="dim">次</span></div>
    <div class="row" style="margin-top:10px"><span class="dim">最近看到</span></div>
    <div id="seenBox" class="dim" style="font-size:12px;line-height:1.7"></div></div>
</section>
<section id="budget">
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
</section>
<section id="config">
    

  <div class="card" id="cfgBox"></div>

    <div class="card" style="margin-top:14px">
      <h2>手机访问</h2>
      <p class="dim" style="margin:0 0 8px">打开后，手机浏览器输入 <code>http://电脑IP:3070</code> 就能用同一个控制台（手机和电脑要连同一个 Wi-Fi）。<b>改完要重启程序才生效。</b></p>
      <div class="gr"><span class="lbl">允许手机访问</span>
        <label class="dim"><input type="checkbox" data-cb="ui.lan" style="width:auto"> 开启（监听 0.0.0.0）</label>
        <span class="hint">开启后必须输密码；只在内网可见，不暴露到公网</span></div>
      <div class="gr"><span class="lbl">访问密码</span>
        <input data-p="ui.pass" placeholder="留空 = 自动生成 6 位数字并写进配置">
        <span class="hint">第一次开启留空即可；程序会把生成的密码打印在启动日志里，也会显示在「状态」页</span></div>
      <div class="row" style="margin-top:8px"><span class="dim">用 DSChat App 填写上面的地址与密码即可连接（App 右上角 ⚙ → 服务器地址）。浏览器页面已下线。</span></div>
    </div>

    <div class="card" style="margin-top:14px" id="guardCard">
      <h2>手机推送（锁屏也能收到）</h2>
      <div class="hint">她在软件里说话时，推一条到你手机。推荐 ntfy：手机装 ntfy App、订阅下面这个主题即可，不用注册。</div>
      <div class="gr"><span class="lbl">通道</span>
        <select data-p="notify.channel">
          <option value="off">关闭</option>
          <option value="ntfy">ntfy（免费、开源）</option>
          <option value="wecom">企业微信群机器人</option>
          <option value="dingtalk">钉钉群机器人</option>
          <option value="bark">Bark（iPhone）</option>
        </select></div>
      <div class="gr"><span class="lbl">服务器 / Webhook</span>
        <input data-p="notify.url" placeholder="ntfy 留空=https://ntfy.sh；企业微信/钉钉填完整 webhook；Bark 填 https://api.day.app"></div>
      <div class="gr"><span class="lbl">主题 / 密钥</span>
        <input data-p="notify.topic" placeholder="ntfy 填主题名（自己起，如 dafeiyu-9f3a）；Bark 填 key"></div>
      <div class="gr"><span class="lbl">什么时候推</span>
        <select data-p="notify.when">
          <option value="local">只在软件里聊天时（QQ 有自己的推送）</option>
          <option value="all">全部（含 QQ 通道）</option>
        </select></div>
      <div class="row"><button class="ghost" onclick="testNotify(this)">发一条测试推送</button></div>
      <h2>QQ 接入</h2>
      <p class="dim" style="margin:0 0 8px">关掉后：不登录 QQ、不刷新二维码、守护也不去重启内核。<b>只保留软件里聊天</b>（DSChat 和手机端照常用）。</p>
      <div class="gr"><span class="lbl">启用 QQ 接入</span>
        <label class="dim"><input type="checkbox" data-cb="qq.enabled" style="width:auto"> 开启（关掉 = 状态页不显示扫码）</label>
        <span class="hint">想重新接 QQ 时勾上，保存后点「立即换一张」或托盘「重启 QQ 内核」</span></div>
      <h2>行为底线（写死在代码里）</h2>
      <p class="dim" style="margin:0 0 8px">这几项不靠人格提示词，由代码在发出前校验：<b>和事实冲突时自动重写一次；还不合格就换成一句不撒谎的兜底话</b>。</p>
      <div class="gr"><span class="lbl">总开关</span>
        <label class="dim"><input type="checkbox" data-cb="norms.enabled" style="width:auto"> 开启</label>
        <span class="hint">关掉后她可能说出与时间/身体/归属矛盾的话</span></div>
      <div class="gr"><span class="lbl">时间逻辑</span>
        <label class="dim"><input type="checkbox" data-cb="norms.time" style="width:auto"> 校验</label>
        <span class="hint">晚上不能说"早上好"、下午不能说"这么晚了"、钟点对不上会重写</span></div>
      <div class="gr"><span class="lbl">身体状态</span>
        <label class="dim"><input type="checkbox" data-cb="norms.body" style="width:auto"> 校验</label>
        <span class="hint">洗没洗澡、吃没吃饭，不许前后反口</span></div>
      <div class="gr"><span class="lbl">身份归属</span>
        <label class="dim"><input type="checkbox" data-cb="norms.owner" style="width:auto"> 校验</label>
        <span class="hint">她自己做过的事，不许反问成"你做了吗"</span></div>
      <div class="gr"><span class="lbl">记忆细节</span>
        <label class="dim"><input type="checkbox" data-cb="norms.memory" style="width:auto"> 校验</label>
        <span class="hint">说不出具体分钟/金额/菜名时，要求改口"记不清"，不许编</span></div>

      <div class="gr"><span class="lbl">日程/位置</span>
        <label class="dim"><input type="checkbox" data-cb="norms.schedule" style="width:auto"> 校验</label>
        <span class="hint">在家却说在外面、非睡觉时间说刚睡醒、手头做的事对不上</span></div>
      <div class="gr"><span class="lbl">关系尺度</span>
        <label class="dim"><input type="checkbox" data-cb="norms.relation" style="width:auto"> 校验</label>
        <span class="hint">不够熟不许喊老公/宝贝；很熟了也不许说"你谁啊"</span></div>
      <div class="gr"><span class="lbl">群聊边界</span>
        <label class="dim"><input type="checkbox" data-cb="norms.social" style="width:auto"> 校验</label>
        <span class="hint">群里不说私密话题、不暴露主人的名字/公司/住址</span></div>
      <div class="gr"><span class="lbl">防复读</span>
        <label class="dim"><input type="checkbox" data-cb="norms.repeat" style="width:auto"> 校验</label>
        <span class="hint">和上一句几乎一样时要求换个说法</span></div>

      <h2>内核守护</h2>
      <p class="dim" style="margin:0 0 8px">守护会在 QQ 掉线时自动重启内核、二维码过期时自动换码。<b>频繁重启/换码会被 QQ 判成异常登录</b>（风控期尤其明显）。</p>
      <div class="gr"><span class="lbl">允许自动重启 / 自动换码</span>
        <label class="dim"><input type="checkbox" data-cb="guard.auto" style="width:auto"> 开启（关掉 = 只监视，不动手）</label>
        <span class="hint">关掉后：掉线只记录状态，二维码也不自动换；换成你手动点「立即换一张」/ 托盘「重启 QQ 内核」</span></div>
    </div>

    <div class="card" style="margin-top:14px">
      <h2>自动降级</h2>
      <p class="dim" style="margin:0 0 10px">失败时要不要自己换条路走。<b>关掉就是只用你指定的</b>，出问题直接报错，不会偷偷换个模型把画风/语气带偏。只有费用超预算时会强制降档，不受这里影响。</p>
      <div class="gr"><span class="lbl">聊天（大脑）</span><label class="sw"><input type="checkbox" data-cb="fallback.chat"><span>主模型失败时，允许回落默认地址/模型</span></label></div>
      <div class="gr"><span class="lbl">看图</span><label class="sw"><input type="checkbox" data-cb="fallback.vision"><span>大脑不能看图时，允许自动套百炼 qwen-vl 兜底</span></label></div>
      <div class="gr"><span class="lbl">画图</span><label class="sw"><input type="checkbox" data-cb="fallback.draw"><span>允许在她指定的后端里换备用模型（<b>默认关</b>：指定火山就只走火山）</span></label></div>
      <div class="gr"><span class="lbl">语音识别</span><label class="sw"><input type="checkbox" data-cb="fallback.asr"><span>识别失败时允许换备用后端</span></label></div>
      <div class="gr"><span class="lbl">语音合成</span><label class="sw"><input type="checkbox" data-cb="fallback.tts"><span>云端合成失败时，允许退回免费 edge 语音</span></label></div>
    </div>

    <div class="card" style="margin-top:14px">
      <h2>运行细节</h2>
      <p class="dim" style="margin:0 0 8px">这些以前写死在代码里，现在你可以调。改完点保存，下一条消息生效。</p>
      <div class="gr"><span class="lbl">私聊打字延迟</span><input type="number" step="100" min="0" max="60000" data-p="reply.privateDelayMs"><span class="hint">毫秒。她收到消息后故意等这么久再发（2000 = 2 秒）</span></div>
      <div class="gr"><span class="lbl">群聊打字延迟</span><input type="number" step="100" min="0" max="60000" data-p="reply.groupDelayMs"><span class="hint">毫秒。群聊里一般比私聊慢一点</span></div>
      <div class="gr"><span class="lbl">聊天原文窗口</span><input type="number" step="10" min="10" max="400" data-p="memory.logKeep"><span class="hint">行。每轮带多少行最近原文进上下文；越大越连贯、越费 token</span></div>
      <div class="gr"><span class="lbl">事实记忆半衰期</span><input type="number" step="1" min="1" max="3650" data-p="memory.halfLifeFact"><span class="hint">天。没再提到的"事实"多久强度减半</span></div>
      <div class="gr"><span class="lbl">琐事记忆半衰期</span><input type="number" step="1" min="1" max="3650" data-p="memory.halfLifeTrivia"><span class="hint">天。闲聊里的"琐事"多久强度减半</span></div>
      <div class="gr"><span class="lbl">NapCat 主机</span><input data-p="napcat.host" placeholder="127.0.0.1"><span class="hint">跑在同一台机器就填 127.0.0.1；搬到别的机器改成它的 IP（改完要重启桥接）</span></div>
      <div class="gr wide"><span class="lbl">戳一戳回什么</span><textarea data-p="talk.pokeLines" rows="3" placeholder="一行一句"></textarea><span class="hint">被她戳时随机挑一句；一行一句</span></div>
      <div class="gr wide"><span class="lbl">兜底日程</span><textarea data-p="talk.fallbackPlan" rows="4" placeholder="12:30 卧室｜刚起来"></textarea><span class="hint">生成日程失败时才会用；格式「HH:MM 地点｜在做什么」</span></div>
      <div class="gr wide"><span class="lbl">她自己消遣池</span><textarea data-p="talk.lifePool" rows="4" placeholder="一行一件小事"></textarea><span class="hint">没排日程时，她从这些里挑一件"正在干的事"</span></div>
    </div>

    <div class="card" style="margin-top:14px">
      <h2>出图提示词</h2>
      <p class="dim" style="margin:0 0 8px">画她、画场景都按这里来。不满意直接改文字，改完保存，下一张就按新写法来。</p>
      <div class="gr"><span class="lbl">画风</span>
        <select data-p="drawStyle">
          <option value="anime">二次元插画</option>
          <option value="semi">半写实轻小说</option>
          <option value="real">写实摄影</option>
          <option value="custom">自定义（用下面的"画风描述"）</option>
        </select>
        <span class="hint">前三项是内置写法；选"自定义"就完全用下面那段文字</span></div>
      <div class="gr wide"><span class="lbl">画风描述</span><textarea data-p="prompts.style" rows="2"></textarea><span class="hint">一句话定整体风格（线条、上色、质感）</span></div>
      <div class="gr wide"><span class="lbl">自拍视角</span><textarea data-p="prompts.selfie" rows="3"></textarea><span class="hint">她自拍时的机位与构图。写太多"不要"有时会反向放大，尽量用正向描述</span></div>
      <div class="gr wide"><span class="lbl">全身照视角</span><textarea data-p="prompts.selfieFull" rows="3"></textarea><span class="hint">她要全身照时用这段（说“站起来/全身/穿搭/鞋子”会自动切过来）</span></div>
          <div class="gr wide"><span class="lbl">自拍禁止项</span><textarea data-p="prompts.selfieBan" rows="3"></textarea><span class="hint">画面里不许出现的东西（手机、边框、拼图、畸形手…）</span></div>
      <div class="gr wide"><span class="lbl">参考图规则</span><textarea data-p="prompts.ref" rows="3"></textarea><span class="hint">告诉她"参考图只是设定稿，别照抄三视图/白底/立绘"</span></div>
      <div class="gr wide"><span class="lbl">场景补充</span><textarea data-p="prompts.scene" rows="2"></textarea><span class="hint">画房间/街景时的补充要求（生活痕迹、光线）</span></div>
      <div class="gr wide"><span class="lbl">场景禁止项</span><textarea data-p="prompts.sceneBan" rows="2"></textarea><span class="hint">场景图里不许出现的东西（人、文字、水印…）</span></div>
      <div class="row" style="margin-top:8px"><button class="ghost btn" onclick="resetPrompts()">恢复默认文案</button></div>
    </div>
  </section>
<section id="log">
  <div class="card"><div class="row" style="justify-content:space-between"><b>日志</b><button class="ghost btn" onclick="loadLog()">刷新</button></div>
    <pre id="logPre" style="max-height:none;height:calc(100vh - 230px)"></pre></div>
</section>
</div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const PG = {
  status: ['状态', '连接、二维码与今天的用量'],
  persona: ['人格', '她是谁、怎么说话'],
  memory: ['记忆', '她记住的事，和遗忘曲线'],
  stickers: ['表情包', '她能随手发的图'],
  interests: ['兴趣', '她自己想聊什么'],
  budget: ['预算', '花钱上限与本月用量'],
  groups: ['群聊', '在群里怎么说话'],
  config: ['设置', '账号、通道与安全'],
  log: ['日志', '最近发生过什么']
};
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
  if (__dirty && ['config', 'groups'].includes(document.querySelector('nav button.on')?.dataset.t)) {
    clearDirty();
    loadCfg().then(() => toast('没保存，已还原成上次的设置', true)).catch(() => {});
  }
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('section').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); $('#' + b.dataset.t).classList.add('on');
  setPageTitle(b.dataset.t);
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.scrollTop = 0;  if (b.dataset.t === 'memory') loadMem();
  if (b.dataset.t === 'stickers') loadStickers();
  if (b.dataset.t === 'interests') loadInterests();
  if (b.dataset.t === 'budget') loadBudget();
  if (b.dataset.t === 'log') loadLog();
  if (b.dataset.t === 'status') loadState();
  if (b.dataset.t === 'chat') chatBoot();
    if (document.getElementById('avBtn') && !document.getElementById('avBtn').onclick) document.getElementById('avBtn').onclick = () => openAvatars();
});
// 深链：#memory / #config … 直接打开对应页（也方便截图核对）
// 注意要等整段脚本执行完（__dirty 在下面才初始化），所以放到下一个 tick
setTimeout(() => {
  try {
    const h = (location.hash || '').replace('#', '');
    if (!h || !PG[h]) return;
    const btn = document.querySelector('nav button[data-t="' + h + '"]');
    if (btn && !btn.classList.contains('on')) btn.click();
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
document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('[data-p],[data-cb],.card')) markDirty(); }, true);
document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('[data-p],[data-cb]')) markDirty(); }, true);

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
      + '<div class="dim" style="margin-top:6px">想让手机浏览器打开这个控制台：去「设置 → 手机访问」把开关打开，然后重启程序。手机要和这台电脑连同一个 Wi-Fi。</div></div>';
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
    await api('/api/qr/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
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
  }).join('') + '</div>' : '<div class="empty" style="margin-top:10px;padding:22px 16px">今天还没主动说过话</div>';
  $('#statusBox').innerHTML =
    '<div class="card"><div class="row"><b>桥接</b>' + (b.alive ? '<span class="ok">运行中 pid ' + b.pid + '</span>' : '<span class="bad">没在跑</span>')
    + '<b style="margin-left:16px">QQ</b>' + (l ? '<span class="ok">' + l.nickname + '（' + l.user_id + '）</span>' : '<span class="bad">未登录</span>')
    + '<button class="ghost btn" style="margin-left:auto" onclick="restart()">重启桥接</button></div>'
    + '<div class="dim" style="margin-top:8px">记忆 ' + S.counts.memories + ' 人 · 表情包 ' + S.counts.stickers + ' 张 · 音色 ' + (c.voiceName||c.voice)
    + (S.budget ? ' · 本月 ￥' + S.budget.spent.toFixed(2) + ' / ' + S.budget.cap : '') + '</div></div>'
    + '<div class="card" id="workCard"><div class="row" style="justify-content:space-between"><b>工作模式</b>'
    + '<span id="workBadge" class="pill">未开启</span></div>'
    + '<div class="dim" id="workInfo" style="margin-top:6px">日常聊天她只能看、不能改。要她动手改文件，点下面按钮，先选一个工作目录。</div>'
    + '<div id="workEdits" style="margin-top:10px"></div>'
    + '<label class="row" style="margin-top:10px;gap:8px;cursor:pointer"><input type="checkbox" id="workTools" onchange="setWorkTools(this.checked)"> <span>允许她动电脑</span></label>'
    + '<div class="dim" style="margin-top:4px;font-size:12px">关着的时候她只能聊天（默认）。打开后她才能在你选的文件夹里读/改文件、跑命令，动手前会问你。</div>'
    + '<div class="row" style="margin-top:10px;gap:8px"><button class="btn" onclick="openWorkDialog()">进入工作模式</button>'
    + '<button class="ghost btn" id="workStop" onclick="stopWork()" style="display:none">停止工作会话</button></div></div>'
    + '<div class="card"><div class="row" style="justify-content:space-between"><b>备份</b>'
    + '<button class="btn" onclick="runBackup()">立刻备份</button>'
    + '<div class="dim" id="bkInfo" style="margin-top:6px">读取中…</div>'
    + '<div class="dim" style="margin-top:4px;font-size:12px">记忆/经验库/技能库/配置/聊天记录/她的画，复制一份到数据目录外面。默认保留 7 份，每天凌晨自动一次。</div></div>'
    + '<div class="card"><div class="row" style="justify-content:space-between"><b>删除授权码</b>'
    + '<button class="btn" onclick="genDelCode()">生成删除授权码</button></div>'
    + '<div class="dim" style="margin-top:6px">删主人号要用这个 6 位码：5 分钟内有效、用一次即废、只存在内存里。</div>'
    + '<div id="delCodeBox" style="margin-top:8px"></div></div>'
    + minds
    + '<div class="card"><b>今天的主动消息</b>' + proHtml + '</div>'
    + '<div class="card"><b>最近日志</b><pre>' + S.log.slice().reverse().map(esc).join('\n') + '</pre></div>'
    + '<div class="card"><b>QQ 内核日志</b><div class="dim">这里就是原来那个黑窗口里的内容（隐藏内核模式下）</div><pre style="max-height:240px">'
    + (S.kernel && S.kernel.length ? S.kernel.slice().reverse().map(esc).join('\n') : '（还没抓到。安装隐藏内核并重启一次 QQ 后，这里会实时出现 NapCat 日志）') + '</pre></div>';
  paintQr(S, l);
  renderDelCode();
  loadBackup();
  try { loadWork(); } catch (e) {}
  if (!l) { clearTimeout(window.__qrT); window.__qrT = setTimeout(loadState, 4000); }
  const who = $('#memWho');
  if (who && S.people) {
    const cur = who.value, nms = S.names || {}, OWN = String(S.ownerUin || '');
    const list = S.people.filter(u => /^[0-9]{5,12}$/.test(String(u)));
    who.innerHTML = list.map(u => '<option value="' + u + '">' + u
      + (String(u) === OWN ? '（主人号）' : (nms[u] && nms[u].name ? '（' + esc(nms[u].name) + '）' : '')) + '</option>').join('');
    if (list.indexOf(cur) >= 0) who.value = cur;
  }
  paintOwnerTag(S);
  // 记忆页：如果打开时人员列表还没回来（表格是空占位），补一次
  const mt = $('#memTable');
  if (mt && /还没有任何人/.test(mt.textContent)) loadMem();
}
// 选中的是不是主人号：是就把红色提醒亮出来，按钮文案也换掉
function paintOwnerTag(S){
  const own = String(((S || {}).ownerUin) || '');
  const cur = ($('#memWho') || {}).value || '';
  const tag = $('#memOwnerTag');
  if (tag) tag.style.display = own && cur === own ? '' : 'none';
  const btn = document.querySelector('button[onclick="dropPerson()"]');
  if (btn) btn.textContent = own && cur === own ? '删除主人号（要授权码）' : '删除这个号';
}
// 删除授权码：生成 / 渲染（状态页那个 6 位数字）
async function genDelCode(){
  const r = await api('/api/delcode', { method: 'POST' });
  if (!(r && r.ok)) return toast('生成失败：' + ((r && r.err) || '未知'), false);
  renderDelCode(r);
  toast('授权码已生成，5 分钟内有效，用一次就作废', true);
}
function renderDelCode(st){
  if (st) window.__delCodeState = st;
  const box = $('#delCodeBox');
  if (!box) return;
  clearTimeout(window.__dcT);
  const cur = window.__delCodeState;
  if (!cur || !cur.active) {
    box.innerHTML = '<span class="dim">还没生成。点右上「生成删除授权码」，可用 5 分钟。</span>';
    return;
  }
  box.innerHTML = '<span class="code-big">' + esc(cur.code) + '</span>'
    + '<span class="dim" style="margin-left:10px">剩 ' + cur.left + ' 秒 · 用一次即废</span>';
  window.__dcT = setTimeout(() => { api('/api/delcode').then(renderDelCode).catch(() => {}); }, 5000);
}
async function qrRefresh(){
  toast('正在换新码，约 5–15 秒…', true);
  try { await api('/api/qr/refresh', { method: 'POST' }); } catch {}
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
function paintQr(S, l){
  const slot = $('#qrSlot');
  if (S && S.qqEnabled === false) { slot.innerHTML = '<div class="card">'
      + '<div class="toolbar"><b>扫码登录 QQ</b><span class="pill">已关闭</span><span class="spacer"></span>'
      + '<button class="btn" onclick="qqStartScan()">启动扫码登录 QQ</button></div>'
      + '<p class="dim" style="margin:0">现在只用软件内聊天（Chat / 手机端照常），不再登录 QQ、也不刷新二维码。点了右上角按钮才会拉起内核并出码。</p></div>';
    slot.dataset.built=''; return; }
  if (l) { slot.innerHTML = ''; slot.dataset.built = ''; slot.dataset.at = ''; return; }
  if (slot.dataset.built !== '1') {
    slot.innerHTML = '<div class="card">'
      + '<div class="toolbar"><b>扫码登录 QQ</b><span class="pill" id="qrPill"></span><span class="spacer"></span>'
      + '<button class="ghost btn" onclick="qrRefresh()">立即换一张</button></div>'
      + '<div class="qrbox"><img id="qrImg" alt="QQ 登录二维码"><div id="qrPh" class="qrempty"></div></div>'
      + '<p class="dim" id="qrMeta" style="margin:0 0 6px"></p>'
      + '<p class="dim" style="margin:0">用手机 QQ 切到小号扫码，扫完在手机上点「确认登录」。二维码过期会自动换，这一块自己更新，不会整页刷新。</p>'
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
    ph.textContent = AGE >= 0
      ? '这张码是 ' + fmtAge(AGE) + '前生成的，早就失效了，扫也没用 —— 点右上「立即换一张」重新出码。'
      : '内核还没出码。点右上「立即换一张」，或到设置里确认 NapCat 路径和内核守护。';
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
    if (r.ok) loadSelf();
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

async function loadMem(){
  const uin = $('#memWho').value || (S.people && S.people[0]) || '';
  if (!uin) { $('#memTable').innerHTML = '<tr><td class="dim">还没有任何人的记忆</td></tr>'; return; }
  const r = await api('/api/memory?uin=' + uin);
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
    + '<td class="dim" style="white-space:nowrap">' + memSource(it) + '</td>'
    + '<td><button class="btn" onclick="saveMem(' + it.index + ')">存</button> <button class="danger btn" onclick="delMem(' + it.index + ')">删</button></td></tr>').join('');
  try { loadLessons(); loadSkills(); } catch (e) {}
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
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  d.innerHTML = '<div style="width:400px;max-width:92vw;background:#151a22;border:1px solid #7a3b3b;border-radius:12px;padding:18px;color:#e6e9ef;font-size:13.5px;line-height:1.6">' + inner + '</div>';
  document.body.appendChild(d);
  return d;
}
const dlgInput = 'width:100%;box-sizing:border-box;margin:5px 0 10px;padding:9px;border-radius:8px;border:1px solid #2b313d;background:#0f1217;color:#e6e9ef;font-size:14px';
// 允许她动电脑的总开关
async function setWorkTools(on) {
  const r = await api('/api/work/tools', { method: 'POST', body: { enabled: !!on } });
  if (r && r.ok) toast(on ? '已允许她动电脑' : '已关掉：她现在只能聊天');
  else toast('没保存成功：' + ((r && r.err) || '未知原因'));
  render();
}

// ---- 工作模式（首期只有文件能力：读 / 改 / 预览 / 恢复 / 停止） ----
let WORK = { active: false };
async function loadWork(){
  try {
    const r = await api('/api/work');
    WORK = (r && r.work) || { active: false };
    const badge = $('#workBadge'), info = $('#workInfo'), stop = $('#workStop');
    if (!badge) return;
    const cb = $('#workTools');
    if (cb) cb.checked = !!(r && r.toolsEnabled === true);
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
      info.innerHTML = '日常聊天她只能看、不能改。要她动手改文件，点下面按钮，先选一个工作目录。';
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
  window.__wkBind(d, { api, toast, source: 'console', onDone: () => loadWork() });
}
async function stopWork(){
  if (!(await askConfirm('停止这次工作会话？她会立刻失去改文件的权限，挂着的等待审批也一起作废。', '停止工作会话'))) return;
  await api('/api/work/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  toast('已停止');
  loadWork();
}


// 主人号删除：手打 uin + 一次性授权码，缺一个都不行
function ownerConfirmDialog(uin){
  return new Promise((resolve) => {
    const d = miniDialog('<div style="font-size:16px;font-weight:700;color:#e2777a;margin-bottom:6px">删除主人号 ' + esc(uin) + '？</div>'
      + '<div style="color:#b9c0cc">这个号的记忆、聊天记录、日记、昵称会一起改名为 <code>.deleted-时间</code> 备份。<br>主人号删了要重新扫码、重新配，<b>再三确认</b>：</div>'
      + '<div style="color:#8b93a1;margin-top:10px;font-size:12.5px">① 把 uin 完整打一遍</div>'
      + '<input id="ockUin" placeholder="' + esc(uin) + '" style="' + dlgInput + '">'
      + '<div style="color:#8b93a1;font-size:12.5px">② 授权码（去「状态」页点「生成删除授权码」）</div>'
      + '<input id="ockCode" inputmode="numeric" maxlength="6" placeholder="6 位数字" style="' + dlgInput + '">'
      + '<div id="ockErr" style="color:#e2777a;font-size:12.5px;min-height:16px"></div>'
      + '<div class="row" style="justify-content:flex-end;gap:8px;margin-top:6px"><button class="btn" id="ockNo">取消</button><button class="danger btn" id="ockYes">确认删除</button></div>');
    const q = (s) => d.querySelector(s);
    const done = (v) => { d.remove(); resolve(v); };
    q('#ockNo').onclick = () => done(null);
    q('#ockYes').onclick = async () => {
      const u = q('#ockUin').value.trim(), code = q('#ockCode').value.trim();
      const errEl = q('#ockErr'), yes = q('#ockYes');
      errEl.textContent = '';
      if (u !== String(uin)) { errEl.textContent = 'uin 没打对，照上面那串数字完整打一遍'; q('#ockUin').focus(); return; }
      if (!/^\d{6}$/.test(code)) { errEl.textContent = '授权码是 6 位数字'; q('#ockCode').focus(); return; }
      yes.disabled = true; yes.textContent = '删除中…';
      const r = await api('/api/memory/person', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, confirmUin: u, code }) });
      if (r && r.ok) { done(r); return; }
      yes.disabled = false; yes.textContent = '确认删除';
      errEl.textContent = (r && r.err) || '删除失败，等一下再试';
      q('#ockCode').value = ''; q('#ockCode').focus();
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
async function loadLessons(){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  const r = await api('/api/lessons?uin=' + encodeURIComponent(uin));
  const st = (r && r.stats) || {};
  $('#lsStat').textContent = st.total ? ('共 ' + st.total + ' 条') : '';
  const box = $('#lsList');
  const items = (r && r.items) || [];
  if (!items.length) { box.className = 'dim'; box.textContent = '还没有学到东西（他夸她一次，这里就会出现）'; return; }
  box.className = '';
  box.innerHTML = items.slice().sort((a, b) => b.at - a.at).map((it) =>
    '<div style="padding:9px 0;border-bottom:1px solid #24304a">'
    + '<div class="dim" style="font-size:12px">' + esc(BUCKET_ZH[it.bucket] || it.bucket) + ' · 分 ' + (it.score || 0) + ' · ' + fmtTime(it.at) + '</div>'
    + '<div>他说：' + esc(it.his || '') + '</div>'
    + '<div class="dim">她答：' + esc(it.mine || '') + '</div>'
    + '<div class="row" style="justify-content:flex-end"><button class="ghost" onclick="delLesson(\'' + esc(it.id) + '\')">删掉这条</button></div></div>').join('');
}
async function delLesson(id){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  const r = await api('/api/lessons?uin=' + encodeURIComponent(uin), { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, id }) });
  toast(r && r.ok ? '已删掉一条' : ('失败：' + ((r && r.err) || '未知')), !!(r && r.ok));
  loadLessons();
}
async function clearLessons(){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  if (!(await askConfirm('把她的经验库清空？（不会动记忆和人设）', '清空经验库'))) return;
  const r = await api('/api/lessons?uin=' + encodeURIComponent(uin), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uin, clear: true }) });
  toast(r && r.ok ? '已清空' : '失败', !!(r && r.ok));
  loadLessons();
}
async function loadSkills(){
  const sel = $('#memWho'); const uin = sel ? sel.value : '';
  const r = await api('/api/skills?uin=' + encodeURIComponent(uin));
  const st = (r && r.stats) || { total: 0, by: {} };
  const by = st.by || {};
  $('#skStat2').textContent = st.total ? ('共 ' + st.total + ' 次 · 成功 ' + Object.values(by).reduce((a, b) => a + b.ok, 0) + ' / 失败 ' + Object.values(by).reduce((a, b) => a + b.fail, 0)) : '';
  const box = $('#skList');
  const items = (r && r.items) || [];
  if (!items.length) { box.className = 'dim'; box.textContent = '还没有调用记录（她开始用工具后这里会有）'; return; }
  box.className = '';
  box.innerHTML = items.slice().reverse().map((it) =>
    '<div style="padding:7px 0;border-bottom:1px solid #24304a">'
    + '<div><b>' + esc(it.name) + '</b> <span class="' + (it.ok ? 'dim' : 'warnchip') + '">' + (it.ok ? '成功' : '失败') + '</span> <span class="dim" style="font-size:12px">' + fmtTime(it.at) + '</span></div>'
    + '<div class="dim" style="font-size:12px;word-break:break-all">' + esc(String(it.args || '').slice(0, 160)) + '</div>'
    + (it.ok ? '' : '<div style="color:#ffb3b3;font-size:12px">' + esc(String(it.err || '').slice(0, 160)) + '</div>')
    + '</div>').join('');
}

// 审批卡片：桥接那边在等她跑命令，这里弹出来让他点
let __apIds = '';
const apDecide = async (id, ok) => {
  await api('/api/approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, ok }) });
  toast(ok ? '同意了，她去执行' : '拒绝了', ok);
  pollApprovals(true);
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
    box.innerHTML = '<div style="padding:11px 13px;border-bottom:1px solid #24304a;font-weight:600">她想执行命令，等你点头</div>'
      + items.map((x) =>
        '<div style="padding:11px 13px;border-bottom:1px solid #24304a">'
        + '<div class="dim" style="font-size:12px">' + esc(x.name) + ' · ' + fmtTime(x.at) + '</div>'
        + (x.dir ? '<div class="dim" style="font-size:12px;margin-top:2px">在工作区里跑：' + esc(x.dir) + (x.mode ? ' · ' + esc(x.mode === 'workspace' ? '只能动这个文件夹' : x.mode === 'full' ? '不限制路径（慎用）' : '已关闭') : '') + '</div>' : '')
        + '<pre style="white-space:pre-wrap;word-break:break-all;margin:6px 0 8px;font-size:12px;color:#c9d6ee;background:#0b1523;padding:8px;border-radius:8px">' + esc(JSON.stringify(x.args || {}, null, 1)) + '</pre>'
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

async function loadCfg(){
  const c = await api('/api/config');
  const br = await api('/api/brain');
  const su = await api('/api/setup').catch(() => ({}));
  const vi = await api('/api/voice').then(r => (r && r.info) || {}).catch(() => ({}));
  const dInfo = await api('/api/draw/info').catch(() => ({}));
  const g = c.groups || {};
  const q = (sel, val) => { const el = document.querySelector(sel); if (el) el.value = (val === undefined || val === null) ? '' : val; };
  // 通用回填：所有 [data-p] / [data-cb] 按配置里的路径还原（切页面时"没保存就复原"靠它）
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  document.querySelectorAll('[data-p]').forEach((el) => {
    const v = getPath(c, el.dataset.p);
    if (v === undefined || v === null) { if (el.type !== 'number' || v === null) el.value = ''; return; }
    if (el.tagName === 'TEXTAREA' && Array.isArray(v)) el.value = v.join('\n');
    else el.value = Array.isArray(v) ? v.join(',') : v;
  });
  document.querySelectorAll('[data-cb]').forEach((el) => {
    const v = getPath(c, el.dataset.cb);
    if (v !== undefined && v !== null) el.checked = !!v;
  });
  q('[data-p="groups.spicy"]', g.spicy ?? 2);
  q('[data-p="groups.joinSec"]', g.joinSec ?? 8);
  q('[data-p="groups.maxJoin"]', g.maxJoin ?? 8);
  q('[data-p="names"]', ((c.names && c.names.length) ? c.names : []).join(','));
  q('[data-p="groups.dayCap"]', g.dayCap ?? 0);
  q('[data-p="groups.monthCap"]', g.monthCap ?? 0);
  api('/api/budget').then(bd => {
    const el = document.getElementById('gSpent');
    if (!el) return;
    const gm = Number((bd && bd.byChannel && bd.byChannel.group) || 0);
    const gd = Number((bd && bd.byChannelDay && bd.byChannelDay.group) || 0);
    const mc = Number((c.groups && c.groups.monthCap) || 0);
    const dc = Number((c.groups && c.groups.dayCap) || 0);
    el.textContent = '今天 ¥' + gd.toFixed(2) + (dc > 0 ? '/' + dc.toFixed(2) : '') + ' · 本月 ¥' + gm.toFixed(2) + (mc > 0 ? '/' + mc.toFixed(2) : '') + ' · 总已花 ¥' + Number((bd && bd.spent) || 0).toFixed(2);
  }).catch(() => {});
  q('[data-p="blacklist.uins"]', ((c.blacklist && c.blacklist.uins) || []).join('\n'));
  q('[data-p="blacklist.mode"]', (c.blacklist && c.blacklist.mode) || 'curse');
  q('[data-p="groups.followMin"]', g.followMin ?? 5);
  q('[data-p="groups.maxChain"]', g.maxChain ?? 6);
  q('[data-p="groups.recallCount"]', g.recallCount ?? 8);
  q('[data-p="groups.gapSec"]', g.gapSec ?? 15);
  q('[data-p="groups.allow"]', (g.allow || []).join('\n'));
  q('[data-p="groups.block"]', (g.block || []).join('\n'));
  const setCb = (sel, on) => { const el = document.querySelector(sel); if (el) el.checked = !!on; };
  setCb('[data-cb="groups.enabled"]', g.enabled !== false);
  setCb('[data-cb="groups.needCall"]', g.needCall !== false);
  setCb('[data-cb="groups.followAuto"]', g.followAuto !== false);
  setCb('[data-cb="stickers.collectFromGroup"]', !!(c.stickers && c.stickers.collectFromGroup));
  const asrInfo = await api('/api/voice').then(r => (r && r.info) || {}).catch(() => ({}));
  const num = (label, path, v, step=1, hint='') => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><input type="number" step="' + step + '" value="' + v + '" data-p="' + path + '" style="width:110px"><span class="dim">' + hint + '</span></div>';
  const tim = (label, path, v) => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><input type="time" step="60" value="' + v + '" data-p="' + path + '" style="width:120px"><span class="dim">24 小时制</span></div>';
  const cb = (label, path, on, hint = '') => '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">' + label + '</span><label class="dim"><input type="checkbox" data-cb="' + path + '"' + (on ? ' checked' : '') + ' style="width:auto"> ' + (hint || '开启') + '</label></div>';
  $('#cfgBox').innerHTML = '<div class="row" style="justify-content:space-between"><b>设置</b><span><span class="dim" id="cfgMsg" style="margin-right:10px"></span><button class="ghost" onclick="restartBridgeClick()">重启桥接</button><button class="btn" onclick="saveCfg()">保存</button></span></div>'
    + '<p class="dim">改完点保存就生效，不用退出程序。只有换模型供应商这类情况才需要点「重启桥接」。</p>'
    + '<h4 class="sect">账号</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">机器人 QQ（小号）</span><input value="' + (su.uin || '') + '" readonly style="width:200px"><span class="dim">扫码登录后自动识别</span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">主人 QQ</span><input id="ownerUin" value="' + (su.ownerUin || '') + '" placeholder="你自己的 QQ 号" style="width:200px"><button class="ghost" onclick="saveOwner()">保存主人</button><span class="dim" id="ownMsg"></span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">数据目录</span><input value="' + (su.dataDir || '') + '" readonly style="flex:1"><button class="ghost" onclick="openData()">打开</button></div>'
    + '<p class="dim" style="margin:0 0 6px 210px">记忆、表情包、人格、聊天日志都在这。换电脑/换盘时把这个文件夹整体拷走即可。</p>'
    + '<h4 class="sect">大脑（API）</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input id="brUrl" value="' + (br.baseUrl || '') + '" style="flex:1"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input id="brKey" type="password" placeholder="' + (br.keySet ? '已保存 ' + br.keyMask + '（留空不改）' : 'sk-…') + '" style="flex:1"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input id="brModel" value="' + (br.model || '') + '" style="flex:1"><button class="ghost" data-kind="chat" onclick="pullModels(this.dataset.kind)">拉取</button></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim"></span><button class="ghost" onclick="testBrain()">测试连接</button><button class="btn" onclick="saveBrain()">保存 API</button><span class="dim" id="brMsg"></span></div>'
    + '<p class="dim" style="margin:0 0 6px 210px">改完 API 后要点「重启桥接」才用新配置。</p>'
    + '<h4 class="sect">语音（TTS）</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">供应商</span><select data-p="tts.provider" style="width:240px"><option value="aliyun"' + ((c.tts&&c.tts.provider==='aliyun')?' selected':'') + '>阿里云 CosyVoice</option><option value="openai"' + ((c.tts&&c.tts.provider==='openai')?' selected':'') + '>OpenAI 兼容 /audio/speech</option><option value="edge"' + ((c.tts&&c.tts.provider==='edge')?' selected':'') + '>Edge-TTS（免费兜底）</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="tts.baseUrl" value="' + ((c.tts && c.tts.baseUrl) || '') + '" style="flex:1" placeholder="留空=阿里云/OpenAI 官方地址；第三方网关填到 /v1 结尾"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="tts.model" list="dlTts" value="' + ((c.tts&&c.tts.model)||'cosyvoice-v2') + '" style="width:260px"><button class="ghost" onclick="pullModels(\'tts\')">拉取</button><span class="dim" id="tmMsg">可下拉选，也可手填</span><datalist id="dlTts"></datalist></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="tts.key" type="password" placeholder="' + (vi.keySet ? '已保存 ' + vi.keyMask + '（留空不改）' : 'sk-…（阿里云百炼）') + '" style="flex:1"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">音色包</span><select id="voiceSel" style="width:260px"></select>'
    + '<button class="ghost" onclick="previewVoice()">试听</button><span class="dim" id="vMsg"></span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">新增音色包</span><input id="vNewName" placeholder="名称，如 甜妹" style="width:150px"><input id="vNewId" placeholder="音色 ID，如 longxin_v2" style="width:200px">'
    + '<button class="ghost" onclick="addVoice()">添加</button><button class="ghost danger" onclick="delVoice()">删除选中</button></div>'
    + '<p class="dim" style="margin:0 0 6px 210px">音色包存在 data\\voices.json，内置的不让删；试听会用当前选中的音色现场合成一句。</p>'
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
    + cb('启用 *', 'browse.enabled', !(c.browse && c.browse.enabled === false), '自己去刷新闻/视频，攒点能聊的东西')
    + num('每天最多次数', 'browse.perDay', c.browse.perDay, 1, '次')
    + tim('最早', 'browse.fromTime', c.browse.fromTime)
    + tim('最晚', 'browse.toTime', c.browse.toTime)
    + '<h4 class="sect">聊天节奏</h4>'
    + num('合消息等待', 'reply.debounceMs', c.reply.debounceMs, 500, '毫秒（4500 = 4.5 秒）')
    + num('最多连发', 'reply.maxConsecutive', c.reply.maxConsecutive, 1, '条')
    + '<h4 class="sect">QQ 空间</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">启用 *</span><label class="dim"><input type="checkbox" data-cb="qzone.enabled"' + (c.qzone.enabled ? ' checked' : '') + ' style="width:auto"> 每天自动发说说</label></div>'
    + num('每天最多', 'qzone.perDay', c.qzone.perDay, 1, '条')
    + tim('最早', 'qzone.fromTime', c.qzone.fromTime)
    + tim('最晚', 'qzone.toTime', c.qzone.toTime)
    + num('当天发的概率', 'qzone.chance', c.qzone.chance, 0.05, '0–1')
    + '<h4 class="sect">记忆</h4>'
    + cb('自动整理记忆', 'memory.digest', !(c.memory && c.memory.digest === false), '从聊天里自动抽「他是谁、喜好、雷区」，不用她每次都记得写标签')
    + cb('记错了自动作废旧条目', 'memory.autoCorrect', !(c.memory && c.memory.autoCorrect === false), '换了城市/工作/学校、毕业、分手这类新情况，会照抄旧的原文把它删掉')
    + '<h4 class="sect">语音识别</h4>'
    + cb('把收到的语音转成文字', 'asr.enabled', !(c.asr && c.asr.enabled === false), '关掉后她只会说「你发了条语音」，省识别费')
    + '<h4 class="sect">她自己的生活</h4>'    + cb('每天给自己排日程', 'life.plan', !(c.life && c.life.plan === false), '关掉就没有「我今天在干嘛」，聊天会变空心')
    + cb('晚上写日记', 'life.journal', !(c.life && c.life.journal === false), '关掉就不写，第二天她也就不知道自己昨天干了啥')
    + cb('外面的事撞到她', 'life.events', !(c.life && c.life.events === false), '每天 2–3 件小事（外卖送错、快递、下雨、朋友找），会进日记和聊天；关掉她的一天就只剩自己排的事')
    + '<h4 class="sect">语音识别（ASR）</h4>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">方式</span><select data-p="asr.provider" style="width:280px"><option value="local"' + (((c.asr && c.asr.provider) || 'local') === 'local' ? ' selected' : '') + '>本机模型（faster-whisper，免费但吃内存）</option><option value="openai"' + ((c.asr && c.asr.provider) === 'openai' ? ' selected' : '') + '>OpenAI 兼容接口（/audio/transcriptions）</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="asr.baseUrl" value="' + ((c.asr && c.asr.baseUrl) || '') + '" style="flex:1" placeholder="选 openai 时必填，如 https://api.openai.com/v1"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="asr.model" list="dlAsr" value="' + ((c.asr && c.asr.model) || '') + '" style="width:260px" placeholder="留空 = whisper-1"><button class="ghost" onclick="pullModels(\'asr\')">拉取</button><span class="dim" id="amMsg">可下拉选，也可手填</span><datalist id="dlAsr"></datalist></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="asr.key" type="password" placeholder="已保存或留空" style="flex:1"></div>'
    + '<h4 class="sect">看图</h4>'
    + '<p class="dim" style="margin:0 0 6px 210px" id="vInfo">检查中…</p>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="vision.baseUrl" value="' + ((c.vision && c.vision.baseUrl) || '') + '" style="flex:1" placeholder="留空 = 用大脑的地址"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="vision.model" list="dlVision" value="' + ((c.vision && c.vision.model) || '') + '" style="width:260px" placeholder="留空 = 用大脑的模型"><button class="ghost" onclick="pullModels(\'vision\')">拉取</button><span class="dim" id="vmMsg">可下拉选，也可手填</span><datalist id="dlVision"></datalist></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="vision.key" type="password" placeholder="留空 = 用大脑的 key" style="flex:1"></div>'
    + '<h4 class="sect">画图</h4>'
    + cb('允许她自己画图', 'draw.enabled', !(c.draw && c.draw.enabled === false), '聊天时她会用 [[画:…]] 亲手画一张发给你')
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">协议</span><select data-p="draw.provider" style="width:320px"><option value="auto"' + (((c.draw && c.draw.provider) || 'auto') === 'auto' ? ' selected' : '') + '>自动（看地址判断）</option><option value="ark"' + ((c.draw && c.draw.provider) === 'ark' ? ' selected' : '') + '>火山方舟 Seedream（支持参考图）</option><option value="dashscope"' + ((c.draw && c.draw.provider) === 'dashscope' ? ' selected' : '') + '>阿里云百炼·万相（异步，纯文字）</option><option value="openai"' + ((c.draw && c.draw.provider) === 'openai' ? ' selected' : '') + '>OpenAI 兼容 /images/generations</option></select></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">接口地址</span><input data-p="draw.baseUrl" value="' + ((c.draw && c.draw.baseUrl) || '') + '" style="flex:1" placeholder="留空=各后端默认：火山 https://ark.cn-beijing.volces.com/api/v3 / 阿里云 https://dashscope.aliyuncs.com"></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">模型</span><input data-p="draw.model" list="dlDraw" value="' + ((c.draw && c.draw.model) || '') + '" style="width:300px" placeholder="留空用默认"><button class="ghost" onclick="pullModels(\'draw\')">拉取</button><span class="dim" id="dmMsg">可下拉选，也可手填 / ep- 接入点</span><datalist id="dlDraw"></datalist></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim">API Key</span><input data-p="draw.key" type="password" placeholder="' + (dInfo.keySet ? ('已保存 ' + (dInfo.keyMask || '') + '（留空不改）') : '留空 = 用 data\\aliyun.key 或 data\\ark.key') + '" style="flex:1"></div>'
    + '<div class="row" style="margin:-2px 0 6px 210px"><span id="dKey" class="dim">检查中…</span></div>'
    + cb('画她时带上参考图', 'draw.ref', !(c.draw && c.draw.ref === false), '火山 Seedream 会按「她的样子」锁人物；阿里云不支持')
    + cb('OpenAI 网关也带图', 'draw.sendRef', !!(c.draw && c.draw.sendRef), '多数网关不支持，会报错，默认关')
    + cb('他要照片时别一直拒', 'draw.ownerPush', !!(c.draw && c.draw.ownerPush), '勾上=可以嫌烦但第二次就拍；不勾=完全看她心情（默认）')
    + num('每天最多画', 'draw.perDay', (c.draw && c.draw.perDay) || 3, 1, '张')
    + num('接着上一张的窗口', 'draw.keepMin', (c.draw && c.draw.keepMin) ?? 120, 0, '分钟')
    + '<div class="row" style="margin:0 0 6px"><span style="width:210px" class="dim"></span><span class="dim">这段时间内再拍，会沿用上一张的环境（只换姿势）；她换了地方或超时就算新场景。0 = 从不接着上一张。可在场景里写「还在」「继续」强制接上。</span></div>'
    + '<div class="row" style="margin:6px 0"><span style="width:210px" class="dim"></span><button class="ghost" onclick="testDraw()">试画一张</button><span class="dim" id="dMsg"></span></div>'
    + '<div id="dOut"></div>'
    + '<h4 class="sect">表情包</h4>'
    + cb('收对方发的表情包', 'stickers.collectFromUser', !(c.stickers && c.stickers.collectFromUser === false), '收到后她自己判断要不要收藏')
    + cb('收群里的表情包', 'stickers.collectFromGroup', !(c.stickers && c.stickers.collectFromGroup === false), '')
    + num('表情包上限', 'stickers.max', c.stickers.max, 10, '张')
    + '<h4 class="sect">预算</h4>'
    + cb('启用月度预算熔断', 'budget.enabled', !(c.budget && c.budget.enabled === false), '超预算自动降耗、再超就停')
    + num('月度预算', 'budget.monthlyCap', c.budget && c.budget.monthlyCap, 1, '元')
    + num('再超多少就停', 'budget.notifyExtra', c.budget && c.budget.notifyExtra, 1, '元');
  await loadVoiceOptions(((c.tts && c.tts.voiceId) || c.voice || ''));
  paintKeyStatus();
  paintVision();
}

// 看图这块：大脑能看图就不用配；看不了就用百炼兜底；都没有才标红让用户填
async function paintVision(){
  const el = $('#vInfo');
  if (!el) return;
  try {
    const i = await api('/api/vision/info');
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
  const cfg = { chat: { msg: '#brMsg', dl: '', model: 'brModel', base: 'brUrl', key: 'brKey' },
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
    const ids = r.ids || [];
    if (dl && dl.tagName === 'DATALIST') dl.innerHTML = ids.map(id => '<option value="' + id + '"></option>').join('');
    if (box) box.textContent = ids.length ? ('拉到 ' + ids.length + ' 个，点输入框下拉选' + (r.from ? '（' + r.from + '）' : '')) : ('没拉到：' + (r.err || '空'));
    const target = document.querySelector('[data-p="' + cfg.model + '"]') || document.getElementById(cfg.model);
    if (ids.length && target) showModelMenu(target, ids);
    if (ids.length === 1 && target && !target.value.trim()) target.value = ids[0];
  } catch (e) { if (box) box.textContent = '拉取失败：' + (e.message || e); }
}
async function saveOwner(){
  const v = $('#ownerUin').value.replace(/\D/g,'').trim();
  if (!v) { $('#ownMsg').textContent = '填个 QQ 号'; return; }
  const r = await api('/api/setup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerUin: v }) });
  $('#ownMsg').textContent = r.ok ? '已保存' : ('保存失败：' + (r.error || ''));
}
async function saveBrain(){
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
  document.querySelectorAll('[data-cb]').forEach(el => {
    const parts = el.dataset.cb.split('.');
    let o = c; for (let i=0;i<parts.length-1;i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length-1]] = el.checked;
  });
  document.querySelectorAll('[data-p]').forEach(el => {
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
async function loadLog(){ const r = await api('/api/log'); $('#logPre').textContent = r.lines.slice().reverse().join('\n'); }

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
  const names = { chat: '对话', tts: '语音合成', asr: '语音识别', vision: '看图' };
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

loadState(); loadPersona(); loadSelf(); loadCfg(); api('/api/delcode').then(renderDelCode).catch(() => {});
setInterval(() => { if ($('#status').classList.contains('on')) loadState(); }, 8000);

</script>  <div id="toast"></div>
</body></html>`;

server.listen(PORT, process.env.QQBOT_UI_HOST || '127.0.0.1', () => {
  console.log('[ui] http://127.0.0.1:' + PORT);
});

