// 自检（开箱自检）：换电脑、重装、第一次用之前，先看最基础的那几项有没有坏。
// 这个测试钉两件事：① 控制台真的挂了 /api/doctor 且十项都在；② 十项里有"硬伤/可选"的区分，
// 别把"QQ 没连"和"没有 API Key"报成同一个级别（前者不影响她用，后者直接起不来）。
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

const IDS = ['api', 'data', 'persona', 'bridge', 'local', 'qq', 'memory', 'work', 'disk', 'version'];

check('控制台挂上了 /api/doctor', () => {
  assert.ok(ui.includes("p === '/api/doctor'"), '没有 /api/doctor 路由');
  assert.ok(/return send\(res, 200, \{ ok: !items\.some\(\(i\) => i\.level === 'fail'\), at: Date\.now\(\), items \}\)/.test(ui));
});

check('十项检查都在', () => {
  for (const id of IDS) {
    assert.ok(new RegExp("add\\('" + id + "'").test(ui), '缺检查项 ' + id);
  }
});

check('没有 API Key 是硬伤，QQ 没连只是可选', () => {
  // api 这一项没有 key 时必须报 fail
  assert.ok(/add\('api', hasKey \? 'ok' : 'fail'/.test(ui), 'api 检查没把缺 key 当硬伤');
  // qq 这一项无论连没连都只能是 ok / warn，绝不能是 fail
  assert.ok(/add\('qq', ch\.online \? 'ok' : 'warn'/.test(ui), 'QQ 检查不该报 fail');
  assert.ok(!/add\('qq',[^)]*'fail'/.test(ui), 'QQ 检查里出现了 fail');
});

check('每一项都给了怎么修（fix 字段）', () => {
  const addCalls = ui.match(/add\('[a-z]+',/g) || [];
  assert.ok(addCalls.length >= IDS.length);
  // 硬伤项必须带修复指引
  assert.ok(/去「模型页」填一个 key/.test(ui));
  assert.ok(/点「重启桥接」/.test(ui));
});

check('概览有自检卡片和一键检查按钮', () => {
  assert.ok(ui.includes('id="doctorBox"'), '没有 doctorBox');
  assert.ok(ui.includes('onclick="runDoctor()"'), '没有「检查一下」按钮');
});

check('#doctor 能直接触发（出问题时把链接发给人）', () => {
  assert.ok(/if \(h === 'doctor' \|\| h === 'check'\)/.test(ui), '没有 #doctor 快捷方式');
  // 概览是异步渲染的，runDoctor 必须等盒子建好才写
  assert.ok(/for \(let i = 0; i < 24 && !box; i\+\+\)/.test(ui), 'runDoctor 没有等 doctorBox');
});

check('自检只读，不写数据目录（除了可写性探针）', () => {
  const seg = ui.slice(ui.indexOf("p === '/api/doctor'"), ui.indexOf("p === '/api/state'"));
  assert.ok(/\.doctor-probe/.test(seg), '没有可写性探针');
  const writes = seg.match(/writeFileSync\(/g) || [];
  assert.equal(writes.length, 1, '自检阶段出现了额外的写操作');
});

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
