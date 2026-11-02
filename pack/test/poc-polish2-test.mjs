import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const bridge = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
const chatui = fs.readFileSync(path.join(SRC, 'chatui.html'), 'utf8');
const ui = fs.readFileSync(path.join(SRC, 'ui.mjs'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL', name, e.message); } };

// P1-5 停止时报改动数
t('stop 统计改动', () => {
  assert.match(bridge, /const lst = snapshots\.list\(__wsNow\.id, 500\) \|\| \[\]/);
  assert.match(bridge, /const real = lst\.filter\(\(x\) => x && x\.action !== 'revert'/);
  assert.match(bridge, /changed: __chg/);
  assert.match(bridge, /本次 ' \+ __chg\.edits \+ ' 条改动/);
});
t('聊天窗停止后提示条数', () => {
  assert.match(chatui, /const ch = \(rp && rp\.changed\) \|\| null;/);
  assert.match(chatui, /这次 ' \+ ch\.edits \+ ' 条改动/);
});

// P1-9 读宽改严
t('提示词有读宽改严', () => {
  assert.match(bridge, /READ_WIDE_WRITE_NARROW/);
  assert.match(bridge, /看的时候宽，改的时候窄/);
  assert.match(bridge, /一次改一个文件/);
});
t('读宽改严已注入提示词', () => {
  assert.match(bridge, /wp, READ_WIDE_WRITE_NARROW, ATTACH_PROMPT/);
});

// P1-11 记忆面板来源与更替链
t('记忆来源判定存在', () => {
  assert.match(ui, /function memSource\(it\)\{/);
  assert.match(ui, /origin === 'chat'\) return '聊天抽取'/);
  assert.match(ui, /origin === 'legacy'\) return '旧数据'/);
});
t('记忆表有来源列', () => {
  assert.match(ui, /<th>来源<\/th>/);
  assert.match(ui, /memSource\(it\)/);
});
t('已更正条目在表格里标出来', () => {
  assert.match(ui, /已被更正，不再用/);
  assert.match(ui, /更正了 ' \+ it\.supersedes\.length \+ ' 条旧说法/);
});

console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
