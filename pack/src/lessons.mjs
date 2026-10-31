// 经验库：把她"答得好的"片段存下来，下次同类场景当例子看。
// 灵感来自两处开源做法：
//   - Generative Agents（斯坦福小镇）的 reflection：经历压成摘要再回灌上下文；
//   - Voyager 的 skill library：把成功的做法存成可复用条目，失败的下次换法子。
// 这里不做向量库，只用"场景桶 + 字面相似 + 新旧"排序，够用且可解释、可测试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as PATHS from './paths.mjs';

const DIR = path.join(PATHS.DATA, 'agent-home', 'memory', 'lessons');
const MAX_ITEMS = 80;
const POS = /(哈哈|嘿嘿|笑死|可爱|好乖|喜欢|么么|抱抱|亲亲|亲一口|乖|摸摸|不错|很好|谢谢|开心|舒服|甜|暖|爱了|真好)/;
const NEG = /(烦|别说了|无聊|闭嘴|滚|不聊了|无语|讨厌|别烦我|没意思|走了)/;

function file(uin) {
  return path.join(DIR, String(uin).replace(/[^\dA-Za-z_-]/g, '') + '.json');
}
function load(uin) {
  try {
    const o = JSON.parse(fs.readFileSync(file(uin), 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(o)) return { items: o };
    return { items: Array.isArray(o.items) ? o.items : [] };
  } catch { return { items: [] }; }
}
function save(uin, o) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = file(uin) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, file(uin));
  } catch {}
}

// 场景桶：够粗就行，太细反而永远匹配不上
const BUCKETS = [
  ['comfort', /(累|难受|不开心|烦|哭|委屈|压力|崩溃|emo|头疼|不舒服)/],
  ['food', /(吃|饭|面|饿|馋|外卖|奶茶|夜宵|早餐|午饭|晚饭)/],
  ['photo', /(拍|照片|自拍|看看你|长什么样|图)/],
  ['night', /(睡|困|晚安|几点|熬夜|醒|起床)/],
  ['work', /(稿|工作|上班|加班|忙|学习|考试|面试)/],
  ['affection', /(想你了|想你|喜欢|抱|亲|爱|么么|陪)/],
  ['greet', /(在吗|早安|早上好|晚安|你好|嗨|hi|hello)/],
  ['tease', /(笨蛋|傻瓜|讨厌|坏|欺负|逗|哈哈)/],
];
export function bucket(text) {
  const s = String(text || '');
  for (const [name, re] of BUCKETS) if (re.test(s)) return name;
  return 'other';
}

export function signal(text) {
  const s = String(text || '');
  if (NEG.test(s)) return 'neg';
  if (POS.test(s)) return 'pos';
  return 'neutral';
}

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / Math.max(a.size, b.size);
}

function trim(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function newId() {
  return 'l' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

// reaction = 他刚发来的这句话（用来判好坏）；his = 她上次回答的那句话对应他说的话
// 正面信号 → 把"他说 + 她答"存成一条经验。
// 负面信号 → 把最近一条相似的回答扣分（说明那样答不行）。
export function note({ uin, his = '', mine = '', reaction = '', at = Date.now() } = {}) {
  const u = String(uin || '');
  if (!u || !mine) return null;
  const o = load(u);
  const sg = signal(reaction);
  if (sg !== 'pos' && sg !== 'neg') return null;
  // 只回了一个表情、一个"嗯"的，学不到东西——别把这种也存成经验
  const plain = String(mine).replace(/\[\[[\s\S]*?\]\]/g, '').replace(/[\s，。！？、,.!?~—-]/g, '');
  if (plain.length < 4) return null;
  if (!String(his || '').trim()) return null;

  if (sg === 'neg') {
    const key = bigrams(his);
    let best = null, bestK = 0.35;
    for (const it of o.items) {
      const k = overlap(key, bigrams(it.his)) + overlap(bigrams(mine), bigrams(it.mine)) * 0.5;
      if (k > bestK) { bestK = k; best = it; }
    }
    if (best) { best.score = Math.max(0, (Number(best.score) || 1) - 1); save(u, o); }
    return null;
  }

  // 去重：同场景、回答高度相似就不再存
  const bk = bucket(his);
  const dup = o.items.find((it) => it.bucket === bk && overlap(bigrams(mine), bigrams(it.mine)) > 0.75);
  if (dup) { dup.score = Math.min(5, (Number(dup.score) || 1) + 1); dup.at = at; save(u, o); return dup; }

  const item = {
    id: newId(),
    at,
    bucket: bk,
    his: trim(his, 120),
    mine: trim(mine, 160),
    score: 1,
    used: 0,
    lastUsed: 0,
  };
  o.items.push(item);
  // 太多就留分数高、时间新的
  o.items.sort((a, b) => (b.score - a.score) || (b.at - a.at));
  o.items = o.items.slice(0, MAX_ITEMS);
  save(u, o);
  return item;
}

// 找 1-2 条最像的经验。只看同桶；字面差距太大就不给（宁可不参考，也别乱套）。
export function pick(uin, incoming, k = 2, now = Date.now()) {
  const o = load(uin);
  if (!o.items.length) return [];
  const bk = bucket(incoming);
  const key = bigrams(incoming);
  const scored = o.items.map((it) => {
    const same = it.bucket === bk ? 1 : 0;
    const sim = overlap(key, bigrams(it.his));
    const ageD = Math.max(0, (now - (it.at || 0)) / 86400e3);
    const fresh = Math.pow(0.5, ageD / 21);          // 21 天半衰
    const score = (Number(it.score) || 1);
    return { it, v: same * 0.6 + sim * 0.8 + fresh * 0.3 + Math.min(0.3, score * 0.06) };
  }).filter((x) => x.it.bucket === bk || x.v > 0.55)
    .sort((a, b) => b.v - a.v)
    .slice(0, k);
  if (!scored.length) return [];
  for (const x of scored) { x.it.used = (Number(x.it.used) || 0) + 1; x.it.lastUsed = now; }
  save(uin, o);
  return scored.map((x) => x.it);
}

export function render(uin, incoming, k = 2) {
  const list = pick(uin, incoming, k);
  if (!list.length) return '';
  const lines = list.map((it) => `- 他说：${it.his}\n  你这样答的：${it.mine}`);
  return '【他以前在类似场景里，你这样答他挺受用】（照着这个路子说，别一字不差，也别提“以前”）\n' + lines.join('\n');
}

export function stats(uin) {
  const o = load(uin);
  const by = {};
  for (const it of o.items) by[it.bucket] = (by[it.bucket] || 0) + 1;
  return { total: o.items.length, by };
}

export function list(uin) { return load(uin).items; }
export function remove(uin, id) {
  const db = load(uin);
  const before = db.items.length;
  db.items = db.items.filter((x) => String(x.id) !== String(id));
  save(uin, db);
  return before - db.items.length;
}
export function reset(uin) { save(uin, { items: [] }); }
export const dir = DIR;
export { file };
