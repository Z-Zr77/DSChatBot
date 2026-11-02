// 极简行级 diff：只用来给人看"改了哪几行"，不做补丁。
export function lineDiff(before, after, max = 8) {
  const a = String(before ?? '').split(/\r?\n/);
  const b = String(after ?? '').split(/\r?\n/);
  const out = [];
  let added = 0;
  let removed = 0;
  const n = Math.max(a.length, b.length);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    // 找下一处相同的行，判断是"删"还是"加"
    let ia = i;
    let jb = j;
    while (ia < a.length && a[ia] !== b[jb] && jb < b.length && a[ia] !== b[jb + 1]) ia++;
    if (j < b.length && (i >= a.length || a[i] !== b[j])) {
      if (a[i] === b[j + 1]) { // 新增了一行
        out.push({ t: '+', s: b[j] });
        added++;
        j++;
        continue;
      }
    }
    if (i < a.length && (j >= b.length || a[i] !== b[j])) {
      if (b[j] === a[i + 1]) { // 删掉了一行
        out.push({ t: '-', s: a[i] });
        removed++;
        i++;
        continue;
      }
    }
    // 兜底：整行替换
    if (i < a.length) { out.push({ t: '-', s: a[i] }); removed++; i++; }
    if (j < b.length) { out.push({ t: '+', s: b[j] }); added++; j++; }
    if (out.length > max * 4) break;
  }
  const clipped = out.slice(0, max);
  return {
    added,
    removed,
    lines: clipped,
    truncated: out.length > max,
    text: clipped.map((x) => (x.t === '+' ? '+ ' : '- ') + String(x.s).slice(0, 160)).join('\n'),
  };
}

export function firstChangedLine(before, after, needle) {
  const b = String(after ?? '').split(/\r?\n/);
  const i = b.findIndex((l) => l.includes(needle));
  return i < 0 ? 0 : i + 1;
}
