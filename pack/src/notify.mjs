// 手机推送：把一个通道抽象出来，UI 里配置，bridge 里调用
// channel: off | ntfy | wecom | dingtalk | bark
import * as settings from './settings.mjs';

function cfg() {
  try {
    const n = settings.load().notify || {};
    return {
      channel: String(n.channel || 'off'),
      url: String(n.url || ''),
      topic: String(n.topic || ''),
      when: String(n.when || 'local'), // local: 只有软件内消息；all: 全部；off
    };
  } catch { return { channel: 'off', url: '', topic: '', when: 'local' }; }
}

async function post(url, body, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 200) };
}

export function enabled() {
  const c = cfg();
  return c.channel && c.channel !== 'off';
}

export async function push(title, body) {
  const c = cfg();
  if (!c.channel || c.channel === 'off') return { ok: false, skip: 'off' };
  const t = String(title || '大肥鱼');
  const b = String(body || '').slice(0, 400);
  try {
    if (c.channel === 'ntfy') {
      const base = (c.url || 'https://ntfy.sh').replace(/\/+$/, '');
      const topic = c.topic || 'qqchat';
      if (!topic) return { ok: false, err: 'no topic' };
      return await post(base + '/' + encodeURIComponent(topic), b, {
        Title: encodeURIComponent(t), Tags: 'speech_balloon', Priority: 'default',
      });
    }
    if (c.channel === 'wecom' || c.channel === 'dingtalk') {
      if (!c.url) return { ok: false, err: 'no webhook url' };
      const content = t + '\n' + b;
      if (c.channel === 'wecom') return await post(c.url, { msgtype: 'text', text: { content } });
      return await post(c.url, { msgtype: 'text', text: { content } });
    }
    if (c.channel === 'bark') {
      const base = (c.url || 'https://api.day.app').replace(/\/+$/, '');
      const key = c.topic || '';
      const u = base + (key ? '/' + key : '') + '/' + encodeURIComponent(t) + '/' + encodeURIComponent(b);
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      return { ok: r.ok, status: r.status };
    }
    return { ok: false, err: 'unknown channel ' + c.channel };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}
