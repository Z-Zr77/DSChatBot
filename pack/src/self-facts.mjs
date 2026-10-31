import fs from 'node:fs';
import path from 'node:path';
import * as PATHS from './paths.mjs';

const FILE = path.join(PATHS.DATA, 'self-facts.json');
const MAX_PER_DAY = 12;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { return { days: {} }; }
}
function save(o) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2)); } catch {}
}
// 从她自己的话里抽“既成事实”
const RULES = [
  [/洗完澡|洗完了|刚洗完|洗过了|冲了个澡/, '洗过澡了'],
  [/还没洗|没洗呢|懒得洗/, '还没洗澡'],
  [/吃完了|吃过了|刚吃完|先吃|在吃|啃完|干掉了/, '吃了东西'],
  [/没吃|还没吃|顾不上吃/, '还没吃饭'],
  [/买了两根|买了|刚买/, '买了东西'],
  [/写完|弄完了|交了|改完了|发过去了/, '稿子弄完了'],
  [/还差|没弄完|赶稿|在改/, '还在赶稿'],
  [/出门|下楼|在小区|到了|回家|回来了/, '出过门'],
  [/躺下|上床|准备睡|要睡了|关灯/, '准备睡了'],
  [/不困|还不想睡|睡不着/, '还不想睡'],
  [/做完饭|在做饭|正做饭/, '在做饭'],
  [/没做饭/, '没做饭'],
];
// 只认“我自己、已经发生、不是问句”的句子：
//  - 分句处理；出现「你/他/她」且不是以「我」开头 → 说的是别人，跳过
//  - 含问号/吗/呢/几/什么 或 要/准备/待会/等/如果/明天 → 疑问或将来，跳过
//  - 同一句同时命中互斥标签 → 有歧义，整句丢弃
const FUTURE = /(要(去|吃|洗|睡|出门|做)|准备|待会|等会|一会儿|马上|如果|要是|明天|后天|下次|晚点|等.{0,8}再|再.{0,4}(聊|说))/;
const ASK = /[?？]|吗|呢|是不是|有没有|几点|什么|哪/;
const OTHER = /(你|您|他|她|你们|他们|她们|别人|对方)/;
// 昨天/上次发生的事不属于"今天既成事实"：以前"我昨天吃完了面"会被记进今天的台账（复查 F15）
const PAST = /(昨天|前天|昨晚|前天晚上|上次|上周|前几天|之前|那时候|以前)/;
// 否定句不能反过来记成"做过"："我还没出门"曾被记成"出过门"
const NEG_OF = {
  '出过门': /(没|还没有|还没|不)(出门|出去|下楼)/,
  '买了东西': /(没买|不买|没买到)/,
  '准备睡了': /(还不睡|不想睡|不睡呢)/,
};

function clauses(text) {
  return String(text || '').split(/[。！!；;\n，,]/).map((x) => x.trim()).filter(Boolean);
}

