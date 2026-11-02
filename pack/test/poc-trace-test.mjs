// 工作轨迹 + 常用位置：静态与结构断言（不启服务）
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const bridge = read('bridge.mjs');
const chatui = read('chatui.html');
const chatserver = read('chatserver.mjs');
const dialog = read('workdialog.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); fail++; }
}

t('bridge 有轨迹缓冲与上限', () => {
  assert.match(bridge, /const TRACES = new Map\(\)/);
  assert.match(bridge, /const TRACE_MAX = 80/);
  assert.match(bridge, /function tracePush\(conv, kind, text, ok\)/);
  assert.match(bridge, /while \(arr\.length > TRACE_MAX\) arr\.shift\(\)/);
});

t('轨迹三类事件都写入：想、用工具、结果', () => {
  assert.match(bridge, /if \(inner\) tracePush\(conv, 'think', inner\)/);
  assert.match(bridge, /tracePush\(conv, 'tool', tc\.name/);
  assert.match(bridge, /tracePush\(conv, 'result', brief, res\.ok === true\)/);
  assert.match(bridge, /tracePush\(conv, 'result', '没权限：'/);
});

t('轨迹不进聊天记录、只存在内存', () => {
  assert.ok(!/chatlog\.append\([^)]*trace/i.test(bridge));
  assert.ok(!/writeFileSync\([^)]*TRACES/.test(bridge));
});

t('3098 暴露 /trace 与 /trace/clear', () => {
  assert.match(bridge, /if \(p === '\/trace' && req\.method === 'GET'\)/);
  assert.match(bridge, /traceList\(__localConv\(\), u\.searchParams\.get\('since'\)\)/);
  assert.match(bridge, /if \(p === '\/trace\/clear' && req\.method === 'POST'\)/);
});

t('3210 代理 /api/trace', () => {
  assert.match(chatserver, /if \(p === '\/api\/trace' && req\.method === 'GET'\)/);
  assert.match(chatserver, /upStrict\(cfg, '\/trace'/);
});

t('聊天窗有「轨迹」按钮与面板', () => {
  // v2：轨迹并进「本轮」抽屉（#drawerBtn 打开 traceWrap）
  assert.match(chatui, /id="drawerBtn"/);
  assert.match(chatui, /id="traceWrap"/);
  assert.match(chatui, /id="traceList"/);
  assert.match(chatui, /id="traceClear"/);
  assert.match(chatui, /async function pollTrace\(all\)/);
  assert.match(chatui, /setInterval\(\(\) => \{ const b = document\.getElementById\('traceWrap'\); if \(b && b\.classList\.contains\('on'\)\) pollTrace\(false\); \}, 2000\)/);
});

t('轨迹面板按 kind 上色，失败标红', () => {
  assert.match(chatui, /\.tr\.tool \.v\{color:#7fb0ff/);
  assert.match(chatui, /\.tr\.result \.v\{color:#8fd694/);
  assert.match(chatui, /\.tr\.result\.bad \.v\{color:#e2777a/);
  assert.match(chatui, /\.tr\.think \.v\{color:#8b93a1;font-style:italic/);
});

t('轨迹最多留 120 条 DOM，防刷屏', () => {
  assert.match(chatui, /while \(trList\.children\.length > 120\) trList\.removeChild\(trList\.firstChild\)/);
});

t('/work 返回常用位置（桌面/文档/下载，只给真实存在的）', () => {
  assert.match(bridge, /function commonPlaces\(\)/);
  assert.match(bridge, /\[ '桌面', 'Desktop' \], \[ '文档', 'Documents' \], \[ '下载', 'Downloads' \]/);
  assert.match(bridge, /places: commonPlaces\(\)/);
});

t('弹窗收成两步：选文件夹 → 开始；例子可点、直接发给她', () => {
  // 2026-11-01 用户："太乱了，还都能点，有的都没用"：
  // 常用位置 / 「用已有的文件夹」/ 新建按钮 / 「已经有东西」勾选框都删了（有东西也直接用）
  assert.doesNotMatch(dialog, /id="wkPlaces"/);
  assert.doesNotMatch(dialog, /id="wkExisting"/);
  assert.doesNotMatch(dialog, /id="wkSug"/);
  assert.match(dialog, /id="wkRoot"/);
  assert.match(dialog, /id="wkFirst"/);
  assert.match(dialog, /window\.__WK_EXAMPLES|const EX = /);
  assert.match(dialog, /\/api\/chat\/send/);
  assert.match(dialog, /useExisting: true, confirmWrite: __mode !== 'read'/);
});

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
