// 自己画图。三种后端，全部可配（config.json 的 draw 段）：
//   dashscope  阿里云百炼「万相」——异步任务，纯文生图
//   ark        火山方舟 Ark「Seedream」——同步，支持参考图（image 字段），能锁人物长相
//   openai     任意 OpenAI 兼容的 /images/generations
// provider = auto 时按 baseUrl 猜；key 留空依次回落 data\aliyun.key / 环境变量。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './paths.mjs';
import * as settings from './settings.mjs';
import * as self from './self.mjs';

const RQ = PATHS.data;
const KEY_FILE = path.join(RQ, 'aliyun.key');
const ARK_KEY_FILE = path.join(RQ, 'ark.key');
const OUT_DIR = path.join(RQ, 'drawn');

const DS_BASE = 'https://dashscope.aliyuncs.com';
const DS_CREATE = '/api/v1/services/aigc/text2image/image-synthesis';
const DS_TASK = '/api/v1/tasks/';
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const STYLE = '，手绘感，卡通插画，构图干净，背景简洁，不要文字，不要水印';
const DS_CHAIN = ['wanx2.1-t2i-turbo', 'wan2.2-t2i-flash', 'wanx-v1'];

function cfg() {
  const c = (settings.load().draw) || {};
  return {
    provider: String(c.provider || 'auto').toLowerCase(), // auto | dashscope | ark | openai
    baseUrl: String(c.baseUrl || '').replace(/\/+$/, ''),
    model: String(c.model || '').trim(),
    key: String(c.key || '').trim(),
    ref: c.ref !== false, // 有参考图就带上（只对支持的后端生效）
  };
}

function keyOf(c) {
  const m = mode(c);
  // 用户可能把火山的 key 填进画图 Key 里，但选的是阿里云万相 —— 那种情况下用它必然 401，
  // 所以按 key 的形状判断是否与目标后端匹配，不匹配就让给文件里的另一家。
  const looksArk = v => /^ark-|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(String(v || ''));
  const looksDash = v => /^sk-[a-z0-9]/i.test(String(v || ''));
  const typed = c.key || '';
  const mismatched = (m === 'dashscope' && looksArk(typed)) || (m === 'ark' && looksDash(typed));
  if (typed && !mismatched) return typed;
  const files = m === 'ark' ? [ARK_KEY_FILE, KEY_FILE] : [KEY_FILE, ARK_KEY_FILE];
  for (const f of files) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (!v) continue;
      if (m === 'dashscope' && looksArk(v)) continue;
      if (m === 'ark' && looksDash(v)) continue;
      return v;
    } catch {}
  }
  if (typed) return typed;
  // 按后端取对应的环境变量：以前不分后端先取 ARK_API_KEY，阿里云后端会拿火山键去 401
  return (m === 'ark'
    ? (process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY)
    : (process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || process.env.OPENAI_API_KEY)) || '';
}

function mode(c) {
  if (c.provider === 'ark' || c.provider === 'volc' || c.provider === 'volcengine') return 'ark';
  if (c.provider === 'dashscope') return 'dashscope';
  if (c.provider === 'openai') return 'openai';
  // auto
  const b = c.baseUrl || '';
  if (/volces\.com/i.test(b)) return 'ark';
  if (/volcengineapi\.com/i.test(b)) return 'ark';
  if (/dashscope\.aliyuncs\.com/i.test(b)) return 'dashscope';
  if (b) return 'openai';
  // 地址留空：先看模型名像哪家（doubao-/seedream-/ep- 都是火山）
  if (/^(doubao|seedream|seedance|ep-|ark-)/i.test(c.model || '')) return 'ark';
  // 再看有哪家的 key，火山的 key 优先（它能带参考图）
  try { if (fs.readFileSync(ARK_KEY_FILE, 'utf8').trim()) return 'ark'; } catch {}
  if (process.env.ARK_API_KEY) return 'ark';   // 键在环境/凭证里时也算数（外壳版就是这么注入的）
  return 'dashscope';
}

