// 多参考图（她 + 他发的图）回归：换装/画东西时要把他那张一起送进生图模型
// 跑法：node pack\poc-multiref-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const src = (n) => fs.readFileSync(path.join('pack', 'src', n), 'utf8');
const bridge = src('bridge.mjs');
const draw = src('draw.mjs');
const selfSrc = src('self.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

t('draw：支持 refFiles 数组，多图走 image: [..]', () => {
  assert.ok(/Array\.isArray\(opts\.refFiles\)/.test(draw), '没有 refFiles');
  assert.ok(/const refs = Array\.isArray\(opts\.refFiles\)/.test(draw), '没有 refs');
  assert.ok(/body\.image = refs\.length === 1 \? refs\[0\] : refs/.test(draw), '多图没有按数组传');
});

t('draw：失败时按 多图 → 单图 → 纯文字 逐级退', () => {
  assert.ok(/if \(refs\.length > 1\) \{/.test(draw), '没有多图先试');
  assert.ok(/\[draw\] ark 多参考图失败/.test(draw), '多图失败没日志');
  assert.ok(/if \(ref\) \{\n\s*try \{\n\s*return \{ file: await call\(1\)/.test(draw), '没有退单图');
});

t('bridge：他发的图会留下指针（带用途，2 小时 TTL 只做兜底）', () => {
  assert.ok(/ps\.lastRefImg = it;/.test(bridge), '没记 lastRefImg');
  assert.ok(/ps\.refImgs = arr\.concat\(\[ it \]\)\.slice\(-6\)/.test(bridge), '没留用途历史');
  assert.ok(/function recentRefImg\(uin, ms = 2 \* 3600e3\)/.test(bridge), '没有 recentRefImg');
  assert.ok(/function refForClothes\(uin, text\)/.test(bridge), '没有按用途选图');
});

t('bridge：/say 收图时把路径传进 noteIncoming', () => {
  assert.ok(/noteIncoming\(__localConv\(\), text \|\| note \|\| '\[附件\]', imgPath && fs\.existsSync\(imgPath\) \? imgPath : ''\)/.test(bridge));
});

t('bridge：换装时把他的图一起给（refFiles=她+他，且必须点名）', () => {
  assert.ok(/const hisRef = refForClothes\(memKeyOf\(conv\), sTxt\)/.test(bridge), '没按用途取他的图');
  assert.ok(/opts\.refFiles = refFiles;/.test(bridge), '没传多图');
  assert.ok(/第1张是她本人（对脸、发型、耳鳍）；第2张是他刚发来的参考图/.test(bridge), '没写多图说明');
});

t('bridge：他点名的那身衣服优先，且不再回退到"日常外出装"', () => {
  assert.ok(bridge.includes("if (newWear.explicit) {"), '没优先用他的话');
  assert.ok(/outfit = newWear\.text;/.test(bridge), '没用他说的那身');
  assert.ok(/src=\$\{outfitSrc\}/.test(bridge), '日志没标来源');
});

t('bridge：画图通道也按用途选参考图（说"照这张"时）', () => {
  assert.ok(/const hisRef = refForClothes\(memKeyOf\(conv\), String\(desc \|\| ''\)\)/.test(bridge), '画图没按用途判断');
  assert.ok(/const wantHis = !!hisRef;/.test(bridge), '画图没判断');
  assert.ok(/if \(wantHis\) \{\n\s*const list = \[ref, hisRef\]/.test(bridge), '画图没传多图');
});

t('self：selfiePrompt/photoPrompt 支持 refNote', () => {
  assert.ok(/const refNoteRule = refNote \? `多图参考：\$\{refNote\}` : '';/.test(selfSrc), 'selfiePrompt 没有 refNote');
  assert.ok(/多图参考：\$\{String\(opts\.refNote\)\.trim\(\)\}/.test(selfSrc), 'photoPrompt 没有 refNote');
});

console.log(`\n${fail ? 'FAILED' : 'OK'} — PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
