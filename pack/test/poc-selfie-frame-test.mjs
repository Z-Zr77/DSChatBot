// 「拍张全身照」被拍成半身：机位要靠他的原话定，不能靠她自己的画面描述。
// 这里只验判定和存取，不真画图（画一张 0.15 元）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfframe-'));
process.env.QQBOT_DATA = tmp;

const SRC = path.resolve('pack', 'src');
const self = await import(new URL('file:///' + path.join(SRC, 'self.mjs').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

t('"拍张全身照" → full', () => assert.equal(self.frameFromText('你现在穿的什么衣服，去房间里拍一张全身照给我看看'), 'full'));
t('"站起来我看看" → full', () => assert.equal(self.frameFromText('站起来我看看'), 'full'));
t('"给我看看上半身" → half（不能误判成全身）', () => assert.equal(self.frameFromText('给我看看上半身就行'), 'half'));
t('"拍张特写" → half', () => assert.equal(self.frameFromText('拍张特写'), 'half'));
t('普通一句"拍张我看看" → 不定机位', () => assert.equal(self.frameFromText('拍张我看看'), ''));
t('存了 full 就能读回来', () => {
  self.setFrame('full');
  assert.equal(self.frameWant(), 'full');
});
t('换进程重启也还在（落盘）', () => {
  const f = path.join(tmp, 'self', 'frame.json');
  assert.ok(fs.existsSync(f), '应该写进 frame.json：' + f);
});
t('用掉之后清掉，不会一直硬要全身', () => {
  self.clearFrame();
  assert.equal(self.frameWant(), '');
});
t('过期的偏好不认（30 分钟前的）', () => {
  const dir = path.join(tmp, 'self');
  fs.writeFileSync(path.join(dir, 'frame.json'), JSON.stringify({ kind: 'full', at: Date.now() - 31 * 60e3 }), 'utf8');
  assert.equal(self.frameWant(), '');
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
