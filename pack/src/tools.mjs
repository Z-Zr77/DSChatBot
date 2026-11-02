// tools.mjs — 工具层（PoC 第 1 轮 → 方案 A 收敛）
// 设计原则：工具只做被明确允许的事；越界直接拒绝，不靠提示词约束。
//
// 方案 A 相对第 1 轮的三处收紧：
//   1. 参数路径白名单：所有像路径的参数必须落在 ROOTS 内；拒绝 cmd 元字符（堵 `type C:\Windows\win.ini`、`dir /s E:\`、`dir & whoami`）
//   2. 收窄可执行命令：移除 python/npm（都能执行任意代码）；node 只允许跑根目录内的 .js/.mjs/.cjs 脚本；git 只允许只读子命令
//   3. 输出解码：UTF-8 严格优先，失败回落 GBK（修中文乱码）
//   4.（可选）根目录判定叠加 realpath，堵目录联接/符号链接绕过
//
// 复查后收紧（2026-10-29 20:10，见 notes\整理后复查-20261029.md）：
//   5. list_dir / read_file 一律先把相对路径按 BASE_CWD 解析成绝对路径再碰文件系统
//      （之前校验用 BASE_CWD、实际读用 process.cwd()，换个工作目录就能读到根外文件）
//   6. git branch 只允许查看类开关：带分支名的调用会创建/删除分支，一律拒绝
//   7. node 执行默认关闭（脚本能跑任意代码），需显式 QQBOT_TOOLS_NODE=1 才开放
//
// 共享文件：pack/mobile-full/src/tools.mjs 与本文件应保持一致；改动后需手动同步（手机端窗口约定先不动）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as fsguard from './fsguard.mjs';
import * as exec from './exec.mjs';
import * as snapshots from './snapshots.mjs';
import * as diff from './diff.mjs';
import * as net from './net.mjs';

const ROOTS = [ 'C:\\qqbot' ];   // 兜底默认；真实范围由工作会话的 roots/deny 传入
const BASE_CWD = ROOTS[0];                                     // 命令的工作目录，限制相对参数的展开范围
const MAX_READ = 200 * 1024;                                   // 读文件上限 200KB
const MAX_OUT = 4000;                                          // 返回给模型的上限
const CMD_TIMEOUT = 20000;

// —— 根目录判定（词法 + realpath 双重）
const ROOT_REAL = ROOTS.map((r) => {
  try { return fs.realpathSync.native(r); } catch { return path.resolve(r); }
});

function relInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function absOf(p) {
  return path.resolve(BASE_CWD, String(p));
}

function inRoots(p) {
  const abs = absOf(p);
  if (!ROOT_REAL.some((r) => relInside(r, abs))) return false;
  let real = null;
  try { real = fs.realpathSync.native(abs); } catch { real = null; }
  if (real && real !== abs && !ROOT_REAL.some((r) => relInside(r, real))) return false;
  return true;
}

