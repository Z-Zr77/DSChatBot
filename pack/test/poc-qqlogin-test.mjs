// 密码登录：不走扫码，登录发生在 QQ 自己的窗口里。
//
// 起因（2026-11-02）：用户要求"QQ 登录同一改为密码登录，不要扫码了"。
// NapCat 是挂在真 QQ 客户端上的壳，没有登录接口，所以能做的只有两件事：
//   ① 把他引导到 QQ 窗口里点「账号密码登录」
//   ② 盯住三个阶段：内核起了 → QQ 开了 → OneBot 连上了
// 密码不经过我们，也不落盘。
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '  ' + e.message); fail++; }
};

const ui = fs.readFileSync('pack/src/ui.mjs', 'utf8');
const ql = fs.readFileSync('pack/src/qqlogin.mjs', 'utf8');

t('QQ 页：扫码入口没了，换成密码登录卡', () => {
  assert.ok(!/扫码登录 QQ/.test(ui.split('<section id="qq">')[1].split('</section>')[0]),
    'QQ 页里还有「扫码登录 QQ」按钮');
  assert.ok(ui.includes('id="qqLoginCard"'), '没有密码登录卡');
  assert.ok(ui.includes('启动 QQ，去登录'), '没有启动按钮');
});

t('三步文案写在后端，前端只显示', () => {
  assert.ok(ql.includes('export const STEPS'), 'qqlogin 没有导出 STEPS');
  assert.ok(/账号密码登录/.test(ql), '三步里没有「账号密码登录」');
  assert.ok(/是我本人/.test(ql), '三步里没有设备锁确认');
});

t('状态接口：内核 / QQ 窗口 / OneBot 三件都要看', () => {
  assert.ok(ql.includes("count('NapCatWinBootMain.exe')"), '没数内核进程');
  assert.ok(ql.includes("count('QQ.exe')"), '没数 QQ 进程');
  assert.ok(ql.includes('3098/qq'), '没查桥接的 OneBot 状态');
  assert.ok(ql.includes("stage: ws ? 'online'"), '没有 online 判定');
});

t('路由与前端都接上了', () => {
  assert.ok(ui.includes("p === '/api/qq/login/status'"), '没有状态路由');
  assert.ok(ui.includes("p === '/api/qq/login/start'"), '没有启动路由');
  assert.ok(ui.includes('function qqLoginRefresh'), '前端没有刷新函数');
  assert.ok(ui.includes('function qqLoginStart'), '前端没有启动函数');
});

t('密码不落盘：代码里不该有写密码的地方', () => {
  assert.ok(!/password/i.test(ql), 'qqlogin 里出现了 password 字样');
  assert.ok(!/saveSetup\([^)]*pass/i.test(ui), 'setup 里像是存了密码');
});

t('二维码那条路不再往页面里画（qrSlot 已删）', () => {
  assert.ok(ui.includes("if ($('#qrSlot')) paintQr(S);"), 'paintQr 没做空元素保护');
  assert.ok(!/<div id="qrSlot"><\/div>/.test(ui), '页面里还有 qrSlot 容器');
});

console.log(`PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
