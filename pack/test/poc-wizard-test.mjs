// 第一次见面向导：没配 Key 或没填"你是谁"时，控制台顶上出一张卡，三步做完就不再出现。
// 这个测试钉四件事：
//   ① 触发条件不能反——配好了还弹，是骚扰；没配却不弹，陌生人第一次打开就懵。
//   ② 「她叫什么」真的能存（POST /api/setup 以前只认 ownerUin）。
//   ③ 向导只走已有的三个接口（setup / brain / chat），不许自己发明后门。
//   ④ 做完要能关掉，不能卡住页面。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const ui = fs.readFileSync(path.join(SRC, 'ui.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

check('GET /api/setup 会把 name 和 keySet 一起吐出来', () => {
  assert.ok(/name: String\(s\.qq\?\.name \|\| ''\)/.test(ui), '没返回 name');
  assert.ok(/keySet: !!\(s\.api && s\.api\.key\)/.test(ui), '没返回 keySet');
});

check('POST /api/setup 能存「她叫什么」（不只是 ownerUin）', () => {
  const seg = ui.slice(ui.indexOf("if (p === '/api/setup')"), ui.indexOf("if (p === '/api/open-data'"));
  assert.ok(/b\.name !== undefined/.test(seg), '没处理 name 字段');
  assert.ok(/patch\.qq\.name = String\(b\.name/.test(seg), 'name 没写进 patch');
  // 只传 name 时不能把 ownerUin 清空
  assert.ok(/if \(b\.ownerUin !== undefined\)/.test(seg), 'ownerUin 被无条件覆盖了');
});

check('触发条件：配好了就不弹，没配才弹', () => {
  assert.ok(/if \(keySet && s && s\.ownerUin\) return;/.test(ui), '触发条件写错了');
  assert.ok(/setTimeout\(\(\) => \{ maybeWizard\(\); \}, 600\)/.test(ui), '启动时没调用 maybeWizard');
});

check('向导只走已有接口，不发明后门', () => {
  const start = ui.indexOf('async function wzSave');
  const end = ui.indexOf('loadState(); loadRecent(); loadPersona();', start);
  const seg = ui.slice(start, end > start ? end : start + 3000);
  const calls = (seg.match(/api\('([^']+)'/g) || []).map(s => s.slice(5, -1));
  const allowed = ['/api/setup', '/api/brain', '/api/restart', '/api/state', '/api/chat/send', '/api/chat/msgs'];
  for (const c of calls) {
    if (c.startsWith('/api/chat/msgs')) continue;
    assert.ok(allowed.includes(c), '用到了没在名单里的接口：' + c);
  }
});

check('做完了能关掉（否则整页被遮罩挡住）', () => {
  assert.ok(/e\.remove\(\); location\.reload\(\)/.test(ui), '完成后没有关闭遮罩');
  assert.ok(/\$\('#wzSkip'\)\.onclick = function\(\)\{ box\.remove\(\); goPage\('config'\); \}/.test(ui), '没有「去模型页自己填」的出口');
});

check('地址和模型默认收在「高级」里，做完能去聊天窗', () => {
  assert.ok(/<details class="wz-adv"><summary>高级<\/summary>/.test(ui), '高级折叠没了');
  assert.ok(!/<details class="wz-adv" open>/.test(ui), '高级不该默认展开');
  assert.ok(/去模型页自己填/.test(ui));
  assert.ok(/打开聊天窗/.test(ui));
  assert.ok(/留在控制台/.test(ui));
  assert.ok(/127\.0\.0\.1:3210/.test(ui), '打开聊天窗没有指向聊天端口');
});

check('第一次见面卡不再问关系/身份', () => {
  const start = ui.indexOf("box.innerHTML = ''");
  const end = ui.indexOf('document.body.appendChild(box)', start);
  const card = ui.slice(start, end);
  assert.ok(start > 0 && end > start, '找不到第一次见面的卡片');
  assert.ok(!card.includes('关系/身份') && !card.includes('wzRelationship'), '卡片里还留着身份选择');
  const save = ui.slice(ui.indexOf('async function wzSave'), ui.indexOf('loadState(); loadRecent();'));
  assert.ok(!save.includes('relationship'), '保存时还在写身份');
  assert.ok(ui.includes('关系/身份：朋友'), '人设页没有告诉人去人格提示词里写关系');
});

check('启动进控制台的第一次见面，QQ 向导不抢第一屏', () => {
  const main = fs.readFileSync(path.join(SRC, '..', 'electron', 'main.cjs'), 'utf8');
  const boot = main.slice(main.indexOf('async function boot'), main.indexOf("app.on('second-instance'"));
  const gate = main.slice(main.indexOf('function needsFirstMeet'), main.indexOf('function showWindow'));
  assert.ok(/function needsFirstMeet\(/.test(main));
  assert.ok(/ownerUin/.test(gate), '第一次见面的判定没看主人号');
  assert.ok(/const needFirstMeet = needsFirstMeet\(\)/.test(boot));
  assert.ok(!/loadURL\(WIZARD\)/.test(boot), '启动流程还会打开 QQ 向导');
  assert.ok(/win\.loadURL\(consoleUrl\(\)\)/.test(boot));
  const launch = fs.readFileSync(path.join(SRC, '..', 'launch.mjs'), 'utf8');
  const start = launch.slice(launch.indexOf('async function startAll'));
  const stripped = start.replace(/if \(process\.env\.QQBOT_WIZARD_ONLY === '1'\) \{ await startWizard\(\); return; \}/, '');
  assert.ok(!/startWizard\(/.test(stripped), '没显式要求时 startAll 仍会开向导');
  const brain = fs.readFileSync(path.join(SRC, 'brain.mjs'), 'utf8');
  assert.ok(!brain.includes('先在向导里填 API Key'), '缺 Key 的报错还在把人送进向导');
});

check('样式跟着控制台走（不能插到手机版那份样式里）', () => {
  const iCss = ui.indexOf('.wz-mask{');
  const iDeskNav = ui.indexOf('nav{width:212px;flex:0 0 212px;height:100vh;');
  const iMobileNav = ui.indexOf('nav{position:fixed;left:0;right:0;bottom:0;');
  assert.ok(iCss > 0 && iDeskNav > 0 && iMobileNav > 0);
  assert.ok(iCss < iDeskNav && iCss > iMobileNav, '向导样式没放在控制台那份样式表里');
});

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
