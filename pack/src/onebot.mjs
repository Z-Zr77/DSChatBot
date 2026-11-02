import { WebSocket as NodeWs } from 'ws';

// OneBot v11 连接参数：把"用哪个协议端、连哪个地址、带什么 token"收在一处。
//
// 为什么要单独一个文件：NapCat / SnowLuma / Lagrange 都是"会说话的 OneBot"，
// 差别只在地址和鉴权。桥接不该知道对面是谁，只该知道怎么连。
//
// SnowLuma 的 OneBot 默认在 ws://127.0.0.1:3001/，并且在 snowluma-data/config/onebot_*.json
// 里带 accessToken；NapCat 默认 3001 且一般不带 token。

export function wsUrlOf(setup, host = '127.0.0.1') {
  const o = (setup && setup.onebot) || {};
  const raw = String(o.wsUrl || '').trim();
  if (raw) {
    // 允许填 ws:// 或 ws://host:port/path；也允许只填 host:port
    if (/^wss?:\/\//i.test(raw)) return raw;
    return 'ws://' + raw.replace(/^\/+/, '');
  }
  const port = Number(o.wsPort || 3001);
  return 'ws://' + host + ':' + port;
}

export function wsHeadersOf(setup) {
  const token = String(((setup && setup.onebot) || {}).accessToken || '').trim();
  if (!token) return {};
  // OneBot v11 两种都有人用：Authorization: Bearer <token> 最常见，
  // 少部分实现只认 query 上的 access_token 或 X-Self-ID 头。
  return { Authorization: 'Bearer ' + token };
}

export function wsUrlWithToken(setup, host = '127.0.0.1') {
  const url = wsUrlOf(setup, host);
  const token = String(((setup && setup.onebot) || {}).accessToken || '').trim();
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('access_token', token);
    return u.toString();
  } catch {
    return url;
  }
}

// 连接用的 WebSocket：Node 自带的那个**不支持自定义请求头**，
// 而 SnowLuma 的 accessToken 只认 Authorization: Bearer（放 query 上握手能过，但调 API 会 401）。
// 所以这里统一用 ws 包，并包一层只有 addEventListener/send/close 的最小壳，
// 让调用方不用改代码。
export function openWs(url, headers = {}, opts = {}) {
  const raw = new NodeWs(url, { headers, handshakeTimeout: 15000, ...opts });
  const bag = new Map();
  const emit = (t, ev) => {
    for (const fn of bag.get(t) || []) { try { fn(ev); } catch {} }
  };
  raw.on('open', () => emit('open', {}));
  raw.on('message', (d) => emit('message', { data: Buffer.isBuffer(d) ? d.toString('utf8') : String(d) }));
  raw.on('close', (code) => emit('close', { code }));
  raw.on('error', (e) => emit('error', { message: (e && e.message) || String(e) }));
  return {
    addEventListener: (t, fn) => {
      const a = bag.get(t) || [];
      a.push(fn);
      bag.set(t, a);
    },
    send: (s) => { try { raw.send(s); } catch {} },
    close: () => { try { raw.close(); } catch {} },
    get readyState() { return raw.readyState; },
  };
}

// HTTP 接口（POST /send_private_msg 这类）用的头。
// SnowLuma 的 ws 和 http 是**两个不同的 accessToken**，所以分开取：
// 填了 onebot.httpToken 就用它，否则退回 accessToken（NapCat 一般两者相同）。
export function httpHeadersOf(setup) {
  const o = (setup && setup.onebot) || {};
  const token = String(o.httpToken || o.accessToken || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}