function baseOf(c, m) {
  const raw = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return m === 'ark' ? ARK_BASE : m === 'dashscope' ? DS_BASE : '';
  // 方舟有两个域名：ark.cn-beijing.volces.com/api/v3（模型推理）与
  // ark.cn-beijing.volcengineapi.com（OpenAPI 网关，要 Action 参数，直接打会 400 MissingParameter）。
  // 用户从控制台抄的常常是后者，这里统一纠正成推理域名。
  if (/volcengineapi\.com/i.test(raw)) return ARK_BASE;
  if (m === 'ark' && /volces\.com/i.test(raw) && !/\/api\/v3$/i.test(raw)) return raw + '/api/v3';
  return raw;
}

function defaultModel(m) {
  if (m === 'ark') return 'doubao-seedream-4-0-250828';
  if (m === 'dashscope') return 'wanx2.1-t2i-turbo';
  return 'gpt-image-1';
}

function fileToDataUrl(f) {
  try {
    const ext = path.extname(f).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,` + fs.readFileSync(f).toString('base64');
  } catch { return ''; }
}

function refDataUrl() {
  try {
    const f = self.refFile();
    return f ? fileToDataUrl(f) : '';
  } catch { return ''; }
}

function savePng(buf) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}.png`);
  fs.writeFileSync(file, buf);
  return file;
}

export async function generate(desc, opts = {}) {
  const c = cfg();
  const k = keyOf(c);
  const prompt = String(desc).replace(/\s+/g, ' ').trim().slice(0, 1600);
  if (!k) throw new Error('没有 key（设置里的画图 Key，或 data\\aliyun.key / data\\ark.key）');

  const m = mode(c);
  // 要带参考图（自拍/画她）时，阿里云万相不支持 image 参数：硬降级会把人画成另一个人。
  // 只有调用方明确给 refFile 才算"要画她"：纯场景不能偷偷带全局参考图，
  // 否则"拍面馆"也会被塞进她本人（2026-10-29 复查 P1；bridge.sendDrawing 已分道）。
  const needRef = !!opts.refFile || (Array.isArray(opts.refFiles) && opts.refFiles.length > 0);
  if (needRef && m === 'dashscope') {
    let hasArk = false;
    try { hasArk = !!fs.readFileSync(ARK_KEY_FILE, 'utf8').trim(); } catch {}
    if (hasArk) {
      const ak = fs.readFileSync(ARK_KEY_FILE, 'utf8').trim();
      console.log('[draw] 需要参考图但后端是阿里云（不支持），改用火山');
      try {
        return await arkImage({ ...c, model: c.model && /^(doubao|seedream|ep-)/i.test(c.model) ? c.model : '' }, ak, prompt, opts);
      } catch (e) {
        throw new Error('需要参考图，但火山出图失败：' + e.message);
      }
    }
    console.log('[draw] 需要参考图但没有火山 key，只能不带参考图出图（人物可能不一致）');
  }
  if (m === 'ark') return await arkImage(c, k, prompt, opts);
  if (m === 'openai') return await openaiImage(c, k, prompt, opts);

  const allowFb = (settings.load().fallback || {}).draw === true;
  let chain = allowFb
    ? [...new Set([opts.model || c.model, ...DS_CHAIN].filter(Boolean))]
    : [opts.model || c.model].filter(Boolean);
  // 模型名留空等于一条链都没有，以前会直接抛 "都失败了 — "（后面什么都没有），
  // 她那边只看到"卡住了"。现在退回该后端第一个默认模型，真失败也说得清是什么问题。
  if (!chain.length) chain = [m === 'dashscope' ? DS_CHAIN[0] : defaultModel(m)];
  let lastErr = '';
  for (const model of chain) {
    try {
      return await dashscopeImage(c, k, model, prompt, opts);
    } catch (e) {
      lastErr = `${model}: ${e.message}`;
      console.log('[draw] ' + lastErr);
    }
  }
  throw new Error('都失败了 — ' + (lastErr || '没有可用的画图模型'));
}

