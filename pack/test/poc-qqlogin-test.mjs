// QQ 登录：扫码是唯一入口，但只扫一次。
//
// 事实（2026-11-02 真机验证）：NapCat 拉起 QQ 时是无窗口的（靠注入 hook 把码写成文件），
// 没有地方输密码，也找不到任何 password 配置——所以"密码登录"在 NapCat 这条路上不存在。
// 结论：保留扫码，但把它做成"一次性"：登录态留在本机，之后开机自动登回去。
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '  ' + e.message); fail++; }
};

const ui = fs.readFileSync('pack/src/ui.mjs', 'utf8');
const ql = fs.readFileSync('pack/src/qqlogin.mjs', 'utf8');
const qqSection = ui.split('<section id="qq">')[1].split('</section>')[0];

t('QQ 页：扫码入口在，且有二维码容器', () => {
  assert.ok(qqSection.includes('qqScanNow'), '没有扫码按钮');
  assert.ok(qqSection.includes('id="qrSlot"'), '没有二维码容器');
  assert.ok(!qqSection.includes('账号密码登录'), 'QQ 页还写着密码登录');
});

t('登一次就够的说法要写清楚', () => {
  // SnowLuma 用网页里账号密码登一次，NapCat 扫码一次；两种都只需一次
  assert.ok(/扫一次|登一次/.test(qqSection), '页面没有说明"一次就够"');
  assert.ok(/登录态/.test(qqSection), '页面没有说明登录态会留在本机');
});

t('扫码动作：先拉起内核，再等码出来', () => {
  assert.ok(ui.includes('async function qqScanNow'), '没有 qqScanNow');
  assert.ok(ui.includes("api('/api/qr/refresh'"), '扫码没有触发内核重启');
  assert.ok(ui.includes('paintQr(st)'), '拿到码之后没画出来');
});

t('状态仍按内核 / 窗口 / 连接三段看', () => {
  assert.ok(ql.includes("count('NapCatWinBootMain.exe')"), '没数内核进程');
  assert.ok(ql.includes("count('QQ.exe')"), '没数 QQ 进程');
  assert.ok(ql.includes('3098/qq'), '没查桥接的 OneBot 状态');
  assert.ok(ql.includes("const stage = ws ? 'online'"), '没有 online 判定');
});

t('密码不落盘：代码里不该有写密码的地方', () => {
  assert.ok(!/password/i.test(ql), 'qqlogin 里出现了 password 字样');
  assert.ok(!/saveSetup\([^)]*pass/i.test(ui), 'setup 里像是存了密码');
});

console.log(`PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
