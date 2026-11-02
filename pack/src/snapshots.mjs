// 写操作的快照与恢复。
// 术语（对应评审 m04193 第 4 条）：
//   A = 本次修改前的版本（用来回滚）
//   B = 她最后一次成功写入后的版本（哈希）
//   C = 执行恢复时磁盘上的现状
// 只有 C === B 才允许回滚；否则先报冲突，绝不覆盖（用户可能自己手改过）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as paths from './paths.mjs';

const ROOT = () => path.join(paths.PATHS.ledger, 'snapshots');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shaFile(f) {
  try { return sha(fs.readFileSync(f)); } catch { return ''; }
}
// 给 tools 用：算一个文件当前的哈希（移动/删除记录里存"移动前"的哈希）
export function shaOf(f) { return shaFile(f); }
function wsDir(wsId) { return path.join(ROOT(), String(wsId || 'unknown')); }
function indexPath(wsId) { return path.join(wsDir(wsId), 'index.json'); }
function ensure(wsId) { fs.mkdirSync(wsDir(wsId), { recursive: true }); }

export function loadIndex(wsId) {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(wsId), 'utf8'));
    return Array.isArray(j.items) ? j : { items: [] };
  } catch { return { items: [] }; }
}

function saveIndex(wsId, idx) {
  ensure(wsId);
  const f = indexPath(wsId);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, f);
}

// 先写"待执行"记录：索引写不进去就直接失败，绝不能先改了文件再记
function recordPending(wsId, rec) {
  const idx = loadIndex(wsId);
  idx.items.push({ at: Date.now(), before: null, after: null, status: 'pending', ...rec });
  if (idx.items.length > 200) idx.items = idx.items.slice(-200);
  saveIndex(wsId, idx);
  return { ok: true };
}

// 写入前调用：把磁盘现状存成 A 版本。文件不存在时记 before:null（表示"新建"）。
export function begin(wsId, absPath, relPath) {
  ensure(wsId);
  const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let before = null;
  if (fs.existsSync(absPath)) {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { ok: false, err: '不是普通文件，拒绝写入：' + relPath };
    if (st.size > 8 * 1024 * 1024) return { ok: false, err: '文件超过 8MB，本轮不写：' + relPath };
    const buf = fs.readFileSync(absPath);
    const dir = path.join(wsDir(wsId), id);
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, 'before');
    fs.writeFileSync(bak, buf);
    before = { sha: sha(buf), size: buf.length, backup: path.relative(wsDir(wsId), bak) };
  }
  try { recordPending(wsId, { id, rel: relPath, action: 'write', target: absPath }); }
  catch (e) { return { ok: false, err: '记不下这次改动的快照（' + String((e && e.message) || e) + '），为了不出现"改了却无法恢复"，这次没动文件' }; }
  return { ok: true, id, before };
}

// 写入成功后调用：记下 A→B 这一笔（含 B 的哈希，恢复时用来比 C）
export function commit(wsId, entry, absPath, relPath, action = 'write', extra = null) {
  let after = null;
  try {
    const buf = fs.readFileSync(absPath);
    after = { sha: sha(buf), size: buf.length };
  } catch { after = null; }
  const idx = loadIndex(wsId);
  const rec = {
    id: entry.id,
    rel: relPath,
    at: Date.now(),
    action,
    before: entry.before,
    after,
    status: 'done',
  };
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
  const at = idx.items.findIndex((x) => x.id === entry.id);
  if (at >= 0) idx.items[at] = { ...idx.items[at], ...rec, at: idx.items[at].at };
  else idx.items.push(rec);
  if (idx.items.length > 200) idx.items = idx.items.slice(-200);
  saveIndex(wsId, idx);
  return { ok: true, id: entry.id, after };
}

// 移动/删除这类"没写内容"的记录：直接记一笔（after 哈希取"移动前那个文件"的）
export function record(wsId, rec) {
  const idx = loadIndex(wsId);
  idx.items.push({ at: Date.now(), before: null, after: null, status: 'done', ...rec });
  if (idx.items.length > 200) idx.items = idx.items.slice(-200);
  saveIndex(wsId, idx);
  return { ok: true, id: rec.id };
}

// 目录类操作（mkdir/move/copy/remove）在动手之前先落一条 pending，出问题也查得到
export function recordPendingOp(wsId, rec) {
  try { recordPending(wsId, rec); return { ok: true }; }
  catch (e) { return { ok: false, err: '记不下这次操作的快照（' + String((e && e.message) || e) + '），这次没动' }; }
}

