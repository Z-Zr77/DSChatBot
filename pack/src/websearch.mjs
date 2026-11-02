// 真联网：走阿里云百炼的 compatible-mode，打开 enable_search。
// 为什么不自己接搜索引擎：百炼的 qwen 系列带联网检索，返回的是真实检索结果，
// 用他已有的 aliyun key 就能跑，不用再买一个搜索服务（2026-11-02 实测 4769 prompt tokens/次）。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

const KEY_FILE = path.join(paths.PATHS.data, 'aliyun.key');
const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export function readKeyFile() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

// 优先级：设置里显式填的 > data/aliyun.key > 语音/看图用的那把 aliyun key
export function resolveKey(cfg = {}) {
  const b = cfg.browse || {};
  const cand = [b.key, readKeyFile(), cfg.tts && cfg.tts.key, cfg.vision && cfg.vision.key];
  for (const k of cand) if (typeof k === 'string' && k.trim()) return k.trim();
  return '';
}

export async function searchChat({ key, model = 'qwen-plus', prompt, timeoutMs = 60000 }) {
  if (!key) return { ok: false, err: '没有可用的搜索 key' };
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(prompt || '').slice(0, 4000) }],
        enable_search: true,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, err: (j.error && j.error.message) || ('HTTP ' + r.status) };
    const text = String(((j.choices || [])[0] || {}).message?.content || '');
    const usage = j.usage || {};
    return { ok: !!text.trim(), text, tokens: usage.total_tokens || 0, err: text.trim() ? '' : '空回复' };
  } catch (e) {
    return { ok: false, err: e.message || String(e) };
  }
}
