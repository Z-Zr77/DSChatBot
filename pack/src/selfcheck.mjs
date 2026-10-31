// 自洽性检查：她这句话和她"已发生的事实"是否冲突
// 设计：纯函数、零依赖，命中才触发一次重写（省钱）
const RULES = [
  { key: 'shower', pos: /(刚洗完澡|洗完澡了|洗过了|冲完澡|洗好了)/, neg: /(还没洗|没洗澡|还没洗澡|懒得洗|等会儿再洗)/, factPos: '洗过澡了', factNeg: '还没洗澡', topic: '洗澡' },
  { key: 'meal', pos: /(吃过了|刚吃完|吃完了|吃完就)/, neg: /(还没吃|没吃饭|没顾上吃|还没吃饭)/, factPos: '吃了东西', factNeg: '还没吃饭', topic: '吃饭' },
  { key: 'work', pos: /(稿子弄完了|写完了|改完了|弄完了|交了)/, neg: /(还在赶|没弄完|还在改|赶稿)/, factPos: '稿子弄完了', factNeg: '还在赶稿', topic: '稿子' },
  { key: 'cook', pos: /(在做饭|做饭呢|刚做完饭)/, neg: /(没做饭|不做饭)/, factPos: '在做饭', factNeg: '没做饭', topic: '做饭' },
];

// 从她的话里取出"表态"
export function claims(text) {
  const t = String(text || '');
  const out = [];
  for (const r of RULES) {
    if (r.pos.test(t)) out.push({ key: r.key, value: 'pos', topic: r.topic, fact: r.factPos });
    if (r.neg.test(t)) out.push({ key: r.key, value: 'neg', topic: r.topic, fact: r.factNeg });
  }
  return out;
}

// facts: self-facts 的 tag 数组（如 ['还没洗澡','还在赶稿']）
export function conflicts(text, facts, opts = {}) {
  const set = new Set((facts || []).map(String));
  const ageOf = typeof opts.ageOf === 'function' ? opts.ageOf : null;
  // 20 分钟前说过"还没洗"，现在"刚洗完回来"是正常推进，不该被判自相矛盾；
  // 但 5 分钟前刚说"还没洗"、马上又说"洗完了"才值得拦（复查 F15）。
  const STALE_MS = 20 * 60 * 1000;
  const hits = [];
  for (const r of RULES) {
    const t = String(text || '');
    const saysPos = r.pos.test(t), saysNeg = r.neg.test(t);
    if (!saysPos && !saysNeg) continue;
    // 台账只记"最近状态"：如果台账说还没洗澡，而她这次说刚洗完 => 冲突
    if (set.has(r.factNeg) && saysPos) {
      const age = ageOf ? ageOf(r.factNeg) : Infinity;
      if (age > STALE_MS) continue;   // 旧状态可以正常往前走，放行
      hits.push(`你说“${r.topic}已经完成”，但台账记的是“${r.factNeg}”`);
    }
    if (set.has(r.factPos) && saysNeg) hits.push(`你说“${r.topic}还没做”，但台账记的是“${r.factPos}”`);
    // 同一句里自相矛盾
    if (saysPos && saysNeg) hits.push(`这一句里“${r.topic}”前后说法相反`);
  }
  return hits;
}

// 日程里已经过去的、还没到的活动，也算"事实来源"。
// 以前自检只认 self-facts 台账，而 prompt 里给的是日程，两边打架（复查 F15）。
const PLAN_WORD = {
  shower: /洗澡|冲澡|搓澡/,
  meal: /吃|饭|面|粥|外卖|早餐|午餐|晚餐|夜宵/,
  work: /稿|海报|文案|画稿|交稿/,
  cook: /做饭|下厨|煮/,
};
export function planTags(items, hm = '') {
  const now = hm || new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
  const out = [];
  for (const r of RULES) {
    const re = PLAN_WORD[r.key];
    if (!re) continue;
    let past = null, future = null;
    for (const it of items || []) {
      const t = `${it.what || ''} ${it.place || ''}`;
      if (!re.test(t)) continue;
      if (String(it.at) <= now) past = it;
      else if (!future) future = it;
    }
    if (past) out.push(r.factPos);
    else if (future) out.push(r.factNeg);
  }
  return out;
}

export function mergeFacts(...lists) {
  return [...new Set(lists.flat().filter(Boolean).map(String))];
}

// 重写也救不回来时的兜底：一句不带任何状态断言的话，保证不再自相矛盾
export function safeReply(_hits) {
  const pool = [
    '等一下，我有点记岔了，容我理理',
    '我这会儿脑子有点乱，先不瞎说了',
    '让我想一下，别催',
  ];
  const i = Math.floor(Date.now() / 1000) % pool.length;
  return pool[i];
}

export function hint(hits) {
  return '【自检】你刚准备说的这句话和事实对不上：' + hits.join('；') +
    '。请重写这一次回复：与事实保持一致，语气照常，不要提“自检/台账/系统”这些词，也不要道歉式解释。';
}
