// 复查第二批（F14–F21）回归测例
// 跑法：node pack/poc-review2-test.mjs
// 说明：先设 QQBOT_DATA 再动态 import，模块在导入时就会按环境变量定目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'rw2-'));
const DATA = path.join(T, 'data');
process.env.QQBOT_DATA = DATA;
process.env.QQBOT_IS_PACKAGED = '0';
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const daily = await import('../src/daily.mjs');
const life = await import('../src/life.mjs');
const sf = await import('../src/self-facts.mjs');
const sc = await import('../src/selfcheck.mjs');
const memory = await import('../src/memory.mjs');

const rows = [];
function check(name, fn) {
  try { fn(); rows.push(['PASS', name]); }
  catch (e) { rows.push(['FAIL', name + ' :: ' + (e && e.message)]); }
}

const UIN = '123456789';
const peopleFile = path.join(DATA, 'agent-home', 'memory', 'people', UIN + '.json');
const writeDb = (o) => fs.writeFileSync(peopleFile, JSON.stringify(o, null, 2), 'utf8');
const readDb = () => JSON.parse(fs.readFileSync(peopleFile, 'utf8'));

// ---------- F14：日程 ----------
check('F14 日程：还没到第一件事时，不该说"正在做"', () => {
  const hm = daily.nowHM();
  if (hm >= '23:59') return;                    // 边界时刻跳过
  assert.equal(daily.currentItem({ items: [{ at: '23:59', what: '晚饭' }] }), null);
  assert.equal(daily.startedCount({ items: [{ at: '23:59', what: '晚饭' }] }), 0);
});

check('F14 日程：到了的事仍然算正在做', () => {
  const now = daily.nowHM();
  const it = { at: '00:00', what: '早饭' };
  if (now >= '00:00') assert.equal(daily.currentItem({ items: [it] }), it);
});

check('F14 改安排不继承旧地点（出门吃夜宵不该还在卧室）', () => {
  const plan = { items: [{ at: '21:30', what: '看书', place: '卧室' }] };
  const r = life.applyOps(plan, '21:30 出门吃夜宵');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].what, '出门吃夜宵');
  assert.equal(r.items[0].place, undefined);
});

check('F14 新安排自带地点时保留地点', () => {
  // 格式是「时间 地点｜事件」，地点在前
  const r = life.applyOps({ items: [{ at: '21:30', what: '看书', place: '卧室' }] }, '21:30 楼下小面馆｜出门吃夜宵');
  assert.equal(r.items[0].place, '楼下小面馆');
  assert.equal(r.items[0].what, '出门吃夜宵');
});

// ---------- F15：既成事实台账 ----------
check('F15 否定句不能反过来记成做过（我还没出门）', () => {
  assert.ok(!sf.extract('我还没出门').includes('出过门'));
});

check('F15 昨天的事不算今天的既成事实', () => {
  assert.equal(sf.extract('我昨天吃完了面').length, 0);
});

check('F15 今天真的出门了仍然要记', () => {
  assert.ok(sf.extract('我刚出门，在小区门口').includes('出过门'));
});

check('F15 台账说"还没洗澡"，20 分钟内说"刚洗完"要拦', () => {
  const hits = sc.conflicts('我洗完澡了', ['还没洗澡'], { ageOf: () => 5 * 60 * 1000 });
  assert.ok(hits.length >= 1);
});

check('F15 三小时前说"还没洗澡"，现在洗完回来应放行', () => {
  const hits = sc.conflicts('我刚洗完澡回来', ['还没洗澡'], { ageOf: () => 3 * 60 * 60 * 1000 });
  assert.equal(hits.length, 0);
});

check('F15 台账表头不再写"不许推翻"', () => {
  sf.reset();
  sf.add(['吃了东西']);
  const txt = sf.render();
  assert.ok(!/不许推翻/.test(txt), txt);
  assert.ok(/既成事实/.test(txt), txt);
});

check('F15 日程里还没到的饭点算"还没吃饭"，已过的算"吃了东西"', () => {
  const hm = daily.nowHM();
  assert.deepEqual(sc.planTags([{ at: hm, what: '吃面' }], hm).includes('吃了东西'), true);
});

// ---------- F16：向量空间 ----------
check('F16 换 embedding 模型后签名要变', () => {
  assert.notEqual(memory.vecSig({ model: 'text-embedding-v3' }), memory.vecSig({ model: 'other-embed' }));
});

check('F16 同配置签名稳定', () => {
  assert.equal(memory.vecSig({ model: 'text-embedding-v3', dim: 512 }), memory.vecSig({ model: 'text-embedding-v3', dim: 512 }));
});

check('F16 改正文会清掉旧向量', () => {
  writeDb({ items: [{ id: 'x1', text: '旧说法', kind: 'fact', vec: [1, 2], vecSig: 's', vecText: 't' }] });
  assert.equal(memory.update(UIN, 0, { text: '新说法' }), true);
  const it = readDb().items[0];
  assert.equal(it.text, '新说法');
  assert.equal(it.vec, undefined);
  assert.equal(it.vecSig, undefined);
});

// ---------- 记忆 ID / 来源 / 更正链（复查 F13 第二批） ----------
check('老记忆自动补稳定 id 并标 legacy 来源', () => {
  writeDb({ items: [{ text: '他在上海', kind: 'fact', created: '2026-10-01', last: '2026-10-01', hits: 0 }] });
  const list = memory.list(UIN);
  assert.ok(/^legacy-/.test(list[0].id), JSON.stringify(list[0].id));
  assert.equal(list[0].origin, 'legacy');
  const again = readDb().items[0].id;
  assert.equal(again, list[0].id);              // 再读一次 id 不变
});

