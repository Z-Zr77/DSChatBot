// "未了之事"：她答应的、他要的，只允许两种结局——做完或过期，不许一直挂着。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-'));
process.env.QQBOT_DATA = tmp;

const SRC = path.resolve('pack', 'src');
const loops = await import(new URL('file:///' + path.join(SRC, 'loops.mjs').replace(/\\/g, '/')).href);

const U = '1000000001';
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

const NOW = new Date(2026, 10, 1, 2, 0, 0).getTime();   // 11-01 02:00
const DAY = 86400e3;

t('他说"拍张全身照我看看" → 记成一件要他等到的事', () => {
  const a = loops.asksFrom('拍张全身照我看看', NOW);
  assert.equal(a.length, 1);
  assert.equal(a[0].tag, 'photo');
  assert.ok(a[0].dueAt > NOW && a[0].dueAt <= NOW + 31 * 60000);
});

t('她答应的"明早给你拍" → 带截止时间', () => {
  const p = loops.promisesFrom('行，明早一睁眼换衣服拍照给你看', NOW);
  assert.equal(p.length, 1);
  assert.equal(p[0].tag, 'photo');
  // 凌晨 2 点说的"明早"算今天中午
  assert.equal(new Date(p[0].dueAt).getDate(), 1);
});

t('"等下再说"这种打发人的话不记账', () => {
  assert.equal(loops.promisesFrom('等下再说吧', NOW).length, 0);
});

t('同一件事记两遍只有一条', () => {
  loops.add(U, { text: '他让你拍张照给他', kind: 'his_ask', tag: 'photo', dueAt: NOW + 1800e3 });
  loops.add(U, { text: '他让你拍张照给他', kind: 'his_ask', tag: 'photo', dueAt: NOW + 1800e3 });
  assert.equal(loops.open(U, NOW).length, 1);
});

t('提示词里带上"还没做完的事"', () => {
  const txt = loops.render(U, NOW);
  assert.ok(txt.includes('还没做完的事'), txt);
  assert.ok(txt.includes('拍张照'), txt);
});

t('过了截止时间自动过期，且不再进提示词', () => {
  const later = NOW + 40 * 60000;
  const txt = loops.render(U, later);
  assert.equal(txt, '', '过点了就不该出现：' + txt);
});

t('真发出来了就关掉（按 tag 一次结清）', () => {
  const db = loops.load(U);
  db.items.push({ id: 'x1', text: '他让你拍张照给他', kind: 'his_ask', tag: 'photo', at: NOW, status: 'open', dueAt: NOW + 1800e3 });
  loops.save(U, db);
  assert.equal(loops.open(U, NOW).length, 1);
  const n = loops.close(U, { tag: 'photo', evidence: '照片发出去了' });
  assert.equal(n, 1);
  assert.equal(loops.open(U, NOW).length, 0);
  assert.equal(loops.render(U, NOW), '');
});

t('没有截止时间的事不会自己过期（他一直想要的那种）', () => {
  loops.add(U, { text: '他想看她的新手机壳', kind: 'his_ask', tag: 'case' });
  assert.equal(loops.open(U, NOW + 30 * DAY).length, 1);
});

t('结掉的事 3 天后从表里清走，不占地方', () => {
  loops.close(U, { tag: 'case', evidence: '发过了' });
  const db = loops.sweep(U, NOW + 5 * DAY);
  assert.equal(db.items.length, 0, JSON.stringify(db.items));
});

// ---- 回归：她的"推脱句"不能被当成新承诺（10-31 那天她连说七遍"说好的明早"） ----
t('"说好的明早，我记着呢。你催得越紧我越想拖" 不是承诺', () => {
  assert.equal(loops.promisesFrom('说好的明早，我记着呢。你催得越紧我越想拖', NOW).length, 0);
});
t('"改天穿上那件紫的再说" 不是承诺（没有给你/发你）', () => {
  assert.equal(loops.promisesFrom('行吧，改天穿上那件紫的再说', NOW).length, 0);
});
t('"明早正经给你拍" 才是承诺', () => {
  assert.equal(loops.promisesFrom('明早正经给你拍', NOW).length, 1);
});
t('同一件事已经在表上：再提只计数，不改写文案', () => {
  const db0 = loops.sweep(U, NOW); db0.items = []; loops.save(U, db0);
  loops.add(U, { text: '他让你拍张照给他', kind: 'his_ask', tag: 'photo', dueAt: NOW + 1800e3 });
  loops.add(U, { text: '站起来拍？我这件宽T恤配长袜，站起来拍出来跟证件照似的', kind: 'her_promise', tag: 'photo', dueAt: NOW + DAY });
  const it = loops.open(U, NOW);
  assert.equal(it.length, 1, JSON.stringify(it));
  assert.equal(it[0].text, '他让你拍张照给他');
  assert.equal(it[0].mentions, 2);
});
t('她空口答应的、没有时间的，一天后自动过期', () => {
  const db1 = loops.sweep(U, NOW); db1.items = []; loops.save(U, db1);
  loops.add(U, { text: '回头给你讲个事', kind: 'her_promise', tag: '' });
  assert.equal(loops.open(U, NOW).length, 1);
  assert.equal(loops.open(U, Date.now() + 25 * 3600e3).length, 0);   // 用真实时间戳：add() 用的是 Date.now()
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
