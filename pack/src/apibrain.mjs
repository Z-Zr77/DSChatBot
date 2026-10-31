// 直连 OpenAI 兼容接口的“大脑”。
// 存在 api.json 且 enabled 时，桥接改用这里；否则仍走 dsh headless。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// 测试用 QQBOT_API_FILE 指到临时目录，避免并行/中断时污染开发目录
export const FILE = process.env.QQBOT_API_FILE ? path.resolve(process.env.QQBOT_API_FILE) : path.join(HERE, 'api.json');

export function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || !j.baseUrl || !j.model) return null;
    return j;
  } catch { return null; }
}

export function save(cfg) {
  const cur = load() || {};
  const next = {
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : (cur.enabled !== false),
    baseUrl: String(cfg.baseUrl !== undefined ? cfg.baseUrl : cur.baseUrl || '').trim(),
    model: String(cfg.model !== undefined ? cfg.model : cur.model || '').trim(),
    key: cfg.key ? String(cfg.key).trim() : (cur.key || ''),
    maxTokens: Number(cfg.maxTokens || cur.maxTokens || 800),
    temperature: Number(cfg.temperature || cur.temperature || 0.9),
  };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function mask(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 10 ? k.slice(0, 3) + '…' : k.slice(0, 6) + '…' + k.slice(-4);
}

function url(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions';
}

// 返回 { ok, text, err, usage }
export async function chat({ baseUrl, model, key, system, user, maxTokens, temperature, timeoutMs = 60000 }) {
  if (!baseUrl || !model || !key) return { ok: false, text: '', err: '没有配置 key/model/baseUrl' };
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  try {
    const r = await fetch(url(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens || 800, temperature: temperature ?? 0.9 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, text: '', err: 'HTTP ' + r.status + ' ' + txt.slice(0, 200) };
    const j = JSON.parse(txt);
    const out = j?.choices?.[0]?.message?.content;
    const text = typeof out === 'string' ? out : Array.isArray(out) ? out.map(x => x?.text || '').join('') : '';
    return { ok: !!text, text: text || '', err: text ? '' : '空回复', usage: j.usage || null };
  } catch (e) {
    return { ok: false, text: '', err: String(e.message || e).slice(0, 200) };
  }
}

export async function testKey(cfg) {
  const r = await chat({ ...cfg, system: '', user: '你好', maxTokens: 64, temperature: 0, timeoutMs: 30000 });
  if (r.ok) return { ok: true, text: r.text.slice(0, 40), err: '' };
  // 接口通了但没有正文（推理模型把 token 全花在思考上）也算连通
  if (/空回复/.test(r.err || '')) return { ok: true, text: '（通了，模型没回正文，可能是推理型模型）', err: '' };
  return { ok: false, text: '', err: r.err };
}
