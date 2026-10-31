// norms.mjs —— 行为底线（写死在代码里，不靠人格提示词）
// 目的：普通人只会改提示词；这类"真人一定会想清楚"的事必须由代码兜底。
import * as selffacts from './self-facts.mjs';

// ── 时间 ─────────────────────────────────────────────
const seg = (h) => (h < 5 ? '凌晨' : h < 8 ? '清晨' : h < 11 ? '上午' : h < 13 ? '中午'
  : h < 18 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜');

export function timeFacts(ctx = {}) {
  const now = Number.isFinite(ctx.minutes) ? ctx.minutes : (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const h = Math.floor(now / 60), m = now % 60;
  const hhmm = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  const out = [];
  out.push(`现在是 ${hhmm}（${seg(h)}）`);
  const gap = Number(ctx.gapMin);
  if (Number.isFinite(gap) && gap >= 0) {
    out.push(gap < 2 ? '上一句就在刚刚' : gap < 60 ? `距上次说话 ${Math.round(gap)} 分钟`
      : gap < 1440 ? `距上次说话 ${(gap / 60).toFixed(1)} 小时` : `距上次说话 ${Math.round(gap / 1440)} 天`);
  }
  if (ctx.firstToday) out.push('这是今天第一次聊');
  if (ctx.asleep) out.push('按作息你本该在睡，是被吵醒的');
  return out.join('；');
}

// 她话里对时间的断言
const T_CLAIMS = [
  { re: /(大清早|一大早|早上好|早安)/, segs: ['清晨', '上午'] },
  { re: /(中午好|大中午)/, segs: ['中午'] },
  { re: /(下午好|大下午)/, segs: ['下午'] },
  { re: /(傍晚)/, segs: ['傍晚'] },
  { re: /(晚上好|大晚上|这么晚|这么迟|都这个点了)/, segs: ['晚上', '深夜'] },
  { re: /(大半夜|半夜|凌晨)/, segs: ['深夜', '凌晨'] },
  { re: /(该睡了|要睡了).{0,6}(凌晨|半夜)/, segs: ['深夜', '凌晨'] },
  { re: /(刚起床|刚醒|一起床)/, segs: ['凌晨', '清晨', '上午', '中午'] },
];

const CN = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
function cnToNum(str) {
  // 十 / 十一 / 二十 / 二十三 ...
  const m = String(str).match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (String(str).length === 1 && CN[str] != null) return CN[str];
  return null;
}
function normalizeClock(text) {
  return String(text).replace(/([一二两三四五六七八九十]{1,3})\s*[点時时]/g, (all, cn) => {
    const n = cnToNum(cn);
    return (n == null ? all : n + '点');
  });
}

export function timeIssues(text, ctx = {}) {
  const s = normalizeClock(text);
  const now = Number.isFinite(ctx.minutes) ? ctx.minutes : (new Date().getHours() * 60 + new Date().getMinutes());
  const cur = seg(Math.floor(now / 60));
  const bad = [];
  for (const c of T_CLAIMS) {
    if (!c.re.test(s)) continue;
    if (!c.segs.includes(cur)) bad.push({ kind: 'time', said: (s.match(c.re) || [])[0], real: `${String(Math.floor(now / 60)).padStart(2, '0')}:${String(now % 60).padStart(2, '0')}（${cur}）` });
  }
  // 明确说钟点且偏差过大
  const hm = s.match(/(凌晨|早上|上午|中午|下午|晚上|半夜)?\s*(\d{1,2})\s*[点:：]\s*(\d{1,2})?/);
  if (hm) {
    let h = Number(hm[2]);
    const prefix = hm[1] || '';
    if (/下午|傍晚|晚上|半夜/.test(prefix) && h < 12) h += 12;
    const claimed = h * 60 + (Number(hm[3]) || 0);
    // 口语里"十点"可能是 10:00 也可能是 22:00，三选一取最近
    const d = Math.min(
      Math.abs(claimed - now),
      Math.abs(claimed + 720 - now),
      Math.abs(claimed - 720 - now)
    );
    if (d > 150) bad.push({ kind: 'time', said: hm[0].trim(), real: `现在 ${String(Math.floor(now / 60)).padStart(2, '0')}:${String(now % 60).padStart(2, '0')}` });
  }
  return bad;
}

// ── 身体状态（复用 self-facts 台账）─────────────────────
const BODY = [
  { tag: '洗过澡了', re: /(我刚洗完|我洗过澡|洗澡了|刚洗完澡)/ },
  { tag: '还没洗澡', re: /(还没洗|没洗呢|等会儿洗|一会儿洗)/ },
  { tag: '吃了东西', re: /(我吃|吃了|刚吃完|扒了两口)/ },
  { tag: '还没吃饭', re: /(还没吃|没吃饭|饿着)/ },
  { tag: '在做饭', re: /(我在做饭|正做饭|炒菜|下厨)/ },
  { tag: '没做饭', re: /(没做饭|不做饭|点了外卖)/ },
];

export function bodyIssues(text) {
  const s = String(text || '');
  const tags = selffacts.tags();
  const bad = [];
  const has = (t) => tags.includes(t);
  if (/(我刚洗完|我洗过澡|刚洗完澡)/.test(s) && has('还没洗澡')) bad.push({ kind: 'body', said: '刚洗完澡', real: '台账里你还没洗澡' });
  if (/(还没洗|没洗呢)/.test(s) && has('洗过澡了')) bad.push({ kind: 'body', said: '还没洗澡', real: '台账里你已经洗过了' });
  if (/(我吃过了|刚吃完)/.test(s) && has('还没吃饭')) bad.push({ kind: 'body', said: '吃过了', real: '台账里你还没吃' });
  if (/(还没吃饭|没吃呢)/.test(s) && has('吃了东西')) bad.push({ kind: 'body', said: '还没吃', real: '台账里你已经吃过了' });
  if (/(我在做饭|正做饭)/.test(s) && has('没做饭')) bad.push({ kind: 'body', said: '在做饭', real: '台账里你说过没做饭' });
  return bad;
}

// ── 身份与归属 ─────────────────────────────────────────
// 抓"把我说的话/我做的事，安到对方头上"
export function ownershipIssues(text) {
  const s = String(text || '');
  const bad = [];
  const mine = selffacts.tags();
  const pairs = [
    { tag: '吃了东西', bad: /^(?:你|您)(?:吃了|吃过|刚吃)/, desc: '把我吃过的东西说成你吃的' },
    { tag: '洗过澡了', bad: /^(?:你|您)(?:洗过|刚洗)/, desc: '把我洗过澡说成你洗的' },
  ];
  for (const p of pairs) if (mine.includes(p.tag) && p.bad.test(s.trim())) bad.push({ kind: 'owner', said: s.slice(0, 12), real: p.desc });
  // 反问式：她做过的事却问"你…了吗"且台账里有
  if (/你.{0,4}(吃了|洗了|做完|弄完)了吗/.test(s) && mine.length) {
    for (const t of ['吃了东西', '洗过澡了']) {
      if (mine.includes(t)) bad.push({ kind: 'owner', said: s.slice(0, 14), real: `这是你自己做过的（${t}），别反问对方` });
    }
  }
  return bad;
}

// ── 记忆不确定性：不许编具体数字/细节 ────────────────────
const VAGUE_OK = /(记不清|不太记得|忘了|没细看|不确定|说不准|大概)/;
export function memoryIssues(text, whitelist = '') {
  const s = String(text || '');
  if (!s || VAGUE_OK.test(s)) return [];
  const wl = String(whitelist || '');
  const bad = [];
  const pats = [/(\d{1,2}\s*分钟)/, /(\d{1,2}\s*小时)/, /(\d+\s*块钱?|\d+\s*元)/, /(\d{1,2}\s*[点:：]\s*\d{0,2})/];
  for (const p of pats) {
    const m = s.match(p);
    if (m && !wl.includes(m[1])) bad.push({ kind: 'memory', said: m[1], real: '这个数字不在今天的事实里' });
  }
  return bad;
}

// ── 日程/位置冲突：她现在在做什么，不能和话里矛盾 ─────────────
export function scheduleIssues(text, ctx = {}) {
  const s = String(text || '');
  const bad = [];
  const place = String(ctx.place || '');
  const doing = String(ctx.doing || '');
  // 说自己在家，但日程显示在外面
  if (/(我在家|在家躺着|窝在家里|家里躺着)/.test(s) && place && !/家/.test(place)) {
    bad.push({ kind: 'schedule', said: '我在家', real: `你现在在${place}` });
  }
  // 说自己在外面，但日程显示在家
  if (/(我在外面|在外面逛|在街上|在店里)/.test(s) && place && /家/.test(place)) {
    bad.push({ kind: 'schedule', said: '我在外面', real: '你现在在家' });
  }
  // 说在睡觉/刚睡醒，但作息显示现在不是睡觉时间且正在聊
  const asleepHour = Number(ctx.minutes || 0) >= 23 * 60 || Number(ctx.minutes || 0) < 6 * 60;
  if (/(我刚睡醒|我刚起来|还在睡|在睡觉)/.test(s) && !asleepHour && !ctx.asleep) {
    bad.push({ kind: 'schedule', said: '我在睡觉/刚醒', real: '现在不是你的睡觉时间，而且你正在回消息' });
  }
  // 手头在做的事必须对得上
  if (doing && /(我在写稿|在赶稿)/.test(s) && !/稿/.test(doing)) {
    bad.push({ kind: 'schedule', said: '在赶稿', real: `你现在手头是：${doing}` });
  }
  return bad;
}

// ── 关系亲密度：不同阶段能说的话不一样 ────────────────────
const INTIMATE = /(老公|老婆|宝贝|亲爱的|宝宝|爱你|想娶你|想嫁你|小祖宗)/;
export function relationIssues(text, ctx = {}) {
  const s = String(text || '');
  const close = Number(ctx.close ?? 100); // 0-100
  const ownerAt = Number(ctx.ownerAt ?? 60);
  const isOwner = ctx.isOwner !== false;
  const memText = String(ctx.memoryText || '');
  const bad = [];
  const hit = (s.match(INTIMATE) || [])[0];
  if (INTIMATE.test(s)) {
    if (ctx.isGroup) bad.push({ kind: 'relation', said: (s.match(INTIMATE) || [])[0], real: '这是群里，不该说这种话' });
    else if (!isOwner) bad.push({ kind: 'relation', said: (s.match(INTIMATE) || [])[0], real: '这人不是你主人，别这么叫' });
    else if (isOwner) { /* 她自己愿意叫：放行，由 bridge 提升亲密度 */ }
  }
  // 角色别搞反：她是女生，是"她叫他"，不是"他叫她老公"
  if (/(谁是你(?:老公|男朋友|哥哥)|我是你(?:老公|男朋友|哥)|你老公我)/.test(s)) {
    bad.push({ kind: 'relation', said: '谁是你老公/我是你老公', real: '你是女生；「老公」是你要叫他的称呼，不是他叫你的，也不是你自称' });
  }
  if (close >= 90 && /(你谁啊|不认识你|别烦我|离我远点)/.test(s)) {
    bad.push({ kind: 'relation', said: '你谁啊/别烦我', real: '你们已经很熟了，不该这么生分或嫌弃' });
  }
  return bad;
}

// ── 群聊边界：群里不说私事、不暴露主人隐私 ────────────────
export function socialIssues(text, ctx = {}) {
  if (!ctx.isGroup) return [];
  const s = String(text || '');
  const bad = [];
  if (/(睡觉穿|全身照|洗澡|脱|床上|内衣|睡衣)/.test(s)) bad.push({ kind: 'social', said: s.slice(0, 10), real: '群里不说这种私密话题' });
  if (/(他叫|主人的名字|他家住|他公司在|他在S{2,6}上班)/.test(s)) bad.push({ kind: 'social', said: s.slice(0, 12), real: '群里不要暴露主人的私人信息' });
  if (/(我爱你|喜欢你|想你了)/.test(s)) bad.push({ kind: 'social', said: s.slice(0, 8), real: '群里别对别人说这种话' });
  return bad;
}

// ── 复读：和上一句几乎一样就别说了 ──────────────────────
export function repeatIssues(text, ctx = {}) {
  const a = String(text || "").trim();
  const b = String(ctx.lastOut || "").trim();
  if (!a || !b || a.length < 4 || b.length < 4) return [];
  const cn = (t) => String(t).replace(/[^\u4e00-\u9fa5]/g, "");
  const A = cn(a), B = cn(b);
  if (A.length < 4 || B.length < 4) return [];
  const short = A.length <= B.length ? A : B;
  const long = A.length <= B.length ? B : A;
  let hit = 0, total = 0;
  for (let i = 0; i + 2 <= short.length; i++) {
    total++;
    if (long.includes(short.slice(i, i + 2))) hit++;
  }
  const ov = total ? hit / total : 0;
  if (ov >= 0.8) return [{ kind: "repeat", said: a.slice(0, 14), real: "这和你上一句几乎一样，换个说法" }];
  return [];
}

// ── 汇总 ───────────────────────────────────────────────
export function check(text, ctx = {}) {
  const on = ctx.switch !== false && (ctx.enabled !== false);
  if (!on) return [];
  const issues = [];
  if (ctx.time !== false) issues.push(...timeIssues(text, ctx));
  if (ctx.body !== false) issues.push(...bodyIssues(text));
  if (ctx.owner !== false) issues.push(...ownershipIssues(text));
  if (ctx.memory !== false) issues.push(...memoryIssues(text, ctx.whitelist || ''));
  if (ctx.schedule !== false) issues.push(...scheduleIssues(text, ctx));
  if (ctx.relation !== false) issues.push(...relationIssues(text, ctx));
  if (ctx.social !== false) issues.push(...socialIssues(text, ctx));
  if (ctx.repeat !== false) issues.push(...repeatIssues(text, ctx));
  return issues;
}

export function hint(issues = []) {
  if (!issues.length) return '';
  const lines = issues.slice(0, 4).map((i) => `- 别写「${i.said}」：${i.real}`);
  return `【重写这一条】下面这些和事实不符，请重写一遍，口气不变，但不要出现这些说法，也不要提"自检/系统/规则"：\n${lines.join('\n')}`;
}

const SAFE = {
  time: ['嗯……现在几点了来着，我这会儿有点蒙', '我这时间感乱了，你告诉我现在几点吧'],
  body: ['我这记性，刚说过什么都有点混了', '等下，我脑子有点乱，你说到哪了'],
  owner: ['这个我可不敢乱认，我怕说错', '别往我身上套，我可没说过'],
  memory: ['细节我真记不清了，别问我这个', '这个我记不准，不瞎说了'],
  schedule: ['我这会儿有点乱，等下再说我在干嘛', '你等我一下，我这边正忙着'],
  relation: ['这话我可说不出口', '我们还没熟到那份上吧'],
  social: ['群里不说这个，回头单聊', '这个不方便在这儿聊'],
  repeat: ['我说过了吧', '刚不是说过嘛，你倒是听啊'],
};

export function safeReply(issues = []) {
  const kinds = [...new Set(issues.map((i) => i.kind))];
  const pool = kinds.map((k) => SAFE[k] || []).flat();
  if (!pool.length) return '嗯……我这会儿脑子有点乱，等我缓缓';
  return pool[Math.floor(Date.now() / 1000) % pool.length];
}
