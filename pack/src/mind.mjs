// 会延续的「状态」：不是记忆，是情绪和精力的余温
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const DIR = path.join(RQ, 'state');
const clamp = (v) => Math.max(0, Math.min(100, v));
const H = 3600e3;

function file(uin) {
  return path.join(DIR, String(uin).replace(/[^\w-]/g, '_') + '.json');
}

function fresh() {
  const h = new Date().getHours();
  return {
    mood: 55 + Math.round(Math.random() * 15),
    energy: h >= 1 && h < 10 ? 25 + Math.round(Math.random() * 15) : 60 + Math.round(Math.random() * 20),
    affinity: 15,
    lastUserAt: 0,
    lastMineAt: 0,
    unansweredProactive: 0,
    asleepUntil: 0,      // 她自己说去睡，睡到什么时候由她定
    sleepHrs: 0,
    wakePending: false,  // 睡醒了还没打过招呼
    updated: Date.now(),
  };
}

// 时间是会稀释情绪的：隔久了，烦躁会散，精力会变
function decay(st) {
  const now = Date.now();
  const hrs = (now - (st.updated || now)) / H;
  if (hrs > 0.05) {
    st.mood = clamp(st.mood + (55 - st.mood) * Math.min(0.6, hrs / 8));
    const h = new Date().getHours();
    const asleep = (st.asleepUntil || 0) > now;      // 她自己说了去睡，就按睡着算
    const resting = asleep || (h >= 4 && h < 12);    // 这段时间按“休息”算（默认作息偏晚）
    st.energy = clamp(st.energy + (asleep ? 12 : resting ? 8 : -1.5) * Math.min(hrs, 6));
    if (!resting && st.energy < 55 && hrs > 1) {
      const woke = new Date(now - hrs * H).getHours();
      if (woke >= 4 && woke < 12) st.energy = clamp(58 + Math.random() * 14);
    }
    if (hrs > 24 && !st.lastUserAt) st.affinity = clamp(st.affinity - 1 * Math.floor(hrs / 24));
    st.updated = now;
  }
  return st;
}

export function load(uin) {
  try {
    const st = JSON.parse(fs.readFileSync(file(uin), 'utf8'));
    return decay({ ...fresh(), ...st });
  } catch {
    const st = fresh();
    save(uin, st);
    return st;
  }
}

export function save(uin, st) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    st.updated = Date.now();
    fs.writeFileSync(file(uin), JSON.stringify(st, null, 2), 'utf8');
  } catch {}
}

export function saveAll(uin, st) {
  save(uin, st);
}

// ---------- 睡觉：什么时候睡、睡多久，都由她自己说 ----------
// 以前代码里没有任何"她真的去睡了"的状态：困只表现为话变短，聊到天亮也照回。
// 现在她可以在回复末尾写 [[睡了: 6]]（6 = 打算睡几小时），之后就按睡着处理。
// 开发/测试开关：QQBOT_NO_SLEEP=1 或 config.dev.noSleep=true 时，她不会真的去睡（也不提困）
function noSleep() {
  if (process.env.QQBOT_NO_SLEEP === '1') return true;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(RQ, 'config.json'), 'utf8'));
    return !!(s && s.dev && s.dev.noSleep);
  } catch { return false; }
}

export { noSleep };

// 刚被叫醒的人不会再"睡一觉"：这时候她说要去睡，只是把刚才那觉睡完。
// 20 分钟内被吵醒过 → 这次最多睡 1.5 小时（否则就是每被吵一次就重排一整夜，永远睡不完）。
export function clampSleepAfterWake(st, hrs, now = Date.now()) {
  const want = Math.max(0.5, Math.min(12, Number(hrs) || 7));
  const woke = Number((st && st.wokeAt) || 0);
  if (woke && now - woke < 20 * 60e3) return { hrs: Math.min(want, 1.5), again: true };
  return { hrs: want, again: false };
}

export function goSleep(uin, hours) {
  if (noSleep()) return { hrs: 0, until: 0, skipped: true };
  const st = load(uin);
  const hrs = Math.max(0.5, Math.min(12, Number(hours) || 7));
  st.asleepUntil = Date.now() + hrs * H;
  st.sleepHrs = hrs;
  save(uin, st);
  return { hrs, until: st.asleepUntil };
}

export function isAsleep(uin) {
  if (noSleep()) return false;
  try {
    const st = load(uin);
    return (st.asleepUntil || 0) > Date.now();
  } catch { return false; }
}

export function asleepUntil(uin) {
  try { return load(uin).asleepUntil || 0; } catch { return 0; }
}

// 睡到点了：清掉睡眠、标"醒来还没招呼"
export function checkWake(uin) {
  const st = load(uin);
  if (!st.asleepUntil || Date.now() < st.asleepUntil) return null;
  st.asleepUntil = 0;
  st.wakePending = true;
  save(uin, st);
  return st;
}

// 取走"刚醒"标记（保证只招呼一次）
export function takeWake(uin) {
  const st = load(uin);
  if (!st.wakePending) return null;
  st.wakePending = false;
  st.sleepHrs = 0;
  save(uin, st);
  return st;
}