// 动作完成后把那条 pending 转成 done
export function markOp(wsId, id, extra = {}) {
  try {
    const idx = loadIndex(wsId);
    const at = idx.items.findIndex((x) => x.id === id);
    if (at < 0) return { ok: false, err: '找不到待执行记录 ' + id };
    idx.items[at] = { ...idx.items[at], ...extra, status: 'done', at: Date.now() };
    saveIndex(wsId, idx);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: '改动已经做了，但快照索引没写成功（' + String((e && e.message) || e) + '）：这条记录仍是 pending，别当成没改过' };
  }
}

export function list(wsId, n = 20) {
  const idx = loadIndex(wsId);
  return idx.items.slice(-n).reverse();
}

// 清理旧账本：删掉「最后一次改动早于 N 天」的会话目录。
// 只删撤销记录，不动任何工作区里的文件；返回 { removed, kept }。
export function prune(days = 30, now = Date.now()) {
  const root = ROOT();
  const cut = now - Math.max(1, Number(days) || 30) * 24 * 3600 * 1000;
  let removed = 0;
  let kept = 0;
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { removed: 0, kept: 0 }; }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      const items = (loadIndex(name).items || []);
      const newest = items.reduce((m, it) => Math.max(m, Number(it.at) || 0), 0);
      if (newest && newest >= cut) { kept++; continue; }
      if (!items.length) {
        const st = fs.statSync(dir);
        if ((st.mtimeMs || 0) >= cut) { kept++; continue; }
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return { removed, kept };
}

// 整个会话一次撤销：按时间倒序逐条 restore，遇到冲突就停下把原因报出来（不硬盖）
// 返回 { ok, done:[{rel,action,ok,err}], stoppedAt }
export function undoAll(wsId, root, limit = 200, opts = {}) {
  const idx0 = loadIndex(wsId);
  const reverted = new Set(idx0.items.filter((x) => x.action === 'revert' && x.revertOf).map((x) => x.revertOf));
  const alive = idx0.items.filter((x) => x.action !== 'revert' && !reverted.has(x.id));
  const todo = alive
    .slice(-limit)
    .reverse();
  const done = [];
  let stoppedAt = '';
  for (const it of todo) {
    const abs = path.join(String(root || ''), String(it.rel || '').split('/').join(path.sep));
    const r = restore(wsId, it.id, abs, { root, guard: opts.guard });
    done.push({ rel: it.rel, action: it.action, ok: !!r.ok, err: r.err || '', conflict: !!r.conflict });
    if (!r.ok) { stoppedAt = it.rel; break; }
  }
  const left = alive.length - done.filter((d) => d.ok).length;
  return { ok: !stoppedAt && left === 0, done, stoppedAt, remaining: left, total: alive.length };
}

