// 第一次启动就得出得来东西：数据目录里没有人设时，得用自带模板生成一份。
// 以前的 bug：syncPersona() 读到 ENOENT 打一行「同步失败」就算了，新人第一次打开她是个空壳。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const mod = await import(new URL('file:///' + path.join(SRC, 'persona-default.mjs').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
const fresh = path.join(tmp, 'userdata', 'persona.md');

t('模板文件在仓库里（打包时别漏）', () => {
  assert.ok(fs.existsSync(mod.PERSONA_TEMPLATE), '缺少 ' + mod.PERSONA_TEMPLATE);
});

t('没有文件时生成，并把名字填进去', () => {
  const r = mod.ensurePersonaFile(fresh, { name: '大肥鱼' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  const txt = fs.readFileSync(fresh, 'utf8');
  assert.ok(txt.includes('大肥鱼'), '名字没填进去');
  assert.ok(!/\{NAME\}|\{AGE\}|\{CITY\}|\{PERSONA\}/.test(txt), '还留着没替换的占位符');
});

t('年龄/城市没填时不留下「 岁，住。」这种残句', () => {
  const f2 = path.join(tmp, 'b.md');
  mod.ensurePersonaFile(f2, { name: '她' });
  const first = fs.readFileSync(f2, 'utf8').split('\n').find(l => l.startsWith('你是「'));
  assert.ok(first, '没找到首行');
  assert.ok(!/，\s*岁/.test(first), '残句：' + first);
  assert.ok(!/住[。，]/.test(first), '残句：' + first);
  assert.ok(!/，。/.test(first), '多余标点：' + first);
});

t('填了年龄城市就带上', () => {
  const f3 = path.join(tmp, 'c.md');
  mod.ensurePersonaFile(f3, { name: '小林', age: 22, city: '武汉' });
  const first = fs.readFileSync(f3, 'utf8').split('\n').find(l => l.startsWith('你是「'));
  assert.ok(first.includes('22 岁') && first.includes('武汉'), first);
});

t('已经有人设时绝不覆盖（用户改过的内容不能丢）', () => {
  const f4 = path.join(tmp, 'd.md');
  fs.writeFileSync(f4, '我自己写的，别动', 'utf8');
  const r = mod.ensurePersonaFile(f4, { name: '别的名字' });
  assert.equal(r.created, false);
  assert.equal(fs.readFileSync(f4, 'utf8'), '我自己写的，别动');
});

t('空文件（控制台点保存但没写字）算没有人设，要补上', () => {
  const f5 = path.join(tmp, 'e.md');
  fs.writeFileSync(f5, '   \n\n', 'utf8');
  const r = mod.ensurePersonaFile(f5, { name: '她' });
  assert.equal(r.created, true);
  assert.ok(fs.readFileSync(f5, 'utf8').includes('你是「她」'));
});

t('母目录不存在时自己建出来', () => {
  const deep = path.join(tmp, 'x', 'y', 'z', 'persona.md');
  const r = mod.ensurePersonaFile(deep, { name: '她' });
  assert.equal(r.created, true);
  assert.ok(fs.existsSync(deep));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\nPASS', pass, '/ FAIL', fail);
process.exit(fail ? 1 : 0);
