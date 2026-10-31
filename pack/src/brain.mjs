// 大脑：OpenAI 兼容的 chat/completions 直连。
// 对外只暴露 ask(content, sessionId) → { ok, text, err }，和原来 dsh headless 的返回形状一致，
// 这样 bridge.mjs 里所有 `await askDsh(...)` 调用点一行都不用改。
import { loadSetup } from './paths.mjs';

export async function ask(content, _sessionId, opts = {}) {
  const s = loadSetup();
  if (!s.api.key) return { ok: false, text: '', err: 'no api key: 先在向导里填 API Key' };
  const base = String(s.api.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const sys = String(opts.system || '').trim();
  const msgs = [];
  if (sys) msgs.push({ role: 'system', content: sys });
  msgs.push({ role: 'user', content });
  const body = {
    model: s.api.model,
    messages: msgs,
    temperature: Number(s.api.temperature ?? 0.85),
    max_tokens: Number(s.api.maxTokens ?? 900),
    stream: false,
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.api.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch {}
    if (!r.ok) return { ok: false, text: '', err: `HTTP ${r.status}: ${txt.slice(0, 300)}` };
    const text = j?.choices?.[0]?.message?.content ?? '';
    if (!text) return { ok: false, text: '', err: 'empty completion: ' + txt.slice(0, 200) };
    return { ok: true, text, sid: null, usage: j?.usage || null };
  } catch (e) {
    return { ok: false, text: '', err: String(e?.message || e) };
  }
}

// 向导里的“测试连接”：用最小请求验证 key / 模型 / 地址能不能用
export async function testKey({ baseUrl, key, model }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }], max_tokens: 64, stream: false }),
      signal: AbortSignal.timeout(30000),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, err: `HTTP ${r.status}: ${txt.slice(0, 240)}` };
    const j = JSON.parse(txt);
    return { ok: true, model: j.model || model, sample: j.choices?.[0]?.message?.content?.slice(0, 40) || '' };
  } catch (e) {
    return { ok: false, err: String(e?.message || e) };
  }
}
