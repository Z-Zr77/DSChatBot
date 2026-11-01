// 验收报告（docs/验收报告-v0.7.2-20261101.md）里六条缺陷的回归测试。
//
// 这些缺陷有一个共同点：38 个套件全绿的时候它们都在。原因是老测试大多在断言
// "代码里有这个字符串"，而毛病出在**跨入口的行为**（发没发出去、给没给权限）。
// 所以这里尽量测行为：能真起模块的就起模块，起不来的（前端模板字符串）至少把
// "错误的那句代码已经不在了"钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---------- L2 / P1：只读会话不能跑命令 ----------
test('L2 grants：只给了 fs:read 的会话，requireCap(exec) 必须拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-exec-gate-'));
  const grants = await import(pathToFileURL(path.join(SRC, 'grants.mjs')).href);
  const key = 'test:readonly:' + Date.now();
  const r = grants.open({ convKey: key, root: dir, caps: ['fs:read'], source: 'test' });
  assert.equal(r.ok, true);

  const st = grants.state(key);
  const exec = grants.requireCap(key, 'exec', st.epoch);
  assert.equal(exec.ok, false, '只读会话不允许 exec');
  assert.match(exec.err, /exec/);

  // 反过来：真给了 exec 的会话要放行（别把闸门焊死）
  grants.setCaps(key, ['fs:read', 'fs:write', 'exec']);
  const st2 = grants.state(key);
  assert.equal(grants.requireCap(key, 'exec', st2.epoch).ok, true);
  grants.stop(key);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('L2 bridge：toolCapsOk 的 exec 分支必须走 requireCap，不能只看开关', () => {
  const b = read('bridge.mjs');
  const i = b.indexOf("if (cap === 'exec') {");
  assert.ok(i > 0, '找不到 exec 分支');
  const block = b.slice(i, i + 900);
  assert.match(block, /requireCap\(workKey\(conv\), 'exec'/, 'exec 分支必须查授权，不能只查 execCfg().mode');
  assert.match(block, /scope\.stale/, 'exec 分支要挡已停止的会话');
});

// ---------- F1 / P1：首条任务发失败不许说成功 ----------
test('F1 两个入口各传自己的发送接口：控制台 /api/chat/send，聊天窗 /api/send', () => {
  const ui = read('ui.mjs');
  const chat = read('chatui.html');
  assert.match(ui, /sendText: async \(text\) => api\('\/api\/chat\/send'/, '控制台要用 /api/chat/send');
  assert.match(chat, /sendText: async \(text\) => api\('\/api\/send'/, '聊天窗要用 /api/send（/api/chat/send 在那边是 404）');
});

test('F1 workdialog：发送结果要判 ok，失败时保留窗口并改按钮', () => {
  const w = read('workdialog.mjs');
  assert.match(w, /o\.sendText/, '弹窗必须用调用方传进来的发送函数');
  assert.match(w, /r2\.ok !== false/, '必须判 ok，不能发了就算成功');
  assert.match(w, /再发一次/, '失败后要能把这句话重发');
  assert.match(w, /if \(first && !\(await __sendFirst\(first\)\)\) return;/, '首条发失败不能关窗');
  // 旧写法：先 el.remove() 再发，而且不看返回值
  assert.doesNotMatch(w, /el\.remove\(\);\s*'\s*,\s*'\s*toast\("工作区：/, '不许再出现"先关窗后发送"的顺序');
});

// ---------- L1 / P2：保存的档位必须真的用上 ----------
test('L1 workdialog：caps 由当前档位算出来，不是写死读写执行', () => {
  const w = read('workdialog.mjs');
  assert.match(w, /caps: CAPS\[__mode\] \|\| CAPS\.read/, 'caps 必须跟着档位走');
  assert.match(w, /__mode = String\(\(w && w\.mode\) \|\| "write"\)/, '档位要从 /api/work 读回来');
  assert.match(w, /confirmWrite: __mode !== 'read'/, '只读档不要带 confirmWrite');
  assert.doesNotMatch(w, /caps: \[ 'fs:read', 'fs:write', 'exec' \]/, '写死的三件套必须删掉');
});

// ---------- F2 / P2：例子承诺的能力必须和档位对得上 ----------
test('F2 三个例子标了所需权限，档位不够就点不动', () => {
  const w = read('workdialog.mjs');
  assert.match(w, /need: 'read'[\s\S]*need: 'write'[\s\S]*need: 'full'/, '三个例子要各自声明 need');
  assert.match(w, /RANK\[__mode\] \|\| 0\) < \(RANK\[need\] \|\| 0\)/, '点例子前要比档位');
  assert.match(w, /要联网/, '联网那句仍然要明说要联网');
});

// ---------- F4 / P2：原生框的等待要长于桥接 ----------
test('F4 聊天代理等原生框的时间要比桥接长', () => {
  const chat = read('chatserver.mjs');
  const pick = chat.slice(chat.indexOf("'/api/work/pick-dir'"));
  assert.match(pick, /150000|: *150000/, 'pick-dir 的代理超时要单独放大');
  const bridge = read('bridge.mjs');
  assert.match(bridge, /pick-dir|120000|120 \* 1000|2 \* 60 \* 1000/, '桥接侧的原生框等待时间仍可查');
});

// ---------- F3 / P2：审批卡片要读真实超时 ----------
test('F3 审批卡片读 timeoutSec，不再编一个 60 秒', () => {
  const ui = read('ui.mjs');
  assert.match(ui, /Number\(a\.timeoutSec\)/, '必须读 args.timeoutSec');
  assert.doesNotMatch(ui, /x\.timeoutMs \|\| x\.args\.timeoutMs \|\| 60/, '旧的一律 60 秒必须删掉');
  assert.match(ui, /cmdExtra/, 'run_cmd 的其它参数（cwd 等）要露出来');
});

// ---------- P3：文档和注释别再和代码对不上 ----------
test('P3 exec.mjs 注释不再说内建命令会 ENOENT（runOnce 会用 cmd /c 包一层）', () => {
  const e = read('exec.mjs');
  assert.match(e, /cmd \/d \/c/, '包装逻辑还在');
  assert.doesNotMatch(e, /干净的 Windows 上会 ENOENT/, '这句话是错的：已经靠 cmd /d /c 跑了');
});

test('P3 architecture.md 的套件数与 CI 描述已同步', () => {
  const doc = fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'architecture.md'), 'utf8');
  assert.doesNotMatch(doc, /29 个测试套件/, '套件数早就不是 29 了');
  assert.doesNotMatch(doc, /没有 CI/, 'CI 已经接了');
});

// ---------- 我补的两条：报告里漏掉的 ----------
test('补1 双窗口 advOpen 同步：监听 storage，且 loadState 按存储值对齐（不是只会展开）', () => {
  const ui = read('ui.mjs');
  assert.match(ui, /addEventListener\('storage'/, '另一个入口改了 advOpen，这边得跟着变');
  assert.match(ui, /toggleAdv\(localStorage\.getItem\('advOpen'\) === '1'\)/, '每次 loadState 都按存储值对齐');
  assert.doesNotMatch(ui, /if \(localStorage\.getItem\('advOpen'\) === '1'\) \{ toggleAdv\(true\)/, '只会强制展开的旧写法要删掉');
});

test('补2 /work/start 的能力由档位决定，客户端传的 caps 不再说了算', () => {
  const br = read('bridge.mjs');
  assert.match(br, /const capsWant = MODE_CAPS\[wantMode\]\.slice\(\)/, '能力必须从档位推');
  assert.doesNotMatch(br, /const capsWant = \(Array\.isArray\(b\.caps\)/, '直接采信 b.caps 的旧写法要删掉');
  assert.match(br, /if \(m && MODE_CAPS\[m\]\) return m;/, 'b.mode 合法就用它');
  assert.match(br, /workCfg\(\)\.defaultMode/, '没传 mode 就退回设置里存的档位');
});

test('补3 guard 重拉内核前必须先收掉上一份（否则一天堆十几个实例，旧实例还占着登录）', () => {
  const g = read('napcat-guard.mjs');
  assert.match(g, /function killKernel\(\)/, '要有 killKernel');
  assert.match(g, /'\/end', '\/tn', TASK_NAME/, '先 /end 结束任务');
  assert.match(g, /taskkill\.exe', \['\/F', '\/T', '\/IM', 'NapCatWinBootMain\.exe'\]/, '只杀 NapCatWinBootMain 的进程树，不按 QQ.exe 名字杀');
  const iKill = g.indexOf('await killKernel();');
  const iRun = g.indexOf('await runTask();');
  assert.ok(iKill > 0 && iRun > iKill, 'killKernel 必须在 runTask 之前');
});
