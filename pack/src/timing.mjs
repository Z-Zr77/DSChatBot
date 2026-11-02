// 文本层面的"时间感"和"心里话"处理。
// 目的：把"多久以前"算成确定量交给提示词，别让模型自己做时间算术；
// 同时保证 `[[想：…]]` 无论如何都不会被发出去（模型经常少写一个右括号）。

// "2026-10-29 20:46" → "（76 分钟前）"；10 分钟以内不标
export function ageTag(y, mo, d, h, mi, now = Date.now()) {
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
  const min = Math.round((now - t) / 60e3);
  if (!Number.isFinite(min) || min < 10) return '';
  if (min < 60) return `（${min} 分钟前）`;
  if (min < 1440) return `（${Math.max(1, Math.round(min / 60))} 小时前）`;
  return `（${Math.round(min / 1440)} 天前）`;
}

// 给聊天记录每行补上"距现在多久"；行首格式是 「- 2026-10-29 20:46 [我] …」
export function agedLog(text, now = Date.now()) {
  return String(text || '')
    .split(/\r?\n/)
    .map((ln) => {
      const m = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(ln);
      if (!m) return ln;
      const tag = ageTag(m[1], m[2], m[3], m[4], m[5], now);
      return tag ? ln + tag : ln;
    })
    .join('\n');
}

// 把 [[想：…]] 拆出来。容忍：只写一个 `]`、与正文同行、跨行且末尾才闭合。
// 规则：`[[想` 所在行若以 `]` 结尾就当场闭合（模型少写括号的常见形态）；
// 不以 `]` 结尾才认为心里话跨行，直到遇到含 `]]` 的行为止。
export function splitInner(text) {
  const inner = [];
  const out = [];
  let open = false;
  for (const ln of String(text || '').split(/\r?\n/)) {
    if (open) {
      const c = ln.indexOf(']]');
      if (c >= 0) {
        const body = ln.slice(0, c).trim();
        if (body) inner.push(body);
        const after = ln.slice(c + 2).trim();
        if (after) out.push(after);
        open = false;
      } else {
        if (ln.trim()) inner.push(ln.trim());
      }
      continue;
    }
    const i = ln.search(/\[\[\s*想/);
    if (i < 0) { out.push(ln); continue; }
    const before = ln.slice(0, i).trim();
    if (before) out.push(before);
    let tail = ln.slice(i).replace(/^\[\[\s*想\s*[:：]?\s*/, '');
    if (/\]\s*$/.test(tail)) {
      // 当场闭合：拆掉尾部 1~3 个右括号
      tail = tail.replace(/\]{1,3}\s*$/, '').trim();
      if (tail) inner.push(tail);
      continue;
    }
    const c = tail.indexOf(']]');
    if (c >= 0) {
      const body = tail.slice(0, c).trim();
      if (body) inner.push(body);
      const after = tail.slice(c + 2).trim();
      if (after) out.push(after);
    } else {
      const body = tail.trim();
      if (body) inner.push(body);
      open = true;
    }
  }
  return { inner: inner.join(' / ').replace(/\s+/g, ' ').trim(), visible: out.join('\n').trim() };
}
