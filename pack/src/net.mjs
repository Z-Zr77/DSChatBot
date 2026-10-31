// 只读抓网页：给"查文档、看报错页、核实事实"用。
// 边界（写清楚，别当成安全边界）：
//  - 只允许 http(s)，只 GET，不发任何请求体，不带 cookie；
//  - 默认拦掉本机/私网/链路本地/元数据地址（防 SSRF），要放行必须由用户在设置里显式 allowHosts；
//  - 重定向最多 3 跳，每一跳都重新过域名策略；
//  - 只接受文本类 content-type，二进制直接拒；
//  - 大小、超时都有上限；每次请求写一条审计（不发内容，只记主机与字节数）。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 20000;
export const MAX_REDIRECTS = 3;

const PRIVATE_V4 = [
  /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
const PRIVATE_V6 = [ /^::1$/, /^fc00:/i, /^fd00:/i, /^fe80:/i ];
const PRIVATE_NAME = /(^|\.)localhost$|\.local$|^metadata(\.|$)|\.internal$/i;

export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (PRIVATE_NAME.test(h)) return true;
  if (PRIVATE_V6.some((re) => re.test(h))) return true;
  if (PRIVATE_V4.some((re) => re.test(h))) return true;
  if (h === '0.0.0.0') return true;
  return false;
}

/** 校验一个 URL 能不能抓；allowHosts 里的主机可以放开私网限制。 */
export function checkUrl(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, err: '这不像一个网址：' + String(raw || '').slice(0, 80) }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, err: '只支持 http / https，别的协议不抓' };
  if (u.username || u.password) return { ok: false, err: '网址里带账号密码的不抓' };
  if (!u.hostname) return { ok: false, err: '网址里没有主机名' };
  const allow = (opts.allowHosts || []).map((x) => String(x || '').toLowerCase());
  const host = u.hostname.toLowerCase();
  const allowed = allow.some((a) => a && (host === a || host.endsWith('.' + a)));
  if (isPrivateHost(host) && !allowed) {
    return { ok: false, err: '本机/内网/元数据地址不抓（要放行得在设置里加进 allowHosts）：' + host };
  }
  return { ok: true, url: u.toString(), host };
}

const TEXT_TYPES = [
  /^text\//i, /^application\/(json|ld\+json|xml|xhtml\+xml|javascript|x-www-form-urlencoded)/i,
  /^application\/(rss|atom)\+xml/i,
];

function stripHtml(html) {
  let s = String(html);
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  return s
    .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

function audit(rec) {
  try {
    const dir = paths.PATHS.ledger;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'fetch', ...rec }) + '\n');
  } catch {}
}

async function readCapped(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf: buf.subarray(0, maxBytes), truncated: buf.length > maxBytes, total: buf.length };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.length))));
      truncated = true;
      try { await reader.cancel(); } catch {}
      break;
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks.map((c) => Buffer.from(c))), truncated, total };
}

/**
 * 抓一个网页，返回纯文本。
 * opts: { allowHosts, maxBytes, timeoutMs, maxRedirects }
 */
export async function fetchText(rawUrl, opts = {}) {
  const allowHosts = opts.allowHosts || [];
  const maxBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(opts.maxBytes) || MAX_BYTES));
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || TIMEOUT_MS));
  const maxRedirects = Math.max(0, Math.min(5, opts.maxRedirects == null ? MAX_REDIRECTS : Number(opts.maxRedirects)));

  let url = rawUrl;
  const started = Date.now();
  const hops = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const chk = checkUrl(url, { allowHosts });
    if (!chk.ok) { audit({ ok: false, url: String(url).slice(0, 300), err: chk.err, hops }); return chk; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(chk.url, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'user-agent': 'qq-bot/0.3 (read-only fetch)', accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1' },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e && e.name === 'AbortError' ? '抓取超时（' + Math.round(timeoutMs / 1000) + ' 秒）' : '抓取失败：' + String((e && e.message) || e).slice(0, 200);
      audit({ ok: false, url: chk.url.slice(0, 300), err: msg, hops });
      return { ok: false, err: msg };
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get('location');
      hops.push({ status: res.status, to: loc ? String(loc).slice(0, 200) : '' });
      if (!loc) { audit({ ok: false, url: chk.url.slice(0, 300), err: '重定向没有目标', hops }); return { ok: false, err: '服务器给了重定向但没给地址' }; }
      try { url = new URL(loc, chk.url).toString(); } catch { return { ok: false, err: '重定向地址看不懂' }; }
      if (hop === maxRedirects) { audit({ ok: false, url: chk.url.slice(0, 300), err: '重定向太多', hops }); return { ok: false, err: '重定向超过 ' + maxRedirects + ' 次，不追了' }; }
      continue;
    }

    const ct = String(res.headers.get('content-type') || '');
    if (ct && !TEXT_TYPES.some((re) => re.test(ct))) {
      audit({ ok: false, url: chk.url.slice(0, 300), status: res.status, err: '不是文本内容：' + ct.slice(0, 80), hops });
      return { ok: false, err: '这不是网页/文本（Content-Type: ' + ct.slice(0, 80) + '），不抓二进制' };
    }

    let read;
    try {
      read = await readCapped(res, maxBytes);
    } catch (e) {
      clearTimeout(timer);
      const msg = e && e.name === 'AbortError' ? '抓取超时（' + Math.round(timeoutMs / 1000) + ' 秒）' : '读取响应时出错：' + String((e && e.message) || e).slice(0, 200);
      audit({ ok: false, url: chk.url.slice(0, 300), status: res.status, err: msg, hops });
      return { ok: false, err: msg };
    }
    clearTimeout(timer);
    const { buf, truncated, total } = read;
    let text = buf.toString('utf8');
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
    if (/html|xml/i.test(ct) || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))) text = stripHtml(text);
    const ms = Date.now() - started;
    audit({ ok: res.status < 400, url: chk.url.slice(0, 300), status: res.status, bytes: total, kept: buf.length, truncated, ms, hops });
    if (res.status >= 400) {
      return { ok: false, status: res.status, err: '对方回了 ' + res.status + (res.status === 403 ? '（它不让抓，别硬试）' : ''), text: text.slice(0, 1500) };
    }
    return { ok: true, status: res.status, url: chk.url, contentType: ct, bytes: total, truncated, ms, text };
  }
  return { ok: false, err: '重定向太多' };
}
