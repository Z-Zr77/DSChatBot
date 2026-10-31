import fs from 'node:fs';
import path from 'node:path';
import * as PATHS from './paths.mjs';
const DATA = (PATHS && (PATHS.data || PATHS.DATA)) || '';

const pad = n => String(n).padStart(2, '0');
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function items() {
  const f = path.join(DATA, 'life', 'plan', today() + '.json');
  const o = readJSON(f, {});
  const arr = Array.isArray(o.items) ? o.items : [];
  return arr.map(x => ({
    min: (() => { const m = String(x.at || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : 9999; })(),
    at: x.at || '', place: x.place || '', what: x.what || '',
  })).filter(x => x.what).sort((a, b) => a.min - b.min);
}
export function planDone(max = 6) {
  const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
  return items().filter(x => x.min <= nm).slice(-max).map(x => `${x.at} 在${x.place}：${x.what}`);
}
export function planNext(max = 3) {
  const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
  return items().filter(x => x.min > nm).slice(0, max).map(x => `${x.at} 在${x.place}：${x.what}`);
}
export function whitelist(ctx = {}) {
  const parts = [];
  const done = planDone();
  if (done.length) parts.push('你今天已经做过/正在做：\n' + done.map(s => '- ' + s).join('\n'));
  const next = planNext();
  if (next.length) parts.push('你接下来原计划：\n' + next.map(s => '- ' + s).join('\n'));
  if (ctx.facts) parts.push(ctx.facts);
  if (ctx.place) parts.push('此刻你在：' + ctx.place + (ctx.doing ? `，手头在做：${ctx.doing}` : ''));
  return parts.join('\n');
}
// 允许出现的“具体细节”集合（用于输出自检，只告警）
export function allowedTokens() {
  const all = items().map(x => `${x.place}${x.what}`).join(' ');
  const facts = readJSON(path.join(DATA, 'self-facts.json'), { days: {} });
  const t = today();
  const ft = ((facts.days || {})[t] || []).map(x => x.tag).join(' ');
  return all + ' ' + ft;
}
const DETAIL = /(\d{1,2}\s*点(?:半|\d{1,2})?|\d+\s*分钟|\d+\s*块钱?|\d+\s*元|吃(?:了|的)[\u4e00-\u9fa5]{1,6}|(?:在|去)[\u4e00-\u9fa5]{2,6}(?:路|街|店|超市|食堂|公司|学校|咖啡))/g;
export function lint(text, allowed) {
  const t = String(text || ''); const hits = []; let m; DETAIL.lastIndex = 0;
  while ((m = DETAIL.exec(t))) { const frag = m[0]; if (allowed && allowed.includes(frag)) continue; hits.push(frag); }
  return hits;
}
