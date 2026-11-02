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
  // 真多轮：history 是 [{role:'user'|'assistant', content}]，让她"顺着聊"而不是每轮答一份文档
  if (Array.isArray(opts.history)) {
    for (const m of opts.history) {
      if (!m || !m.content) continue;
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
    }
  }
  msgs.push({ role: 'user', content });
  const body = {
    model: s.api.model,
    messages: msgs,
    temperature: Number(s.api.temperature ?? 0.85),
    max_tokens: Number(s.api.maxTokens ?? 900),
    // 让她别老用同一批词（"行吧""还行""确实"）—— repetition 惩罚比加形容词有效
    frequency_penalty: Number(s.api.frequencyPenalty ?? 0.3),
    stream: false,
  };
  async function once(bd) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.api.key}` },
      body: JSON.stringify(bd),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch {}
    return { status: r.status, ok: r.ok, txt, j, text: j?.choices?.[0]?.message?.content ?? '', fin: j?.choices?.[0]?.finish_reason || '' };
  }

  try {
    const a = await once(body);
    if (!a.ok) return { ok: false, text: '', err: `HTTP ${a.status}: ${a.txt.slice(0, 300)}` };
    if (a.text) return { ok: true, text: a.text, sid: null, usage: a.j?.usage || null };

    // 空回复：最常见是 max_tokens 被"思考"吃光（finish_reason=length）。
    // 以前这里直接判失败，她的回复就凭空消失了——用户只看到"她不理我"。
    // 现在加一次更大的预算重试；还是空，才如实报错。
    const bigger = Math.max(1600, Number(body.max_tokens || 900) * 2);
    const b = await once({ ...body, max_tokens: bigger });
    if (b.ok && b.text) return { ok: true, text: b.text, sid: null, usage: b.j?.usage || null, retried: true };
    return {
      ok: false, text: '',
      err: `empty completion (finish=${a.fin || '?'}, 重试后仍空): ` + a.txt.slice(0, 200),
    };
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
