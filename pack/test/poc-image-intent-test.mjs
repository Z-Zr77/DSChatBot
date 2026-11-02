// 生图/自拍第一轮修复的验收用例（2026-10-30 修改指导）
// 只测"判定与状态"，不调模型；真实出图另行人工验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-'));
process.env.QQBOT_DATA = TMP;

const src = fs.readFileSync(path.join('pack', 'src', 'bridge.mjs'), 'utf8');
const selfSrc = fs.readFileSync(path.join('pack', 'src', 'self.mjs'), 'utf8');
const ii = await import('file://' + path.join(process.cwd(), 'pack', 'src', 'imageintent.mjs').replace(/\\/g, '/'));
const self = await import('file://' + path.join(process.cwd(), 'pack', 'src', 'self.mjs').replace(/\\/g, '/'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}

// ---------- 一、画面里是谁 ----------
t('#1 我在书桌前站好，穿深蓝女仆装，全身照 → 含她（photo）', () => {
  const r = ii.subjectOf('我在书桌前站好，穿深蓝女仆装，全身照');
  assert.equal(r.role, 'her');
  assert.equal(r.shot, 'photo');
});

t('#2 不要我入镜，只拍书桌 → 无人', () => {
  assert.equal(ii.subjectOf('不要我入镜，只拍书桌').role, 'none');
});

t('#3 我想看这件女仆装的商品图，不要人物 → 无人（我≠画面人物）', () => {
  assert.equal(ii.subjectOf('我想看这件女仆装的商品图，不要人物').role, 'none');
});

t('#4 我想画全身镜，镜子前不要站人 → 全身不是有人出现的证据', () => {
  assert.equal(ii.subjectOf('我想画全身镜，镜子前不要站人').role, 'none');
});

t('#5 书桌上一台显示器 → 无人', () => {
  assert.equal(ii.subjectOf('书桌上一台显示器').role, 'none');
});

t('#6 自拍 → 含她 + shot=selfie', () => {
  const r = ii.subjectOf('来一张自拍，我在窗边');
  assert.equal(r.role, 'her');
  assert.equal(r.shot, 'selfie');
});

// ---------- 二、这轮给了什么衣服 ----------
t('#7 换上了米白罗纹紧身短裙、黑色连裤袜 → 无残留前缀，整套保留', () => {
  const r = ii.outfitOf('换上了米白罗纹紧身短裙、黑色连裤袜');
  assert.equal(r.explicit, true);
  assert.equal(r.text, '米白罗纹紧身短裙、黑色连裤袜');
});

t('#8 明天再穿白裙 → 计划，不算现在这身', () => {
  const r = ii.outfitOf('明天再穿白裙');
  assert.equal(r.explicit, false);
  assert.equal(r.planned, true);
});

t('#9 这次不要换衣服 → 否定', () => {
  const r = ii.outfitOf('这次不要换衣服');
  assert.equal(r.explicit, false);
  assert.equal(r.negated, true);
});

t('#10 换好了，再拍一张 → 没有新衣服信息', () => {
  const r = ii.outfitOf('换好了，再拍一张');
  assert.equal(r.explicit, false);
  assert.equal(r.text, '');
});

t('#10b 整句里只摘衣服（不把场景、光线、构图塞进穿着）', () => {
  const r = ii.outfitOf('我在书桌前站好，穿深蓝女仆装，全身照，屋里光线偏暗');
  assert.equal(r.explicit, true);
  assert.equal(r.text, '深蓝女仆装');
});

// ---------- 三、穿着状态保持 ----------
t('#11 设过之后能读回；再设覆盖', () => {
  self.setOutfit('米白短裙、黑色连裤袜', 'her');
  assert.equal(self.getOutfit().text, '米白短裙、黑色连裤袜');
  self.setOutfit('黑色吊带短裙黑丝袜', 'his');
  assert.equal(self.getOutfit().src, 'his');
});

t('#12 「换好了」有明确待办目标 → 落实它', () => {
  self.setOutfit('黑色吊带短裙黑丝袜', 'his');
  self.setPendingOutfit('米白短裙、黑色连裤袜');
  const applied = self.takePendingOutfit();
  assert.equal(applied.text, '米白短裙、黑色连裤袜');
  assert.equal(self.getOutfit().text, '米白短裙、黑色连裤袜');
});

t('#13 「换好了」没有待办目标 → 保持原样，不回退外套长裤', () => {
  self.setOutfit('米白短裙、黑色连裤袜', 'her');
  assert.equal(self.takePendingOutfit(), null);
  assert.equal(self.getOutfit().text, '米白短裙、黑色连裤袜');
});

t('#14 穿着状态独立于上一张照片文件（照片删了也不影响）', () => {
  self.setOutfit('米白短裙、黑色连裤袜', 'her');
  const fake = path.join(TMP, 'nope.png');
  assert.equal(fs.existsSync(fake), false);
  assert.equal(self.getOutfit().text, '米白短裙、黑色连裤袜');
});

// ---------- 四、道具：复合词与否定 ----------
t('#15 书桌 → 不需要书', () => {
  assert.deepEqual(ii.propsOf('书桌上一台显示器'), []);
});

t('#16 画面里是一碗面 → 不需要面（画面/面条是复合词）', () => {
  assert.deepEqual(ii.propsOf('画面里是一碗面'), []);
});

t('#17 手里端着一碗面 → 需要面', () => {
  assert.deepEqual(ii.propsOf('手里端着一碗面'), ['面']);
});

t('#18 没有包子 → 否定不算必需', () => {
  assert.deepEqual(ii.propsOf('手里没有包子'), []);
});

t('#19 电脑桌 → 不需要电脑', () => {
  assert.deepEqual(ii.propsOf('电脑桌上放着键盘'), []);
});

// ---------- 五、参考图用途 ----------
t('#20 收图时判定用途：衣服 / 画稿', () => {
  assert.equal(ii.refPurposeOf('穿上这套'), 'clothes');
  assert.equal(ii.refPurposeOf('这是画稿你帮我看看'), 'doc');
  assert.equal(ii.refPurposeOf('给你看看'), 'unknown');
});

t('#21 只有明确点名才算"用他发的那张"', () => {
  assert.equal(ii.pointsAtRef('穿上这套'), true);
  assert.equal(ii.pointsAtRef('照着图上的样子画'), true);
  assert.equal(ii.pointsAtRef('在干嘛呢'), false);
});

// ---------- 六、接线（静态）----------
t('#22 两条链共用同一个参考图选择函数', () => {
  assert.match(src, /const hisRef = refForClothes\(memKeyOf\(conv\), String\(desc \|\| ''\)\)/);
  assert.match(src, /const hisRef = refForClothes\(memKeyOf\(conv\), sTxt \+ ' ' \+ askTxt\)/);
  assert.doesNotMatch(src, /useHisRef = !!hisRef && \(changing/);
});

t('#23 参考图绑定用途 + TTL 只做兜底', () => {
  assert.match(src, /function refForClothes\(uin, text\)/);
  assert.match(src, /if \(!imageintent\.pointsAtRef\(s\)\) return '';/);
  assert.match(src, /purpose === 'doc'\) continue/);
});

t('#24 不再因为"提到道具"就用最近一张图', () => {
  assert.doesNotMatch(src, /propsIn\(sTxt\)\.length > 0/);
});

t('#25 删掉了"检测到换衣但没新衣服 → 外套+长裤"的默认回退', () => {
  assert.doesNotMatch(src, /else if \(changing\) outfit = dressWord \? dressWord : '日常外出装/);
  assert.match(src, /outfitSrc = 'keep'/);
});

t('#26 穿着不再从上一张照片的 outfit 继承', () => {
  assert.doesNotMatch(src, /else if \(cont && prev && prev\.outfit\) outfit = prev\.outfit/);
});

t('#27 propsIn 走 imageintent.propsOf，且补画仍由 missing.length 把关', () => {
  assert.match(src, /function propsIn\(text\) \{\s*return imageintent\.propsOf\(text\);/);
  assert.match(src, /if \(ALLOW_REDRAW && missing\.length\) \{/);
});

t('#28 判定没有塞回 bridge（HER_RE/PRESENCE_RE 已删除，只在 imageintent 里）', () => {
  assert.doesNotMatch(src, /const PRESENCE_RE/);
  assert.doesNotMatch(src, /const HER_RE/);
  assert.match(selfSrc, /export function getOutfit/);
});


t('#29 手里有东西时不能再说举着手机自拍（手多了的根因）', () => {
  assert.match(selfSrc, /selfieBusy:/);
  assert.match(selfSrc, /const busy = opts.handsBusy === true;/);
  assert.match(selfSrc, /只出现她的两只手、两条胳膊/);
  assert.match(src, /const busyHands = \//);
  assert.match(src, /handsBusy: busyHands/);
});

t('#30 出图后查形体，多手就重画一次，并记日志', () => {
  assert.match(src, /async function selfieAudit\(file\)/);
  assert.match(src, /HANDS=/);
  assert.match(src, /ARMS=/);
  assert.match(src, /audit.bad/);
  assert.match(src, /重画后形体/);
  assert.match(src, /let audit = await selfieAudit\(shot\.file\);/);
});

t('#31 没有新衣服时，先沿用上一张的穿着，别退成日常便装', () => {
  assert.match(src, /outfitSrc = 'prev'/);
  assert.match(src, /outfit = prev.outfit/);
});


t('#32 通用默认（便装/家居服）不落状态、也不算她真实这身', () => {
  assert.ok(src.includes('const GENERIC_WEAR ='));
  assert.ok(src.includes('日常便装：简单上衣'));
  assert.ok(src.includes('const curOk = !!(curWear'));
  assert.ok(!src.includes("self.setOutfit(outfit, 'init')"));
});

t('#33 上一张不太旧时，衣服跟着上一张走（不再因为换地点/超时就丢）', () => {
  assert.ok(src.includes('prev.outfit && !GENERIC_WEAR.test(prev.outfit)'));
  assert.ok(src.includes('12 * 3600e3'));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
