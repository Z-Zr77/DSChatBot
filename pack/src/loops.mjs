// 「还没做完的事」——她答应过的、他要她做的，只有两种结局：做完，或者过期。
//
// 为什么单独一张表：记忆（memory.mjs）里的事实只会「越来越重要」，没有「已完成」。
// 于是"答应他明早换衣服拍照"升级成 core 之后永远挂着，两天后她还在拿这句当没办的事说。
// 这里把"未了之事"从事实里拆出来，给它生命周期：
//   open ──（做到/发出来了）──> done
//      └──（时间过了）──────> expired
//      └──（他说算了）──────> dropped
// 提示词里只给 open 的，且最多三条；done / expired 一律不再提。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
import { relDeadline } from './memory.mjs';

const DIR = path.join(PATHS.data, 'loops');
const FILE = uin => path.join(DIR, String(uin || 'unknown') + '.json');

export function load(uin) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(uin), 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch {}
  return { uin: String(uin || ''), items: [] };
}

export function save(uin, db) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE(uin), JSON.stringify(db, null, 1), 'utf8');
  } catch {}
  return db;
}

// 同一件事别记两遍：同 tag 或文字高度重合，就当成同一条（更新文字/截止时间）
function same(a, b) {
  if (a.tag && b.tag && a.tag === b.tag) return true;
  const x = String(a.text || ''), y = String(b.text || '');
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  let hit = 0;
  for (let i = 0; i + 2 <= y.length; i++) if (x.includes(y.slice(i, i + 2))) hit++;
  return hit / Math.max(1, y.length - 2) > 0.6;
}

// 记一条"未了之事"。kind: her_promise（答应的）| his_ask（他要的）
export function add(uin, { text, kind = 'her_promise', tag = '', dueAt = null, src = '' } = {}) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const db = load(uin);
  const now = Date.now();
  const cand = { text: t, kind, tag: String(tag || ''), dueAt: Number(dueAt) || null };
  const dup = db.items.find(it => it.status === 'open' && same(it, cand));
  if (dup) {
    // 同一件事已经在表上了：只数它被提过几次。
    // 千万不要用新句子覆盖旧文案——她每次"说好的明早"都带否认语气，
    // 覆盖之后这条待办就变成了她自己的推脱台词，下一轮再喂回模型，她接着推脱。
    dup.mentions = (dup.mentions || 1) + 1;
    dup.touchedAt = now;
    save(uin, db);
    return dup;
  }
  const rec = { id: 'l' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36), ...cand, at: now, status: 'open', closedAt: 0, evidence: '', src: String(src || '').slice(0, 40) };
  db.items.push(rec);
  save(uin, db);
  return rec;
}

// 到点没做就算过期；做完/过期超过 3 天就从表里清掉（留着只会一直挂着）
export function sweep(uin, now = Date.now()) {
  const db = load(uin);
  let changed = false;
  for (const it of db.items) {
    if (it.status !== 'open') continue;
    if (it.dueAt && now > it.dueAt) {
      it.status = 'expired';
      it.closedAt = now;
      it.evidence = '时间过了';
      changed = true;
    } else if (!it.dueAt && it.kind === 'her_promise' && now - (it.at || 0) > 24 * 3600e3) {
      // 她空口答应的、又没有时间的，晾一天就当没这回事；
      // 他想要的东西（his_ask）不算在内——那种"他一直想看看"可以一直等着。
      it.status = 'expired';
      it.closedAt = now;
      it.evidence = '晾了一天没人提';
      changed = true;
    }
  }
  const keep = db.items.filter(it => !(it.status !== 'open' && now - (it.closedAt || 0) > 3 * 86400e3));
  if (keep.length !== db.items.length) { db.items = keep; changed = true; }
  if (changed) save(uin, db);
  return db;
}

export function open(uin, now = Date.now()) {
  const db = sweep(uin, now);
  return db.items.filter(it => it.status === 'open')
    .sort((a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15));
}

// 做完/放弃了。tag 传了就按 tag 关（她真发了照片 → 所有"要照片"的事一起了结）
export function close(uin, { id = '', tag = '', evidence = '', how = 'done', at = 0 } = {}) {
  const db = load(uin);
  const now = at || Date.now();
  let n = 0;
  for (const it of db.items) {
    if (it.status !== 'open') continue;
    if (id ? it.id === id : (tag ? it.tag === tag : false)) {
      it.status = how === 'dropped' ? 'dropped' : 'done';
      it.closedAt = now;
      it.evidence = String(evidence || '').slice(0, 80);
      n++;
    }
  }
  if (n) save(uin, db);
  return n;
}