// 恢复：C 必须等于 B
// opts.root 用来解析移动/删除记录里的相对路径（这两类不靠快照文件，靠"原位置还在不在"）
export function restore(wsId, id, absPath, opts = {}) {
  const idx = loadIndex(wsId);
  const it = idx.items.find((x) => x.id === id);
  if (!it) return { ok: false, err: '找不到这条编辑记录' };
  const root = String(opts.root || '');
  // 恢复也要过写守卫：哈希相同只能证明内容，不能证明这个路径还指向工作区里
  const guard = typeof opts.guard === 'function' ? opts.guard : null;
  const deny = (p, what) => {
    if (!guard) return null;
    let r;
    try { r = guard(p); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    if (r && r.ok !== false) return null;
    return { ok: false, err: '恢复被拒绝（' + what + '）：' + ((r && r.err) || '路径不安全') };
  };

  // —— 目录：撤销 = 空目录则删掉 ——
  if (it.action === 'mkdir') {
    const abs = absPath;
    const g = deny(abs, '目录');
    if (g) return g;
    try {
      if (!fs.existsSync(abs)) return { ok: false, err: '这个目录已经不在了' };
      if (fs.readdirSync(abs).length) return { ok: false, conflict: true, err: '目录里已经有东西了，不敢删，你自己看看' };
      fs.rmdirSync(abs);
    } catch (e) { return { ok: false, err: '撤销失败：' + String((e && e.message) || e) }; }
    markRevert(wsId, it, 'removed');
    return { ok: true, action: 'removed' };
  }

  // —— 删除：从回收站搬回原处 ——
  if (it.action === 'delete') {
    const trashAbs = path.join(root, it.trashRel || '');
    const g1 = deny(trashAbs, '回收站副本');
    if (g1) return g1;
    const g2 = deny(absPath, '回原位');
    if (g2) return g2;
    if (!fs.existsSync(trashAbs)) return { ok: false, err: '回收站里的副本不在了：' + (it.trashRel || '') };
    const stT = fs.lstatSync(trashAbs);
    const trashIsDir = stT.isDirectory();
    if (stT.isSymbolicLink()) return { ok: false, err: '回收站里那一份是链接，不往回搬' };
    if (!trashIsDir && !stT.isFile()) return { ok: false, err: '回收站里那一份既不是文件也不是文件夹，不往回搬' };
    const wantSha = (it.after && it.after.sha) || '';
    if (wantSha) {
      const cur = shaFile(trashAbs) || '';
      if (cur !== wantSha) return { ok: false, conflict: true, err: '回收站里的副本被改过，不往回搬', diskSha: cur.slice(0, 12), expectSha: wantSha.slice(0, 12) };
    }
    if (fs.existsSync(absPath)) return { ok: false, conflict: true, err: '原位置已经有新文件了，先挪走它再恢复' };
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.renameSync(trashAbs, absPath);
    } catch (e) { return { ok: false, err: '搬回来失败：' + String((e && e.message) || e) }; }
    markRevert(wsId, it, 'restored');
    return { ok: true, action: 'restored' };
  }

  // —— 移动：原地空着才搬回 ——
  if (it.action === 'move') {
    const toAbs = path.join(root, it.toRel || '');
    const g1 = deny(toAbs, '移动后的位置');
    if (g1) return g1;
    const g2 = deny(absPath, '原位置');
    if (g2) return g2;
    if (!fs.existsSync(toAbs)) return { ok: false, err: '移动后的文件不在了：' + (it.toRel || '') };
    if (fs.existsSync(absPath)) return { ok: false, conflict: true, err: '原位置已经有东西了，先挪走再恢复' };
    const cur = shaFile(toAbs);
    const b = (it.after && it.after.sha) || '';
    if (b && cur !== b) {
      return { ok: false, conflict: true, err: '移动后的文件又被改过，不直接搬回', diskSha: cur.slice(0, 12), expectSha: b.slice(0, 12) };
    }
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.renameSync(toAbs, absPath);
    } catch (e) { return { ok: false, err: '搬回来失败：' + String((e && e.message) || e) }; }
    markRevert(wsId, it, 'restored');
    return { ok: true, action: 'restored' };
  }

  // —— 复制：撤销 = 删掉那份副本（内容还是复制时的才删）——
  if (it.action === 'copy') {
    const toAbs = path.join(root, it.toRel || '');
    const g1 = deny(toAbs, '副本位置');
    if (g1) return g1;
    if (!fs.existsSync(toAbs)) return { ok: false, err: '副本已经不在了' };
    const cur = shaFile(toAbs);
    const b = (it.after && it.after.sha) || '';
    if (b && cur !== b) return { ok: false, conflict: true, err: '副本在你复制之后又被改过，不删', diskSha: cur.slice(0, 12), expectSha: b.slice(0, 12) };
    try { fs.rmSync(toAbs, { force: true }); } catch (e) { return { ok: false, err: '删副本失败：' + String((e && e.message) || e) }; }
    markRevert(wsId, it, 'removed');
    return { ok: true, action: 'removed' };
  }

  const g0 = deny(absPath, '要恢复的文件');
  if (g0) return g0;
  const cur = fs.existsSync(absPath) ? shaFile(absPath) : '';
  const b = (it.after && it.after.sha) || '';
  if (!b) return { ok: false, err: '这条记录没有写入后的哈希，无法安全恢复' };
  if (cur !== b) {
    return {
      ok: false,
      conflict: true,
      err: '磁盘上的内容在这之后又变过（可能你自己改过），不直接覆盖',
      diskSha: cur.slice(0, 12),
      expectSha: b.slice(0, 12),
    };
  }
  if (!it.before) {
    // 新建的文件：撤销 = 删掉；但只在内容仍是 B 时删
    fs.rmSync(absPath, { force: true });
  } else {
    const bak = path.join(wsDir(wsId), it.before.backup);
    if (!fs.existsSync(bak)) return { ok: false, err: '快照文件不在了：' + it.before.backup };
    const buf = fs.readFileSync(bak);
    if (sha(buf) !== it.before.sha) return { ok: false, err: '快照校验失败（文件被改动过）' };
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmp = absPath + '.qqbot-r-' + Date.now().toString(36) + '.tmp';
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, absPath); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  }
  markRevert(wsId, it, it.before ? 'restored' : 'removed');
  return { ok: true, action: it.before ? 'restored' : 'removed' };
}

function markRevert(wsId, it, action) {
  const idx2 = loadIndex(wsId);
  idx2.items.push({
    id: 'r' + Date.now().toString(36),
    rel: it.rel,
    at: Date.now(),
    action: 'revert',
    revertOf: it.id,
    before: null,
    after: it.before || null,
    note: action,
  });
  saveIndex(wsId, idx2);
}

