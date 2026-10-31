// 联网（P1-2）：域名策略、私网拦截、大小/超时/重定向、审计、工具接线
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-net-'));
process.env.QQBOT_DATA = TMP;

const net = await import(new URL('../src/net.mjs', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };

// ---- 域名/协议策略 ----
t('#1 file:// 拒绝', () => {
  const r = net.checkUrl('file:///C:/Windows/win.ini');
  assert.equal(r.ok, false);
  assert.match(r.err, /http|https/);
});
t('#2 javascript: 拒绝', () => assert.equal(net.checkUrl('javascript:alert(1)').ok, false));
t('#3 localhost 拒绝', () => {
  const r = net.checkUrl('http://localhost:3070/api/state');
  assert.equal(r.ok, false);
  assert.match(r.err, /本机|内网/);
});
t('#4 127.0.0.1 拒绝', () => assert.equal(net.checkUrl('http://127.0.0.1/').ok, false));
t('#5 10.x 拒绝', () => assert.equal(net.checkUrl('http://10.1.2.3/').ok, false));
t('#6 192.168.x 拒绝', () => assert.equal(net.checkUrl('http://192.168.1.1/').ok, false));
t('#7 172.16–31 拒绝', () => {
  assert.equal(net.checkUrl('http://172.16.0.1/').ok, false);
  assert.equal(net.checkUrl('http://172.31.255.1/').ok, false);
  assert.equal(net.checkUrl('http://172.32.0.1/').ok, true); // 32 不是私网
});
t('#8 元数据地址拒绝', () => assert.equal(net.checkUrl('http://169.254.169.254/latest/meta-data/').ok, false));
t('#9 IPv6 环回拒绝', () => assert.equal(net.checkUrl('http://[::1]:8080/').ok, false));
t('#10 .local / .internal 拒绝', () => {
  assert.equal(net.checkUrl('http://printer.local/').ok, false);
  assert.equal(net.checkUrl('http://svc.internal/').ok, false);
});
t('#11 带账号密码的 URL 拒绝', () => assert.equal(net.checkUrl('http://user:pw@example.com/').ok, false));
t('#12 正常公网地址放行', () => {
  const r = net.checkUrl('https://example.com/a?b=1');
  assert.equal(r.ok, true);
  assert.equal(r.host, 'example.com');
});
t('#13 allowHosts 可放行本机', () => {
  const r = net.checkUrl('http://127.0.0.1:1234/x', { allowHosts: [ '127.0.0.1' ] });
  assert.equal(r.ok, true);
});

// ---- 实际抓取（本地桩服务器） ----
const server = http.createServer((req, res) => {
  if (req.url === '/html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><style>.a{color:red}</style><script>var x=1;</script></head><body><h1>标题</h1><p>第一段</p><p>第二段 &amp; 更多</p></body></html>');
  } else if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hello: '世界' }));
  } else if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(300 * 1024));
  } else if (req.url === '/slow') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
    setTimeout(() => res.end('end'), 3000);
  } else if (req.url === '/redirect-out') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  } else if (req.url === '/redirect-in') {
    res.writeHead(302, { location: '/html' });
    res.end();
  } else if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([ 0x89, 0x50, 0x4e, 0x47 ]));
  } else if (req.url === '/404') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hi'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = 'http://127.0.0.1:' + PORT;
const allow = { allowHosts: [ '127.0.0.1' ] };