// 事件驱动地改状态
export function bump(st, ev) {
  const now = Date.now();
  switch (ev.type) {
    case 'user_msg': {
      const gap = st.lastUserAt ? now - st.lastUserAt : Infinity;
      st.mood = clamp(st.mood + (gap < 5 * 60e3 ? 4 : 2));
      st.energy = clamp(st.energy + 1);
      if (st.unansweredProactive > 0) {
        st.affinity = clamp(st.affinity + 4);
        st.mood = clamp(st.mood + 6);
        st.unansweredProactive = 0;
      }
      st.affinity = clamp(st.affinity + Math.max(0.3, 2 - Math.min(1.5, gap / 6e5)));
      st.lastUserAt = now;
      break;
    }
    case 'my_reply':
      st.lastMineAt = now;
      st.energy = clamp(st.energy - 1);
      break;
    case 'proactive':
      st.unansweredProactive = (st.unansweredProactive || 0) + 1;
      st.lastMineAt = now;
      if (st.unansweredProactive >= 3) {
        st.mood = clamp(st.mood - 6);
        st.affinity = clamp(st.affinity - 2);
      }
      break;
    case 'long_silence':
      st.mood = clamp(st.mood - 3);
      break;
  }
  return st;
}

const band = (v, a, b, c, d) => (v < a ? b : v < c ? d : v);

// 去结论化：只给事实，情绪交给模型自己读（不再写"心情 70/100"）
export function facts(st, ctx = {}) {
  const now = new Date();
  const hh = String(ctx.hhmm || (now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0')));
  const agoMin = st.lastUserAt ? Math.round((Date.now() - st.lastUserAt) / 60e3) : -1;
  const lines = [];
  lines.push('- 现在是 ' + hh + (ctx.weekday ? '（' + ctx.weekday + '）' : ''));
  if (ctx.place) lines.push('- 你在' + ctx.place);
  if (ctx.doing) lines.push('- 手上正在做：' + ctx.doing);
  if (ctx.meal) lines.push('- ' + ctx.meal);
  if (ctx.weather) lines.push('- 外面' + ctx.weather);
  if (agoMin < 0) lines.push('- 这是你第一次跟这个人说话');
  else if (agoMin < 3) lines.push('- 他刚刚还在跟你说话');
  else if (agoMin < 90) lines.push('- 他上一次说话是 ' + agoMin + ' 分钟前');
  else if (agoMin < 1440) lines.push('- 他上一次说话是 ' + Math.round(agoMin / 60) + ' 小时前');
  else lines.push('- 他上一次说话是 ' + Math.round(agoMin / 1440) + ' 天前');
  if (ctx.turnsToday) lines.push('- 今天你们已经来回说了 ' + ctx.turnsToday + ' 轮');
  if (st.unansweredProactive > 0) lines.push('- 你主动找过他 ' + st.unansweredProactive + ' 次，他没有回');
  // 只描述当前状态，不替她编具体经历（睡了几小时、"有件事没解决"都要有记录才算）
  if (st.energy < 22) lines.push('- 你现在很累，脑子发闷，想少说两句');
  if (st.mood < 28) lines.push('- 你现在心情很低，有点堵，不太想多聊');
  if (ctx.goals) lines.push(ctx.goals);
  return ['【你现在的事实处境】（这些是事实，不是情绪标签；怎么感觉由你自己判断）'].concat(lines).join('\n');
}

export function describe(st, uin) {
  const moodTxt = band(st.mood, 25, '很差，有点烦，不想应付', 45, '平淡，没什么劲儿', 70, '还行，懒得生气', '挺好，有点想说话');
  const enTxt = band(st.energy, 20, '几乎没电了，脑子转不动', 40, '有点困', 65, '正常', '精神很好');
  const afTxt = band(st.affinity, 20, '不熟，还在客气', 45, '聊过几次，熟了点', 70, '比较熟，说话随便', '很熟，可以损、可以发疯');
  const ago = st.lastUserAt ? Math.round((Date.now() - st.lastUserAt) / 60e3) : -1;
  const gapTxt = ago < 0 ? '第一次聊' : ago < 10 ? '刚刚还在聊' : ago < 120 ? `${ago} 分钟前聊过` : ago < 1440 ? `${Math.round(ago / 60)} 小时前聊过` : `大概 ${Math.round(ago / 1440)} 天没说话了`;
  const pending = st.unansweredProactive > 0 ? `\n- 你之前主动找过他 ${st.unansweredProactive} 次，他没回` : '';
  return [
    '【你此刻的状态】（不是设定，是你现在的真实感觉，会影响你说话的耐性和力气）',
    `- 心情：${Math.round(st.mood)}/100，${moodTxt}`,
    `- 精力：${Math.round(st.energy)}/100，${enTxt}`,
    `- 跟这个人：${Math.round(st.affinity)}/100，${afTxt}`,
    `- 上次说话：${gapTxt}${pending}`,
    st.energy < 25 ? '- 你现在困得厉害：句子短，反应慢，别硬撑着聊' : '',
    st.mood < 30 ? '- 你心情不好：话少、没什么耐心、不主动接梗' : '',
    st.unansweredProactive >= 2 ? '- 他老不回你：你现在有点赌气，别再巴结他' : '',
  ].filter(Boolean).join('\n');
}

// 内心反应的落盘，方便回头看她在想什么
const MIND_DIR = path.join(RQ, 'mind');
export function logInner(uin, text) {
  try {
    fs.mkdirSync(MIND_DIR, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fs.appendFileSync(path.join(MIND_DIR, `${uin}-${stamp}.md`), `- ${d.toTimeString().slice(0, 5)} ${text}\n`, 'utf8');
  } catch {}
}
