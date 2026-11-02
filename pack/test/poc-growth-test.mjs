// 三步验收：长期自我事实 / 经验库 / 技能成长（工具调用记录）
// 跑法：node pack\poc-growth-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-growth-'));
process.env.QQBOT_DATA = DATA;
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });

const lessons = await import('../src/lessons.mjs');
const sf = await import('../src/self-facts.mjs');
const skills = await import('../src/skills.mjs');

let pass = 0, fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

const U = '1234567890';
const DAY = 86400e3;

// ---------- 经验库 ----------
t('经验库：他夸了就存一条', () => {
  const r = lessons.note({ uin: U, his: '今天好累啊', mine: '那早点睡，别硬撑着', reaction: '哈哈谢谢你真贴心', at: Date.now() });
  assert.ok(r && r.id, '应该存下一条');
  assert.equal(lessons.list(U).length, 1);
});

t('经验库：中性/负面的反应不学', () => {
  lessons.note({ uin: U, his: '在干嘛', mine: '躺着呢', reaction: '哦' });
  assert.equal(lessons.list(U).length, 1, '中性不应该新增');
});

t('经验库：同场景相似说法会去重加分', () => {
  const before = lessons.list(U)[0].score;
  lessons.note({ uin: U, his: '今天好累啊', mine: '那早点睡，别硬撑着', reaction: '哈哈好乖' });
  assert.equal(lessons.list(U).length, 1, '不该重复存');
  assert.ok(lessons.list(U)[0].score >= before);
});

t('经验库：只回一个表情/太短的不学（真机上踩到过）', () => {
  const n0 = lessons.list(U).length;
  const a = lessons.note({ uin: U, his: '帮我跑个命令', mine: '🙄', reaction: '真乖' });
  const b = lessons.note({ uin: U, his: '帮我跑个命令', mine: '嗯', reaction: '真乖' });
  assert.equal(a, null, '表情不该存');
  assert.equal(b, null, '嗯不该存');
  assert.equal(lessons.list(U).length, n0, '数量不该变');
});

t('经验库：类似场景能捡回来', () => {
  const r = lessons.render(U, '今天真的好累', 2);
  assert.ok(r.includes('早点睡'), '应该带出那条经验：' + r);
  assert.ok(r.includes('别一字不差'));
});

t('经验库：不相干的场景不乱套', () => {
  const r = lessons.render(U, '帮我看看这段代码', 2);
  assert.ok(!r.includes('早点睡'), '不该硬套：' + r);
});

t('经验库：他不满意会扣分', () => {
  const before = lessons.list(U)[0].score;
  lessons.note({ uin: U, his: '今天好累啊', mine: '那早点睡，别硬撑着', reaction: '烦，别说了' });
  assert.ok(lessons.list(U)[0].score < before, '分数应该降');
});

// ---------- 长期自我事实 ----------
const SF = path.join(DATA, 'self-facts.json');
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function seed(days) { fs.writeFileSync(SF, JSON.stringify({ days }, null, 2)); }

t('长期事实：今天的进"今天"，过去的进"这段时间"', () => {
  const now = Date.now();
  const yday = now - DAY;
  seed({ [dayKey(now)]: [{ tag: '洗过澡了', at: now - 600e3, n: 1 }], [dayKey(yday)]: [{ tag: '出过门', at: yday, n: 1 }] });
  const today = sf.render(8);
  assert.ok(today.includes('洗过澡了'), '今天该有：' + today);
  assert.ok(!today.includes('出过门'), '今天不该有昨天的事：' + today);
  const long = sf.renderLong(4, now);
  assert.ok(long.includes('出过门'), '长期里应该有：' + long);
  assert.ok(long.includes('这段时间'));
});