// ---- 火山方舟 Seedream：同步返回，可选参考图 ----
async function arkImage(c, k, prompt, opts = {}) {
  const base = baseOf(c, 'ark');
  const url = base + '/images/generations';
  const model = opts.model || c.model || defaultModel('ark');
  const size = opts.size || '1024x1024';
  // 只认显式给到的参考图：不再因为设置里开着 ref 就偷偷给每张图塞她本人
  const ref = opts.refFile ? fileToDataUrl(opts.refFile) : '';
  // 多参考图：第 1 张她本人，第 2 张是他发来的参考（衣服/物件）。Seedream 4.5+ 支持 image 数组
  const refs = Array.isArray(opts.refFiles)
    ? opts.refFiles.map((f) => (f ? fileToDataUrl(f) : '')).filter(Boolean)
    : [];

  // mode: 0 不带图 / 1 只带 ref / 2 带多参考图（没有多图时退回单图）
  const call = async (mode) => {
    const body = {
      model,
      prompt: prompt + STYLE,
      size,
      response_format: 'b64_json',
      watermark: false,
    };
    if (mode === 2) {
      if (refs.length) body.image = refs.length === 1 ? refs[0] : refs;
      else if (ref) body.image = ref;
    } else if (mode === 1) {
      body.image = ref;
    }
    const post = async (b) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(180000),
      });
      return { r, t: await r.text() };
    };
    let { r, t } = await post(body);
    // 有些新模型（5.0 系列）不认 sequential_image_generation，带了直接 400，去掉重试一次
    if (r.status === 400 && /sequential_image_generation/i.test(t)) {
      const b2 = { ...body };
      delete b2.sequential_image_generation;
      ({ r, t } = await post(b2));
    }
    if (r.status !== 200) {
      if (/ModelNotOpen/i.test(t)) {
        throw new Error(`这个账号还没开通模型“${model}”。去方舟控制台「开通管理」把它开通（开通后一般几分钟内生效）。原始返回：` + t.slice(0, 140));
      }
      if (r.status === 404 && /NotFound|does not exist/i.test(t)) {
        throw new Error(`模型“${model}”在这个账号下不可用：要么没开通服务，要么 ID 不对。点「拉取」选列表里的 ID，或去控制台复制准确 ID（ep- 接入点也行）。原始返回：` + t.slice(0, 140));
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('火山的 API Key 不认（' + r.status + '）：检查 Key 属于哪个账号、是否过期。原始返回：' + t.slice(0, 120));
      }
      throw new Error(`HTTP ${r.status} ${t.slice(0, 220)}`);
    }
    let j;
    try { j = JSON.parse(t); } catch { throw new Error('返回不是 JSON: ' + t.slice(0, 200)); }
    const item = j?.data?.[0];
    if (!item) throw new Error('返回里没有 data[0]: ' + t.slice(0, 200));
    if (item.b64_json) return savePng(Buffer.from(item.b64_json, 'base64'));
    if (item.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(90000) });
      if (!img.ok) throw new Error('下载图片失败 ' + img.status);
      return savePng(Buffer.from(await img.arrayBuffer()));
    }
    throw new Error('既没有 b64_json 也没有 url');
  };

  // 先试多参考图（她 + 他给的图），不行退回单张她本人，最后才纯文字——
  // 退回时一定要说清是哪一步失败，否则"换不明白"只能靠猜。
  if (refs.length > 1) {
    try {
      return { file: await call(2), prompt, model, ref: true, refCount: refs.length };
    } catch (e) {
      console.log('[draw] ark 多参考图失败（' + refs.length + ' 张），退单图重试：' + e.message);
    }
  }
  if (ref) {
    try {
      return { file: await call(1), prompt, model, ref: true, refCount: 1 };
    } catch (e) {
      console.log('[draw] ark 带参考图失败，改纯文字重试：' + e.message);
    }
  }
  return { file: await call(0), prompt, model, ref: false };
}

