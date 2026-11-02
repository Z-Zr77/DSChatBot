// 只分类已有会话信号；回应风格由 persona.default.draft.md 决定。
export function relationshipFor(conv, ownerUin, persona = '') {
  if (!conv || !['local', 'private'].includes(conv.kind)) return '';
  if (String(conv.id) !== String(ownerUin)) return '';
  const role = String(persona).match(/^关系\/身份[：:]\s*([^\n]+)/m)?.[1]?.trim() || '';
  return /^(女友|女朋友|老婆|妻子|girlfriend|wife)(?:[（(\s]|$)/i.test(role) ? role : '';
}

export function detect({ text = '', hour = 12, lastUserAt = 0, now = Date.now() } = {}) {
  const s = String(text);
  if (/(?:我(?:现在|这会儿|今天)?(?:在忙|正忙|要忙|很忙|有点忙|忙着))|^(?:在忙|正忙|先忙|忙一会)|别打扰|不要打扰|晚点聊|等我忙完/.test(s)) return ['busy'];
  const events = [];
  if (!/(?:不|没|并不)(?:太|怎么|觉得)?累/.test(s) && /(?:^|[，。！？\s])(?:我(?:今天|现在)?(?:觉得|感觉)?)?(?:好|很|太|有点|真的|特别)?(?:累(?!积|计|加|赘)|疲惫|疲倦|撑不住)/.test(s)) events.push('tired');
  if (hour >= 23 || hour < 6) events.push('late_night');
  if (/(?:工作|加班|写代码|写论文|开会|干活).{0,12}(?:[两三四五六七八九十]|[2-9]|\d{2,})个?小时|(?:工作|加班|写代码|写论文|开会|干活).{0,8}(?:一整天|一天了|到现在|好久)/.test(s)) events.push('long_work');
  if (!events.includes('tired') && !events.includes('long_work')) {
    if (/别的女(?:生|孩)|其他女(?:生|孩)|女同事|女同学|一个女(?:生|孩)/.test(s)) events.push('other_girl');
    if (lastUserAt > 0 && now - lastUserAt >= 6 * 3600e3) events.push('long_absence');
  }
  return events;
}

export function quietUntil(events, now = Date.now()) {
  return events.includes('busy') ? now + 4 * 3600e3 : 0;
}
export function isQuiet(state, now = Date.now()) {
  return Number(state?.momentQuietUntil || 0) > now;
}
export function render(state, now = Date.now()) {
  const moment = state?.moment;
  if (!moment || now - moment.at > 10 * 60e3 || now < moment.at || !moment.events?.length) return '';
  return '【相处事件】' + JSON.stringify({ relationship: moment.relationship, events: moment.events });
}
