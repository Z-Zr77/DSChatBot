import assert from 'node:assert/strict';
import fs from 'node:fs';
import { relationshipFor, detect, quietUntil, isQuiet, render } from '../src/moments.mjs';
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('PASS', name); pass++; } catch (e) { console.log('FAIL', name, e.message); fail++; } }
const owner = '12345678';
const local = { kind: 'local', id: owner };
const persona = '关系/身份：女友（默认）';
t('身份：仅主人私聊的恋人身份启用，朋友/陌生人/群聊不启用', () => {
  for (const role of ['女友', '女朋友', '老婆', '妻子', 'girlfriend', 'wife']) assert.ok(relationshipFor(local, owner, '关系/身份：' + role));
  for (const role of ['朋友', '自定义', '女友的朋友', '不是女友', '']) assert.equal(relationshipFor(local, owner, '关系/身份：' + role), '');
  assert.equal(relationshipFor({ kind: 'private', id: '87654321' }, owner, persona), '');
  assert.equal(relationshipFor({ kind: 'group', id: owner }, owner, persona), '');
  assert.equal(relationshipFor(local, owner, '我同事的女友'), '');
});
t('时间、疲惫与明确长时间工作触发', () => {
  assert.deepEqual(detect({ text: '我好累', hour: 23 }), ['tired', 'late_night']);
  assert.deepEqual(detect({ text: '我写代码四小时了', hour: 14 }), ['long_work']);
  assert.deepEqual(detect({ text: '我不累', hour: 14 }), []);
  assert.deepEqual(detect({ text: '你累不累', hour: 14 }), []);
  assert.deepEqual(detect({ text: '今天累积了十条数据', hour: 14 }), []);
  assert.deepEqual(detect({ text: '你在忙吗', hour: 14 }), []);
  assert.deepEqual(detect({ text: '今天工作很顺利', hour: 14 }), []);
  assert.ok(detect({ hour: 2 }).includes('late_night'));
  assert.deepEqual(detect({ hour: 6 }), []);
});
t('忙时优先安静，新消息恢复；状态按用户独立', () => {
  const now = 100000000;
  const events = detect({ text: '我在忙，晚点聊', hour: 23 });
  assert.deepEqual(events, ['busy']);
  const a = { momentQuietUntil: quietUntil(events, now) };
  assert.ok(isQuiet(a, now + 1000));
  assert.equal(isQuiet({}, now), false);
  assert.equal(isQuiet(a, now + 4 * 3600e3), false);
  assert.equal(quietUntil(detect({ text: '忙完啦', hour: 14 }), now), 0);
});
t('轻松话题和长时间未聊可触发，疲惫时不加吃醋', () => {
  const now = 100000000;
  assert.deepEqual(detect({ text: '和女同事一起吃午饭', hour: 14 }), ['other_girl']);
  assert.deepEqual(detect({ text: '我好累，女同事也累', hour: 14 }), ['tired']);
  assert.deepEqual(detect({ text: '回来啦', lastUserAt: now - 6 * 3600e3, now }), ['long_absence']);
  assert.deepEqual(detect({ text: '第一次聊天', now }), []);
});
t('事件及时过期；代码只传事实，回应方式留在人设草稿', () => {
  const state = { moment: { relationship: '女友', events: ['tired'], at: 1000 } };
  assert.ok(render(state, 2000).includes('tired'));
  assert.equal(render(state, 1000 + 11 * 60e3), '');
  const bridge = fs.readFileSync('pack/src/bridge.mjs', 'utf8');
  assert.ok(bridge.includes('moments.relationshipFor(conv, cfg.ownerUin'));
  assert.ok(bridge.includes('moments.isQuiet(pstate[memKeyOf(conv)])'));
  assert.ok(bridge.includes('moments.render(pstate[mk])'));
  const draft = fs.readFileSync('pack/assets/persona.default.draft.md', 'utf8');
  for (const event of ['busy', 'tired', 'late_night', 'long_work', 'other_girl', 'long_absence']) assert.ok(draft.includes(event));
  assert.ok(draft.includes('不让他内疚'));
});
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
