// 她先开口的那场聊天：没说完就不能装没看见。
//
// 2026-11-01：她主动找他，聊到一半突然没下文（不回、标了跳过、困了直接睡、生成太慢把回复丢了）。
// pendingSince 只表示「这条招呼他还没回」，他一开口就被清掉，后面的沉默就没人管了。
// 这里单独记「这场是她开的、还没结束」：轮到她时不许静默；真要走，得说一句人话并留个回头的钩子。

export const OPEN_MS = 45 * 60 * 1000;
// 刚说完要走的这几分钟，他若立刻追一句，还算这场
export const LEAVE_GRACE_MS = 3 * 60 * 1000;

const LEAVE_RE = /睡了|去睡|先睡|困得|去忙|先忙|先撤|先走|先去|到点了|有事|忙完/;
const HOOK_RE = /回头|等下|晚点|待会|待会儿|回来|醒了再|接着|继续|再说|跟你说|跟你讲|这事先放/;

const LINES = {
  sleep: [
    '我先睡了，眼皮打架。你这句我醒了再接。',
    '撑不住了，先去睡。醒了跟你说。',
  ],
  busy: [
    '我先去忙一下，回头接着说。',
    '这会儿有事，先撤了。等下回来跟你讲。',
  ],
  life: [
    '我这边到点了，先去干我的事。回来再聊。',
    '手头的事撞上了，我先过去。这事先放着，回头说。',
  ],
};

function toMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function pick(pool, now) {
  const list = pool && pool.length ? pool : LINES.busy;
  const n = Math.abs(Math.floor(Number(now) / 1000)) || 0;
  return list[n % list.length];
}

export function openByHer(now) {
  const t = Number(now) || Date.now();
  return { by: 'her', open: true, at: t, lastTurnAt: t, owed: false, left: false, leftAt: 0 };
}

// 还在这场里：她开的头，没说再见，而且最后一句没隔太久
export function isLive(thread, now) {
  if (!thread || thread.by !== 'her' || thread.left || thread.open === false) return false;
  const last = Number(thread.lastTurnAt || thread.at || 0);
  if (!last) return false;
  if (Number(now) - last > OPEN_MS) return false;
  return true;
}

export function inLeaveGrace(thread, now) {
  if (!thread || !thread.left) return false;
  const leftAt = Number(thread.leftAt || 0);
  if (!leftAt) return false;
  return Number(now) - leftAt <= LEAVE_GRACE_MS;
}

// 轮到她说话：要么这场还开着，要么刚说要走、他立刻追了一句
export function mustAnswer(thread, now) {
  if (!thread || !thread.owed) return false;
  return isLive(thread, now) || inLeaveGrace(thread, now);
}

export function noteHim(thread, now) {
  if (!thread) return thread;
  const t = Number(now) || Date.now();
  if (isLive(thread, t) || inLeaveGrace(thread, t)) {
    return { ...thread, lastTurnAt: t, owed: true, open: true };
  }
  return { ...thread, open: false, owed: false };
}

export function noteHerReply(thread, now, opts = {}) {
  if (!thread) return thread;
  const t = Number(now) || Date.now();
  const leaving = !!opts.leaving;
  if (leaving) {
    return { ...thread, by: 'her', open: true, owed: false, left: true, leftAt: t, lastTurnAt: t };
  }
  const live = isLive(thread, t) || inLeaveGrace(thread, t) || !!thread.owed;
  if (!live) return { ...thread, open: false, owed: false };
  return { ...thread, open: true, owed: false, left: false, leftAt: 0, lastTurnAt: t };
}

// 她先开的这场还轮到她：回复计划里的「这次不回」作废
export function planSkip(plan, hold) {
  if (!plan) return { ms: 0, skip: false };
  if (!hold || !plan.skip) return plan;
  return { ms: plan.ms, skip: false };
}

export function looksLikeLeave(text) {
  const s = String(text || '');
  return LEAVE_RE.test(s) && HOOK_RE.test(s);
}

export function isVanish(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return true;
  return /^[.…。~～、,，!！?？\-—]+$/.test(s);
}

export function leaveLine(reason, now = Date.now(), detail = '') {
  const what = String(detail || '').trim().slice(0, 16);
  if ((reason === 'life' || reason === 'busy') && what) {
    return pick([
      `到点了，我先去${what}。回头再接着说。`,
      `我先去${what}，这事先放着。等下回来讲。`,
    ], now);
  }
  const key = reason === 'sleep' || reason === 'life' ? reason : 'busy';
  return pick(LINES[key], now);
}

// 已经在说要走、但没留钩子：补半句。空的就整句换掉。
export function withHook(text, reason = 'busy', now = Date.now(), detail = '') {
  const s = String(text || '').trim();
  if (!s || isVanish(s)) return leaveLine(reason, now, detail);
  if (looksLikeLeave(s)) return s;
  if (LEAVE_RE.test(s)) {
    const hook = reason === 'sleep' ? '醒了再接。' : '回头接着说。';
    return s.replace(/[。！!？?\s]+$/g, '') + '。' + hook;
  }
  return s + '\n' + leaveLine(reason, now, detail);
}

// 日程刚切到一件会把她拉开的事（睡觉 / 上课 / 出门…）。过了宽限就不当成「刚被打断」。
export function schedulePull(plan, hm, opts = {}) {
  const graceMin = Number.isFinite(opts.graceMin) ? opts.graceMin : 8;
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  const nowM = toMin(hm);
  if (!items.length || nowM == null) return null;
  let cur = null;
  for (const it of items) {
    if (!it || !it.at) continue;
    const at = toMin(it.at);
    if (at == null) continue;
    if (at <= nowM) cur = it;
  }
  if (!cur) return null;
  const delta = nowM - toMin(cur.at);
  if (!Number.isFinite(delta) || delta < 0 || delta > graceMin) return null;
  const blob = `${cur.what || ''} ${cur.place || ''}`;
  let reason = '';
  if (/睡|躺下|上床|关灯|被窝/.test(blob)) reason = 'sleep';
  else if (/上课|上班|开会|赶路|出门|洗澡|考试|通勤/.test(blob)) reason = 'busy';
  if (!reason) return null;
  return { reason, what: String(cur.what || '').slice(0, 24), at: String(cur.at || '') };
}

// 模型这轮会消失（空、省略号、跳过之后没正文）时，换成一句离开。
// 已经像人话的回复不动。sleep: 这句说完应该真的去睡（调用方决定，已经睡着就别重排）。
export function sealReply(text, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const why = ctx.why || { reason: 'busy', what: '' };
  const media = !!ctx.media;
  const t = String(text || '').trim();
  const sleepTagged = Number(ctx.sleepHours) > 0;
  if (sleepTagged && !looksLikeLeave(t)) {
    const base = isVanish(t) ? '' : t;
    return { text: withHook(base, 'sleep', now), leave: true, sleep: true, reason: 'sleep' };
  }
  if (!media && isVanish(t)) {
    const reason = why.reason === 'sleep' || why.reason === 'life' ? why.reason : 'busy';
    return { text: leaveLine(reason, now, why.what || ''), leave: true, sleep: reason === 'sleep', reason };
  }
  if (ctx.pinned && !looksLikeLeave(t)) {
    const reason = why.reason === 'sleep' || why.reason === 'life' ? why.reason : 'busy';
    return { text: String(ctx.pinned), leave: true, sleep: reason === 'sleep', reason };
  }
  return { text: t, leave: looksLikeLeave(t), sleep: false, reason: looksLikeLeave(t) ? (why.reason || '') : '' };
}
