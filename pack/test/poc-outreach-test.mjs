// 她先开口的这场聊天：他回了她不能装没看见。
// 真要走（忙、睡、日程把她拉开）得说一句人话，并留一句回头接着聊的话。
// 跑法：node pack/test/poc-outreach-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as outreach from '../src/outreach.mjs';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log('PASS', name); pass++; }
  else { console.log('FAIL', name, extra); fail++; }
}

const NOW = 1_700_000_000_000;
const HOOK = /回头|等下|晚点|待会|待会儿|回来|醒了再|接着|跟你说|跟你讲|这事先放/;
const LEAVE = /睡了|去睡|先睡|去忙|先忙|先撤|先走|先去|到点了|有事/;

function threadOf(over) {
  return { by: 'her', open: true, at: NOW, lastTurnAt: NOW, owed: false, left: false, leftAt: 0, ...over };
}

check('她开口：这场算她开的，还没轮到她', (() => {
  const th = outreach.openByHer(NOW);
  return th.by === 'her' && th.open && !th.owed && outreach.isLive(th, NOW) && !outreach.mustAnswer(th, NOW);
})());

check('他一回，轮到她，而且 pending 清掉也不算这场结束', (() => {
  const th = outreach.noteHim(outreach.openByHer(NOW), NOW + 1000);
  return outreach.mustAnswer(th, NOW + 1000) && th.owed === true;
})());

check('她正常接完：场还开着，但不再欠一句', (() => {
  let th = outreach.noteHim(outreach.openByHer(NOW), NOW + 1000);
  th = outreach.noteHerReply(th, NOW + 2000, { leaving: false });
  return outreach.isLive(th, NOW + 2000) && !th.owed && !th.left && !outreach.mustAnswer(th, NOW + 2000);
})());

check('她说了要走：他马上追一句，这几分钟里还得接', (() => {
  let th = outreach.noteHim(outreach.openByHer(NOW), NOW + 1000);
  th = outreach.noteHerReply(th, NOW + 2000, { leaving: true });
  const grace = outreach.noteHim(th, NOW + 2000 + 30e3);
  const later = outreach.noteHim(th, NOW + 2000 + outreach.LEAVE_GRACE_MS + 1000);
  return th.left && outreach.mustAnswer(grace, NOW + 2000 + 30e3) && !outreach.mustAnswer(later, NOW + 2000 + outreach.LEAVE_GRACE_MS + 1000);
})());

check('隔了太久：这场凉了，不再逼她回', (() => {
  const th = outreach.noteHim(outreach.openByHer(NOW), NOW + 1000);
  return !outreach.mustAnswer(th, NOW + outreach.OPEN_MS + 5000);
})());

check('她先开的这场，计划里的「这次不回」作废', (() => {
  const held = outreach.planSkip({ ms: 8000, skip: true }, true);
  const free = outreach.planSkip({ ms: 8000, skip: true }, false);
  return held.skip === false && held.ms === 8000 && free.skip === true;
})());

check('离开的话要同时有「走」和「回头」', (() => {
  const line = outreach.leaveLine('busy', NOW);
  const sleep = outreach.leaveLine('sleep', NOW);
  const bare = outreach.withHook('我去睡了', 'sleep', NOW);
  return LEAVE.test(line) && HOOK.test(line)
    && LEAVE.test(sleep) && HOOK.test(sleep)
    && outreach.looksLikeLeave(line)
    && !outreach.looksLikeLeave('我去睡了')
    && outreach.looksLikeLeave(bare)
    && /醒了再接/.test(bare);
})());

check('日程里的上课/睡觉，刚到点算把她拉开；吃饭不算，过了宽限也不算', (() => {
  const plan = { items: [
    { at: '12:00', what: '吃饭' },
    { at: '13:00', what: '去上课' },
    { at: '23:40', place: '卧室', what: '躺下睡觉' },
  ] };
  const cls = outreach.schedulePull(plan, '13:04', { graceMin: 8 });
  const meal = outreach.schedulePull(plan, '12:02', { graceMin: 8 });
  const late = outreach.schedulePull(plan, '13:20', { graceMin: 8 });
  const bed = outreach.schedulePull(plan, '23:42', { graceMin: 8 });
  return cls && cls.reason === 'busy' && /上课/.test(cls.what)
    && meal == null
    && late == null
    && bed && bed.reason === 'sleep';
})());

