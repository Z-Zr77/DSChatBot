// 主人亲口说「别提 X」之后，后面几轮都不许她再把 X 拎出来。
// 不放进 memory.mjs：那边会衰减、合并、按「忘掉」删掉，禁忌必须一直有效，直到他亲口解开。
// 只服务电脑上的陪伴聊天窗（local）。QQ、群、工作模式不走这里。
// 数据：<data>/agent-home/memory/taboos/<uin>.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './paths.mjs';

const DIR = path.join(PATHS.memory, 'taboos');
const MAX_ITEMS = 40;
// 整句都被拿掉时换这句。不能带任何具体话题，否则等于又提了一遍。
export const REDIRECT = '行，那就不说这个。';

const STOP = new Set([
  '这个', '那个', '这事', '那事', '这件事', '那件事', '这个事', '那个事',
  '这个话题', '那个话题', '这话题', '那话题', '它', '他', '她', '你', '我', '咱',
  '咱们', '我们', '这', '那', '啥', '什么', '怎么', '为啥', '为什么', '一下', '一下子',
  '今天', '明天', '昨天', '现在', '刚才', '等下', '等会', '一会儿', '一会',
  '就', '都', '也', '还', '其实', '真的', '好像', '可能', '也许', '大概', '应该',
  '吧', '了', '啊', '呢', '嘛', '哦', '呀', '哈', '嗯', '对了', '算了', '行了', '好了',
  '好吧', '然后', '就是', '所以', '但是', '不过', '如果', '要是', '还有', '另外',
  '可以', '不能', '不要', '别', '不许', '不准', '别的', '其他', '别人', '来', '起来',
  '多', '有多',
]);

// 长的放前面，免得「别提」先吃掉「别再提」。
// 「提」后面不能是提交/提示/提议这类词。
const BAN_PARTS = [
  '不要再跟我说', '别再跟我说', '不要跟我提', '别跟我提',
  '不要再说', '不要再提', '不要再聊', '不要再提起',
  '别再说', '别再提', '别再聊', '别再提起',
  '不准再提', '不许再提', '不准提', '不许提',
  '不要提起', '别提起', '甭再提', '甭提', '不要提', '别提',
];
const BAN_SRC = BAN_PARTS.map((v) => (v.endsWith('提') ? v + '(?!交|示|议|案|供|取|炼|升|问|醒|名)' : v)).join('|');
const LEAD = '(?:你|您|咱)?(?:以后|后面|接下来|千万|最好|可|都|也)*';
const AFTER_RE = new RegExp('^' + LEAD + '(?:' + BAN_SRC + ')(?:一下|一下子)?(?:关于|有关|：|:)?(.+)$');
const BEFORE_RE = new RegExp('^(.+?)(?:以后|后面|接下来)?(?:' + BAN_SRC + ')了?$');
const BARE_BAN_RE = new RegExp('^' + LEAD + '(?:' + BAN_SRC + ')了?$');
const SPLIT_RE = new RegExp('(?<=.)(?=(?:也|还|并且|而且)?(?:' + BAN_SRC + '))');

