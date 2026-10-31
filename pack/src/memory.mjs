// 类人记忆：强度 + 遗忘曲线 + 线索触发回忆
// 数据：memory/people/<uin>.json
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
import * as settings from './settings.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const DIR = PATHS.memoryPeople;
const HALF_LIFE = { core: Infinity, important: 30, fact: 45, trivia: 14 }; // 天后强度减半
export function setHalfLife(fact, trivia) {
  if (Number(fact) > 0) HALF_LIFE.fact = Number(fact);
  if (Number(trivia) > 0) HALF_LIFE.trivia = Number(trivia);
}

function safeUin(uin) { return typeof uin === 'string' && /^\d{5,12}$/.test(uin) ? uin : null; }
function fjson(uin) { const u = safeUin(uin); if (!u) throw new Error('invalid uin'); return path.join(DIR, u + '.json'); }
function fmd(uin) { const u = safeUin(uin); if (!u) throw new Error('invalid uin'); return path.join(DIR, u + '.md'); }
const today = () => new Date().toISOString().slice(0, 10);

function empty() { return { items: [] }; }

// 稳定 ID：以前记忆只有正文，改写/更正时对不上原来是哪一条，也无法表达"新条目替代了旧条目"（2026-10-29 复查 F13）。
function newId() { return 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

// 老数据没有 id/origin：补 id、标成 legacy（来源未确认，不能冒充"他亲口说的"），并保留原 src。
// 只在第一次补齐时回写一次，之后 id 就固定了。
function normalize(db) {
  let changed = false;
  for (const it of db.items || []) {
    if (!it) continue;
    if (!it.id) {
      let h = 5381;
      const t = String(it.text || '');
      for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
      it.id = 'legacy-' + h.toString(16);
      changed = true;
    }
    if (!it.origin) { it.origin = it.src ? 'chat' : 'legacy'; changed = true; }
  }
  return changed;
}

export function load(uin) {
  let raw;
  try { raw = fs.readFileSync(fjson(uin), 'utf8'); }
  catch (e) {
    // 文件不存在才是"老数据"；读不动就返回空，不改盘
    if (e && e.code === 'ENOENT') return migrate(uin);
    return empty();
  }
  try {
    const db = JSON.parse(raw);
    if (!Array.isArray(db.items)) throw new Error('bad shape');
    if (normalize(db)) save(uin, db);
    return db;
  } catch (e) {
    // 坏文件先留现场：只读一次不能把人家几年的记忆覆盖成空库（2026-10-29 复查 P1）
    quarantine(uin, e);
    return empty();
  }
}

function quarantine(uin, e) {
  try {
    const f = fjson(uin);
    const bad = f + '.corrupt-' + Date.now();
    fs.copyFileSync(f, bad);
    console.warn('[memory] 记忆文件解析失败，已另存 ' + path.basename(bad) + '：' + (e && e.message));
  } catch {}
}

// 旧版是 markdown 一行一条（- 2026-10-24：内容），首次访问时迁移
function migrate(uin) {
  const db = empty();
  try {
    const md = fs.readFileSync(fmd(uin), 'utf8');
    for (const line of md.split(/\r?\n/)) {
      const m = line.match(/^-\s*(\d{4}-\d{2}-\d{2})\s*[：:]\s*(.+)$/);
      if (m) db.items.push({ id: newId(), text: m[2].trim(), kind: 'fact', w: 1, created: m[1], last: m[1], hits: 0, origin: 'legacy' });
    }
  } catch {}
  save(uin, db);
  return db;
}

export function save(uin, db) {
  if (!validUin(uin)) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const f = fjson(uin);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, f);   // 先写临时文件再替换：写一半断电也不会留下半个 JSON
  } catch {}
}

const UIN_RE = /^[0-9]{5,12}$/;
export const validUin = (u) => UIN_RE.test(String(u || '').trim());

export function remember(uin, text, opts = {}) {
  if (!validUin(uin)) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const db = load(uin);
  const kind = opts.core ? 'core' : (opts.trivia ? 'trivia' : 'fact');
  const dup = db.items.find(i => i.text === t);
  if (dup) { touch(dup); save(uin, db); return false; }
  db.items.push({ id: newId(), text: t.slice(0, 200), kind, w: 1, created: today(), last: today(), hits: 0,
    anchor: opts.anchor || null, src: String(opts.src || '').slice(0, 120) || null, at: Date.now(),
    origin: opts.origin || 'chat' });
  save(uin, db);
  return true;
}

