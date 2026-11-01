// 一次性承诺会过期：她说"答应他明早换衣服拍照"，两天后还拿这句当没办的事接着说。
// 记忆里事实没有"已完成"的概念，只能靠里面的相对时间点判死。
// 跑法：node pack\run-tests.mjs（或单独 node pack\test\poc-memory-expire-test.mjs）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memexp-'));
process.env.QQBOT_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'agent-home', 'memory', 'people'), { recursive: true });

const SRC = path.resolve('pack', 'src');
const mem = await import(new URL('file:///' + path.join(SRC, 'memory.mjs').replace(/\\/g, '/')).href);

// 固定一个基准时刻：2026-11-01 02:00（本地时间）
const T = new Date(2026, 10, 1, 2, 0, 0).getTime();   // 11 月 1 日 02:00
const DAY = 86400000;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

const NOW = T + 0;

t('"明早" → 睡醒那个中午 12 点过期', () => {
  const dl = mem.relDeadline('答应他明早换衣服拍照发给他', T - 2 * DAY);
  const want = new Date(2026, 9, 30, 12, 0, 0).getTime();   // 10-30 12:00
  assert.equal(dl, want, '实际 ' + new Date(dl).toLocaleString());
});

t('两天前的"明早"承诺，现在算过期', () => {
  const item = { text: '答应他明早换衣服拍照发给他', kind: 'core', at: T - 2 * DAY };
  assert.equal(mem.expired(item, NOW), true);
});

t('今晚说的"明早"，今晚还算有效', () => {
  const item = { text: '答应他明早换衣服拍照', kind: 'core', at: T };
  assert.equal(mem.expired(item, NOW), false, '才凌晨 2 点，明早还没到');
  assert.equal(mem.expired(item, T + 11 * 3600e3), true, '到中午就该过期');
});

t('"今晚"在当天 24 点前有效，过后过期', () => {
  const item = { text: '今晚把代码写完', kind: 'fact', at: T };
  assert.equal(mem.expired(item, T + 20 * 3600e3), false);
  assert.equal(mem.expired(item, T + 23 * 3600e3), true);
});

t('"下周三"过完周三就过期，没过期前有效', () => {
  const item = { text: '他下周三面试', kind: 'core', at: T };   // 11-01 是周日 → 下周三 = 11-04
  const dl = mem.relDeadline(item.text, T);
  assert.equal(new Date(dl).getDate(), 4, '应该落到 11-04，实际 ' + new Date(dl).toLocaleString());
  assert.equal(mem.expired(item, new Date(2026, 10, 3, 23, 0, 0).getTime()), false);
  assert.equal(mem.expired(item, new Date(2026, 10, 5, 1, 0, 0).getTime()), true);
});

t('没有相对时间的记忆永远不过期（名字、称呼这类）', () => {
  const item = { text: '他叫钟梓润，在准备实习', kind: 'core', at: T - 30 * DAY };
  assert.equal(mem.relDeadline(item.text, T - 30 * DAY), null);
  assert.equal(mem.expired(item, NOW), false);
});

t('已经标了 stale 的照样不算数', () => {
  assert.equal(mem.expired({ text: '他喜欢猫', stale: true }, NOW), true);
});

t('render 不再把过期承诺塞进提示词', () => {
  const U = '2585086723';
  const db = { items: [
    { id: 'a', text: '答应他明早换衣服拍照发给他', kind: 'core', at: T - 2 * DAY, w: 1 },
    { id: 'b', text: '他叫钟梓润', kind: 'core', at: T - 30 * DAY, w: 1 },
  ] };
  mem.save(U, db);
  const out = mem.render(U, '', {});
  const text = typeof out === 'string' ? out : out.text;
  assert.ok(!text.includes('换衣服拍照'), '过期的承诺不该出现：' + text);
  assert.ok(text.includes('钟梓润'), '长期事实要留着：' + text);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
