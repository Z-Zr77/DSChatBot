// 语音：文字 -> edge-tts(mp3) -> PCM -> SILK ；收到 SILK -> PCM
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync as readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { encode as silkEncode, decode as silkDecode, isSilk } from 'silk-wasm';
import { MPEGDecoder } from 'mpg123-decoder';
import * as settings from './settings.mjs';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const PY = process.env.QQBOT_PYTHON || 'python';
const TMP = path.join(os.tmpdir(), 'dsh-qq-voice');

export const VOICES = {
  xiaoxiao: 'zh-CN-XiaoxiaoNeural', // 温软女声
  xiaoyi: 'zh-CN-XiaoyiNeural',     // 活泼女声
  xiaohan: 'zh-CN-XiaohanNeural',   // 知性
};

async function tmpFile(ext) {
  await fs.mkdir(TMP, { recursive: true });
  return path.join(TMP, `${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

// 文字 -> mp3 buffer
export async function ttsMp3(text, voice = VOICES.xiaoxiao) {
  const out = await tmpFile('mp3');
  await new Promise((resolve, reject) => {
    const p = spawn(PY, ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', out], {
      windowsHide: true,
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}: ${err.slice(-300)}`))));
  });
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return buf;
}

// mp3 -> Int16LE PCM
export async function mp3ToPcm(mp3Buf) {
  const dec = new MPEGDecoder();
  await dec.ready;
  const { channelData, sampleRate, samplesDecoded, errors } = dec.decode(new Uint8Array(mp3Buf));
  dec.free();
  if (!samplesDecoded) throw new Error(`mp3 decode failed ${JSON.stringify(errors || [])}`);
  const ch = channelData[0];
  const pcm = Buffer.alloc(ch.length * 2);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return { pcm, sampleRate };
}

// 文字 -> SILK buffer
export async function textToSilk(text, voice) {
  const provider = await pickProvider();
  if (provider === 'openai') {
    const mp3o = await openaiMp3(text, voice);
    const dec = await mp3ToPcm(mp3o);
    const rateO = dec.sampleRate >= 24000 ? 24000 : dec.sampleRate;
    const enc = await silkEncode(dec.pcm, rateO);
    return { silk: Buffer.from(enc.data), durationMs: enc.duration, provider };
  }
  if (provider === 'aliyun') {
    const { pcm, sampleRate, chars } = await aliyunPcm(text, voice || currentVoice());
    recordUsage(chars || text.length);
    const { data, duration } = await silkEncode(pcm, sampleRate);
    return { silk: Buffer.from(data), durationMs: duration, provider };
  }
  const mp3 = await ttsMp3(text, voice);
  const { pcm, sampleRate } = await mp3ToPcm(mp3);
  const rate = sampleRate >= 24000 ? 24000 : sampleRate;
  const { data, duration } = await silkEncode(pcm, rate);
  return { silk: Buffer.from(data), durationMs: duration, provider };
}

// ---------- OpenAI 兼容的 /audio/speech（OpenAI、硅基流动、自建网关都行）----------
export async function openaiMp3(text, voice) {
  const c = ttsCfg();
  const base = c.baseUrl || 'https://api.openai.com/v1';
  const url = base.replace(/\/+$/, '') + '/audio/speech';
  const key = c.key || process.env.OPENAI_API_KEY || '';
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.model || 'tts-1',
      input: String(text).slice(0, 900),
      voice: (voice && !String(voice).includes('_v')) ? voice : 'alloy',
      response_format: 'mp3',
    }),
  });
  if (!r.ok) throw new Error('TTS HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const buf = Buffer.from(await r.arrayBuffer());
  recordUsage(String(text).length);
  return buf;
}

// ---------- 阿里云百炼 CosyVoice ----------
export const ALI_VOICE = process.env.ALI_TTS_VOICE || 'longwan_v2'; // 音色 B（用户选定）
// 网页界面里改的音色优先；每次调用现读，不用重启
export function ttsCfg() {
  try {
    const c = settings.load();
    const t = (c && c.tts) || {};
    return {
      provider: t.provider || 'aliyun',
      baseUrl: String(t.baseUrl || '').replace(/\/+$/, ''),
      model: t.model || 'cosyvoice-v2',
      key: (t.key || '').trim(),
      voiceId: t.voiceId || '',
    };
  } catch { return { provider: 'aliyun', model: 'cosyvoice-v2', key: '', voiceId: '' }; }
}