check('空话和省略号要换成离开；正常一句别改', (() => {
  const gone = outreach.sealReply('……', { why: { reason: 'busy', what: '' }, now: NOW });
  const keep = outreach.sealReply('到家就好', { why: { reason: 'busy', what: '' }, now: NOW });
  const nap = outreach.sealReply('', { sleepHours: 7, now: NOW });
  const named = outreach.sealReply('……', { why: { reason: 'life', what: '上课' }, now: NOW });
  return gone.leave && HOOK.test(gone.text) && gone.sleep === false
    && keep.leave === false && keep.text === '到家就好'
    && nap.sleep && /睡/.test(nap.text) && HOOK.test(nap.text)
    && /上课/.test(named.text) && HOOK.test(named.text);
})());

check('只发了表情不算消失', (() => {
  const sticker = outreach.sealReply('', { media: true, why: { reason: 'busy' }, now: NOW });
  return sticker.leave === false && sticker.text === '';
})());

const bridgeSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'bridge.mjs'), 'utf8');
check('桥接：她先开的场会关掉「这次不回」', /outreachHold\(conv\)/.test(bridgeSrc) && /outreach\.planSkip\(plan, true\)/.test(bridgeSrc));
check('桥接：睡着但这场没说完，先把离开说出来', /睡着了，但这场是她开的，先说一声/.test(bridgeSrc) && /她睡着了，这条不回/.test(bridgeSrc));
check('桥接：跳过和空正文会补上离开', /她标了跳过，这场是她开的，改成离开/.test(bridgeSrc) && /outreach\.sealReply\(/.test(bridgeSrc));
check('桥接：她先找的他，回复生成慢了也不许丢掉', /过了 4 分钟，但这场是她开的、他还在等，照发/.test(bridgeSrc) && /结果已过期，丢弃:/.test(bridgeSrc));
check('桥接：主动开口会记下这场，日程拉开时先说一声', /outreach\.openByHer\(/.test(bridgeSrc) && /async function outreachLeaveTick\(/.test(bridgeSrc) && /schedulePull\(planCache/.test(bridgeSrc));
check('桥接：群聊不走这套', /conv\.kind === 'group'\) return false/.test(bridgeSrc));

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-outreach-'));
const DATA = path.join(TMP, 'data');
const U = '10086002';
const LOCAL_PORT = 3796;
const API = path.join(TMP, 'api.json');

let nextReply = '嗯';
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: nextReply } }],
      usage: { prompt_tokens: 4, completion_tokens: 4 },
    }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let log = '';

function chatFile() { return path.join(DATA, 'chat', U + '.jsonl'); }
function readRows() {
  try {
    return fs.readFileSync(chatFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function readThread() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'proactive.json'), 'utf8'));
    return (j[U] && j[U].herThread) || null;
  } catch { return null; }
}
function outs(rows) { return rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text); }

async function waitOut(before, pred, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const fresh = readRows().slice(before);
    const hit = outs(fresh).find(pred);
    if (hit) return fresh;
    await sleep(200);
  }
  return null;
}

async function post(pathname, body) {
  const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status !== 200) throw new Error(pathname + ' HTTP ' + r.status);
}

