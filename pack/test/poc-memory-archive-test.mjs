// 长期档案（2026-11-01）：活跃记忆只留"现在还活着"的，合并掉和放久淡掉的都会消失，
// 于是"一个月前他说过什么"她永远想不起来。档案层要把这些留下来，聊到相关话题时能翻出来。
// 跑法：node pack\run-tests.mjs（或单独 node pack\test\poc-memory-archive-test.mjs）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memarch-'));
process.env.QQBOT_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'agent-home', 'memory', 'people'), { recursive: true });

const SRC = path.resolve('pack', 'src');
const mem = await import(new URL('file:///' + path.join(SRC, 'memory.mjs').replace(/\\/g, '/')).href);

const UIN = '2585086723';
const PEOPLE = path.join(tmp, 'agent-home', 'memory', 'people');
const F = path.join(PEOPLE, UIN + '.json');
const FA = path.join(PEOPLE, UIN + '.archive.json');
const DAY = 86400000;
const NOW = Date.now();

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}
const put = (items) => fs.writeFileSync(F, JSON.stringify({ items }));
const read = () => JSON.parse(fs.readFileSync(F, 'utf8')).items;
const arch = () => JSON.parse(fs.readFileSync(FA, 'utf8')).items;
const reset = () => { fs.rmSync(F, { force: true }); fs.rmSync(FA, { force: true }); };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// 1. 合并掉的进档案，不再是"直接消失"
reset();
put([
  { id: 'a1', text: '他下周三要去面试', kind: 'fact', w: 1, created: iso(NOW), last: iso(NOW), hits: 2, at: NOW },
  { id: 'a2', text: '他下周三要去面试这件事', kind: 'fact', w: 1, created: iso(NOW), last: iso(NOW), hits: 1, at: NOW },
]);
check('合并掉的条目进了档案', () => {
  const r = mem.consolidate(UIN);
  assert.ok(r.merged >= 1);
  assert.equal(read().length, 1);
  assert.ok(arch().length >= 1);
  assert.ok(arch().every((x) => x.why));
});

// 2. 放久了的琐事挪进档案（不是删掉）
reset();
put([
  { id: 'b1', text: '他提到楼下有一家卖糖炒栗子的摊', kind: 'fact', w: 1, hits: 0,
    created: iso(NOW - 45 * DAY), last: iso(NOW - 45 * DAY), at: NOW - 45 * DAY },
  { id: 'b2', text: '他住在武汉', kind: 'core', w: 1, hits: 0,
    created: iso(NOW - 45 * DAY), last: iso(NOW - 45 * DAY), at: NOW - 45 * DAY },
]);
check('放久淡掉的进档案，core 留下', () => {
  mem.consolidate(UIN);
  const live = read().map((x) => x.text);
  assert.equal(live.length, 1);
  assert.equal(live[0], '他住在武汉');
  assert.ok(arch().some((x) => x.text.includes('糖炒栗子')));
});

// 3. 聊到相关话题时能从档案里翻出来（同一套 query 向量，不额外调模型）
reset();
const V = [1, 0, 0, 0];
put([{ id: 'c1', text: '他住在武汉', kind: 'core', w: 1, hits: 0, created: iso(NOW), last: iso(NOW), at: NOW }]);
fs.writeFileSync(FA, JSON.stringify({ items: [
  { text: '他提过小时候在汉江边长大', at: NOW - 40 * DAY, kind: 'fact', why: '放久了', vec: V, vecSig: 'S' },
]}));
check('档案命中时给出「很久以前的事」并带日期', () => {
  const r = mem.render(UIN, '', { vec: V, vecSig: 'S' });
  assert.ok(/很久以前的事/.test(r.text), r.text);
  assert.ok(/月/.test(r.text));
  assert.ok(r.old.length === 1);
});

// 4. 向量换了坐标系（换了 embedding 模型）就不许比
check('换了 embedding 空间后档案不参与召回', () => {
  const r = mem.render(UIN, '', { vec: V, vecSig: 'T' });
  assert.ok(!/很久以前的事/.test(r.text), r.text);
});

// 5. "忘了那条"真的忘掉
reset();
put([{ id: 'd1', text: '他下周三要去面试', kind: 'fact', w: 1, hits: 1, created: iso(NOW), last: iso(NOW), at: NOW }]);
check('他说忘掉，就真的忘掉那条', () => {
  const r = mem.forgetByInstruction(UIN, '忘掉我下周三要去面试这事吧');
  assert.equal(r.removed, 1);
  assert.equal(read().length, 0);
});

// 6. core 默认不删，先问一句
reset();
put([{ id: 'e1', text: '他下周三要去面试', kind: 'core', w: 1, hits: 1, created: iso(NOW), last: iso(NOW), at: NOW }]);
check('core 级事实默认不动，先问一句', () => {
  const r = mem.forgetByInstruction(UIN, '忘掉我下周三要去面试这事');
  assert.equal(r.removed, 0);
  assert.equal(r.blocked, 1);
  assert.equal(read().length, 1);
});

// 7. 他说"一定要"才动 core
check('他说「一定要忘掉」才动 core', () => {
  const r = mem.forgetByInstruction(UIN, '一定要忘掉我下周三要去面试这事');
  assert.equal(r.removed, 1);
  assert.equal(read().length, 0);
});

// 8. 光说"忘了"不算指令，别误删
reset();
put([{ id: 'f1', text: '他喜欢吃虾', kind: 'fact', w: 1, hits: 1, created: iso(NOW), last: iso(NOW), at: NOW }]);
check('没有具体指代的不算遗忘指令', () => {
  assert.equal(mem.forgetByInstruction(UIN, '忘了').removed, 0);
  assert.equal(mem.forgetByInstruction(UIN, '我刚才忘了带钥匙').removed, 0);
  assert.equal(read().length, 1);
});

// 9. 档案有上限，不会无限长
reset();
check('档案最多留 400 条', () => {
  for (let i = 0; i < 405; i++) mem.archiveAdd(UIN, { text: '旧事 ' + i, at: NOW - i * DAY, kind: 'fact' }, '测试');
  assert.equal(mem.archiveCount(UIN), 400);
});

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
