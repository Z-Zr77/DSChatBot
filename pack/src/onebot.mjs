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
