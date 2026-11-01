// 通道 = 她说话的几个出口。
//
// 她住在桥接进程里：有作息、有记忆、会犯困、会主动开口。QQ 只是出口之一，
// 出口堵了她照样活着——消息改走本地窗口，或者只写进她自己的日志。
//
// 所以这个模块只回答三个问题：
//   1. 现在有哪些出口？（list）
//   2. 这个出口通不通？（online / downSec）
//   3. 这句话该从哪个出口出去？（pick）
//
// 加一个平台（微信 / Telegram / 只留浏览器）= 在这里 register 一个通道，
// 不动她的作息、记忆、对话内核。以前 QQ 的状态散在 bridge.mjs 里十几处，
// 每接一个新平台就要改一遍，那是把"她"和"她的嘴"焊死了。

const REG = new Map();

export function register(ch) {
  if (!ch || !ch.id) throw new Error('channel needs id');
  const rec = {
    id: String(ch.id),
    label: String(ch.label || ch.id),
    online: !!ch.online,
    since: Number(ch.since) || 0,
    lastClose: 0,
    // 这个出口负责哪几种会话（private / group / local…）
    kinds: Array.isArray(ch.kinds) ? ch.kinds.map(String) : [],
    // 真正把东西发出去的那一步。投递层和决策层分开：这里不通，换一个出口。
    send: typeof ch.send === 'function' ? ch.send : null,
    // 这个出口上，"他"是谁 —— QQ 要用他的号，本地窗口固定是主人
    conv: typeof ch.conv === 'function' ? ch.conv : null,
    note: String(ch.note || ''),
  };
  REG.set(rec.id, rec);
  return rec;
}

export function get(id) { return REG.get(String(id)) || null; }

export function setOnline(id, on, now = Date.now()) {
  const c = REG.get(String(id));
  if (!c) return null;
  const next = !!on;
  if (next === c.online) return c;
  c.online = next;
  c.since = now;
  if (!next) c.lastClose = now;
  return c;
}

export function online(id) {
  const c = REG.get(String(id));
  return !!(c && c.online);
}

export function downSec(id, now = Date.now()) {
  const c = REG.get(String(id));
  if (!c || c.online) return 0;
  return c.since ? Math.max(0, Math.round((now - c.since) / 1000)) : 0;
}

export function list(now = Date.now()) {
  return [...REG.values()].map(c => ({
    id: c.id, label: c.label, online: c.online, since: c.since,
    lastClose: c.lastClose, downSec: c.online ? 0 : (c.since ? Math.max(0, Math.round((now - c.since) / 1000)) : 0),
    note: c.note,
  }));
}

// 从优先出口往下找第一个通的；都不通就返回 null（各调用点自己决定是攒着、还是只记日志）
export function pick(ids = [], now = Date.now()) {
  for (const id of ids) {
    const c = REG.get(String(id));
    if (c && c.online) return c;
  }
  return null;
}

// 这个出口上"跟他说话"该用哪个会话对象
export function convOn(ch, uin, fallbackUin = '') {
  if (ch && ch.conv) return ch.conv(uin);
  return { kind: 'local', id: String(fallbackUin || uin) };
}

// 这个会话归哪个出口管（private/group → QQ，local → 本地窗口）
export function forConv(conv) {
  const k = String((conv && conv.kind) || '');
  for (const c of REG.values()) if ((c.kinds || []).includes(k)) return c;
  return null;
}

// 投递：把一段东西交给它该去的出口。
// 注意这里只负责"交给谁"，不负责"发不出去怎么办"——那是调用点的事
// （给主人的私聊可以改走本地窗口，群消息不能，硬换出口比不发更糟）。
export async function dispatch(conv, payload) {
  const ch = forConv(conv);
  if (!ch) return { ok: false, err: '没有能送这句话的通道' };
  if (!ch.online) return { ok: false, err: ch.label + '这个入口没连上', channel: ch.id, offline: true };
  if (!ch.send) return { ok: false, err: ch.label + '这个通道还不会发东西', channel: ch.id };
  try {
    const r = await ch.send(conv, payload);
    return Object.assign({ channel: ch.id }, r || { ok: true });
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e), channel: ch.id };
  }
}

export function reset() { REG.clear(); }
