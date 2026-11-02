// 插件层：她默认是空白的，能力按需装。
// 这一版只有 QQ 一个插件，但它证明了这套切法：插件关掉，内核照样活着。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as plugins from '../src/plugins.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');

test('扫描得到 qq 插件，带 kind/needs', () => {
  const all = plugins.scan();
  const qq = all.find((m) => m.id === 'qq');
  assert.ok(qq, '没扫到 qq 插件');
  assert.equal(qq.kind, 'channel');
  assert.ok(qq.needs.includes('onebot.port'));
  assert.ok(qq.version);
});

test('默认启用；显式关掉就是关掉', () => {
  assert.equal(plugins.isEnabled({}, 'qq'), true);
  assert.equal(plugins.isEnabled({ plugins: { qq: { enabled: false } } }, 'qq'), false);
  assert.equal(plugins.isEnabled({ plugins: { qq: { enabled: true } } }, 'qq'), true);
});

test('list() 带上启用状态', () => {
  const items = plugins.list({ plugins: { qq: { enabled: false } } });
  const qq = items.find((x) => x.id === 'qq');
  assert.equal(qq.enabled, false);
});

test('缺什么配置能算出来：没 token 就报 token', () => {
  const qq = plugins.get('qq');
  const m = plugins.missing(qq, { onebot: { wsPort: 3001 } });
  // needs 里只有 onebot.port，这个已经满足
  assert.deepEqual(m, []);
  // 换成完全没有 onebot 的场景
  const m2 = plugins.missing(qq, {});
  assert.ok(m2.includes('onebot.port'));
});

test('bridge 只有在插件启用时才注册 QQ 通道、才去连 OneBot', () => {
  const b = read('pack/src/bridge.mjs');
  assert.match(b, /plugins\.isEnabled\(SETUP, 'qq'\)/);
  assert.match(b, /if \(QQ_ON\) channels\.register\(/);
  assert.match(b, /if \(QQ_ON\) connectWs\(\)/);
});

test('QQ 不再由她管：没有内核管理、没有扫码登录模块', () => {
  assert.equal(fs.existsSync('pack/src/napcat-guard.mjs'), false, 'napcat-guard 应该已经删了');
  assert.equal(fs.existsSync('pack/src/qqlogin.mjs'), false, 'qqlogin 应该已经删了');
  const ui = read('pack/src/ui.mjs');
  assert.equal(/qqlogin/.test(ui), false, 'ui 不该再引用 qqlogin');
  assert.equal(/api\/qr\/refresh/.test(ui), true, '一键接上还在（它只是读配置）');
});

test('插件页有开关、有一键接上、有打开面板', () => {
  const ui = read('pack/src/ui.mjs');
  assert.match(ui, /id="plgToggle"/);
  assert.match(ui, /togglePlugin\('qq'\)/);
  assert.match(ui, /attachOnebot\(this\)/);
  assert.match(ui, /openSnowLuma\(\)/);
  assert.match(ui, /if \(p === '\/api\/plugins' && req.method === 'GET'\)/);
  assert.match(ui, /if \(p === '\/api\/plugins\/toggle' && req.method === 'POST'\)/);
});