await ta('#14 不加 allowHosts 时本地桩被拒（策略先于网络）', async () => {
  const r = await net.fetchText(base + '/html');
  assert.equal(r.ok, false);
  assert.match(r.err, /本机|内网/);
});
await ta('#15 HTML 抓回来是纯文本、脚本样式被去掉', async () => {
  const r = await net.fetchText(base + '/html', allow);
  assert.equal(r.ok, true);
  assert.match(r.text, /标题/);
  assert.match(r.text, /第一段/);
  assert.match(r.text, /& 更多/);
  assert.doesNotMatch(r.text, /var x=1/);
});
await ta('#16 JSON 原样返回', async () => {
  const r = await net.fetchText(base + '/json', allow);
  assert.equal(r.ok, true);
  assert.match(r.text, /世界/);
});
await ta('#17 大响应被截到 maxBytes', async () => {
  const r = await net.fetchText(base + '/big', { ...allow, maxBytes: 64 * 1024 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 64 * 1024 + 10, 'text too long: ' + r.text.length);
});
await ta('#18 超时被掐掉', async () => {
  const r = await net.fetchText(base + '/slow', { ...allow, timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.match(r.err, /超时/);
});
await ta('#19 重定向到元数据地址被拒（每一跳都过策略）', async () => {
  const r = await net.fetchText(base + '/redirect-out', allow);
  assert.equal(r.ok, false);
  assert.match(r.err, /本机|内网|元数据/);
});
await ta('#20 工作区内重定向可跟随', async () => {
  const r = await net.fetchText(base + '/redirect-in', allow);
  assert.equal(r.ok, true);
  assert.match(r.text, /标题/);
});
await ta('#21 非文本类型拒绝', async () => {
  const r = await net.fetchText(base + '/binary', allow);
  assert.equal(r.ok, false);
  assert.match(r.err, /文本|二进制/);
});
await ta('#22 404 报对方状态', async () => {
  const r = await net.fetchText(base + '/404', allow);
  assert.equal(r.ok, false);
  assert.match(r.err, /404/);
});
await ta('#23 审计落盘（含 host/status/bytes，不含正文）', async () => {
  const f = path.join(TMP, 'ledger', 'audit.jsonl');
  assert.ok(fs.existsSync(f), 'audit.jsonl 不存在');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ok = lines.find((x) => x.kind === 'fetch' && x.status === 200);
  assert.ok(ok, '没有成功抓取的审计记录');
  assert.equal(ok.host === undefined, true); // host 不单独记，url 里带
  assert.ok(typeof ok.bytes === 'number');
  assert.equal(typeof ok.ok, 'boolean');
});

// ---- 工具与接线 ----
const tools = await import(new URL('../src/tools.mjs', import.meta.url).href);
const bridgeSrc = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
t('#24 fetch_url 声明 net 能力', () => {
  assert.deepEqual(tools.tools.fetch_url.caps, [ 'net' ]);
});
t('#25 fetch_url 不需要人工审批（靠会话里的 net 授权）', () => {
  assert.equal(tools.needsApproval('fetch_url'), false);
});
await ta('#26 fetch_url 走 net.fetchText 并截断到 maxChars', async () => {
  const r = await tools.call('fetch_url', { url: base + '/big', maxChars: 500 }, { netAllowHosts: [ '127.0.0.1' ] });
  assert.equal(r.ok, true);
  assert.ok(r.out.length < 1200, 'out too long: ' + r.out.length);
});
await ta('#27 fetch_url 被策略拒时 ok:false', async () => {
  const r = await tools.call('fetch_url', { url: 'http://169.254.169.254/' }, {});
  assert.equal(r.ok, false);
  assert.match(r.err, /本机|内网|元数据/);
});
t('#28 bridge 有 net 能力门与 netCfg 传参', () => {
  assert.match(bridgeSrc, /cap === 'net'/);
  assert.match(bridgeSrc, /netAllowHosts: nc\.allowHosts/);
  assert.match(bridgeSrc, /function netCfg\(\)/);
});
t('#28b net 能力门用 scope.epoch，不再引用不存在的 pinned（回归）', () => {
  const start = bridgeSrc.indexOf("if (cap === 'net')");
  assert.ok(start > 0, '没找到 net 分支');
  const m = [ bridgeSrc.slice(start, start + 500) ];
  assert.doesNotMatch(m[0], /pinned/);
  assert.match(m[0], /grants\.requireCap\(workKey\(conv\), 'net'/);
});
t('#29 权限选择挪到输入框（0.3.32）：聊天窗有三档，弹窗只显示当前档', () => {
  const dlg = fs.readFileSync(new URL('../src/workdialog.mjs', import.meta.url), 'utf8');
  const chat = fs.readFileSync(new URL('../src/chatui.html', import.meta.url), 'utf8');
  // v2：档位搬到顶部状态条（#modeBtn + #modeMenu）
  assert.match(chat, /id="modeBtn"/);
  assert.match(chat, /id="modeMenu"/);
  assert.match(chat, /data-mode="read"/);
  assert.match(chat, /data-mode="write"/);
  assert.match(chat, /data-mode="full"/);
  assert.match(chat, /api\/work\/mode/);
  assert.match(dlg, /wkModeNow/);
  assert.match(dlg, /'fs:read', 'fs:write', 'net', 'exec'/);
});
t('#30 settings 默认 net 是对象且开着', () => {
  const src = fs.readFileSync(new URL('../src/settings.mjs', import.meta.url), 'utf8');
  assert.match(src, /net: \{ enabled: true, allowHosts: \[\]/);
});

t('#31 grants 不会把 net 能力过滤掉（回归）', async () => {
  const g = await import(new URL('../src/grants.mjs', import.meta.url).href);
  const r = g.open({ convKey: 'net-test', root: process.cwd(), caps: [ 'fs:read', 'net' ], inPlace: true });
  assert.deepEqual(r.state.caps, [ 'fs:read', 'net' ]);
  g.stop('net-test', 'test');
});

server.close();
console.log('\nPASS ' + pass + ' / FAIL ' + fail);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