// —— 命令白名单
const BUILTIN = new Set([ 'dir', 'type', 'findstr', 'where' ]);      // cmd 内建，必须经 cmd /c
const EXE_ALLOW = new Set([ 'node', 'git' ]);                        // python / npm 已移除：都能执行任意代码
const NODE_BAN = /^(-e|--eval|--print|-p|-r|--require|--import|--loader|--experimental-loader|-i|--interactive)(=|$)/;
const GIT_DENY = /^(-c|-C|--config|--exec-path|--upload-pack|--receive-pack)(=|$)|^(--output|--exec-path|--upload-pack|--receive-pack)=/;
const GIT_SUB = new Set([ 'status', 'diff', 'log', 'show', 'branch', 'ls-files', 'rev-parse', 'describe' ]);
// branch 的只读开关；任何非开关参数都可能是分支名（= 创建/删除），一律拒绝
const GIT_BRANCH_OK = new Set([ '-a', '-r', '-v', '-vv', '-l', '--all', '--list', '--show-current', '--merged', '--no-merged' ]);
// 每次调用时读环境变量：启动脚本/控制台可以在运行时决定开不开
const nodeEnabled = () => process.env.QQBOT_TOOLS_NODE === '1';
const METACHAR = /[&|<>^()%"`]/;                                     // cmd 元字符：一次解析就会变成第二条命令
const CMD_DENY = /(rm |del |rd |rmdir|format|diskpart|shutdown|reg |regedit|net user|taskkill|curl .*\| *(sh|bash)|Invoke-WebRequest.*OutFile|>.+\.(bat|ps1|exe))/i;

// 开关（/s /b /r /i …）不是路径；其余含分隔符、盘符、.. 的都当路径处理
const SWITCH = /^\/[A-Za-z]+$/;
function isPathLike(tok) {
  if (/^[A-Za-z]:/.test(tok)) return true;
  if (tok === '.' || tok === '..' || /^\.\.[\\/]/.test(tok)) return true;
  if (SWITCH.test(tok)) return false;
  return tok.includes('\\') || tok.includes('/');
}

// 每个 token 都过一遍：先挡元字符，再把像路径的 token 关进 ROOTS
function checkArgs(argv, roots, deny = []) {
  for (const a of argv) {
    if (METACHAR.test(a)) return '参数含不允许的字符（& | < > ^ ( ) % " `）：' + a;
    if (isPathLike(a)) {
      if (Array.isArray(roots) && roots.length) {
        const chk = fsguard.checkRead(a, { base: BASE_CWD, roots, denyAbs: deny });
        if (!chk.ok) return '参数路径不在允许范围：' + a;
      } else if (!inRoots(a)) return '参数路径不在允许范围：' + a;
    }
  }
  return null;
}

function nodeScript(args) {
  const first = args.find((a) => !a.startsWith('-'));
  if (!first) return 'node 需要脚本文件参数';
  if (!/\.(js|mjs|cjs)$/i.test(first)) return 'node 只允许运行 .js/.mjs/.cjs 脚本：' + first;
  const abs = path.resolve(BASE_CWD, first);
  if (!inRoots(abs)) return '脚本不在允许范围：' + first;
  let st = null;
  try { st = fs.statSync(abs); } catch { return '脚本不存在：' + first; }
  if (st.isDirectory()) return '脚本不是文件：' + first;
  return null;
}

function gitCheck(args) {
  for (const a of args) {
    const hit = GIT_DENY.exec(a);
    if (hit) return 'git 参数被拒绝：' + a;
  }
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub) return 'git 需要子命令';
  if (!GIT_SUB.has(sub)) return 'git 只允许只读子命令（' + [ ...GIT_SUB ].join('/') + '）：' + sub;
  if (sub === 'branch') {
    const rest = args.slice(args.indexOf('branch') + 1);
    for (const a of rest) {
      if (!a.startsWith('-')) return 'git branch 只允许查看，不接受分支名（会创建/删除分支）：' + a;
      if (!GIT_BRANCH_OK.has(a)) return 'git branch 参数被拒绝：' + a;
    }
  }
  return null;
}

// —— 输出解码：严格 UTF-8 优先，失败回落 GBK
function decode(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gbk').decode(buf); } catch {}
  return buf.toString('latin1');
}

