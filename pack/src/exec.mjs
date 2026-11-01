// 受限命令执行：给了她"能跑起来"的能力，但把能干的事收在一个盒子里
// 设计参照 DSH 的 sandbox 三档（read-only / workspace-write / danger-full-access），
// 但 Windows 上没有便宜的进程级文件隔离，所以这里**不声称是沙箱**：
//   - 命令必须人工审批（bridge 那层弹卡）
//   - 默认只在工作区里跑（cwd 锁死、参数里的路径必须落在工作区）
//   - 程序白名单 + 危险片段黑名单 + 无 shell 拼接 + 超时杀进程树 + 输出上限
//   - 每次执行记一条审计（data/work/audit.jsonl）
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import * as fsguard from './fsguard.mjs';

export const MODES = [ 'off', 'workspace', 'full' ];

export const DEFAULT_ALLOW = [
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'py', 'pip', 'pip3',
  'git', 'tsc', 'pytest', 'jest', 'mocha', 'vitest',
  'cargo', 'go', 'dotnet', 'mvn', 'gradle',
  // dir / type / echo / mkdir / copy 是 cmd 内建命令，没有 .exe：机器上有 Git/MSYS 才跑得起来，
  // 干净的 Windows 上会 ENOENT。真要列目录读文件，走 list_dir / read_file 那两个工具更稳。
  'dir', 'type', 'where', 'findstr', 'tar',
];

