// 入库前分类：她自己说的话不能当"关于他"；"他要她做的事"该进待办，不该当核心事实。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ PASS', name); pass++; }
  catch (e) { console.log('❌ FAIL', name, '::', e.message); fail++; }
}

const junk = [
  '这个读不了，api.json 里的 key 不能念。你要是在调 qq-bot，自己去文件里看',
  '链接我点不开，你自己复制过来给我看写了啥',
  '要不就直接说你想问啥',
  '这我发不了，你换个问题',
];
for (const j of junk) check('垃圾：' + j.slice(0, 12), () => assert.equal(memory.classify(j), 'junk'));

const req = [
  '他昨天发过一套衣服，要对方穿上看看',
  '他要我穿那套紫色蕾丝紧身连衣裙拍给他看',
  '他要对方把 shots/demo.png 直接发给他看',
  '他让把工作区里的 m.txt 改成 hello',
];
for (const r of req) check('转待办：' + r.slice(0, 14), () => assert.equal(memory.classify(r), 'request'));

const facts = [
  '对方是你的主人',
  '他喜欢听大肥鱼唱歌',
  '他面试是下周三下午三点',
  '他现在在湖北鄂州',
];
for (const f of facts) check('事实：' + f.slice(0, 12), () => assert.equal(memory.classify(f), 'fact'));

check('太短的直接丢', () => assert.equal(memory.classify('嗯'), 'junk'));
check('空值不炸', () => { assert.equal(memory.classify(''), 'junk'); assert.equal(memory.classify(null), 'junk'); });

// 两条写入路径都必须走分类
const bridge = fs.readFileSync(path.resolve('pack', 'src', 'bridge.mjs'), 'utf8');
check('MEMO 路径走分类', () => assert.match(bridge, /const kind = memory\.classify\(memo\)/));
check('后台整理也走分类', () => {
  const i = bridge.indexOf('for (const t of leftLines)');
  assert.ok(i > 0);
  assert.match(bridge.slice(i, i + 320), /memory\.classify\(t\)/);
});
check('转待办用的是 loops.noteHisAsk，不是又塞回记忆', () => {
  const n = (bridge.match(/loops\.noteHisAsk/g) || []).length;
  assert.ok(n >= 3, '至少三处（拍照、MEMO、整理），实际 ' + n);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