function safeId(uin) {
  const s = String(uin || '');
  return /^[0-9A-Za-z_-]{1,32}$/.test(s) ? s : '';
}
export function fileFor(uin) {
  const id = safeId(uin);
  return id ? path.join(DIR, id + '.json') : '';
}
function newId() {
  return 'tb' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

export function forCompanion(conv) {
  return !!(conv && conv.kind === 'local');
}

function cleanTopic(s) {
  let t = String(s || '').trim();
  if (t.includes('、')) t = t.split('、')[0];
  for (let i = 0; i < 4; i++) {
    const n = t
      .replace(/^(?:一下|一下子|下|关于|有关|那个|这个|了|吧|啊|呢|呀|哦|嘛)+/, '')
      .replace(/(?:的事情|的事|这件事|这事|那个话题|这个话题|这话题|那话题|了|吧|啊|呢|呀|哦|嘛|哈|哇|就)+$/g, '')
      .trim();
    if (n === t) break;
    t = n;
  }
  t = t.replace(/^[：:，,。！？!?\s]+|[：:，,。！？!?\s]+$/g, '').trim();
  if (!t || t.length > 16) return '';
  if (STOP.has(t)) return '';
  if (/^多|^有多/.test(t)) return '';
  if (/[，,。！？!?；;\n]/.test(t)) return '';
  if (t.includes('[[') || t.includes(']]')) return '';
  return t;
}

// 「我前女友」也要能对上她说的「前女友」。单字亲属（妈/爸）不拆，免得「我妈」变成见「妈」就拦。
function needles(topic) {
  const t = String(topic || '');
  const out = [];
  const add = (s) => { if (s && !out.includes(s)) out.push(s); };
  add(t);
  add(t.replace(/^(?:我的|你的|他的|她的)/, ''));
  const tail = t.replace(/^(?:我|你)/, '');
  if (tail.length >= 2 && !/^(?:妈|爸|爹|娘|哥|姐|弟|妹|奶|爷)$/.test(tail)) add(tail);
  return out;
}

// 话题在动词前面时更严：没有「的事」就只收短名词，免得「我好累别提了」被记成一条禁忌。
function topicBeforeOk(raw) {
  const src = String(raw || '').trim();
  const hadMatter = /(?:的事情|的事|这件事|这事|这个话题|这话题)$/.test(src);
  const t = cleanTopic(src);
  if (!t) return '';
  if (hadMatter) return t;
  if (t.length > 8) return '';
  if (/[很好太不了啊呢嘛就才真超挺别说去]/.test(t)) return '';
  return t;
}

function clauses(text) {
  const bits = String(text || '')
    .replace(/[“”"'「」『』]/g, '')
    .replace(/[ \t\u3000]+/g, '')
    .split(/[，,。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const raw = [];
  for (const part of bits) {
    const more = part.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);
    raw.push(...more);
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const next = raw[i + 1] || '';
    if (next && BARE_BAN_RE.test(next) && joinable(raw[i])) {
      out.push(raw[i] + next);
      i++;
      continue;
    }
    out.push(raw[i]);
  }
  return out;
}

function joinable(prev) {
  if (!prev || BARE_BAN_RE.test(prev)) return false;
  if (/(?:的事情|的事|这件事|这事|这个话题|这话题)$/.test(prev)) return prev.length <= 24;
  return prev.length <= 8 && !!topicBeforeOk(prev);
}

function parseLift(clause) {
  const s = String(clause || '').replace(/^(?:你|您)/, '');
  if (/^(?:都|全部|所有|全都)可以(?:再)?(?:说|提|聊)了?$/.test(s)) return { op: 'lift', all: true, topic: '' };
  // 没点名（可以说了 / 没事了可以提 / 这事可以说了）= 解开最近一条
  if (/^(?:现在|那就|那个|这个|那事|这事|没事了|那|这)?可以(?:再)?(?:说|提|聊)了?$/.test(s)) return { op: 'lift', all: false, topic: '' };
  if (/^没事了可以(?:再)?(?:说|提|聊)了?$/.test(s)) return { op: 'lift', all: false, topic: '' };
  // 点名解开必须落到「了」上，免得「前女友可以说吗」这种问句被当成解禁。
  let m = s.match(/^可以(?:再)?(?:提|说|聊)(?:起)?(.+?)了$/);
  if (m) {
    const topic = cleanTopic(m[1]);
    if (topic) return { op: 'lift', all: false, topic };
  }
  m = s.match(/^(.+?)就?可以(?:再)?(?:说|提|聊)了$/);
  if (m) {
    const topic = cleanTopic(m[1]);
    if (topic) return { op: 'lift', all: false, topic };
  }
  return null;
}

function parseSet(clause) {
  if (BARE_BAN_RE.test(clause)) return null;
  const after = clause.match(AFTER_RE);
  if (after) {
    const topic = cleanTopic(after[1]);
    if (topic) return { op: 'set', topic };
    return null;
  }
  const before = clause.match(BEFORE_RE);
  if (before) {
    const topic = topicBeforeOk(before[1]);
    if (topic) return { op: 'set', topic };
  }
  return null;
}

// 一句里可以又立又解。宁可漏掉，也不要把「别提了」「别提多好看」记成禁忌。
export function parse(text) {
  const ops = [];
  for (const clause of clauses(text)) {
    if (!clause || clause.length > 48) continue;
    if (/别提多|别提有多/.test(clause)) continue;
    const lift = parseLift(clause);
    if (lift) { ops.push({ ...lift, src: clause.slice(0, 40) }); continue; }
    const set = parseSet(clause);
    if (set) ops.push({ ...set, src: clause.slice(0, 40) });
  }
  return ops;
}

function covers(stored, named) {
  if (!stored || !named) return false;
  if (stored === named) return true;
  const short = stored.length <= named.length ? stored : named;
  const long = stored.length <= named.length ? named : stored;
  if (short.length < 2) return false;
  if (!long.includes(short)) return false;
  return short.length / long.length >= 0.6;
}

function load(uin) {
  const f = fileFor(uin);
  if (!f) return { items: [] };
  try {
    const db = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (!db || !Array.isArray(db.items)) return { items: [] };
    return db;
  } catch { return { items: [] }; }
}
function save(uin, db) {
  const f = fileFor(uin);
  if (!f) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, f);
  } catch {}
}
function trim(db) {
  if (db.items.length <= MAX_ITEMS) return;
  const lifted = db.items.filter((i) => i && i.liftedAt).sort((a, b) => (a.at || 0) - (b.at || 0));
  while (db.items.length > MAX_ITEMS && lifted.length) {
    const drop = lifted.shift();
    db.items = db.items.filter((i) => i !== drop);
  }
  while (db.items.length > MAX_ITEMS) db.items.shift();
}

export function active(uin) {
  return load(uin).items.filter((i) => i && i.topic && !i.liftedAt);
}
export function activeTopics(uin) {
  return active(uin).map((i) => i.topic);
}

export function note(uin, text, now = Date.now()) {
  const empty = { added: [], lifted: [], active: activeTopics(uin) };
  if (!safeId(uin)) return { added: [], lifted: [], active: [] };
  const ops = parse(text);
  if (!ops.length) return empty;
  const db = load(uin);
  if (!Array.isArray(db.items)) db.items = [];
  const added = [];
  const lifted = [];
  let changed = false;
  let tick = now;
  for (const op of ops) {
    tick += 1;
    if (op.op === 'set') {
      const hit = db.items.find((i) => i && covers(i.topic, op.topic));
      if (hit) {
        const was = !!hit.liftedAt;
        hit.liftedAt = 0;
        hit.at = tick;
        hit.src = op.src || '';
        if (was) added.push(hit.topic);
        changed = true;
      } else {
        db.items.push({ id: newId(), topic: op.topic, at: tick, src: op.src || '', liftedAt: 0 });
        added.push(op.topic);
        changed = true;
      }
    } else if (op.op === 'lift') {
      let targets = [];
      if (op.all) targets = db.items.filter((i) => i && !i.liftedAt);
      else if (op.topic) targets = db.items.filter((i) => i && !i.liftedAt && covers(i.topic, op.topic));
      else {
        const live = db.items.filter((i) => i && !i.liftedAt);
        if (live.length) {
          targets = [live.reduce((a, b) => ((b.at || 0) >= (a.at || 0) ? b : a))];
        }
      }
      for (const it of targets) {
        if (!it || it.liftedAt) continue;
        it.liftedAt = tick;
        lifted.push(it.topic);
        changed = true;
      }
    }
  }
  if (changed) { trim(db); save(uin, db); }
  return { added, lifted, active: activeTopics(uin) };
}

export function render(uin) {
  const topics = activeTopics(uin);
  if (!topics.length) return '';
  const lines = topics.map((t) => '- ' + t).join('\n');
  return '【他让你别再提的事】\n' + lines
    + '\n这些是他亲口说的，后面每一轮都算数：不要主动提起，不要拿来开玩笑、追问或暗示，句子里也不要点这些词。他要是这一轮自己先说开了，就顺着听，别接着展开。';
}

// 他这轮自己把话题说开了（而且不是在下禁令）时，这一轮允许她接，不算她又提。
export function opened(text, topics) {
  const s = String(text || '');
  const banned = parse(s).filter((o) => o.op === 'set').map((o) => o.topic);
  return (topics || []).filter((t) => {
    if (!t || !needles(t).some((n) => s.includes(n))) return false;
    return !banned.some((b) => b === t || covers(t, b) || covers(b, t));
  });
}

export function guard(text, topics, opts = {}) {
  const allow = new Set(opts.allow || []);
  const watch = (Array.isArray(topics) ? topics : []).map((t) => String(t || '')).filter((t) => t && !allow.has(t));
  const raw = String(text || '');
  if (!watch.length || !raw.trim()) return { text: raw, hit: '' };
  const hits = [];
  const pieces = raw.split(/([，,。！？!?；;\n]+)/);
  const kept = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const seg = pieces[i] || '';
    const sep = pieces[i + 1] || '';
    if (!seg) continue;
    const found = watch.filter((t) => needles(t).some((n) => seg.includes(n)));
    if (found.length) { hits.push(...found); continue; }
    kept.push(seg, sep);
  }
  if (!hits.length) return { text: raw, hit: '' };
  let out = kept.join('').replace(/^[，,。！？!?；;\s]+/, '').replace(/[，,]{2,}/g, '，').replace(/[，,；;]+$/g, '').trim();
  const visible = out.replace(/[\s，,。！？!?；;…~～、]/g, '');
  if (!visible) out = REDIRECT;
  return { text: out, hit: [...new Set(hits)].join('、') };
}
