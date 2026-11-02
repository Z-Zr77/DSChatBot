// 全新机器体检：把"新装一台电脑，第一分钟就会撞上"的几件事钉住。
//
// 起因（2026-11-02 真机实测）：跳过第一次见面、在模型页配好 Key 之后，
// 再打开控制台那张卡又弹回来；没配任何语音，"语音"那盏灯却是绿的，
// 她真去发语音时报 edge-tts exit 9009（本机没有 Python）。
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '  ' + e.message); fail++; }
};

const ui = fs.readFileSync('pack/src/ui.mjs', 'utf8');
const bridge = fs.readFileSync('pack/src/bridge.mjs', 'utf8');
const caps = fs.readFileSync('pack/src/caps.mjs', 'utf8');

t('第一次见面：主人号留空不再当成"没做完"', () => {
  assert.ok(ui.includes('if ((s && s.introDone) || keySet) return;'), '向导判定没改');
  assert.ok(!ui.includes('if (keySet && s && s.ownerUin) return;'), '还在用 ownerUin 当门槛');
});

t('第一次见面：跳过动作要落盘（introDone）', () => {
  assert.ok(ui.includes('introDone: true'), '跳过/保存时没有写 introDone');
  assert.ok(ui.includes('introDone: !!(s.intro && s.intro.done)'), 'GET /api/setup 没有回 introDone');
  assert.ok(ui.includes('patch.intro = { ...(s.intro || {}), done: !!b.introDone }'), 'POST /api/setup 没落盘');
});

t('语音灯：按"这台机器真能不能跑"判，不按配置字段判', () => {
  assert.ok(ui.includes("p === '/api/caps'"), '没有 /api/caps');
  assert.ok(ui.includes('function refreshCaps'), '没有 refreshCaps');
  assert.ok(ui.includes("paint('lampTts'"), '语音灯没接上探测结果');
  assert.ok(ui.includes("paint('lampAsr'"), '识别灯没接上探测结果');
});

t('caps：edge 要探 python，云端要钥', () => {
  assert.ok(caps.includes('export function pythonOk'), '没有 python 探测');
  assert.ok(caps.includes('export function edgeTtsOk'), '没有 edge-tts 探测');
  assert.ok(caps.includes("provider === 'edge'"), '没有按 provider 分流');
  assert.ok(caps.includes('aliyun.key'), '没有回落到 data/aliyun.key');
  assert.ok(caps.includes('TTL = 60_000'), '探测结果没有缓存');
});

t('没有主人号时，QQ 页要有一行说明', () => {
  assert.ok(ui.includes('id="qqOwnerHint"'), '没有这个提示元素');
  assert.ok(ui.includes('function paintOwnerHint'), '没有 paintOwnerHint');
  assert.ok(ui.includes("su.ownerUin"), '提示没有依赖真实主人号');
});

t('新机器没有 ~/.dsh/.credentials.yaml 时不该报错', () => {
  assert.ok(bridge.includes("if (e && e.code !== 'ENOENT') log('credential refs failed:', e.message);"),
    'credential refs 的 ENOENT 还在刷日志');
});

console.log(`PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