// 更正一条记忆：新条目记下 supersedes，旧条目记下 supersededBy 并标 stale（不删，能回看）。
// 以前更正只能"删旧的 + 记新的"，来源和理由全丢了，也判断不出新条目是不是模型自己编的。
export function correct(uin, oldText, newText, opts = {}) {
  if (!validUin(uin)) return null;
  const n = String(newText || '').trim().slice(0, 200);
  if (!n) return null;
  const db = load(uin);
  const key = String(oldText || '').trim();
  // 同一条事实常被 digest 记成好几种说法（"他下周有面试" / "他面试在下周"）。
  // 只作废第一条的话，剩下那条会继续在提示词里
  // 跟新说法打架（2026-10-31 真机抓到），所以凡是"包含这段原文"的活条目一起作废。
  const olds = key
    ? db.items.filter((i) => !i.stale && (i.text === key || i.text.includes(key) || key.includes(i.text)))
    : [];
  const old = olds[0] || null;
  const id = newId();
  const it = {
    id, text: n, kind: opts.kind || (old && old.kind) || 'fact', w: 1,
    created: today(), last: today(), hits: 0,
    anchor: opts.anchor || (old && old.anchor) || null,
    src: String(opts.src || '').slice(0, 120) || null, at: Date.now(),
    origin: opts.origin || 'chat',
    supersedes: olds.map((o) => o.id || o.text),
  };
  for (const o of olds) { o.supersededBy = id; o.stale = true; }
  db.items.push(it);
  save(uin, db);
  return id;
}

// 巩固：把高度相似的合并成一条，把很久没人提、又没命中的琐事标为 stale（不删，能回滚）
export function consolidate(uin) {
  const db = load(uin);
  const out = { merged: 0, stale: 0, total: db.items.length };
  const alive = db.items.filter((x) => !x.stale);
  const removed = new Set();
  for (let i = 0; i < alive.length; i++) {
    if (removed.has(alive[i])) continue;
    for (let j = i + 1; j < alive.length; j++) {
      if (removed.has(alive[j])) continue;
      const a = alive[i], b = alive[j];
      if (a.kind === 'core' || b.kind === 'core') continue;
      if (jac(a.text, b.text) < 0.6) continue;
      // 保留权重大的，把另一条并进去
      const main = (a.w || 1) >= (b.w || 1) ? a : b;
      const other = main === a ? b : a;
      if (!main.text.includes(other.text)) {
        main.text = (main.text + '；' + other.text).slice(0, 200);
        delete main.vec; delete main.vecSig; delete main.vecText;   // 合并后语义变了，向量要重算
      }
      main.w = Math.max(main.w || 1, other.w || 1);
      main.hits = (main.hits || 0) + (other.hits || 0);
      removed.add(other);
      out.merged++;
      // a 可能刚好被并掉了，后面的 j 不能再拿它去比
      if (removed.has(a)) break;
    }
  }
  const now = Date.now();
  for (const it of db.items) {
    if (removed.has(it)) continue;
    const ageDays = (now - Date.parse(it.last || it.created || Date.now())) / 86400000;
    if (it.kind === 'trivia' && !it.hits && ageDays > 30) { it.stale = true; out.stale++; }
  }
  db.items = db.items.filter((x) => !removed.has(x));
  save(uin, db);
  out.total = db.items.length;
  return out;
}
export function backfillAnchors(uin, place) {
  // 给缺 anchor 的老记忆补一个"不知道"，避免检索时误加权
  const db = load(uin);
  let n = 0;
  for (const it of db.items) if (!it.anchor) { it.anchor = { place: '', unknown: true }; n++; }
  save(uin, db);
  return n;
}