t('长期事实：太旧的会被时间衰减掉', () => {
  const now = Date.now();
  seed({ [dayKey(now)]: [{ tag: '洗过澡了', at: now, n: 1 }], [dayKey(now - 60 * DAY)]: [{ tag: '写过稿', at: now - 60 * DAY, n: 1 }] });
  const long = sf.renderLong(4, now);
  assert.ok(!long.includes('写过稿'), '60 天前的应该淡出：' + long);
});

t('长期事实：30 天窗口（7 天之前不再被裁掉）', () => {
  const now = Date.now();
  seed({ [dayKey(now - 10 * DAY)]: [{ tag: '跑了步', at: now - 10 * DAY, n: 1 }] });
  // 再走一次 add()，触发 30 天裁剪
  sf.add(['洗过澡了']);
  const raw = JSON.parse(fs.readFileSync(SF, 'utf8'));
  const flat = JSON.stringify(raw);
  assert.ok(flat.includes('跑了步'), '10 天前的记录应还在文件里');
});
// ---------- 技能成长 ----------
t('技能：成功一次记一条', () => {
  const it = skills.note({ uin: U, name: 'list_dir', args: { path: 'C:/qqbot' }, res: { ok: true, out: '[D] src' } });
  assert.ok(it && it.ok);
  assert.equal(skills.stats(U).by.list_dir.ok, 1);
});

t('技能：失败会留下"上次这样失败过"', () => {
  skills.note({ uin: U, name: 'read_file', args: { path: 'C:/Windows/win.ini' }, res: { ok: false, err: '路径不在允许范围：C:/Windows/win.ini' } });
  const h = skills.hintText(U, 'read_file');
  assert.ok(h.includes('以前试过'), h);
  assert.ok(h.includes('不在允许范围'), h);
});

t('技能：没失败过就不啰嗦', () => {
  assert.equal(skills.hintText(U, 'list_dir'), '');
});

t('技能：只记最近 120 条', () => {
  for (let i = 0; i < 130; i++) skills.note({ uin: U, name: 'list_dir', args: { path: 'x' }, res: { ok: true, out: '' } });
  assert.ok(skills.list(U).length <= 120);
});

// ---------- 静态接线 ----------
t('bridge：工具轮在回复链里、只在允许的会话里跑', () => {
  const s = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(s.includes('// ---------- 工具轮（T1）'), '缺工具轮');
  assert.ok(s.includes('function toolsAllowed(conv, extras = {})'), '缺守门');
  assert.ok(s.includes("if (conv.kind === 'local') return true;"));
  assert.ok(s.includes('return String(conv.id) === String(cfg.ownerUin) || !c.ownerOnly;'), '私聊只给主人');
  assert.ok(s.includes('for (let round = 0; round < TC.maxRounds; round++)'), '缺轮数上限');
  assert.ok(s.includes("skills.note({ uin: mk, name: tc.name, args: tc.args, res });"), '缺记录');
  assert.ok(s.includes('skills.hintText(mk, tc.name)'), '缺失败提醒');
  assert.ok(s.includes('toolsAllowed(conv, extras) ? TOOL_PROMPT : '), '提示词没接');
});

t('bridge：工具 JSON 不会漏进正文', () => {
  const s = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(s.includes('万一最后一轮还是工具调用'), '缺剥离');
  assert.ok(s.includes('(?:工具|TOOL)[\\s\\S]*?'), '剥离正则不对');
});

t('bridge：经验库与长期事实都进了提示词', () => {
  const s = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  const n = (s.match(/lessonsNote,/g) || []).length;
  assert.equal(n, 2, '两条通道都要有经验库，实际 ' + n);
  assert.ok(s.includes('selffacts.renderLong(4)'), '缺长期事实');
  assert.ok(s.includes('lessons.note({ uin: mkL'), '缺判好坏');
});

t('bridge：模型名/会话都不许乱写', () => {
  const s = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(s.includes('const again = await askBrain(body2, null);'), '工具结果要新起一轮，不能续会话');
});

for (const [name, fn] of cases) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '\n     ', e.message); fail++; }
}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
