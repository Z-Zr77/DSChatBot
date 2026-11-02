// 能力探测：控制台那五盏灯不能按"配置里有字段"亮，得按"这台机器上真的跑得起来"亮。
//
// 起因（2026-11-02 全新机器实测）：没配任何语音，五类能力里"语音"却是绿的；
// 她真去发语音时报 `edge-tts exit 9009: Python was not found`。
// 因为灯只看 `tts.key || tts.voiceId`，而 voiceId 有默认值。
//
// 这里只做"能不能跑"的判断，不联网、不花钱：
//   - 云端服务看有没有 key（key 可能来自配置、也可能来自 data/*.key 文件）
//   - 本地能力（edge-tts / 本地 whisper）看这台机器上有没有 python 和对应包
// 结果缓存 60 秒，避免每次刷控制台都 spawn 进程。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

const TTL = 60_000;
const cache = new Map();

function once(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.val;
  const val = fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

// 跑一个短命令，返回是否成功（超时 3 秒，失败就当没有）
export function probeCmd(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let p;
    try {
      p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      return finish(false);
    }
    const t = setTimeout(() => { try { p.kill(); } catch {} finish(false); }, timeoutMs);
    p.on('error', () => { clearTimeout(t); finish(false); });
    p.on('close', (code) => { clearTimeout(t); finish(code === 0); });
  });
}

// python 能不能用（Windows 上 python / py / python3 都试）
export function pythonOk() {
  return once('python', async () => {
    for (const c of ['python', 'py', 'python3']) {
      if (await probeCmd(c, ['-V'])) return true;
    }
    return false;
  });
}

// edge-tts 能不能用：优先命令行，其次 python -m edge_tts
export function edgeTtsOk() {
  return once('edge', async () => {
    if (await probeCmd('edge-tts', ['--help'])) return true;
    for (const c of ['python', 'py', 'python3']) {
      if (await probeCmd(c, ['-m', 'edge_tts', '--help'])) return true;
    }
    return false;
  });
}

function readKeyFile(name) {
  try {
    const t = fs.readFileSync(path.join(PATHS.data, name), 'utf8').trim();
    return t || '';
  } catch {
    return '';
  }
}

function anyKey(cfg, kind) {
  const sec = (cfg && cfg[kind]) || {};
  if (String(sec.key || '').trim()) return true;
  // 约定：data/aliyun.key 对所有阿里云系能力都算数
  if (readKeyFile('aliyun.key')) return true;
  if (kind === 'tts' && readKeyFile('tts.key')) return true;
  if (kind === 'asr' && readKeyFile('asr.key')) return true;
  return false;
}

// 语音合成能不能发出去
export async function ttsStatus(cfg) {
  const t = (cfg && cfg.tts) || {};
  let provider = String(t.provider || '').trim();
  if (!provider) provider = anyKey(cfg, 'tts') ? 'aliyun' : 'edge';
  if (provider === 'edge') {
    const ok = await edgeTtsOk();
    return { ok, provider, label: ok ? 'Edge-TTS（本机）' : '没配语音（Edge-TTS 需要本机 Python）', why: ok ? '' : '本机没有 Python / edge-tts' };
  }
  const ok = anyKey(cfg, 'tts');
  return { ok, provider, label: ok ? String(t.model || provider) : '没配语音（缺 Key）', why: ok ? '' : '缺 Key' };
}

// 语音识别能不能听
export async function asrStatus(cfg) {
  const a = (cfg && cfg.asr) || {};
  if (anyKey(cfg, 'asr')) return { ok: true, label: String(a.model || 'qwen3-asr-flash'), why: '' };
  const env = await pythonOk();
  return {
    ok: env,
    label: env ? '本机 Python（第一次要下模型）' : '没配识别（需要 Key 或本机 Python）',
    why: env ? '' : '本机没有 Python，也没有云端 Key',
  };
}

export async function caps(cfg) {
  const [tts, asr] = await Promise.all([ttsStatus(cfg), asrStatus(cfg)]);
  return { tts, asr };
}

export function _reset() { cache.clear(); }