// 命令里一出现就拒的片段（不区分大小写）
const DENY = /(\brm\s+-rf\b|\bdel\s+\/f\b|\bformat\b|\bdiskpart\b|\bshutdown\b|\breg\s+(add|delete)\b|\bnet\s+user\b|\btaskkill\b|\bbcdedit\b|\bvssadmin\b|\bcipher\b|\btakeown\b|\bicacls\b|Invoke-WebRequest|curl\s+.*\|\s*(sh|bash)|\bwget\b)/i;
// shell 元字符：一律不许（不做 shell 拼接）
const META = /[&|<>^`]/;
// node 内联执行参数：绕过脚本文件校验，一律拒
const NODE_BAN = /^(-e|--eval|--print|-p|-r|--require|--import|--loader|--experimental-loader|-i|--interactive)(=|$)/;

const active = new Map(); // wsId -> Set<pid>

function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const half = Math.floor((max - 40) / 2);
  return s.slice(0, half) + '\n…（中间省略 ' + (s.length - half * 2) + ' 字）…\n' + s.slice(-half);
}

export function looksLikePath(tok) {
  const t = String(tok || '');
  if (!t) return false;
  if (/^[A-Za-z]:/.test(t)) return true;
  if (t === '.' || t === '..' || t.startsWith('.\\') || t.startsWith('../') || t.startsWith('..\\')) return true;
  if (/^\/[A-Za-z]+$/.test(t)) return false; // 开关
  return t.includes('\\') || t.includes('/');
}

/** 参数里的路径必须落在工作区（写得到、读得到都算），开关类参数不动 */
export function checkPaths(argv, { root, deny = [] } = {}) {
  if (!root) return '没有工作区，不能跑命令';
  for (const a of argv) {
    if (!looksLikePath(a)) continue;
    if (path.resolve(root, a) === path.resolve(root)) continue;   // 工作区根自己：允许（checkWrite 只对根下的路径有意义）
    const r = fsguard.checkWrite(a, { base: root, root, denyAbs: deny, allowCreate: true });
    if (!r.ok) return '参数路径不在工作区里：' + a + '（' + r.err + '）';
  }
  return '';
}

function baseEnv() {
  const keep = [ 'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    'OS', 'LANG', 'LC_ALL', 'HOME', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH' ];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  // 密钥类一律不带进子进程，避免 `env` 一抖就漏
  env.QQBOT_CHILD = '1';
  env.NO_COLOR = '1';
  return env;
}

export function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', [ '/PID', String(pid), '/T', '/F' ], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/** 停会话时把还在跑的子进程全掐掉（评审 F13：停止不能留进程树） */
export function killAll(wsId) {
  const set = active.get(wsId);
  let n = 0;
  if (set) {
    for (const pid of set) { killTree(pid); n++; }
    set.clear();
  }
  return n;
}

export function activeCount(wsId) {
  const set = active.get(wsId);
  return set ? set.size : 0;
}

function audit(rec) {
  try {
    const dir = paths.PATHS.ledger;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch {}
}

/**
 * 跑一条命令。
 * @param {string[]} argv 例如 ['node','build.mjs']
 * @param {object} opts { root, deny, wsId, mode, allow, timeoutMs, maxOutput, env }
 */
export async function run(argv, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : 'workspace';
  if (mode === 'off') return { ok: false, err: '命令执行没开（工作模式里可以打开）' };
  if (!Array.isArray(argv) || !argv.length) return { ok: false, err: 'cmd 必须是非空数组' };

  const exe0 = String(argv[0]);
  if (/[\\/]/.test(exe0)) return { ok: false, err: '命令只能用名称，不能用路径：' + exe0 };
  const low = exe0.toLowerCase().replace(/\.exe$/, '');
  const allow = (Array.isArray(opts.allow) && opts.allow.length ? opts.allow : DEFAULT_ALLOW).map((x) => String(x).toLowerCase().replace(/\.exe$/, ''));
  if (!allow.includes(low)) return { ok: false, err: '命令不在白名单：' + exe0
      + '（现在只有：' + allow.join('、') + '）'
      + '。要加就往设置 work.exec.allow 里加一条，比如 "tar"；'
      + '只读目录、改错别字、复制移动删除文件这些不用跑命令，直接用读/写/移动那几个工具就行。' };

  const line = argv.map(String).join(' ');
  if (DENY.test(line)) return { ok: false, err: '命令含危险片段，已拒绝：' + line };
  for (const a of argv) if (META.test(String(a))) return { ok: false, err: '参数含不允许的字符 &\u007c<>\u005e\u0060：' + a };
  if (low === 'node') {
    for (const a of argv.slice(1)) if (NODE_BAN.test(String(a))) return { ok: false, err: 'node 内联执行参数被拒绝：' + a };
  }
  if (/^(python|python3|py)$/.test(low)) {
    for (const a of [ ...argv.slice(1), ...argv.slice(0, 1) ]) if (String(a) === '-c') return { ok: false, err: 'python -c 内联执行被拒绝（要跑就写成脚本文件）' };
  }
  if (low === 'git') {
    for (const a of argv.slice(1)) {
      if (/^(-c|--exec-path|--upload-pack|--receive-pack)(=|$)/.test(String(a))) return { ok: false, err: 'git 参数被拒绝（会注入外部命令）：' + a };
      if (/^--output(=|$)/.test(String(a))) return { ok: false, err: 'git --output 写文件被拒绝：' + a };
    }
    const sub = String(argv[1] || '').toLowerCase();
    const GIT_BAN_SUB = [ 'clean', 'reset', 'push', 'rebase', 'filter-branch', 'gc', 'prune', 'update-ref', 'reflog' ];
    if (GIT_BAN_SUB.includes(sub)) return { ok: false, err: '这个 git 子命令会改历史/删东西，不让她跑：git ' + sub };
    if (sub === 'branch') {
      const rest = argv.slice(2).map(String);
      const badFlag = rest.find((a) => /^-(D|d|m|M|c|C|f|u)$/.test(a));
      const positional = rest.find((a) => !a.startsWith('-'));
      if (badFlag || positional) return { ok: false, err: 'git branch 只允许查看，不接受改名/删除/新建：' + [ badFlag, positional ].filter(Boolean).join(' ') };
    }
  }

  let root = opts.root ? path.resolve(opts.root) : '';
  if (mode === 'workspace') {
    if (!root) return { ok: false, err: '没有工作区，不能跑命令' };
    const bad = checkPaths(argv, { root, deny: opts.deny || [] });
    if (bad) return { ok: false, err: bad };
  } else {
    root = opts.root ? path.resolve(opts.root) : process.cwd();
  }
  if (!fs.existsSync(root)) return { ok: false, err: '工作区不存在：' + root };

  const timeoutMs = Math.max(1000, Math.min(300000, Number(opts.timeoutMs) || 60000));
  const maxOut = Math.max(500, Math.min(64000, Number(opts.maxOutput) || 8000));

  let realExe = exe0;
  let realArgs = argv.slice(1);
  if ([ 'dir', 'type', 'where', 'findstr' ].includes(low)) {
    realExe = process.env.ComSpec || 'cmd.exe';
    realArgs = [ '/d', '/c', exe0, ...argv.slice(1) ];
  }

  const env = Object.assign(baseEnv(), opts.env || {});
  const t0 = Date.now();
  const wsId = String(opts.wsId || '');
  const res = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(realExe, realArgs, { cwd: root, env, windowsHide: true, shell: false, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    } catch (e) {
      resolve({ ok: false, err: '起不来：' + (e && e.message) });
      return;
    }
    const chunk = [];
    let size = 0;
    let truncated = false;
    const take = (b) => {
      if (!b) return;
      size += b.length;
      if (size > 2 << 20) { truncated = true; return; }
      chunk.push(b);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { killTree(child.pid); } catch {} }, timeoutMs);
    if (wsId) {
      if (!active.has(wsId)) active.set(wsId, new Set());
      active.get(wsId).add(child.pid);
    }
    const finish = (ok, extra) => {
      clearTimeout(timer);
      if (wsId && active.has(wsId)) active.get(wsId).delete(child.pid);
      const buf = Buffer.concat(chunk);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('latin1'); } }
      resolve(Object.assign({ ok, out: clip(text, maxOut), ms: Date.now() - t0, killed, truncated }, extra || {}));
    };
    child.on('error', (e) => finish(false, { err: '执行失败：' + (e && e.message) }));
    child.on('close', (code) => {
      if (killed) finish(false, { err: '超时（' + Math.round(timeoutMs / 1000) + ' 秒）被掐掉', code: code == null ? -1 : code });
      else if (code === 0) finish(true, { code: 0 });
      else finish(false, { err: '退出码 ' + code, code });
    });
  });

  audit({
    at: new Date().toISOString(), ws: wsId, mode, cmd: argv.map(String), cwd: root,
    ok: res.ok, code: res.code == null ? null : res.code, ms: res.ms,
    killed: !!res.killed, truncated: !!res.truncated, outLen: String(res.out || '').length,
  });
  return res;
}
