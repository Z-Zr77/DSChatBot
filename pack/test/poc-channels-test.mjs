// 通道层：她住在桥接里，QQ / 本地窗口只是出口。出口堵了她照样活。
import assert from 'node:assert';
import path from 'node:path';

const SRC = path.resolve('pack', 'src');
const ch = await import(new URL('file:///' + path.join(SRC, 'channels.mjs').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '→', e.message); fail++; }
}

ch.reset();
ch.register({ id: 'qq', label: 'QQ', online: false, kinds: ['private', 'group'], conv: (u) => ({ kind: 'private', id: String(u) }) });
ch.register({ id: 'local', label: '本地窗口', online: true, kinds: ['local'], conv: (u) => ({ kind: 'local', id: String(u) }) });

t('注册后 list 里有两条，字段齐全', () => {
  const l = ch.list(1000);
  assert.equal(l.length, 2);
  const q = l.find(x => x.id === 'qq');
  assert.equal(q.online, false);
  assert.equal(q.label, 'QQ');
  assert.ok(typeof q.downSec === 'number');
});

t('setOnline 记录连上/断开的时间，downSec 跟着走', () => {
  ch.setOnline('qq', true, 10000);
  assert.equal(ch.online('qq'), true);
  assert.equal(ch.downSec('qq', 20000), 0);
  ch.setOnline('qq', false, 30000);
  assert.equal(ch.online('qq'), false);
  assert.equal(ch.downSec('qq', 30000 + 90 * 1000), 90);
});

t('pick 优先拿通的通道：QQ 断了就落到本地窗口', () => {
  assert.equal(ch.pick(['qq', 'local']).id, 'local');
  ch.setOnline('qq', true, 1);
  assert.equal(ch.pick(['qq', 'local']).id, 'qq');
  ch.setOnline('qq', false, 2);
});

t('pick 全都不通时返回 null（调用点自己决定攒着还是只记日志）', () => {
  ch.setOnline('local', false, 3);
  assert.equal(ch.pick(['qq', 'local']), null);
  ch.setOnline('local', true, 4);
});

t('convOn 用通道自己的会话构造器', () => {
  const c = ch.get('qq');
  assert.deepEqual(ch.convOn(c, '1000000001'), { kind: 'private', id: '1000000001' });
  const l = ch.get('local');
  assert.deepEqual(ch.convOn(l, '1000000001'), { kind: 'local', id: '1000000001' });
});

t('重复 setOnline 同一状态不刷新时间戳（避免掉线时长被重置）', () => {
  ch.setOnline('qq', false, 500);
  const a = ch.get('qq').since;
  ch.setOnline('qq', false, 900000);
  assert.equal(ch.get('qq').since, a);
});

// ---- 投递层：这句话归哪个出口、发不出去时怎么报 ----
t('forConv：私聊/群归 QQ，本地归本地窗口', () => {
  ch.setOnline('qq', true, 1);
  assert.equal(ch.forConv({ kind: 'private', id: '1' }).id, 'qq');
  assert.equal(ch.forConv({ kind: 'group', id: '2' }).id, 'qq');
  assert.equal(ch.forConv({ kind: 'local', id: '3' }).id, 'local');
  assert.equal(ch.forConv({ kind: 'nope' }), null);
});

t('dispatch：QQ 断了要明确报 offline，调用点才知道能不能换出口', async () => {
  ch.setOnline('qq', false, 2);
  const r = await ch.dispatch({ kind: 'private', id: '1' }, { text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
});

t('dispatch：通道自己抛错也要变成 {ok:false}，不能把异常漏给她的主流程', async () => {
  ch.reset();
  ch.register({ id: 'local', label: '本地窗口', online: true, kinds: ['local'], send: async () => { throw new Error('boom'); } });
  const r = await ch.dispatch({ kind: 'local', id: '1' }, { text: 'x' });
  assert.equal(r.ok, false);
  assert.match(String(r.err), /boom/);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