// ---- 阿里云万相：提交任务 + 轮询 ----
async function dashscopeImage(c, k, model, rawPrompt, opts = {}) {
  const prompt = rawPrompt + STYLE;
  const size = opts.size || '1024*1024';
  const base = baseOf(c, 'dashscope');
  const r = await fetch(base + DS_CREATE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model, input: { prompt }, parameters: { size, n: 1, prompt_extend: true } }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  if (r.status !== 200) throw new Error(`创建任务失败 ${r.status} ${t.slice(0, 160)}`);
  const id = JSON.parse(t)?.output?.task_id;
  if (!id) throw new Error('没有拿到 task_id: ' + t.slice(0, 160));

  const deadline = Date.now() + 60000; // 单模型最多等 60 秒，卡住就换下一个
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 2000));
    const q = await fetch(`${base}${DS_TASK}${id}`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(20000) });
    const qj = await q.json();
    const st = qj?.output?.task_status;
    if (st === 'SUCCEEDED') {
      const url = qj?.output?.results?.[0]?.url;
      if (!url) throw new Error('任务成功但没有图片 URL');
      const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!img.ok) throw new Error('下载图片失败 ' + img.status);
      return { file: savePng(Buffer.from(await img.arrayBuffer())), prompt, model };
    }
    if (st === 'FAILED' || st === 'UNKNOWN' || st === 'CANCELED') {
      throw new Error('生成失败: ' + JSON.stringify(qj?.output?.message || qj?.output).slice(0, 160));
    }
  }
  throw new Error('等待超时（60 秒）');
}

// ---- OpenAI 兼容：POST {base}/images/generations（同步返回 base64 或 url）----
async function openaiImage(c, k, prompt, opts = {}) {
  const base = baseOf(c, 'openai');
  if (!base) throw new Error('OpenAI 兼容模式要在设置里填接口地址');
  const url = base + '/images/generations';
  const model = opts.model || c.model || defaultModel('openai');
  const size = opts.size || '1024x1024';
  const body = { model, prompt, n: 1, size, response_format: 'b64_json' };
  // 只认显式给到的参考图：不再因为设置里开着 ref 就偷偷给每张图塞她本人
  const ref = opts.refFile ? fileToDataUrl(opts.refFile) : '';
  if (ref && c.sendRef) body.image = ref; // 有些网关支持，支持才勾
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const t = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(t); } catch { throw new Error('返回不是 JSON: ' + t.slice(0, 200)); }
  const item = j?.data?.[0];
  if (!item) throw new Error('返回里没有 data[0]: ' + t.slice(0, 200));
  if (item.b64_json) return { file: savePng(Buffer.from(item.b64_json, 'base64')), prompt, model, ref: !!body.image };
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error('下载图片失败 ' + img.status);
    return { file: savePng(Buffer.from(await img.arrayBuffer())), prompt, model, ref: !!body.image };
  }
  throw new Error('既没有 b64_json 也没有 url');
}

export function info() {
  const c = cfg();
  const m = mode(c);
  const k = keyOf(c);
  return {
    provider: c.provider,
    mode: m,
    baseUrl: baseOf(c, m),
    model: c.model || defaultModel(m),
    ref: c.ref,
    hasRef: !!self.refFile(),
    keySet: !!k,
    keyMask: k ? k.slice(0, 6) + '…' + k.slice(-4) : '',
  };
}

export async function selfTest(desc = '一只蓝色小鲸鱼，Q版，白底') {
  const t0 = Date.now();
  try {
    const r = await generate(desc);
    return { ok: true, ms: Date.now() - t0, file: r.file, model: r.model, ref: !!r.ref };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}
