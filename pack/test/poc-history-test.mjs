import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-hist-'));
const DATA = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.QQBOT_DATA = DATA;

const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('PASS', name); } catch (e) { FAIL++; console.log('FAIL', name, '::', e.message); } };
const ta = async (name, fn) => { try { await fn(); PASS++; console.log('PASS', name); } catch (e) { FAIL++; console.log('FAIL', name, '::', e.message); } };

(async () => {
  const grants = await load('grants.mjs');
  const snapshots = await load('snapshots.mjs');
  const fsguard = await load('fsguard.mjs');
  const bridgeSrc = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(SRC, 'chatui.html'), 'utf8');

  const ws1 = path.join(TMP_ROOT, 'proj-a');
  const ws2 = path.join(TMP_ROOT, 'proj-b');
  fs.mkdirSync(ws1, { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });

  // ---- 历史记录里必须带 root/caps ----
  t('open 的历史带 root 与 caps', () => {
    const r = grants.open({ convKey: 'local:1', root: ws1, caps: ['fs:read', 'fs:write'], source: 'test' });
    assert.equal(r.ok, true);
    const h = grants.history(20).filter((x) => x.action === 'open').pop();
    assert.equal(path.resolve(h.root), path.resolve(ws1));
    assert.deepEqual(h.caps, ['fs:read', 'fs:write']);
  });
  t('stop 的历史也带 root（不然重开后列不出来）', () => {
    grants.stop('local:1', 'test');
    const h = grants.history(20).filter((x) => x.action === 'stop').pop();
    assert.ok(h && h.root, 'stop 记录应带 root');
    assert.equal(path.resolve(h.root), path.resolve(ws1));
  });

  // ---- 收口：/workRecent 归并、/work/edits 校验、restore 支持旧 wsId ----
  t('bridge 有 workRecent 且按目录归并', () => {
    assert.match(bridgeSrc, /function workRecent\(limit = 8\)/);
    assert.match(bridgeSrc, /x\.wsIds\.slice\(-6\)/);
  });
  t('bridge 的 /work 响应带 recent', () => {
    assert.match(bridgeSrc, /recent: workRecent\(\)/);
  });
  t('bridge 新增 GET /work/edits 且校验归属', () => {
    assert.match(bridgeSrc, /p === '\/work\/edits' && req\.method === 'GET'/);
    assert.match(bridgeSrc, /knownWsIds\(\)/);
    assert.match(bridgeSrc, /不认识的会话/);
  });
  t('restore 支持旧 wsId，且跨目录要拒', () => {
    assert.match(bridgeSrc, /const wantId = String\(b\.wsId \|\| st\.id\)/);
    assert.match(bridgeSrc, /这条记录来自别的工作区/);
    assert.match(bridgeSrc, /snapshots\.restore\(wantId, String\(b\.id\), abs/);
  });

  // ---- 真实跑一遍：旧会话改动在重开后仍能恢复 ----
  await ta('重开同一目录后，旧 wsId 的改动仍可恢复', async () => {
    const g1 = grants.open({ convKey: 'local:1', root: ws1, caps: ['fs:read', 'fs:write'] });
    assert.equal(g1.ok, true);
    const sid1 = grants.state('local:1').id;
    const file = path.join(ws1, 'a.txt');
    fs.writeFileSync(file, 'v1\n');
    const beg = snapshots.begin(sid1, file, 'a.txt');
    assert.equal(beg.ok, true);
    fs.writeFileSync(file, 'v2\n');
    snapshots.commit(sid1, beg, file, 'a.txt', 'overwrite');
    const list1 = snapshots.list(sid1, 10);
    assert.ok(list1.length >= 1);

    grants.stop('local:1', 'test');
    const g2 = grants.open({ convKey: 'local:1', root: ws1, caps: ['fs:read', 'fs:write'] });
    assert.equal(g2.ok, true);
    const sid2 = grants.state('local:1').id;
    assert.notEqual(sid2, sid1);

    const guard = (p2) => fsguard.checkWrite(p2, { base: ws1, root: ws1, denyAbs: [], allowCreate: true });
    const rec = list1[0];
    const r = snapshots.restore(sid1, rec.id, file, { root: ws1, guard });
    assert.equal(r.ok, true, '旧会话的记录应能恢复：' + JSON.stringify(r));
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1\n');
  });

  // ---- UI：v2 把状态条 + 本轮抽屉收敛掉侧栏，历史能力仍在数据侧 ----
  t('v2：聊天窗顶部是一行状态条（目录/档位/策略/剩余/本轮/停止）', () => {
    assert.match(uiSrc, /id="workBar"/);
    assert.match(uiSrc, /id="workDir"/);
    assert.match(uiSrc, /id="modeBtn"/);
    assert.match(uiSrc, /id="apprBtn"/);
    assert.match(uiSrc, /id="workTime"/);
    assert.match(uiSrc, /id="drawerBtn"/);
    assert.match(uiSrc, /id="workStopBtn"/);
  });
  t('v2：旧的工作信息侧栏与权限胶囊已移除', () => {
    // 旧侧栏（workInfo / permBtn / traceBtn）不该再出现；
    // 「最近的工作区」在 0.6.5 挪进了本轮抽屉，容器 #workRecent 保留是正常的
    assert.doesNotMatch(uiSrc, /id="workInfo"/);
    assert.doesNotMatch(uiSrc, /id="permBtn"/);
    assert.doesNotMatch(uiSrc, /id="traceBtn"/);
    assert.match(uiSrc, /id="workRecent"/);
  });
  t('本轮抽屉里同时放改动与轨迹', () => {
    assert.match(uiSrc, /id="workEdits"/);
    assert.match(uiSrc, /id="traceList"/);
    assert.match(uiSrc, /id="drawerClose"/);
    assert.match(uiSrc, /id="workUndoAll"/);
  });
  t('恢复请求会带上 wsId', () => {
    assert.match(uiSrc, /wsId: wsId \|\| undefined/);
  });
  t('工作条默认收在「更多」里，设置里能去控制台改人设和模型', () => {
    assert.match(uiSrc, /id="workMore"/);
    assert.match(uiSrc, /<summary id="workMoreSum">更多<\/summary>/);
    assert.match(uiSrc, /改人设/);
    assert.match(uiSrc, /改模型 API/);
    assert.match(uiSrc, /#her/);
    assert.match(uiSrc, /#config/);
    assert.match(uiSrc, /details\.work-more:not\(\[open\]\) > #workBar\{display:none!important\}/);
  });
  t('主动开口的消息能标出来，头上能接心情和日程', () => {
    assert.match(uiSrc, /她来找你/);
    assert.match(uiSrc, /m\.proactive/);
    assert.match(uiSrc, /presence/);
    assert.match(uiSrc, /asleepUntil/);
    assert.match(bridgeSrc, /__markProactive = !!extras\.proactive/);
    assert.match(bridgeSrc, /proactive: !!__markProactive/);
  });

  console.log('\n' + (FAIL ? 'FAILED ' + FAIL : 'ALL PASS') + '  PASS=' + PASS + ' FAIL=' + FAIL);
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(FAIL ? 1 : 0);
})();