function leftText(dueAt, now) {
  if (!dueAt) return '';
  const m = Math.round((dueAt - now) / 60000);
  if (m <= 0) return '（已经过点了）';
  if (m < 60) return `（还有 ${m} 分钟）`;
  const h = Math.round(m / 60);
  if (h < 24) return `（还有 ${h} 小时）`;
  return `（还有 ${Math.round(h / 24)} 天）`;
}

// 提示词里的那一段。没有未了之事就返回空串，别塞个空标题。
export function render(uin, now = Date.now(), max = 3) {
  const items = open(uin, now).slice(0, max);
  if (!items.length) return '';
  const lines = items.map(it => {
    const who = it.kind === 'his_ask' ? '他让你做的' : '你自己答应的';
    const when = it.at ? new Date(it.at) : null;
    const at = when ? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '';
    return `- ${it.text}｜${who}${at ? '，' + at : ''}${leftText(it.dueAt, now) ? '，' + leftText(it.dueAt, now) : ''}`;
  });
  return [
    '【你手上还没做完的事】（做完就别再提了；已经不是"没做"的事，不许当成还没办来说）',
    ...lines,
  ].join('\n');
}

// ---- 从他/她的话里认出"一件事"（纯词表，不额外调模型） ----

// 他要她做的
const HIS_PHOTO = /(拍|照|自拍|整张|来张|发张)/;
const HIS_WANT = /(看看|发我|给我|一张|照片|自拍|全身|半身|看看你|拍我)/;
export function asksFrom(text, now = Date.now()) {
  const t = String(text || '');
  const out = [];
  if (HIS_PHOTO.test(t) && HIS_WANT.test(t)) {
    out.push({ text: '他让你拍张照给他', kind: 'his_ask', tag: 'photo', dueAt: now + 30 * 60e3, src: t.slice(0, 40) });
  }
  const w = relDeadline(t, now);
  const want = /(给我|帮我|替我|发我|给我做|带我去|买|写|画)/.test(t);
  if (w && want) out.push({ text: '他让你' + t.replace(/^[你他]/, '').slice(0, 40), kind: 'his_ask', tag: '', dueAt: w, src: t.slice(0, 40) });
  return out;
}

// 她答应的（"明早正经给你拍""回头给你带"）。
// 判据收紧：必须出现「给你/发你/帮你…」这种明确的给予对象。
// 只靠「明早 + 拍」会把她的否认句也算成承诺——"说好的明早，我记着呢""别催我"全都会记成新待办。
const PROMISE_TIME = /(明早|明天|明晚|后天|大后天|今晚|等会|一会儿|晚点|待会|回头|下次|改天|下周)/;
const PROMISE_DO = /(给你|发你|帮你|带你|弄给你|做给你|说给你|写给你|画给你|拍给你|带回来|讲给你)/;
export function promisesFrom(text, now = Date.now()) {
  const t = String(text || '');
  if (!PROMISE_TIME.test(t) || !PROMISE_DO.test(t)) return [];
  // "等下再说""一会聊"这种是打发人的口气，不是真事，别记
  if (/^(等下|一会儿)?(再)?(说|聊)/.test(t.replace(/\s/g, '')) && t.length < 8) return [];
  const due = relDeadline(t, now) || (now + 2 * 3600e3);
  const kind = /(拍|照)/.test(t) ? 'photo' : '';
  return [{ text: t.replace(/\s+/g, ' ').slice(0, 60), kind: 'her_promise', tag: kind, dueAt: due, src: t.slice(0, 40) }];
}

// 便捷封装：把他的原话/她的回复各记一笔
export function noteHisAsk(uin, text, now = Date.now()) {
  let n = 0;
  for (const it of asksFrom(text, now)) if (add(uin, it)) n++;
  return n;
}

export function noteHerPromise(uin, text, now = Date.now()) {
  let n = 0;
  for (const it of promisesFrom(text, now)) {
    // 同一类事已经有 open 的了，就别再叠一条：她一天里会反复提同一件事
    if (it.tag && open(uin, now).some(o => o.tag === it.tag)) continue;
    if (add(uin, it)) n++;
  }
  return n;
}
