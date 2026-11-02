// P1 复查修复的回归测例（2026-10-29 复查：数据保护 / 联系人隔离 / 输出后处理 / 自拍调用链）
// 跑法：node pack\poc-p1-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
process.env.QQBOT_DATA = path.join(T, 'data');
fs.mkdirSync(path.join(process.env.QQBOT_DATA, 'agent-home', 'memory', 'people'), { recursive: true });

const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' → ' + e.message); fail++; }
}

const memory = await import('../src/memory.mjs');
const settings = await import('../src/settings.mjs');
const PEOPLE = path.join(process.env.QQBOT_DATA, 'agent-home', 'memory', 'people');
const pfile = (uin) => path.join(PEOPLE, uin + '.json');

// ---------- 记忆：坏文件不许被覆盖成空库 ----------
t('坏记忆文件：读不炸、不覆盖、留 .corrupt 现场', () => {
  fs.writeFileSync(pfile('10000001'), '{"items": [ 坏掉的', 'utf8');
  const db = memory.load('10000001');
  assert.equal(db.items.length, 0);
  assert.equal(fs.readFileSync(pfile('10000001'), 'utf8'), '{"items": [ 坏掉的');
  const files = fs.readdirSync(PEOPLE).filter((f) => f.startsWith('10000001.json.corrupt-'));
  assert.equal(files.length, 1, '应另存一份 .corrupt-*');
});

t('正常记忆文件：读得回来', () => {
  memory.remember('10000002', '他下周三有面试', { kind: 'fact' });
  memory.remember('10000002', '妹妹下周三考试', { kind: 'fact' });
  const db = memory.load('10000002');
  assert.equal(db.items.length, 2);
});

t('forgetByKeyword：只删说得上的那条，不连带删相似记忆', () => {
  const n = memory.forgetByKeyword('10000002', '下周三有面试');
  assert.equal(n, 1);
  const left = memory.load('10000002').items.map((i) => i.text);
  assert.deepEqual(left, ['妹妹下周三考试']);
});

t('forgetByKeyword：短描述只做包含匹配，不按相似度乱删', () => {
  const n = memory.forgetByKeyword('10000002', '下周三');
  // "下周三"只有 2 个二字片段（<3），只删包含它的；"妹妹下周三考试"含"下周三"会被删——这是包含匹配的语义
  assert.equal(n, 1);
  assert.equal(memory.load('10000002').items.length, 0);
});

t('记忆写盘是原子的：不留下 .tmp', () => {
  memory.remember('10000003', '测试原子写', { kind: 'fact' });
  const tmp = fs.readdirSync(PEOPLE).filter((f) => f.endsWith('.tmp'));
  assert.equal(tmp.length, 0);
});

// ---------- 配置：坏主文件不许盖掉好备份 ----------
const CFG = settings.FILE;
t('配置：只提交部分字段时，其余字段保留（画图 Key 不被重置）', () => {
  settings.save({ draw: { key: 'sk-keep-me', model: 'doubao-x' } });
  settings.save({ voice: { enabled: true } });
  const cur = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  assert.equal(cur.draw.key, 'sk-keep-me');
  assert.equal(cur.draw.model, 'doubao-x');
});

t('配置：主文件坏了，新的保存不会把好 .bak 覆盖掉', () => {
  const bak = CFG + '.bak';
  assert.ok(fs.existsSync(bak), '应有 .bak');
  const goodBak = fs.readFileSync(bak, 'utf8');
  JSON.parse(goodBak);                       // 备份本身是好的
  fs.writeFileSync(CFG, '{ 这不是 JSON', 'utf8');
  settings.save({ voice: { enabled: false } });
  assert.equal(fs.readFileSync(bak, 'utf8'), goodBak, '.bak 必须保持原样');
  const cur = JSON.parse(fs.readFileSync(CFG, 'utf8'));   // 新写入的仍是完整 JSON
  assert.equal(typeof cur, 'object');
});

// ---------- 静态回归：bridge / self / ui / draw 的关键分支 ----------
t('bridge：lastPlace 用 QQ 号文件名（memKeyOf），不再用 convKey', () => {
  const s = src('bridge.mjs');
  assert.match(s, /lastPlace\(memKeyOf\(conv\)\)/);
  assert.doesNotMatch(s, /lastPlace\(convKey\(conv\)\)/);
});

t('bridge：lastPlace 只认她自己说的、跳过否定与计划', () => {
  const s = src('bridge.mjs');
  assert.match(s, /if \(!line\.includes\('\[我\]'\)\) continue;/);
  assert.match(s, /不在\|没在\|不去\|没去\|不待\|不回/);
  assert.match(s, /明天\|后天\|下周\|下个月\|周末\|放假/);
});

t('bridge：地位变化不再"接着上一张"', () => {
  const s = src('bridge.mjs');
  assert.match(s, /const placeMoved = placeKnown \? prev\.place !== placeHint : false;/);
  assert.match(s, /const cont = canCarry && !placeMoved/);
});

t('bridge：回复定稿后重新拆心里话/动作，并把副作用放到定稿之后', () => {
  const s = src('bridge.mjs');
  assert.match(s, /const fin = splitInner\(finalRaw\)/);   // 定稿按重写后的原始稿拆（媒体动作不能丢）
  assert.match(s, /const P1 = extractMemos\(fin\.visible\)/);
  assert.match(s, /let P0 = extractMemos\(visible\)/);
});

t('bridge：3098 本地通道有 Host/Origin 守门，/proactive 只收 POST', () => {
  const s = src('bridge.mjs');
  assert.match(s, /function __localGuard\(req, res\)/);
  assert.match(s, /if \(!__localGuard\(req, res\)\) return;/);
  assert.match(s, /if \(req\.method !== 'POST'\) return __json\(res, 405/);
  assert.match(s, /sec-fetch-site/);
});

t('bridge：QQ 离线时主动消息只发给主人', () => {
  const s = src('bridge.mjs');
  assert.match(s, /cands\.filter\(\(\[u\]\) => String\(u\) === String\(cfg\.ownerUin\)\)/);
});

t('bridge：自拍显式给参考图（接上一张 / 固定形象图；换装时不用上一张）', () => {
  const s = src('bridge.mjs');
  assert.match(s, /opts\.refFile = changing \? herRef : \(cont \? prev\.file : herRef\)/);
});

t('self：不再写死室内光，地点按室内外，白天/夜里分光', () => {
  const s = src('self.mjs');
  assert.match(s, /import \* as settings from '\.\/settings\.mjs';/);
  assert.match(s, /&& !INDOOR_RE\.test\(where\)/);
  assert.match(s, /night = hour < 6 \|\| hour >= 18/);
});

t('draw：参考图只认显式 refFile，提示词上限放宽到 1600', () => {
  const s = src('draw.mjs');
  assert.match(s, /const needRef = !!opts\.refFile \|\| \(Array\.isArray\(opts\.refFiles\) && opts\.refFiles\.length > 0\);/);
  assert.equal((s.match(/const ref = opts\.refFile \? fileToDataUrl\(opts\.refFile\) : '';/g) || []).length, 2);
  assert.match(s, /slice\(0, 1600\)/);
});

t('ui：控制台触发主动消息用 POST', () => {
  const s = src('ui.mjs');
  assert.match(s, /fetch\(LOCAL \+ '\/proactive', \{ method: 'POST' \}\)/);
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} — PASS ${pass} / FAIL ${fail}`);
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