export function voiceInfo() {
  const t = ttsCfg();
  const fileKey = (() => { try { return readSync(ALI_KEY_FILE, 'utf8').trim(); } catch { return ''; } })();
  const k = t.key || process.env.DASHSCOPE_API_KEY || fileKey || aliKeyCache || '';
  return {
    provider: t.provider, model: t.model, voiceId: currentVoice(),
    keySet: !!k, keyFromUI: !!t.key, keyFromFile: !t.key && !!fileKey,
    keyMask: k ? (k.length <= 10 ? k.slice(0, 3) + '…' : k.slice(0, 6) + '…' + k.slice(-4)) : '',
  };
}

export function currentVoice() {
  try {
    const c = settings.load();
    const t = (c && c.tts) || {};
    return t.voiceId || c.voice || ALI_VOICE;
  } catch { return ALI_VOICE; }
}
const ALI_KEY_FILE = path.join(RQ, 'aliyun.key');
const ALI_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

let aliKeyCache = null;
export async function aliKey() {
  // 优先级：网页里填的 key → 环境变量 → 老的文件
  const fromUI = ttsCfg().key;
  if (fromUI) return fromUI;
  if (aliKeyCache) return aliKeyCache;
  try {
    aliKeyCache = (await fs.readFile(ALI_KEY_FILE, 'utf8')).trim();
  } catch {
    aliKeyCache = process.env.DASHSCOPE_API_KEY || '';
  }
  return aliKeyCache;
}

function ttsFallbackAllowed() {
  try { return (settings.load().fallback || {}).tts !== false } catch { return true }
}

async function pickProvider() {
  const c = ttsCfg();
  if (c.provider === 'openai') return 'openai';
  if (c.provider === 'edge') return 'edge';
  // aliyun（默认）：有 key 或有自定义地址就走云端，否则退回 edge 免费兜底
  if (c.baseUrl || (await aliKey())) return 'aliyun';
  // 关了 tts 降级就老老实实报错，不偷偷用免费 edge
  if (!ttsFallbackAllowed()) throw new Error('语音合成没配 key，且已关闭自动降级（设置 → 语音合成）');
  return 'edge';
}

