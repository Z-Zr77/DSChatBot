// fsguard.mjs — 文件工具的路径边界（读 / 写各一套）
//
// 说明（别当成绝对安全承诺）：
//   * 这里只保证"经过文件工具的路径"落在授权目录里；开了 exec 之后，子进程能碰哪由它自己决定。
//   * "最近存在的祖先 realpath + 逐段 lstat"能挡住 junction/符号链接指向外部、以及新建文件时父目录被换掉这两种常见逃逸；
//     但它不是文件系统锁，检查与真正打开之间仍有理论竞态（写路径用 wx 打开 + 打开后 fstat 复核来缩小）。
//   * 验收看行为：工作区外的文件没有被创建、修改、删除。
import fs from 'node:fs';
import path from 'node:path';

export function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function realOrResolve(p) {
  const abs = path.resolve(String(p || ''));
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

// 从目标往上找最近一个真实存在的祖先，返回它的 realpath（目标不存在时也能判定）
export function realAncestor(abs) {
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const st = fs.lstatSync(cur);
      const real = fs.realpathSync.native(cur);
      return { real, exact: cur === abs, st };
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return { real: cur, exact: false, st: null };
      cur = up;
    }
  }
  return { real: abs, exact: false, st: null };
}

function isLink(st) {
  return !!st && (st.isSymbolicLink() || (typeof st.isFile === 'function' && st.isSymbolicLink()));
}

// 逐段检查 root → parent 之间没有符号链接/junction（已存在的那部分）
export function noLinksOnPath(root, abs) {
  const rel = path.relative(root, path.dirname(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, err: '路径不在允许范围' };
  let cur = root;
  for (const seg of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, seg);
    try {
      const st = fs.lstatSync(cur);
      if (isLink(st)) return { ok: false, err: '路径里有符号链接/联接：' + cur };
    } catch {
      break; // 从这里开始还不存在，后面由 wx 打开保证
    }
  }
  return { ok: true };
}

// 禁读/禁改命中：同一路径、其子路径，以及它的备份/历史副本（config.json → config.json.bak / config.json.bak-20261029）
// 复查 R3：只禁主文件时，settings.save 生成的 .bak 仍可读。
export function denyHit(d, x) {
  const dl = path.resolve(String(d || '')).toLowerCase();
  const xl = path.resolve(String(x || '')).toLowerCase();
  if (!dl || !xl) return false;
  return xl === dl || xl.startsWith(dl + path.sep) || xl.startsWith(dl + '/') || xl.startsWith(dl + '.');
}

// ---- 读 ----
// roots: 允许读的目录（已 realpath）
// denyAbs: 禁止读的绝对路径（前缀匹配；含具体文件与目录）
export function checkRead(p, { base, roots = [], denyAbs = [] } = {}) {
  const abs = path.resolve(base || process.cwd(), String(p || ''));
  const anc = realAncestor(abs);
  const rootsReal = roots.map(realOrResolve);
  const hit = rootsReal.find((r) => isInside(r, anc.real));
  if (!hit) return { ok: false, err: '路径不在允许范围：' + abs };
  for (const d of denyAbs) if (denyHit(d, abs) || denyHit(d, anc.real)) return { ok: false, err: '这个位置不允许读：' + abs };
  if (anc.exact) {
    const real = fs.realpathSync.native(abs);
    if (!rootsReal.some((r) => isInside(r, real))) return { ok: false, err: '链接指向了授权目录之外：' + abs };
    for (const d of denyAbs) if (denyHit(d, real)) return { ok: false, err: '这个位置不允许读：' + abs };
  }
  return { ok: true, abs };
}

// ---- 写 ----
export function checkWrite(p, { base, root, denyAbs = [], allowCreate = true } = {}) {
  if (!root) return { ok: false, err: '没有可写的工作目录' };
  const rootReal = realOrResolve(root);
  const abs = path.resolve(base || rootReal, String(p || ''));
  const anc = realAncestor(abs);
  if (!isInside(rootReal, anc.real)) return { ok: false, err: '路径不在允许范围：' + abs };
  for (const d of denyAbs) if (denyHit(d, abs)) return { ok: false, err: '这个位置不允许改：' + abs };

  const seg = noLinksOnPath(rootReal, abs);
  if (!seg.ok) return seg;

  let exists = false;
  try {
    const st = fs.lstatSync(abs);
    exists = true;
    if (isLink(st)) return { ok: false, err: '目标是符号链接/联接，不写：' + abs };
    if (!st.isFile() && !st.isDirectory()) return { ok: false, err: '不是普通文件/目录：' + abs };
    // 复查 R5：硬链接不是符号链接，lstat/realpath 都看不出"还指着工作区外"；多链接文件直接不写
    if (st.isFile() && typeof st.nlink === 'number' && st.nlink > 1) return { ok: false, err: '这个文件有 ' + st.nlink + ' 个硬链接（可能同时指向工作区外），不写：' + abs };
  } catch { exists = false; }

  if (!exists && !allowCreate) return { ok: false, err: '目标不存在：' + abs };
  return { ok: true, abs, exists, root: rootReal };
}