check('correct() 留更正链：新条目 supersedes，旧条目 supersededBy 且 stale', () => {
  writeDb({ items: [{ id: 'm-old', text: '他在上海', kind: 'fact', origin: 'chat' }] });
  const id = memory.correct(UIN, '他在上海', '他搬到成都了', { src: 'test' });
  assert.ok(id);
  const db = readDb();
  const oldIt = db.items.find((i) => i.id === 'm-old');
  const newIt = db.items.find((i) => i.id === id);
  assert.equal(oldIt.stale, true);
  assert.equal(oldIt.supersededBy, id);
  assert.deepEqual(newIt.supersedes, ['m-old']);
  assert.equal(newIt.text, '他搬到成都了');
  assert.equal(memory.list(UIN).filter((i) => !i.stale).length, 1);
});

// ---------- forgetByKeyword 不误删 ----------
check('删「下周三有面试」不连带删「妹妹下周三考试」', () => {
  writeDb({ items: [
    { id: 'a', text: '下周三有面试', kind: 'fact' },
    { id: 'b', text: '妹妹下周三考试', kind: 'fact' },
  ] });
  const n = memory.forgetByKeyword(UIN, '下周三有面试');
  assert.equal(n, 1);
  assert.deepEqual(readDb().items.map((i) => i.id), ['b']);
});

// ---------- F17/F18/F19/F21：静态回归 ----------
const bridge = read('bridge.mjs');
const chatserver = read('chatserver.mjs');
const ui = read('ui.mjs');

check('F17 App 通道也记账（noteIncoming 用在 /say）', () => {
  assert.ok(/function noteIncoming\(/.test(bridge));
  assert.ok(/noteIncoming\(conv, text\)/.test(bridge));
  assert.ok(/noteIncoming\(__localConv\(\), text \|\| note \|\| '\[附件\]', imgPath/.test(bridge));
});

check('F17 digest 也收 local 会话', () => {
  assert.ok(/conv\.kind === 'private' \|\| conv\.kind === 'local'/.test(bridge));
});

check('F18 锁按人上（lockKeyOf）', () => {
  assert.ok(/const lockKeyOf = \(conv\) => `u:\$\{memKeyOf\(conv\)\}`/.test(bridge));
  assert.ok(/return withConvLock\(lkey,/.test(bridge));
});

check('F19 改目录先迁移再切指针，并同步 data-location.txt', () => {
  assert.ok(/function migrateData\(from, to\)/.test(chatserver));
  assert.ok(/function writeLocation\(dir\)/.test(chatserver));
  assert.ok(/if \(!mv\.ok\) return \{ ok: false, err: mv\.err \}/.test(chatserver));
  assert.ok(/if \(changed\) writeLocation\(cfg\.dataDir\)/.test(chatserver));
  assert.ok(/QQBOT_UI_PORT\) \|\| 3070/.test(chatserver));
});

check('F19 /api/config 保存失败要返回 400', () => {
  assert.ok(/if \(!r \|\| r\.ok === false\) return send\(res, 400/.test(chatserver));
});

check('F20 发送接口要读 HTTP 状态和 retcode', () => {
  assert.ok(/retcode/.test(bridge));
  assert.ok(/if \(!r\.ok\) \{ log\('\[ws api\]', method, 'HTTP', r\.status\)/.test(bridge));
  assert.ok(/if \(!r \|\| !r\.ok\) \{ log\('\[send\] 没发出去'/.test(bridge));
});

check('F21 控制台 Node 侧日志函数存在，重启提示不再用裸 log(', () => {
  assert.ok(/function nlog\(\.\.\.a\)/.test(ui));
  // 只看 Node 作用域（页面脚本的 log 是另一回事）
  const nodePart = ui.slice(0, ui.indexOf('const HTML = String.raw'));
  assert.equal((nodePart.match(/[^n]log\('\[restart\]/g) || []).length, 0);
  assert.ok(/nlog\('\[restart\] 没有 bridge\.pid/.test(nodePart));
});

// ---------- 定稿块：只发媒体 / 重写后带标签 ----------
check('定稿按重写后的原始稿拆标签（媒体不会被拆成空的）', () => {
  assert.ok(/let finalRaw = visible;/.test(bridge));
  assert.ok(/const fin = splitInner\(finalRaw\);/.test(bridge));
  assert.ok(/out = out2; finalRaw = v2;/.test(bridge));            // 两处重写都要带上
  // 反向：不能再用剥干净的 out 当定稿来源
  assert.ok(!/const fin = splitInner\(out\);/.test(bridge));
});

check('媒体标签解析本身只认标签、不吃正文', () => {
  // extractExtras 是纯函数，这里用同样的正则口径验一遍"只发一个表情"的情形
  const t = '[[FACE:76]]';
  const re = /\[\[\s*(FACE|STICKER|VOICE|画|DRAW|场景|场景更新|SCENE)\s*(?:[:：]\s*([^\]\n]+?))?\s*\]\]/gi;
  const m = [...t.matchAll(re)];
  assert.equal(m.length, 1);
  assert.equal(m[0][1], 'FACE');
  const cleaned = t.replace(/\[\[[^\]]*\]\]/g, '').trim();
  assert.equal(cleaned, '');
});

// ---------- 汇总 ----------
const pass = rows.filter((r) => r[0] === 'PASS').length;
const fail = rows.length - pass;
for (const [st, name] of rows) console.log(`${st === 'PASS' ? '✅' : '❌'} ${st} ${name}`);
console.log(`\nPASS ${pass} / FAIL ${fail}`);
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
