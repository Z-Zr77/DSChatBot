// 表情表 / 换装链路 / 图片发送 的回归测例
// 跑法：node pack\poc-face-outfit-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', 'src', p), 'utf8');
const bridge = read('bridge.mjs');
const selfSrc = read('self.mjs');
const chatui = read('chatui.html');
const faceTable = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'src', 'facelist.json'), 'utf8'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message.split('\n')[0]); fail++; }
}

// ---- 表情表 ----
t('表情：提示词只列 facelist.json 里真实存在的 id', () => {
  const m = bridge.match(/const FACE_ZH = \{([\s\S]*?)\};/);
  assert.ok(m, '找不到 FACE_ZH');
  const ids = [...m[1].matchAll(/(\d+):/g)].map((x) => x[1]);
  assert.ok(ids.length >= 10, 'id 太少');
  const miss = ids.filter((id) => !faceTable[id]);
  assert.equal(miss.length, 0, '这些 id 表情表里没有：' + miss.join(','));
});

t('表情：不再出现 76赞 / 99鼓掌 / 106委屈 这类错标', () => {
  const code = bridge.replace(/^\s*\/\/.*$/gm, '');   // 注释里会引用旧清单做说明，不算
  assert.ok(!/76赞|99鼓掌|106委屈|179doge|203笑哭/.test(code), '还有错标的 id');
});

t('表情：查不到就跳过，不再降级成一个 🙂', () => {
  assert.ok(!/降级为/.test(bridge), '还有降级逻辑');
  assert.ok(/这条表情跳过/.test(bridge));
});

t('表情：提示词标注了含义（名字+表情），她知道自己选的是什么', () => {
  assert.ok(/id \+ 名字 \+ 表情/.test(bridge));
  assert.ok(/只能从下面这张表里选/.test(bridge));
});

// ---- 换装链路 ----
t('换装：正则认得出“换一套衣服 / 换一身 / 换掉”', () => {
  const m = bridge.match(/const changing = askedChange \|\| (\/[\s\S]*?\/)\.test\(sTxt\);/);
  assert.ok(m, '找不到 changing 正则');
  const re = eval(m[1]);
  for (const s of ['换一套衣服', '换一身', '换掉这身', '换上黑色卫衣', '换了件睡衣']) {
    assert.ok(re.test(s), '没认出来：' + s);
  }
});

t('需求识别：他明确要求换装时强制换（30 分钟窗口 + 只认他说的话）', () => {
  assert.ok(/function ownerDemands\(uin\)/.test(bridge));
  assert.ok(/30 \* 60e3/.test(bridge));
  assert.ok(/const askedChange = ownerAskedChange\(memKeyOf\(conv\)\);/.test(bridge));
  assert.ok(/function ownerAskedChange\(uin\) \{\s*return \(ownerDemands\(uin\)\.kinds\.clothes \|\| 0\) > 0;/.test(bridge));
  const kinds = [...bridge.matchAll(/\['(clothes|selfie|voice|place|show)', \/(.*?)\/\]/g)];
  assert.equal(kinds.length, 4, '四类内联正则');
  assert.ok(/\['selfie', imageintent\.PHOTO_ASK\]/.test(bridge), '自拍复用统一需求识别');
  const re = new RegExp(kinds.find((k) => k[1] === 'clothes')[2]);
  for (const s of ['换一套衣服嘛，怎么老是穿这个', '你换上那件卫衣试试', '换一身']) {
    assert.ok(re.test(s), '没认出来：' + s);
  }
});

t('需求识别：提了几次 + 语气硬度 → 生成"他这次是认真的"提示', () => {
  assert.ok(/function demandNote\(uin\)/.test(bridge));
  assert.ok(/他这次是认真的/.test(bridge));
  assert.ok(/n >= 2 \|\| d\.total >= 3/.test(bridge));
  assert.ok(/const DEMAND_STRONG =/.test(bridge));
  const strong = bridge.match(/const DEMAND_STRONG = (\/[\s\S]*?\/);/)[1];
  const re = eval(strong);
  assert.ok(re.test('求你了'), '没认出"求你了"');
  assert.ok(re.test('我说了几遍了'), '没认出"我说了几遍了"');
  assert.ok(re.test('快点！！！'), '没认出连打感叹号');
  assert.ok(!re.test('今天天气不错'), '普通句子不该算硬');
  assert.ok(/demandNote\(mk\)/.test(bridge), '提示词里没接上 demandNote');
});

t('换装：换装时不拿上一张当参考图（旧衣服会压回去）', () => {
  // 换装 → 固定形象图；没换装 → 固定图 + 上一张（脸和衣服各锁一张）
  assert.ok(/} else if \(changing\) \{[\s\S]{0,120}opts\.refFile = herRef;/.test(bridge), '换装时必须用固定形象图');
  assert.ok(/opts\.refFiles = conts/.test(bridge) && /opts\.refFile = prev\.file \|\| herRef/.test(bridge), '没换装时要带上上一张');
});

t('换装：提示词在换装时不再说“只改姿势/别换衣服”', () => {
  assert.ok(/opts\.changed === true/.test(selfSrc));
  assert.ok(/衣服\*\*必须换成下面这身\*\*/.test(selfSrc));
  assert.ok(/这是他明确要求换的/.test(selfSrc));
});

// ---- 图片发送 ----
t('图片：头像换图不再复用 #file（不会顶掉发图片）', () => {
  assert.ok(!/const f = \$\('#file'\);\s*\n\s*f\.value = '';\s*\n\s*f\.onchange/.test(chatui));
  assert.ok(/document\.createElement\('input'\)/.test(chatui));
});

t('图片：选了先进输入框（可带一句话一起发），失败要说清原因', () => {
  assert.ok(/function stageFile\(/.test(chatui), '没有 stageFile');
  assert.ok(/URL\.createObjectURL\(f\)/.test(chatui), '没有本地预览');
  assert.ok(/x-caption/.test(chatui), '没有把文字和图一起发');
  assert.ok(/没发出去：/.test(chatui), '失败没有提示');
  assert.ok(/const hasFiles = \(e\)/.test(chatui) && /dropHint/.test(chatui), '没有拖拽入口');
});

console.log(`\n${fail ? 'FAILED' : 'OK'} — PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