// 按关键词删（她自己在对话里说"这条不对"时用）
export function forgetByKeyword(uin, needle, allowCore = false) {
  const db = load(uin);
  const k = String(needle || '').trim();
  if (!k) return 0;
  const before = db.items.length;
  const B = grams(k);
  db.items = db.items.filter((it) => {
    if (!allowCore && it.kind === 'core') return true;
    if (it.text.includes(k)) return false;
    // 以前"共享 2 个二字片段"就删，导致「下周三有面试」连带删掉「妹妹下周三考试」。
    // 现在要求共享片段覆盖 needle 的一半以上、且 needle 至少 3 个片段才算同一条；
    // 太短的描述（"面试"这种 1 个片段）只做包含匹配，绝不按相似度删（2026-10-29 复查 P1）。
    if (B.size < 3) return true;
    const A = grams(it.text);
    let inter = 0;
    for (const x of B) if (A.has(x)) inter++;
    return inter / B.size < 0.6;
  });
  save(uin, db);
  return before - db.items.length;
}

// 按原文精确删
export function forgetByText(uin, text, allowCore = false) {
  const db = load(uin);
  const t = String(text || '').trim();
  if (!t) return 0;
  const before = db.items.length;
  db.items = db.items.filter((it) => (it.text === t && (allowCore || it.kind !== 'core') ? false : true));
  save(uin, db);
  return before - db.items.length;
}

export function forget(uin, index) {
  if (!validUin(uin)) return { items: [] };
  const db = load(uin);
  if (index >= 0 && index < db.items.length) db.items.splice(index, 1);
  save(uin, db);
  return db;
}

// 手动改一条：text / kind / w（基础权重，0.1–3）
export function update(uin, index, patch = {}) {
  if (!validUin(uin)) return false;
  const db = load(uin);
  const it = db.items[index];
  if (!it) return false;
  if (typeof patch.text === 'string' && patch.text.trim() && patch.text.trim() !== it.text) {
    it.text = patch.text.trim().slice(0, 200);
    // 正文改了，旧向量描述的是旧文本，必须重算（复查 F16）
    delete it.vec; delete it.vecSig; delete it.vecText;
  }
  if (patch.kind === 'core' || patch.kind === 'fact' || patch.kind === 'trivia') it.kind = patch.kind;
  if (patch.w !== undefined && patch.w !== null && patch.w !== '') {
    const w = Number(patch.w);
    if (Number.isFinite(w)) it.w = Math.min(3, Math.max(0.1, Math.round(w * 100) / 100));
  }
  if (patch.touch === true) it.last = today();
  save(uin, db);
  return true;
}

function touch(it) {
  it.last = today();
  it.hits = (it.hits || 0) + 1;
  if (it.kind !== 'core') it.w = Math.min(3, (it.w || 1) + 0.5);
  // 命中升档：被反复提起的事慢慢变成"重要""核心"
  const h = it.hits || 0;
  if (it.kind === 'trivia' && h >= 2) { it.kind = 'fact'; it.promotedAt = Date.now(); }
  if (it.kind === 'fact' && h >= 4) { it.kind = 'important'; it.promotedAt = Date.now(); }
  if (it.kind === 'important' && h >= 12) { it.kind = 'core'; it.promotedAt = Date.now(); }
}

// 强度：核心永久；其余按半衰期衰减
export function score(it, now = Date.now()) {
  if (it.kind === 'core') return 99;
  const from = Date.parse(it.last || it.created || today());
  const days = Number.isFinite(from) ? (now - from) / 86400000 : 0;
  const hl = HALF_LIFE[it.kind] || HALF_LIFE.fact;
  return (it.w || 1) * Math.pow(0.5, days / hl);
}

const STOP = new Set(['他说', '她说', '自己', '一个', '这个', '那个', '什么', '怎么', '因为', '所以',
  '但是', '然后', '就是', '不是', '没有', '可以', '我们', '你们', '他们', '现在', '时候', '觉得',
  '知道', '有点', '一点', '东西', '事情', '而且', '如果', '还是', '已经', '可能', '应该']);

function grams(text) {
  const out = new Set();
  const clean = String(text).replace(/[a-zA-Z0-9]+/g, ' ').replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const run of clean.split(/\s+/)) {
    if (!run) continue;
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return out;
}