export function extract(text) {
  const out = [];
  for (const c of clauses(text)) {
    if (ASK.test(c)) continue;
    if (FUTURE.test(c)) continue;
    if (PAST.test(c)) continue;
    if (OTHER.test(c) && !/^我/.test(c)) continue;
    const hit = [];
    for (const [re, tag] of RULES) {
      if (!re.test(c)) continue;
      if (NEG_OF[tag] && NEG_OF[tag].test(c)) continue;
      hit.push(tag);
    }
    if (!hit.length) continue;
    const pairs = [['洗过澡了', '还没洗澡'], ['吃了东西', '还没吃饭'], ['稿子弄完了', '还在赶稿'], ['在做饭', '没做饭']];
    if (pairs.some((p) => hit.includes(p[0]) && hit.includes(p[1]))) continue;
    for (const h of hit) if (!out.includes(h)) out.push(h);
  }
  return out;
}
export function add(tags) {
  if (!tags || !tags.length) return;
  const o = load();
  const d = today();
  o.days[d] = o.days[d] || [];
  const now = Date.now();
  for (const tag of tags) {
    const hit = o.days[d].find(x => x.tag === tag);
    if (hit) { hit.at = now; hit.n++; }
    else o.days[d].push({ tag, at: now, n: 1 });
  }
  // 互斥修正：洗过澡 > 还没洗澡；吃饭同理
  const fix = (a, b) => {
    const A = o.days[d].find(x => x.tag === a), B = o.days[d].find(x => x.tag === b);
    if (A && B) { (A.at >= B.at ? B : A).dead = true; }
  };
  fix('洗过澡了', '还没洗澡');
  fix('吃了东西', '还没吃饭');
  fix('稿子弄完了', '还在赶稿');
  fix('在做饭', '没做饭');
  o.days[d] = o.days[d].filter(x => !x.dead).slice(-MAX_PER_DAY);
  // 保留 30 天：今天用【今天的既成事实】，更早的用来算"这段时间"（长期记忆）
  const keys = Object.keys(o.days).sort().slice(-30);
  const nd = {}; for (const k of keys) nd[k] = o.days[k];
  o.days = nd;
  save(o);
}
const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
export function render(max = 8) {
  const o = load(); const d = today();
  const list = (o.days[d] || []).slice().sort((a, b) => a.at - b.at).slice(-max);
  if (!list.length) return '';
  // 别再写"不许推翻"：状态会随时间正常往前走（之前没洗 → 现在洗了），
  // 只是不能凭空跳变、也不能把计划说成已完成（复查 F15）。
  return '【你今天的既成事实（按时间排，后面的可以自然接上）】\n' + list.map(x => `- ${hhmm(x.at)} ${x.tag}`).join('\n');
}
export function tags() {
  const o = load(); const d = today();
  return (o.days[d] || []).map(x => x.tag);
}
// 这条事实是多久以前记的（毫秒）；没有就返回 Infinity。
// 用来区分"5 分钟前刚说还没洗"和"三小时前说还没洗，现在洗完回来很正常"。
export function ageOf(tag) {
  const o = load(); const d = today();
  const hit = (o.days[d] || []).find(x => x.tag === tag);
  return hit && Number.isFinite(hit.at) ? Math.max(0, Date.now() - hit.at) : Infinity;
}

// ---------- 长期：不只今天 ----------
// 半衰期 14 天：越久远的事权重越低，但不会被"7 天一到全清"。
// 目的：她能有连续的"我这段时间在忙什么/最近老在赶稿"，而不是每天从零开始。
const HALF_LIFE_DAYS = 14;
const LONG_WINDOW_DAYS = 45;
const LONG_MIN_W = 0.5;

function fmtDay(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function longTerm(now = Date.now(), max = 4) {
  const o = load(); const d = today();
  const agg = new Map();
  for (const [day, list] of Object.entries(o.days || {})) {
    if (day === d) continue;                     // 今天的单独渲染，不重复
    for (const it of list || []) {
      if (!it || !it.tag) continue;
      const ageD = Math.max(0, (now - Number(it.at || 0)) / 86400e3);
      if (ageD > LONG_WINDOW_DAYS) continue;
      const w = Math.pow(0.5, ageD / HALF_LIFE_DAYS) * Math.max(1, Number(it.n) || 1);
      const cur = agg.get(it.tag) || { w: 0, last: 0, days: new Set() };
      cur.w += w;
      cur.last = Math.max(cur.last, Number(it.at) || 0);
      cur.days.add(day);
      agg.set(it.tag, cur);
    }
  }
  return [...agg.entries()]
    .map(([tag, v]) => ({ tag, w: v.w, last: v.last, times: v.days.size }))
    .filter((x) => x.w >= LONG_MIN_W)
    .sort((a, b) => b.w - a.w)
    .slice(0, max);
}

export function renderLong(max = 4, now = Date.now()) {
  const list = longTerm(now, max);
  if (!list.length) return '';
  const lines = list.map((x) => {
    const ago = Math.max(1, Math.round((now - x.last) / 86400e3));
    return `- ${fmtDay(x.last)} ${x.tag}（${x.times > 1 ? `这段时间 ${x.times} 天有过` : `${ago} 天前`}）`;
  });
  return '【这段时间的你（不只今天，越久越淡）】\n' + lines.join('\n') +
    '\n这是你自己过去这些天做过的事，聊到"最近在忙什么"可以自然提，别当成今天的。';
}

export function reset() { save({ days: {} }); }
export const file = FILE;
