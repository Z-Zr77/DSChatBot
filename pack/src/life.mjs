// 她的"生活"：作息表（plan）、临时改主意（[[计划: ]]）、外界事件（events）。
// 这里只放纯函数 + 少量文件读写；生成靠 bridge.mjs 的大模型调用（提示词里带人设，不写死人设）。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

const DIR = path.join(paths.PATHS.data, 'life');
const EVENTS = path.join(DIR, 'events');

function mk(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// ---------- 一行日程 ----------
// "12:40 卧室｜爬起来 摸手机" / "00:30｜追两集剧" / "3:10 阳台 抽根烟"
export function parseLine(line) {
  const m = String(line || '').trim().match(/^[-·*]?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[｜|]?\s*(.+)$/);
  if (!m) return null;
  const at = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  const rest = m[3].replace(/^[-·*\s]+/, '').trim();
  const parts = rest.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
  const place = parts.length > 1 ? parts[0].slice(0, 16) : '';
  const what = (parts.length > 1 ? parts.slice(1).join('｜') : rest).slice(0, 40);
  if (!what) return null;
  return place ? { at, place, what } : { at, what };
}

// ---------- 她自己改日程 ----------
// 支持："21:30 出门吃夜宵"（改/加一条）、"21:30 取消"（删这一条）、"取消 吃夜宵"（按内容删）
export function applyOps(plan, raw) {
  const out = { items: (plan && Array.isArray(plan.items) ? plan.items.slice() : []), changed: [] };
  for (const chunk of String(raw || '').split(/\s*[；;\n]+\s*/)) {
    const s = chunk.trim().replace(/^[-·*]\s*/, '');
    if (!s) continue;

    // 取消某时间
    let m = s.match(/^(\d{1,2})\s*[:：]\s*(\d{2})\s*(取消|删掉|删了|不去了|算了)$/);
    if (m) {
      const at = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
      const before = out.items.length;
      out.items = out.items.filter((it) => it.at !== at);
      if (out.items.length !== before) out.changed.push(`删掉了 ${at} 那条`);
      continue;
    }

    // 取消某事（按关键词）
    m = s.match(/^(?:取消|删掉|删了|不去)\s*(.+)$/);
    if (m) {
      const kw = m[1].trim();
      const before = out.items.length;
      out.items = out.items.filter((it) => !String(it.what).includes(kw));
      if (out.items.length !== before) out.changed.push(`删掉了「${kw}」`);
      continue;
    }

    // 改/加一条
    const p = parseLine(s);
    if (!p) continue;
    const i = out.items.findIndex((it) => it.at === p.at);
    if (i >= 0) {
      const merged = { ...out.items[i], ...p };
      // 新安排没写地点时不能继承旧地点：
      // 21:30 把"卧室看书"改成"出门吃夜宵"，还留着 place=卧室，自拍就画在卧室里了（复查 F14）
      if (!p.place) delete merged.place;
      out.items[i] = merged;
      out.changed.push(`${p.at} 改成「${p.what}」`);
    } else {
      out.items.push(p);
      out.changed.push(`加了一条 ${p.at}「${p.what}」`);
    }
  }
  out.items.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

// ---------- 外界事件 ----------
export function eventsFile(date) { return path.join(EVENTS, `${date}.json`); }

export function loadEvents(date) {
  try {
    const j = JSON.parse(fs.readFileSync(eventsFile(date), 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

export function saveEvents(date, items) {
  mk(EVENTS);
  try { fs.writeFileSync(eventsFile(date), JSON.stringify({ date, items }, null, 2), 'utf8'); } catch {}
}

// 已经发生了的事件（时间已过），最多取 n 条最近的
export function happened(items, hm, n = 2) {
  return (items || []).filter((e) => e.at && e.at <= hm).slice(-n);
}

export function eventsText(items) {
  return (items || []).map((e) => `${e.at} ${e.what}`).join('\n');
}