try {
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + stub.address().port + '/v1';
  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(API, JSON.stringify({
    enabled: true, baseUrl: base, model: 'stub-model', key: 'sk-stub', maxTokens: 200,
  }));
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: U } }));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    proactive: { enabled: false, minGapMin: 999, quietMin: 999 },
    browse: { enabled: false },
    qzone: { enabled: false },
    reply: { debounceMs: 50, privateDelayMs: 0, groupDelayMs: 0 },
    memory: { digest: false, embed: { on: false } },
    norms: { enabled: false },
    life: { journal: false },
  }));

  child = spawn(process.execPath, [path.join(SRC, 'bridge.mjs')], {
    env: {
      ...process.env,
      QQBOT_DATA: DATA,
      QQBOT_API_FILE: API,
      QQBOT_LOCAL_PORT: String(LOCAL_PORT),
      QQBOT_NAP_SKIP: '1',
      QQBOT_DELAY_SCALE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: TMP,
  });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/say', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      up = r.status === 400 || r.status === 200;
    } catch {}
  }
  check('桥接起来了', up, log.slice(-400));
  if (!up) throw new Error('local channel down');

  // —— 她先开口，然后睡着，还没说再见 ——
  {
    nextReply = '还没睡呢';
    const before = readRows().length;
    await post('/proactive', {});
    const fresh = await waitOut(before, (t) => /还没睡呢/.test(t));
    check('她先开口，这句话发出去了', !!fresh, log.slice(-500));
    let th = null;
    for (let i = 0; i < 30 && !(th && th.open && !th.left); i++) { await sleep(100); th = readThread(); }
    check('这场记成她开的', !!(th && th.by === 'her' && th.open && !th.owed), JSON.stringify(th));

    const mindFile = path.join(DATA, 'state', U + '.json');
    const st = JSON.parse(fs.readFileSync(mindFile, 'utf8'));
    st.asleepUntil = Date.now() + 6 * 3600e3;
    st.energy = 80;
    fs.writeFileSync(mindFile, JSON.stringify(st));

    nextReply = 'UNIQUE_SHOULD_NOT_APPEAR';
    const mark = readRows().length;
    await post('/say', { text: '在吗' });
    const gone = await waitOut(mark, (t) => LEAVE.test(t) && HOOK.test(t));
    const said = gone ? outs(gone).join('\n') : '';
    check('睡着了也不许装没看见：先说去睡，并留钩子', !!gone && !/UNIQUE_SHOULD_NOT_APPEAR/.test(said), said || log.slice(-600));
    const closed = readThread();
    check('说完要睡，这场算她道过别了', !!(closed && closed.left), JSON.stringify(closed));

    const n0 = readRows().length;
    await post('/say', { text: '喂' });
    await sleep(2500);
    const extra = outs(readRows().slice(n0));
    check('道过别之后继续睡，不再接', extra.length === 0, extra.join(' | ') || log.slice(-400));

    const st2 = JSON.parse(fs.readFileSync(mindFile, 'utf8'));
    st2.asleepUntil = 0;
    st2.energy = 80;
    fs.writeFileSync(mindFile, JSON.stringify(st2));
  }

  // —— 醒着：正常接话；模型想跳过时改成离开 ——
  {
    nextReply = '在干嘛呀';
    const before = readRows().length;
    await post('/proactive', {});
    const opened = await waitOut(before, (t) => /在干嘛呀/.test(t));
    check('第二场她又先开口', !!opened, log.slice(-400));
    let th = null;
    for (let i = 0; i < 30 && !(th && th.open && !th.left); i++) { await sleep(100); th = readThread(); }
    check('第二场重新算她开的', !!(th && th.open && !th.left), JSON.stringify(th));

    nextReply = '到家就好';
    const b2 = readRows().length;
    await post('/say', { text: '刚到家' });
    const replied = await waitOut(b2, (t) => /到家就好/.test(t));
    check('他回了闲话，她照常接，不拿离开的套话顶掉', !!replied, outs(readRows().slice(b2)).join(' | '));
    const mid = readThread();
    check('接完还算这场，但不再欠一句', !!(mid && mid.open && !mid.owed && !mid.left), JSON.stringify(mid));

    nextReply = '[[跳过]]';
    const b3 = readRows().length;
    await post('/say', { text: '嗯' });
    const left = await waitOut(b3, (t) => LEAVE.test(t) && HOOK.test(t) && !/跳过/.test(t));
    const leftText = left ? outs(left).join('\n') : '';
    check('模型想跳过时，改成一句离开加钩子', !!left && !/\[\[/.test(leftText), leftText || log.slice(-600));
    const end = readThread();
    check('跳过被改成离开之后，这场记下她道过别', !!(end && end.left), JSON.stringify(end));
    check('日志记了「不能装没看见」', /这场是她开的，改成离开|补上离开|不能装没看见/.test(log));
  }
} catch (e) {
  console.log('FAIL 异常', e.message);
  fail++;
} finally {
  try { child && child.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  if (!process.env.KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  else console.log('TMP kept at', TMP);
  await sleep(200);
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
