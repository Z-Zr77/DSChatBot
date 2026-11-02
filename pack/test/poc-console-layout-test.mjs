// 真正运行控制台脚本：临时数据、假 QQ/模型/桥接，不连接安装版、不发送真实消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVision } from '../src/capability.mjs';

const file = fileURLToPath(import.meta.url), PACK = path.resolve(path.dirname(file), '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(createRequire(import.meta.url)('electron'), [file], { env, stdio: 'inherit', timeout: 120000 });
  if (run.error) console.error(run.error.message);
  process.exit(run.status === 0 ? 0 : 1);
}
const { app, BrowserWindow } = await import('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-console-layout-'));
const data = path.join(tmp, 'data'), artifacts = process.env.CONSOLE_QA_DIR || path.join(tmp, 'screens');
app.setPath('userData', path.join(tmp, 'electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let child, win, stub, failed = 0, passed = 0, toolsEnabled = false;
const requests = [], errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ' :: ' + e.stack); }
};
const write = (name, value) => { const dest = path.join(data, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, typeof value === 'string' ? value : JSON.stringify(value)); };
const js = code => win.webContents.executeJavaScript('{\n' + code + '\n}', true);
const waitFor = async code => {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await pause(100); }
  throw new Error('等待超时：' + code);
};
const screen = async name => { await pause(150); fs.mkdirSync(artifacts, { recursive: true }); fs.writeFileSync(path.join(artifacts, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
const guard = setTimeout(() => { console.error('FAIL 渲染测试超时'); child?.kill(); app.exit(1); }, 100000);
async function run() {
try {
  await app.whenReady();
  stub = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, body });
    let value = { ok: true };
    if (req.url === '/work/tools') { toolsEnabled = !!body.enabled; value = { ok: true, stillOn: toolsEnabled }; }
    if (req.url === '/work') value = { ok: true, toolsEnabled, work: { active: false } };
    if (req.url === '/approvals') value = { items: [] };
    if (req.url.endsWith('/chat/completions')) value = { choices: [{ message: { content: '测试角色：短发、蓝色外套。' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + stub.address().port;
  const api = { baseUrl: base + '/v1', model: 'gpt-4o', key: 'fake-console-key' };
  write('setup.json', { api, qq: { ownerUin: '999990001', name: '测试角色' }, work: { toolsEnabled: false } });
  write('api.json', api);
  write('config.json', { qq: { enabled: false }, vision: { baseUrl: base + '/vision', model: 'qwen-vl-test', key: 'fake-vision-key' }, proactive: { chance: 0.3 }, groups: { dayCap: 7 }, ui: { lan: false } });
  write('persona.md', '# 测试人设\n友善的伙伴。');
  write('bridge.log', '[2026-11-01T12:00:00Z] [memo] 999990001 + 喜欢散步\n[2026-11-01T12:01:00Z] [draw] fail test-only\n');
  const today = new Date().toISOString().slice(0, 10);
  write('agent-home/memory/people/999990001.json', { items: [
    { id: 'old', text: '以前住在海边', kind: 'fact', origin: 'chat', w: 1, created: today, last: today, stale: true, supersededBy: 'new' },
    { id: 'new', text: '现在住在山里', kind: 'core', origin: 'chat', w: 1, created: today, last: today, supersedes: ['old'] },
    { id: 'cause', text: '下雨所以带伞', kind: 'fact', origin: 'chat', w: 1, created: today, last: today, causedBy: ['new'] },
    { id: 'separate', text: '<script>throw Error("escaped")</script>', kind: 'trivia', origin: 'legacy', w: 1, created: today, last: today }
  ] });
  const runner = path.join(tmp, 'run-ui.mjs');
  // 只替换外部 QQ 的探活；控制台 API 与真实文件保存全部照常执行。
  const src = process.env.CONSOLE_SOURCE_DIR || path.join(PACK, 'src');
  fs.writeFileSync(runner, 'const originalFetch = globalThis.fetch; globalThis.fetch = (u,o) => String(u).startsWith("http://127.0.0.1:3000/") ? Promise.resolve(new Response("{\\"data\\":null}")) : originalFetch(u,o);\nawait import(' + JSON.stringify(pathToFileURL(path.join(src, 'ui.mjs')).href) + ');');
  child = spawn(process.execPath, [runner], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QQBOT_DATA: data, QQBOT_API_FILE: path.join(data, 'api.json'), QQBOT_UI_PORT: '0', QQBOT_NAPCAT_DIR: path.join(tmp, 'napcat'), QQBOT_LOCAL_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = ''; child.stdout.on('data', chunk => { serverLog += chunk; }); child.stderr.on('data', chunk => { serverLog += chunk; });
  // 服务端日志会报告实际监听端口，测试不用固定端口。
  for (let i = 0; i < 100 && !serverLog.includes('[ui]'); i++) await pause(100);
  const port = serverLog.match(/\[ui\] http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port && port !== '0', serverLog);
  const url = 'http://127.0.0.1:' + port;
  win = new BrowserWindow({ width: 1360, height: 960, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3 && /Uncaught|ReferenceError|TypeError|SyntaxError/.test(message)) errors.push(message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('render-process-gone ' + details.reason));
  await win.loadURL(url); await waitFor('document.querySelector("#sToolsBtn") && document.querySelector("#voiceSel option")');
  await check('六页顺序（她/QQ/日志/人设/花费/模型）、蓝色胶囊与唯一权限入口', async () => {
    assert.deepEqual(await js('[...document.querySelectorAll("nav button")].map(b => b.dataset.t)'), ['overview', 'qq', 'log', 'her', 'money', 'config']);
    assert.equal(await js('getComputedStyle(document.querySelector("nav button.on")).backgroundColor'), 'rgb(52, 120, 246)');
    // 「让她动电脑」不再挤在第一屏：它跟自检/备份/授权码一起收在「模型 → 更多」里
    assert.equal(await js('document.querySelector("#sToolsBtn").closest("section").id'), 'config');
    await js('toggleWorkTools()'); assert.equal(toolsEnabled, true);
    await js('toggleWorkTools()'); assert.equal(toolsEnabled, false);
    await screen('01-overview');
  });
  await check('扫码入口固定状态在刷新后保留', async () => {
    await js('toggleQrPin()'); win.reload(); await waitFor('document.querySelector("#sToolsBtn")');
    assert.equal(await js('document.querySelector("#qrPin").getAttribute("aria-pressed")'), 'true');
    await js('showQqScan()'); assert.equal(await js('document.querySelector("#qrSlot").hidden'), false);
  });
  await check('概览短摘要与独立日志页可刷新', async () => {
    await js('loadRecent()'); assert.ok((await js('document.querySelector("#recentSummary").textContent')).includes('出现问题'));
    await js('goPage("log"); loadLog()'); assert.equal(await js('document.querySelector("section.on").id'), 'log');
    assert.ok((await js('document.querySelector("#logPre").textContent')).includes('[draw] fail')); await screen('02-logs');
  });
  await check('记忆只画明确关系、核心更大、只剩一个 Tab', async () => {
    await js('goPage("memory"); loadMem()');
    assert.equal(await js('document.querySelectorAll("#memGraph .memory-node").length'), 4);
    assert.equal(await js('document.querySelectorAll("#memGraph [data-edge=correction]").length'), 1);
    assert.equal(await js('document.querySelectorAll("#memGraph [data-edge=cause]").length'), 1);
    assert.equal(await js('memoryNodes[1].radius > memoryNodes[0].radius'), true);
    // 经验库 / 技能记录 两个 tab 已删：只剩「记忆」一个，旧的 DOM 不该再出现
    assert.equal(await js('!!document.querySelector("#tab-lessons")'), false);
    assert.equal(await js('!!document.querySelector("#tab-skills")'), false);
    assert.equal(await js('!!document.querySelector("#lessonsPane")'), false);
    assert.equal(await js('document.querySelector("#memPane").hidden'), false);
    await screen('03-memory');
  });
  await check('记忆图可缩放、拖动、查看并编辑', async () => {
    const scale = await js('memoryCamera.scale'); await js('zoomMemory(1.25)'); assert.ok(await js('memoryCamera.scale') > scale);
    const x = await js('memoryNodes[0].x');
    const point = await js(`const r = document.querySelector('[data-node="0"] circle').getBoundingClientRect(); ({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 45, y: point.y + 10 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 45, y: point.y + 10, button: 'left', clickCount: 1 });
    await pause(100);
    assert.notEqual(await js('memoryNodes[0].x'), x);
    await js('inspectMemory(1); editSelectedMemory()'); assert.equal(await js('document.querySelector("#memListView").hidden'), false);
    await js('document.querySelector("#memText").value="新增测试记忆"; addMem()');
    await waitFor('memoryNodes.some(it => it.text === "新增测试记忆")');
  });
  await check('设置保存保留未展示配置，视觉跟大脑', async () => {
    await js('goPage("config"); loadCfg()'); await waitFor('document.querySelector("#visionFields").hidden');
    assert.equal(await js('/账号|数据目录|群聊|手机/.test(document.querySelector("#config").innerText)'), false);
    await js(`document.querySelector('[data-p="proactive.chance"]').value="0.45"; saveCfg()`);
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(config.proactive.chance, 0.45); assert.equal(config.groups.dayCap, 7); assert.equal(config.vision.key, 'fake-vision-key');
    assert.equal(await js('api("/api/vision/info").then(r => r.mode)'), 'brain'); await screen('04-settings');
  });
  await check('参考图上传自动描述，跟随大脑与单独接口', async () => {
    await js('goPage("her"); loadSelf()');
    await js('const input = document.querySelector("#sfFile"), dt = new DataTransfer(); const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="), c=>c.charCodeAt(0)); dt.items.add(new File([bytes],"reference.png",{type:"image/png"})); input.files=dt.files; input.dispatchEvent(new Event("change"));');
    await waitFor('document.querySelector("#sfDesc").value.includes("蓝色外套")');
    assert.equal(requests.filter(r => r.url.endsWith('/chat/completions')).at(-1).body.model, 'gpt-4o');
    await js('api("/api/brain",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"text-only-model"})})');
    assert.equal(await js('api("/api/vision/info").then(r => r.mode)'), 'custom');
    await js('describeRef()'); assert.equal(requests.filter(r => r.url.endsWith('/chat/completions')).at(-1).body.model, 'qwen-vl-test'); await screen('05-persona');
  });
  await check('视觉路由尊重大脑、独立接口和关闭兜底', () => {
    assert.equal(resolveVision(api, { model: 'custom' }, 'key').mode, 'brain');
    assert.equal(resolveVision({ model: 'text' }, { model: 'custom' }, 'key').mode, 'custom');
    assert.equal(resolveVision({ model: 'text' }, {}, 'key', false).mode, 'none');
    assert.equal(resolveVision({ model: 'text' }, {}, 'key', true).mode, 'fallback');
  });
  await check('主题预设、圆角密度字体、CSS、导入和刷新持久化', async () => {
    await js('goPage("theme"); chooseTheme("light"); document.querySelector("#themeRadius").value="8"; document.querySelector("#themeDensity").value="compact"; document.querySelector("#themeFont").value="mono"; document.querySelector("#themeCss").value=".brand b { letter-spacing: 3px; }"; saveTheme()');
    assert.equal(await js('getComputedStyle(document.querySelector(".brand b")).letterSpacing'), '3px');
    const stored = await js('localStorage.getItem(THEME_KEY)'); win.reload(); await waitFor('document.querySelector("#themeRadius").value === "8"');
    assert.equal(await js('localStorage.getItem(THEME_KEY)'), stored);
    await js('const input=document.querySelector("#themeFile"), dt=new DataTransfer(); dt.items.add(new File(["{bad json"],"bad.json")); input.files=dt.files; importTheme(input)');
    assert.equal(await js('localStorage.getItem(THEME_KEY)'), stored);
    await js('const input=document.querySelector("#themeFile"), dt=new DataTransfer(); dt.items.add(new File([JSON.stringify({...consoleTheme, radius:20})],"theme.json")); input.files=dt.files; importTheme(input)');
    assert.equal(await js('consoleTheme.radius'), 20); await screen('06-theme');
  });
  await check('主题导出仅含主题设置', async () => {
    const downloaded = new Promise((resolve, reject) => {
      win.webContents.session.once('will-download', (_event, item) => {
        const dest = path.join(tmp, 'exported-theme.json'); item.setSavePath(dest);
        item.once('done', (_e, state) => state === 'completed' ? resolve(dest) : reject(new Error(state)));
      });
    });
    await js('exportTheme()'); const exported = JSON.parse(fs.readFileSync(await downloaded, 'utf8'));
    assert.equal(exported.radius, 20); assert.deepEqual(Object.keys(exported).sort(), ['colors', 'css', 'density', 'font', 'preset', 'radius', 'version']);
  });
  await check('窄窗布局可用且无横向页面溢出', async () => {
    await js('resetTheme(); goPage("config"); loadCfg()'); win.setSize(760, 920); await pause(200);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true); await screen('07-narrow');
  });
  await check('实际渲染无脚本异常或渲染进程崩溃', () => assert.deepEqual(errors, []));
} catch (e) { failed++; console.error('FAIL 渲染准备 :: ' + e.stack); }
finally {
  clearTimeout(guard); if (win && !win.isDestroyed()) win.destroy(); child?.kill(); stub?.close();
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  if (process.env.CONSOLE_QA_DIR) console.log('截图：' + artifacts);
  await pause(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
}
}
// Electron 在入口模块结束求值后才发 ready，不能顶层 await whenReady。
run();