function jac(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// 这段话里有没有提到这条记忆
function hit(it, msg) {
  if (!msg) return false;
  for (const g of grams(it.text)) if (msg.includes(g)) return true;
  return false;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function cos(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

export function render(uin, incoming = '', opts = {}) {
  const qvec = Array.isArray(opts.vec) ? opts.vec : null;
  const vsig = String(opts.vecSig || '');
  // 传了签名就只认同空间的向量；没传（老调用点）就按老行为，不做过滤
  const vecOk = (it) => Array.isArray(it.vec) && (!vsig || it.vecSig === vsig);
  const here = String(opts.place || '');
  const db = load(uin);
  if (!db.items.length) return { text: '', recalled: [], stats: { total: 0, stable: 0, faint: 0 } };
  const now = Date.now();
  const recalled = [];

  for (const it of db.items) {
    if (it.stale) continue;
    if (hit(it, incoming)) {
      const before = score(it, now);
      touch(it);
      if (before < 0.9 && it.kind !== 'core') recalled.push(it);
    }
  }
  // 语义召回（字面没提但意思相近）
  // 短中文句子的 embedding 基线普遍在 0.5 上下，单看绝对值会混进噪声，
  // 因此用「第一名 + 领先第二名」两个条件来判定。
  const SEM_HITS = [];
  if (qvec) {
    const cand = [];
    for (const it of db.items) {
      if (it.stale || !vecOk(it) || it.kind === 'core') continue;
      if (hit(it, incoming)) continue;
      cand.push({ it, c: cos(qvec, it.vec) });
    }
    cand.sort((a, b) => b.c - a.c);
    const top = cand[0], second = cand[1];
    if (top && top.c >= 0.60 && (!second || top.c - second.c >= 0.035)) {
      SEM_HITS.push(top);
      if (top.c >= 0.70 && second && top.c - second.c >= 0.06) SEM_HITS.push(second);
    }
  }

  save(uin, db);

  const live = db.items.filter(i => !i.stale);
  const core = live.filter(i => i.kind === 'core');
  const rest = live.filter(i => i.kind !== 'core')
    .map(i => {
      let s = score(i, now);
      if (qvec && vecOk(i)) {
        const c = cos(qvec, i.vec);
        s *= 0.7 + 0.6 * Math.max(0, c);   // 语义相近最多放大 1.3 倍
      }
      if (here && i.anchor && i.anchor.place && i.anchor.place === here) s *= 1.12;
      return { i, s };
    })
    .sort((a, b) => b.s - a.s);

  const stable = rest.filter(x => x.s >= 0.5).map(x => x.i);
  const faint = rest.filter(x => x.s >= 0.05 && x.s < 0.5).map(x => x.i);

  const parts = [];
  if (core.length || stable.length) {
    const lines = [...core, ...stable].map(i => `- ${i.text}`);
    parts.push('【你确定记得的】\n' + clip(lines.join('\n'), 2600));
  }
  if (faint.length) {
    const lines = faint.slice(0, 12).map(i => `- ${i.text}（有点模糊）`);
    parts.push('【印象已经淡了，别说得太确定】\n' + clip(lines.join('\n'), 700));
  }
  if (recalled.length) {
    const lines = recalled.slice(0, 6).map(i => `- ${i.text}`);
    parts.push('【对方刚提到这些，你想起来了】\n' + lines.join('\n'));
  } else if (SEM_HITS.length) {
    const lines = SEM_HITS.slice(0, 3).map(x => `- ${x.it.text}`);
    parts.push('【跟这次话题有关的旧事】\n' + lines.join('\n'));
  }
  return { text: parts.join('\n\n'), recalled, stats: { total: db.items.length, stable: core.length + stable.length, faint: faint.length } };
}

export function list(uin) {
  if (!safeUin(uin)) return [];
  const db = load(uin);
  const now = Date.now();
  return db.items.map((it, i) => ({ index: i, ...it, score: Math.round(score(it, now) * 100) / 100 }));
}


// ── 向量检索（embedding）────────────────────────────────────────────
// 说明：memory.mjs 本身不联网取配置，由调用方传入 { baseUrl, model, key }。
const QVEC_CACHE = new Map();
const KEY_ALI = () => {
  try { return fs.readFileSync(path.join(RQ, 'aliyun.key'), 'utf8').trim(); } catch { return ''; }
};
function embCfg(cfg = {}) {
  return {
    baseUrl: String(cfg.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    model: String(cfg.model || 'text-embedding-v3'),
    dim: Number(cfg.dim) || 512,
    key: String(cfg.key || KEY_ALI() || ''),
  };
}
export function embOn() { try { const s = settings.load(); return !(s.memory && s.memory.embed && s.memory.embed.on === false); } catch { return true; } }
export function embedReady(cfg = {}) { return !!embCfg(cfg).key; }

// 向量是有"坐标系"的：换模型、换维度、换服务端之后，旧向量和新向量根本不能比。
// 以前只记 vec 数组、不记它属于哪个空间，换了 embedding 模型就会拿两套坐标算余弦（复查 F16）。
function sigBase(cfg = {}) {
  const c = embCfg(cfg);
  const raw = `${c.baseUrl}|${c.model}|${c.dim}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(16) + '-' + c.dim;
}
export function vecSig(cfg = {}) { return sigBase(cfg); }

// 记忆正文的指纹：正文改了（或被重新合并）就必须重算向量
function textSig(t) {
  const s = String(t || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export async function embedText(text, cfg = {}) {
  const c = embCfg(cfg);
  if (!c.key) return null;
  const t = String(text || '').slice(0, 900);
  if (!t.trim()) return null;
  const ck = t + '|' + sigBase(cfg);
  const hit = QVEC_CACHE.get(ck);
  if (hit) return hit;
  try {
    const r = await fetch(c.baseUrl + '/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
      body: JSON.stringify({ model: c.model, input: t, dimensions: c.dim, encoding_format: 'float' }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    const v = j?.data?.[0]?.embedding;
    if (!Array.isArray(v)) { return null; }
    const rounded = v.map((x) => Math.round(x * 1000) / 1000);
    if (QVEC_CACHE.size > 300) QVEC_CACHE.clear();
    QVEC_CACHE.set(ck, rounded);
    return rounded;
  } catch {
    return null;
  }
}

// 给还没有向量的记忆补向量（每次最多 max 条，避免请求堆积）
export async function embedMissing(uin, cfg = {}, max = 8) {
  if (!safeUin(uin)) return { ok: false, done: 0 };
  if (!embedReady(cfg)) return { ok: false, done: 0, err: 'no key' };
  const db = load(uin);
  const sig = sigBase(cfg);
  const dim = embCfg(cfg).dim;
  // 只有"没有向量"或"向量维度不对"才需要真的去算；老向量只是缺签名的话就地补签名，
  // 否则每次都会从数组头部反复重算同一批老条目，真正缺向量的永远轮不到（2026-10-31 真机抓到）。
  const need = (x) => !x.stale && (!Array.isArray(x.vec) || x.vec.length !== dim);
  const todo = db.items.filter(need).slice(0, max);
  let done = 0;
  for (const it of todo) {
    const v = await embedText(it.text, cfg);
    if (v) { it.vec = v; it.vecAt = Date.now(); it.vecSig = sig; it.vecText = textSig(it.text); done++; }
  }
  let stamped = 0;
  for (const it of db.items) {
    if (!it || it.stale || !Array.isArray(it.vec)) continue;
    let changed = false;
    if (it.vecSig !== sig) { it.vecSig = sig; changed = true; }
    if (!it.vecText) { it.vecText = textSig(it.text); changed = true; }
    if (changed) stamped++;
  }
  if (done || stamped) {
    // 修复：只把新算出的向量按 id 合并进「最新」库，不用旧快照整表回写
    const fresh = load(uin);
    const got = new Map();
    const __key = (x) => String((x && (x.id || x.text)) || '');
    for (const it of db.items) { if (it && it.vec) { const k = __key(it); if (k) got.set(k, it); } }
    let applied = 0;
    for (const it of (fresh.items || [])) {
      const src = it ? got.get(__key(it)) : null;
      if (!src) continue;
      const same = Array.isArray(it.vec) && it.vecSig === src.vecSig && it.vecText === src.vecText;
      if (same) continue;
      it.vec = src.vec; it.vecAt = src.vecAt || Date.now(); it.vecSig = src.vecSig; it.vecText = src.vecText; applied++;
    }
    if (applied) save(uin, fresh);
  }
  return { ok: true, done, stamped, left: Math.max(0, db.items.filter((x) => !x.stale && (!Array.isArray(x.vec) || x.vec.length !== dim)).length - done) };
}

export function vecStats(uin) {
  if (!safeUin(uin)) return { total: 0, withVec: 0 };
  const db = load(uin);
  const live = db.items.filter((x) => !x.stale);
  return { total: live.length, withVec: live.filter((x) => Array.isArray(x.vec)).length };
}