function clip(s) {
  s = String(s == null ? '' : s);
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…（截断，原长 ${s.length}）` : s;
}

// 读类工具的范围：默认仍是原来的两个根；工作会话会传进来自己的 readRoots + 禁读清单
// 子路径能不能露：search/find/list_dir 递归时逐项用同一份 roots/deny
function loud(sc, abs) {
  try {
    const r = fsguard.checkRead(abs, { base: sc.base, roots: sc.roots, denyAbs: sc.deny });
    if (!(r && r.ok)) return false;
    // 这个目录里只要装着禁读/禁改的东西，名字也别露（复查 F01：目录名同样会泄露）
    const pre = (abs.endsWith(path.sep) ? abs : abs + path.sep).toLowerCase();
    for (const d of sc.deny || []) {
      const dd = String(d).toLowerCase();
      if (dd === pre.slice(0, -1) || dd.startsWith(pre)) return false;
    }
    return true;
  } catch { return false; }
}

function readScope(opts = {}) {
  const roots = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : ROOT_REAL;
  const deny = Array.isArray(opts.deny) ? opts.deny.map((d) => path.resolve(String(d))) : [];
  return { roots, deny, base: opts.base || BASE_CWD };
}

// 写类工具的范围：只允许一个写根（工作会话的工作区），外加禁写清单
// 目录级操作前：整个子树里只要有一个子路径被禁（禁改表/链接/根外），就不许整目录搬
function subtreeDenied(sc, abs) {
  const bad = (p) => {
    const r = fsguard.checkWrite(p, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: false });
    return !(r && r.ok);
  };
  const walk = (dir, depth) => {
    if (depth > 8) return '';
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (bad(p)) return p;
      if (d.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
    }
    return '';
  };
  if (bad(abs)) return abs;
  try { if (!fs.statSync(abs).isDirectory()) return ''; } catch { return ''; }
  return walk(abs, 0);
}

function writeScope(opts = {}) {
  const root = opts.writeRoot ? path.resolve(String(opts.writeRoot)) : '';
  const deny = Array.isArray(opts.deny) ? opts.deny.map((d) => path.resolve(String(d))) : [];
  return { root, deny, base: opts.base || BASE_CWD, wsId: String(opts.wsId || '') };
}

// 原子写：同目录 tmp + rename（中途失败不留半个文件）
function atomicWrite(absPath, buf) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.qqbot-w-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.tmp');
  fs.writeFileSync(tmp, buf);
  try { fs.renameSync(tmp, absPath); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

export const tools = {
  list_dir: {
    desc: '列出目录内容（只读）。参数：{ path }，path 省略就是当前工作区根目录',
    caps: [ 'fs:read' ],
    async run({ path: p }, opts = {}) {
      const pp = p || '.';
      const sc = readScope(opts);
      const chk = fsguard.checkRead(pp, { base: sc.base, roots: sc.roots, denyAbs: sc.deny });
      if (!chk.ok) return { ok: false, err: chk.err };
      let items = [];
      try { items = fs.readdirSync(chk.abs, { withFileTypes: true }).slice(0, 200); } catch (e) { return { ok: false, err: decode(String(e.message || e)) }; }
      const shown = items.filter((d) => loud(sc, path.join(chk.abs, d.name)));
      return { ok: true, out: clip(shown.map((d) => (d.isDirectory() ? '[D] ' : '[F] ') + d.name).join('\n')) };
    },
  },
  read_file: {
    desc: '读取文本文件（只读，≤200KB）。参数：{ path, maxBytes? }',
    caps: [ 'fs:read' ],
    async run({ path: p, maxBytes }, opts = {}) {
      if (!p) return { ok: false, err: '需要 path' };
      const sc = readScope(opts);
      const chk = fsguard.checkRead(p, { base: sc.base, roots: sc.roots, denyAbs: sc.deny });
      if (!chk.ok) return { ok: false, err: chk.err };
      let st = null;
      try { st = fs.statSync(chk.abs); } catch (e) { return { ok: false, err: '读不到：' + p }; }
      if (st.isDirectory()) return { ok: false, err: '这是目录，用 list_dir' };
      const cap = Math.max(1024, Math.min(MAX_READ, Number(maxBytes) || MAX_READ));
      if (st.size > cap) return { ok: false, err: `文件 ${st.size} 字节，超过 ${Math.round(cap / 1024)}KB 上限` };
      return { ok: true, out: clip(decode(fs.readFileSync(chk.abs))) };
    },
  },

  write_file: {
    desc: '写入/覆盖工作区里的文本文件（会先存快照，可恢复）。参数：{ path, content }',
    caps: [ 'fs:write' ],
    async run({ path: p, content }, opts = {}) {
      if (!p) return { ok: false, err: '需要 path' };
      if (typeof content !== 'string') return { ok: false, err: 'content 必须是字符串' };
      if (content.length > 1024 * 1024) return { ok: false, err: '内容超过 1MB，本轮不写' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能写文件' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能写（无法记快照）' };
      const chk = fsguard.checkWrite(p, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!chk.ok) return { ok: false, err: chk.err };
      const abs = chk.abs;
      const rel = path.relative(sc.root, abs).split(path.sep).join('/');
      const existed = fs.existsSync(abs);
      let beforeText = '';
      if (existed) {
        const ob = fs.readFileSync(abs);
        try { beforeText = new TextDecoder('utf-8', { fatal: true }).decode(ob); }
        catch {
          return { ok: false, err: '这个文件不是 UTF-8（可能是 GBK 或二进制），整份覆盖会写坏它；要改请用 edit_file 同一个编码的片段，或者先转码' };
        }
      }
      const snap = snapshots.begin(sc.wsId, abs, rel);
      if (!snap.ok) return { ok: false, err: snap.err };
      try { atomicWrite(abs, Buffer.from(content, 'utf8')); } catch (e) { return { ok: false, err: '写失败：' + decode(String((e && e.message) || e)) }; }
      snapshots.commit(sc.wsId, snap, abs, rel, existed ? 'overwrite' : 'create');
      const d = diff.lineDiff(beforeText, content, 8);
      return {
        ok: true,
        out: (existed ? '已覆盖 ' : '已新建 ') + rel + '（' + content.length + ' 字）'
          + (d.lines.length ? '\n改动：\n' + d.text + (d.truncated ? '\n…（还有更多改动）' : '') : ''),
        edit: { id: snap.id, rel, action: existed ? 'overwrite' : 'create', added: d.added, removed: d.removed },
      };
    },
  },
  edit_file: {
    desc: '把工作区里某个文件中的一段文字替换掉（old 必须在文件里唯一出现）。参数：{ path, old, new, all? }',
    caps: [ 'fs:write' ],
    async run({ path: p, old: o, new: nw, all }, opts = {}) {
      if (!p || typeof o !== 'string' || typeof nw !== 'string' || !o) return { ok: false, err: '需要 path、old、new' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能写文件' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能写（无法记快照）' };
      const chk = fsguard.checkWrite(p, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: false });
      if (!chk.ok) return { ok: false, err: chk.err };
      const abs = chk.abs;
      if (!fs.existsSync(abs)) return { ok: false, err: '文件不存在（新建请用 write_file）：' + p };
      let text = '';
      try {
        const ob = fs.readFileSync(abs);
        text = new TextDecoder('utf-8', { fatal: true }).decode(ob);
      } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: false, err: '读不到：' + p };
        return { ok: false, err: '这个文件不是 UTF-8（可能是 GBK 或二进制），直接编辑会写坏没被改到的中文；先转码再来改' };
      }
      const count = text.split(o).length - 1;
      if (count === 0) return { ok: false, err: '文件里找不到这段原文（old 要一字不差，含空格缩进）' };
      if (count > 1 && all !== true) return { ok: false, err: '这段原文出现了 ' + count + ' 次，要么写长一点唯一，要么传 all:true 全换' };
      const rel = path.relative(sc.root, abs).split(path.sep).join('/');
      const snap = snapshots.begin(sc.wsId, abs, rel);
      if (!snap.ok) return { ok: false, err: snap.err };
      const outText = text.split(o).join(nw);
      try { atomicWrite(abs, Buffer.from(outText, 'utf8')); } catch (e) { return { ok: false, err: '写失败：' + decode(String((e && e.message) || e)) }; }
      snapshots.commit(sc.wsId, snap, abs, rel, 'edit');
      const d = diff.lineDiff(text, outText, 8);
      return {
        ok: true,
        out: '已替换 ' + (all === true ? count : 1) + ' 处 → ' + rel
          + (d.lines.length ? '\n改动：\n' + d.text : ''),
        edit: { id: snap.id, rel, action: 'edit', added: d.added, removed: d.removed },
      };
    },
  },
  mkdir: {
    desc: '在工作区里新建目录（可多级）。参数：{ path }',
    caps: [ 'fs:write' ],
    async run({ path: p }, opts = {}) {
      if (!p) return { ok: false, err: '需要 path' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能建目录' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能改（无法记快照）' };
      const chk = fsguard.checkWrite(p, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!chk.ok) return { ok: false, err: chk.err };
      const abs = chk.abs;
      const rel = path.relative(sc.root, abs).split(path.sep).join('/');
      if (fs.existsSync(abs)) return { ok: fs.statSync(abs).isDirectory(), out: '目录已经在了：' + rel, err: fs.statSync(abs).isDirectory() ? undefined : '同名文件已存在：' + rel };
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pend = snapshots.recordPendingOp(sc.wsId, { id, rel, action: 'mkdir', target: abs });
      if (!pend.ok) return { ok: false, err: pend.err };
      try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return { ok: false, err: '建不了目录：' + decode(String((e && e.message) || e)) }; }
      const mark = snapshots.markOp(sc.wsId, id, { action: 'mkdir' });
      if (!mark.ok) return { ok: false, err: mark.err };
      return { ok: true, out: '已新建目录 ' + rel, edit: { id, rel, action: 'mkdir' } };
    },
  },
  move: {
    desc: '把工作区里的文件/目录移动到另一个位置（同一次会话内）。参数：{ from, to }',
    caps: [ 'fs:write' ],
    async run({ from, to }, opts = {}) {
      if (!from || !to) return { ok: false, err: '需要 from、to' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能移动' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能改（无法记快照）' };
      const a = fsguard.checkWrite(from, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: false });
      if (!a.ok) return { ok: false, err: a.err };
      const b = fsguard.checkWrite(to, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!b.ok) return { ok: false, err: b.err };
      if (!fs.existsSync(a.abs)) return { ok: false, err: '要移动的东西不存在：' + from };
      const forbidden = subtreeDenied(sc, a.abs);
      if (forbidden) return { ok: false, err: '这个目录里有不该动的东西（' + forbidden + '），整目录搬走会让它换个路径变可读，先单独处理' };
      if (fs.existsSync(b.abs)) return { ok: false, err: '目标已存在，覆盖会丢东西：' + to };
      const relA = path.relative(sc.root, a.abs).split(path.sep).join('/');
      const relB = path.relative(sc.root, b.abs).split(path.sep).join('/');
      const afterSha = fs.statSync(a.abs).isFile() ? snapshots.shaOf(a.abs) : '';
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pend = snapshots.recordPendingOp(sc.wsId, { id, rel: relA, action: 'move', toRel: relB, target: b.abs });
      if (!pend.ok) return { ok: false, err: pend.err };
      try { fs.mkdirSync(path.dirname(b.abs), { recursive: true }); fs.renameSync(a.abs, b.abs); }
      catch (e) { return { ok: false, err: '移动失败：' + decode(String((e && e.message) || e)) }; }
      const mark = snapshots.markOp(sc.wsId, id, { action: 'move', toRel: relB, after: afterSha ? { sha: afterSha, size: fs.statSync(b.abs).size } : null });
      if (!mark.ok) return { ok: false, err: mark.err };
      return { ok: true, out: '已移动：' + relA + ' → ' + relB, edit: { id, rel: relA, action: 'move' } };
    },
  },
  copy: {
    desc: '复制工作区里的文件。参数：{ from, to }',
    caps: [ 'fs:write' ],
    async run({ from, to }, opts = {}) {
      if (!from || !to) return { ok: false, err: '需要 from、to' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能复制' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能改（无法记快照）' };
      const a = fsguard.checkWrite(from, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: false });
      if (!a.ok) return { ok: false, err: a.err };
      const b = fsguard.checkWrite(to, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!b.ok) return { ok: false, err: b.err };
      if (!fs.existsSync(a.abs)) return { ok: false, err: '要复制的东西不存在：' + from };
      if (!fs.statSync(a.abs).isFile()) return { ok: false, err: '只能复制文件，目录请用 mkdir + 逐个复制' };
      if (fs.existsSync(b.abs)) return { ok: false, err: '目标已存在：' + to };
      const relA = path.relative(sc.root, a.abs).split(path.sep).join('/');
      const relB = path.relative(sc.root, b.abs).split(path.sep).join('/');
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pend = snapshots.recordPendingOp(sc.wsId, { id, rel: relA, action: 'copy', toRel: relB, target: b.abs });
      if (!pend.ok) return { ok: false, err: pend.err };
      try { fs.mkdirSync(path.dirname(b.abs), { recursive: true }); fs.copyFileSync(a.abs, b.abs, fs.constants.COPYFILE_EXCL); }
      catch (e) { return { ok: false, err: '复制失败：' + decode(String((e && e.message) || e)) }; }
      const mark = snapshots.markOp(sc.wsId, id, { action: 'copy', toRel: relB, after: { sha: snapshots.shaOf(b.abs), size: fs.statSync(b.abs).size } });
      if (!mark.ok) return { ok: false, err: mark.err };
      return { ok: true, out: '已复制：' + relA + ' → ' + relB, edit: { id, rel: relA, action: 'copy' } };
    },
  },
  remove: {
    desc: '删除工作区里的文件或整个文件夹（整体搬进回收站 .trash，可恢复）。删文件夹会连里面的东西一起搬，做之前先想清楚。参数：{ path }',
    caps: [ 'fs:write' ],
    async run({ path: p }, opts = {}) {
      if (!p) return { ok: false, err: '需要 path' };
      const sc = writeScope(opts);
      if (!sc.root) return { ok: false, err: '这个会话没有工作区，不能删文件' };
      if (!sc.wsId) return { ok: false, err: '缺少工作会话 id，不能改（无法记快照）' };
      if (String(p).includes('.trash')) return { ok: false, err: '回收站里的东西不用再删' };
      const chk = fsguard.checkWrite(p, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: false });
      if (!chk.ok) return { ok: false, err: chk.err };
      const abs = chk.abs;
      if (!fs.existsSync(abs)) return { ok: false, err: '要删的不存在：' + p };
      const st = fs.statSync(abs);
      const isDir = st.isDirectory();
      if (isDir) {
        if (path.resolve(abs) === path.resolve(sc.root)) return { ok: false, err: '不能删工作区根本身' };
        const bad = subtreeDenied(sc, abs);
        if (bad) return { ok: false, err: '这个目录里有不该动的东西（' + bad + '），不能整棵删' };
      }
      const rel = path.relative(sc.root, abs).split(path.sep).join('/');
      const trashDir = path.join(sc.root, '.trash');
      const trashName = Date.now().toString(36) + '-' + path.basename(abs);
      const trashAbs = path.join(trashDir, trashName);
      const shaBefore = snapshots.shaOf(abs);
      const tchk = fsguard.checkWrite(trashDir, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!tchk.ok) return { ok: false, err: '回收站不可用：' + tchk.err };
      if (fs.existsSync(trashDir)) {
        const ts = fs.lstatSync(trashDir);
        if (ts.isSymbolicLink() || !ts.isDirectory()) return { ok: false, err: '回收站 .trash 不是普通目录（可能是链接），拒绝往里搬' };
      }
      const t2 = fsguard.checkWrite(trashAbs, { base: sc.base, root: sc.root, denyAbs: sc.deny, allowCreate: true });
      if (!t2.ok || t2.abs !== trashAbs) return { ok: false, err: '回收站目标路径不安全：' + ((t2 && t2.err) || trashAbs) };
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const trashRel = path.relative(sc.root, trashAbs).split(path.sep).join('/');
      const pend = snapshots.recordPendingOp(sc.wsId, { id, rel, action: 'delete', trashRel, target: trashAbs });
      if (!pend.ok) return { ok: false, err: pend.err };
      try { fs.mkdirSync(trashDir, { recursive: true }); fs.renameSync(abs, trashAbs); }
      catch (e) { return { ok: false, err: '删除失败：' + decode(String((e && e.message) || e)) }; }
      const mark = snapshots.markOp(sc.wsId, id, { action: 'delete', kind: isDir ? 'dir' : 'file', trashRel, after: isDir ? { size: 0 } : { sha: shaBefore, size: st.size } });
      if (!mark.ok) return { ok: false, err: mark.err };
      return { ok: true, out: (isDir ? '整个文件夹' : '文件') + '已删到回收站：' + rel + '（能恢复）', edit: { id, rel, action: 'delete' } };
    },
  },
  search: {
    desc: '在工作区里搜文本（只读）。参数：{ pattern, path?, ext? }，返回 文件:行号: 内容',
    caps: [ 'fs:read' ],
    async run({ pattern, path: p, ext }, opts = {}) {
      const q = String(pattern || '');
      if (!q) return { ok: false, err: '需要 pattern' };
      const sc = readScope(opts);
      let base = sc.base;
      if (p) {
        const chk = fsguard.checkRead(p, { base: sc.base, roots: sc.roots, denyAbs: sc.deny });
        if (!chk.ok) return { ok: false, err: chk.err };
        base = chk.abs;
      }
      let re = null;
      try { re = new RegExp(q.includes('.*') || q.includes('[') ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      catch { return { ok: false, err: '正则写法有问题：' + q }; }
      const hits = [];
      const walk = (dir, depth) => {
        if (hits.length >= 40 || depth > 6) return;
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of ents) {
          if (hits.length >= 40) return;
          if (d.name === '.git' || d.name === 'node_modules' || d.name === '.trash') continue;
          const abs = path.join(dir, d.name);
          if (!loud(sc, abs)) continue;   // 禁读表 / 根外 / 链接：递归里同样要挡
          if (d.isDirectory()) { walk(abs, depth + 1); continue; }
          if (!d.isFile()) continue;
          if (ext && path.extname(d.name).toLowerCase() !== String(ext).toLowerCase()) continue;
          let st = null;
          try { st = fs.statSync(abs); } catch { continue; }
          if (st.size > 512 * 1024) continue;
          let text = '';
          try { text = decode(fs.readFileSync(abs)); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 40; i++) {
            if (re.test(lines[i])) hits.push(path.relative(sc.base || base, abs).split(path.sep).join('/') + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 160));
          }
        }
      };
      walk(base, 0);
      return { ok: true, out: hits.length ? hits.join('\n') : '没搜到：' + q };
    },
  },
  find: {
    desc: '按名字找文件（只读）。参数：{ pattern, path? }，pattern 里的 * 表示任意字符，如 "*.md"',
    caps: [ 'fs:read' ],
    async run({ pattern, path: p }, opts = {}) {
      const q = String(pattern || '');
      if (!q) return { ok: false, err: '需要 pattern' };
      const sc = readScope(opts);
      let base = sc.base;
      if (p) {
        const chk = fsguard.checkRead(p, { base: sc.base, roots: sc.roots, denyAbs: sc.deny });
        if (!chk.ok) return { ok: false, err: chk.err };
        base = chk.abs;
      }
      const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const out = [];
      const walk = (dir, depth) => {
        if (out.length >= 80 || depth > 6) return;
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of ents) {
          if (out.length >= 80) return;
          if (d.name === '.git' || d.name === 'node_modules' || d.name === '.trash') continue;
          const abs = path.join(dir, d.name);
          const rel = path.relative(sc.base || base, abs).split(path.sep).join('/');
          if (!loud(sc, abs)) continue;
          if (d.isDirectory()) { if (re.test(d.name)) out.push('[D] ' + rel); walk(abs, depth + 1); }
          else if (re.test(d.name)) out.push('[F] ' + rel);
        }
      };
      walk(base, 0);
      return { ok: true, out: out.length ? out.join('\n') : '没找到：' + q };
    },
  },
  run_cmd: {
    desc: '执行命令（默认只允许在工作区里跑）：参数 { cmd: string[], timeoutSec?: number }，如 ["npm","test"]。只能用白名单程序，参数里的路径必须在工作区里，需要人工审批。',
    caps: [ 'exec' ],
    async run({ cmd, timeoutSec }, opts = {}) {
      if (!Array.isArray(cmd) || !cmd.length) return { ok: false, err: 'cmd 必须是非空数组' };
      const argv = cmd.map(String);
      const root = opts.writeRoot || (Array.isArray(opts.roots) && opts.roots.length ? opts.roots[0] : '');
      const r = await exec.run(argv, {
        root,
        deny: Array.isArray(opts.deny) ? opts.deny : [],
        wsId: opts.wsId || '',
        mode: opts.execMode || 'workspace',
        allow: Array.isArray(opts.execAllow) ? opts.execAllow : undefined,
        timeoutMs: timeoutSec ? Math.round(Number(timeoutSec) * 1000) : (opts.execTimeoutMs || 60000),
        maxOutput: opts.execMaxOutput || 8000,
      });
      if (!r.ok) return { ok: false, err: r.err, out: r.out || '', killed: !!r.killed };
      return { ok: true, out: r.out || '（没有输出）', ms: r.ms, truncated: !!r.truncated };
    },
  },

  fetch_url: {
    desc: '只读抓一个网页/接口，返回纯文本：参数 { url: string, maxChars?: number }。只能 http/https，本机与内网地址默认拒绝；重定向最多 3 跳；只收文本类型。',
    caps: [ 'net' ],
    async run({ url, maxChars }, opts = {}) {
      const allowHosts = Array.isArray(opts.netAllowHosts) ? opts.netAllowHosts : [];
      const r = await net.fetchText(url, {
        allowHosts,
        maxBytes: opts.netMaxBytes || undefined,
        timeoutMs: opts.netTimeoutMs || undefined,
      });
      if (!r.ok) {
        const head = r.text ? '\n正文开头：\n' + r.text : '';
        return { ok: false, err: r.err, out: head };
      }
      const cap = Math.max(500, Math.min(20000, Number(maxChars) || 6000));
      const body = String(r.text || '').replace(/\n{3,}/g, '\n\n').trim();
      const cut = body.length > cap;
      return {
        ok: true,
        out: (cut ? body.slice(0, cap) + '\n…（后面还有 ' + (body.length - cap) + ' 字，觉得关键可以再抓一次换个 maxChars）' : body) || '（这一页没有文字内容）',
        status: r.status,
        url: r.url,
        bytes: r.bytes,
        truncated: r.truncated || cut,
      };
    },
  },

};

// 审批：高风险工具（run_cmd）默认要人工点头；PoC 用环境变量模拟"手机点了同意"
export function needsApproval(name) { return name === 'run_cmd'; }
export async function approve(name, args) {
  if (!needsApproval(name)) return true;
  if (process.env.QQBOT_APPROVE === '1') return true;      // 已审批
  if (process.env.QQBOT_APPROVE === '0') return false;     // 拒绝
  return 'ASK';                                            // 交给界面/手机去问
}

// opts.approved=true：控制台已经点过同意，这一次直接放行（不用环境变量）
export async function call(name, args = {}, opts = {}) {
  const t = tools[name];
  if (!t) return { ok: false, err: '没有这个工具：' + name };
  const a = opts && opts.approved === true ? true : await approve(name, args);
  if (a === false) return { ok: false, err: '用户拒绝执行' };
  if (a === 'ASK') return { ok: false, err: '需要用户确认（还没接审批界面）', needApproval: true, tool: name, args };
  return await t.run(args, opts);
}