// 本地记账：cosyvoice-v2 官方价 2 元/万字符（华北2 北京）
const USAGE_FILE = path.join(RQ, 'tts-usage.json');
export const PRICE_PER_10K = 2;
export function recordUsage(chars) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let db = {};
    try { db = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
    const d = (db[today] = db[today] || { chars: 0, calls: 0 });
    d.chars += chars;
    d.calls += 1;
    fs.writeFileSync(USAGE_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch {}
}
export function usageSummary() {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
  const days = Object.keys(db).sort();
  const total = days.reduce((s, k) => s + db[k].chars, 0);
  return { days: days.map((k) => ({ date: k, ...db[k], cost: +(db[k].chars / 1e4 * PRICE_PER_10K).toFixed(4) })), totalChars: total, totalCost: +(total / 1e4 * PRICE_PER_10K).toFixed(4) };
}

// 返回 Int16LE PCM（24k 单声道）与采样率
export async function aliyunPcm(text, voice = currentVoice(), extra = {}) {
  const key = await aliKey();
  if (!key) throw new Error('no aliyun key');
  const body = {
    model: ttsCfg().model || 'cosyvoice-v2',
    input: { text, voice, format: 'pcm', sample_rate: 24000, ...extra },
  };
  const r = await fetch(ttsCfg().baseUrl || ALI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`aliyun ${r.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  const url = j?.output?.audio?.url;
  if (!url) throw new Error('aliyun no audio url: ' + JSON.stringify(j).slice(0, 200));
  const a = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!a.ok) throw new Error(`aliyun download ${a.status}`);
  const pcm = Buffer.from(await a.arrayBuffer());
  return { pcm, sampleRate: 24000, chars: j?.usage?.characters || 0 };
}

// SILK buffer -> 16k PCM（给 ASR 用）
export async function silkToPcm(buf) {
  const raw = new Uint8Array(buf);
  const out = await silkDecode(raw, 16000);
  return Buffer.from(out.data);
}

export { isSilk };

// 16k 单声道 Int16LE PCM -> WAV
export function pcmToWav(pcm, rate = 16000) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// SILK 文件 -> 16k WAV 文件，返回路径
// 试听：直接返回一段 WAV（浏览器能放），不走 SILK
export async function ttsPreview(text = '这是试听，我是大肥鱼。') {
  const t = ttsCfg();
  const key = await aliKey();
  if (t.provider !== 'edge' && key) {
    const { pcm, sampleRate } = await aliyunPcm(text);
    return pcmToWav(pcm, sampleRate || 24000);
  }
  const mp3 = await ttsMp3(text, VOICES.xiaoxiao);
  const pcm = await mp3ToPcm(mp3);
  return pcmToWav(pcm, 16000);
}

// SILK 文件 -> 16k WAV 文件，返回路径
export async function silkFileToWav(silkPath) {
  const silk = await fs.readFile(silkPath);
  const pcm = await silkToPcm(silk);
  const wav = await tmpFile('wav');
  await fs.writeFile(wav, pcmToWav(pcm, 16000));
  return wav;
}

// 常驻 ASR 进程：一次加载模型，反复识别
export class Asr {
  constructor(onLog = () => {}) {
    this.onLog = onLog;
    this.proc = null;
    this.buf = '';
    this.readyPromise = null;
    this.waiter = null;
    this._resolveReady = null;
  }

  start() {
    if (this.proc) return this.readyPromise;
    const p = spawn(PY, [path.join(RQ, 'asr_server.py')], {
      windowsHide: true,
      env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' },
    });
    this.proc = p;
    this.buf = '';
    this.readyPromise = new Promise((res) => { this._resolveReady = res; });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ready !== undefined) {
          this.onLog(`[asr] ready=${j.ready} ${j.size || ''} ${j.error || ''}`);
          this._resolveReady?.(j.ready === true);
          this._resolveReady = null;
          continue;
        }
        const w = this.waiter;
        this.waiter = null;
        w?.(j);
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.onLog('[asr:err] ' + s.slice(0, 300)); });
    p.on('exit', (code) => {
      this.onLog('[asr] exit', code);
      this.proc = null;
      const w = this.waiter; this.waiter = null; w?.({ error: `asr_exit_${code}` });
      this._resolveReady?.(false); this._resolveReady = null;
    });
    return this.readyPromise;
  }

  async transcribe(wavPath, timeoutMs = 120000) {
    const ac = (settings.load().asr) || {};
    if (ac.provider === 'openai') return await this.transcribeApi(wavPath, ac, timeoutMs);
    if (!this.proc) this.start();
    const ready = await Promise.race([
      this.readyPromise,
      new Promise((r) => setTimeout(() => r(false), 180000)),
    ]);
    if (!ready) return { error: 'asr_not_ready' };
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.proc.stdin.write(wavPath + '\n');
      setTimeout(() => {
        if (this.waiter === resolve) { this.waiter = null; resolve({ error: 'asr_timeout' }); }
      }, timeoutMs);
    });
  }

  // OpenAI 兼容的 /audio/transcriptions（OpenAI、硅基流动、Groq 等都支持）
  async transcribeApi(wavPath, ac, timeoutMs = 120000) {
    try {
      const base = String(ac.baseUrl || '').replace(/\/+$/, '');
      if (!base) return { error: 'asr_no_baseurl' };
      const key = String(ac.key || process.env.OPENAI_API_KEY || '');
      const model = String(ac.model || 'whisper-1');
      const buf = await fs.readFile(wavPath);
      const form = new FormData();
      form.append('file', new Blob([buf], { type: 'audio/wav' }), 'a.wav');
      form.append('model', model);
      form.append('language', 'zh');
      const r = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const t = await r.text();
      if (r.status !== 200) return { error: `asr_http_${r.status}: ${t.slice(0, 160)}` };
      let j;
      try { j = JSON.parse(t); } catch { return { text: t.trim() }; }
      return { text: String(j.text || '').trim(), model };
    } catch (e) {
      return { error: 'asr_api: ' + e.message };
    }
  }
}


