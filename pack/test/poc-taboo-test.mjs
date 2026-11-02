// 主人亲口说「别提 / 不要再说 / 别再提」，后面几轮都得记住。
// 「可以说了 / 没事了可以提」才解开。模型还是说出来，就在发出去之前拿掉。
// 只覆盖陪伴聊天窗。QQ 通道不记、不挡。
// 跑法：node pack/test/poc-taboo-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-taboo-'));
const DATA = path.join(TMP, 'data');
process.env.QQBOT_DATA = DATA;
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });

const taboos = await import(pathToFileURL(path.join(SRC, 'taboos.mjs')).href);
const again = await import(pathToFileURL(path.join(SRC, 'taboos.mjs')).href + '?session=2');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log('PASS', name); pass++; }
  else { console.log('FAIL', name, extra); fail++; }
}
const UIN = '10086002';
const file = path.join(DATA, 'agent-home', 'memory', 'taboos', UIN + '.json');
const wipe = () => { try { fs.rmSync(file, { force: true }); } catch {} };
const topics = () => { wipe(); };

topics();
function setOf(text) {
  return taboos.parse(text).filter((o) => o.op === 'set').map((o) => o.topic);
}
function liftOf(text) {
  return taboos.parse(text).filter((o) => o.op === 'lift');
}

check('别提 X', setOf('别提前女友').join() === '前女友');
check('别再提 X', setOf('别再提前女友').join() === '前女友');
check('不要再说 X', setOf('不要再说前女友').join() === '前女友');
check('不要再提我妈', setOf('不要再提我妈了').join() === '我妈');
check('别再说工资的事', setOf('别再说工资的事').join() === '工资');
check('以后别提那家公司', setOf('以后别提那家公司').join() === '那家公司');
check('别跟我提离婚', setOf('别跟我提离婚').join() === '离婚');
check('不准再提分手', setOf('不准再提分手').join() === '分手');
check('不许提加班', setOf('不许提加班').join() === '加班');
check('别再聊前任', setOf('别再聊前任').join() === '前任');
check('带引号', setOf('别提「面试」').join() === '面试');
check('话题在前面', setOf('前女友的事别提了').join() === '前女友');
check('前女友别再提', setOf('前女友别再提').join() === '前女友');
check('逗号拆开再接上', setOf('前女友的事，别提了').join() === '前女友');
check('一句里两件', setOf('别提前女友，也别提工资').join(',') === '前女友,工资');
check('别提钱', setOf('别提钱').join() === '钱');
check('别提了没有话题，不记', setOf('别提了').length === 0);
check('别说了不是禁忌', setOf('别说了').length === 0);
check('不要再说了没有话题，不记', setOf('不要再说了').length === 0);
check('这事别提了不记', setOf('这事别提了').length === 0);
check('别提这个不记', setOf('别提这个').length === 0);
check('别提多好看是口语，不记', setOf('别提多好看了').length === 0);
check('别提有多烦不记', setOf('别提有多烦').length === 0);
check('我好累别提了不记', setOf('我好累别提了').length === 0);
check('别提交不是在提这件事', setOf('别提交代码').length === 0);
check('别提示我不是禁忌', setOf('别提示我').length === 0);
check('标签不能混进禁忌', setOf('别提[[跳过]]').length === 0);

check('可以说了是解开、不点名', liftOf('可以说了').length === 1 && liftOf('可以说了')[0].topic === '' && !liftOf('可以说了')[0].all);
check('没事了可以提', liftOf('没事了可以提').length === 1 && liftOf('没事了可以提')[0].topic === '');
check('没事了，可以提了', liftOf('没事了，可以提了').some((o) => o.op === 'lift' && !o.topic));
check('前女友可以说了', liftOf('前女友可以说了')[0].topic === '前女友');
check('可以提前女友了', liftOf('可以提前女友了')[0].topic === '前女友');
check('都可以说了解开全部', liftOf('都可以说了')[0].all === true);
check('没事了单独一句不解', liftOf('没事了').length === 0);
check('问句不算解开', liftOf('前女友可以说吗').length === 0 && liftOf('可以提前走吗').length === 0);

wipe();
const n1 = taboos.note(UIN, '别再提我前女友');
check('记到盘上', n1.added.join() === '前女友' || n1.added.join() === '我前女友', JSON.stringify(n1));
check('文件在禁忌目录', fs.existsSync(file));
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
check('条目还在，没写进普通记忆', saved.items.length === 1 && saved.items[0].liftedAt === 0);
check('新会话读得回', again.activeTopics(UIN).length === 1 && again.activeTopics(UIN)[0].includes('前女友'));
const n2 = taboos.note(UIN, '别提前女友');
check('同一件不重复记', n2.added.length === 0 && taboos.activeTopics(UIN).length === 1);
check('提示词里有这件', taboos.render(UIN).includes('【他让你别再提的事】') && taboos.render(UIN).includes('前女友'));
taboos.note(UIN, '不要再说工资');
check('两件都有效', taboos.activeTopics(UIN).length === 2);
const liftedLatest = taboos.note(UIN, '可以说了');
check('可以说了解开最近一条', liftedLatest.lifted.join() === '工资' && taboos.activeTopics(UIN).length === 1);
check('解开的还留在文件里', JSON.parse(fs.readFileSync(file, 'utf8')).items.some((i) => i.topic === '工资' && i.liftedAt));
taboos.note(UIN, '没事了可以提');
check('没事了可以提再解开剩下的', taboos.activeTopics(UIN).length === 0);
check('解开之后提示词是空的', taboos.render(UIN) === '');
taboos.note(UIN, '别提前女友');
taboos.note(UIN, '也别提工资');
taboos.note(UIN, '都可以说了');
check('都可以说了全部解开', taboos.activeTopics(UIN).length === 0);
taboos.note(UIN, '别提前女友');
taboos.note(UIN, '前女友可以说了');
check('点名解开', taboos.activeTopics(UIN).length === 0);
taboos.note(UIN, '别提前女友');
check('解开之后还能再立', taboos.activeTopics(UIN).some((t) => t.includes('前女友')));

const g1 = taboos.guard('你前女友最近怎么样', ['前女友']);
check('整句都在提，换成不点名的话', g1.hit === '前女友' && g1.text === taboos.REDIRECT && !g1.text.includes('前女友'));
const g2 = taboos.guard('今天天气不错。你前女友呢。吃饭了吗', ['前女友']);
check('只拿掉那一句', g2.hit === '前女友' && g2.text.includes('今天天气不错') && g2.text.includes('吃饭了吗') && !g2.text.includes('前女友'));
const g3 = taboos.guard('吃饭了吗', ['前女友']);
check('没提到就原样', g3.hit === '' && g3.text === '吃饭了吗');
const g4 = taboos.guard('前女友又怎么了', ['前女友'], { allow: ['前女友'] });
check('他这轮自己说开了就不挡', g4.hit === '' && g4.text.includes('前女友'));
check('下禁令的那句不算他自己说开', taboos.opened('别提前女友', ['前女友']).length === 0);
check('他主动提起算说开', taboos.opened('前女友找我了', ['前女友']).join() === '前女友');
check('我前女友也对得上前女友', taboos.guard('你前女友呢', ['我前女友']).hit === '我前女友' && !taboos.guard('你前女友呢', ['我前女友']).text.includes('前女友'));
check('我妈不会因为一个妈就拦', taboos.guard('你妈呢', ['我妈']).hit === '' && taboos.guard('别跟我妈说', ['我妈']).hit === '我妈');
check('坏 uin 不写文件', taboos.note('../etc/passwd', '别提前女友').added.length === 0 && !fs.existsSync(path.join(DATA, 'agent-home', 'memory', 'taboos', '..json')));
check('只认陪伴聊天窗', taboos.forCompanion({ kind: 'local' }) === true);
check('QQ 私聊不走禁忌', taboos.forCompanion({ kind: 'private', id: UIN }) === false);
check('群不走禁忌', taboos.forCompanion({ kind: 'group' }) === false);

const bridge = fs.readFileSync(path.join(SRC, 'bridge.mjs'), 'utf8');
check('桥接用 forCompanion 做门', /taboos\.forCompanion\(conv\)/.test(bridge));
check('桥接会把禁忌写进提示词', /tabooBlock/.test(bridge) && /taboos\.render\(/.test(bridge));
check('发出去之前会挡', /taboos\.guard\(/.test(bridge));

// ---------- 真走本地通道：下一轮提示词里有，模型又提就被拿掉 ----------
const U = UIN;
const LOCAL_PORT = 3794;
const API = path.join(TMP, 'api.json');
let nextReply = '嗯';
const prompts = [];
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const user = (j.messages || []).filter((m) => m && m.role === 'user').map((m) => String(m.content || '')).join('\n');
      if (user) prompts.push(user);
    } catch {}
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
function tabooFile() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: [] }; }
}
function activeNow() {
  return (tabooFile().items || []).filter((i) => i && i.topic && !i.liftedAt).map((i) => i.topic);
}

async function say(text, reply) {
  nextReply = reply;
  const before = readRows().length;
  const p0 = prompts.length;
  const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (r.status !== 200) throw new Error('say HTTP ' + r.status);
  let lastN = -1;
  let stable = 0;
  let sawOut = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const rows = readRows();
    const freshOut = rows.slice(before).filter((x) => x.dir === 'out');
    if (freshOut.length) sawOut = true;
    if (rows.length === lastN) stable++;
    else { stable = 0; lastN = rows.length; }
    if (sawOut && stable >= 3) {
      return {
        rows: rows.slice(before),
        prompts: prompts.slice(p0),
        said: rows.slice(before).filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n'),
      };
    }
  }
  throw new Error('没等到回复：「' + text + '」\n' + log.slice(-800));
}

try {
  wipe();
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + stub.address().port + '/v1';
  fs.writeFileSync(API, JSON.stringify({
    enabled: true, baseUrl: base, model: 'stub-model', key: 'sk-stub', maxTokens: 200,
  }));
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: U } }));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    proactive: { enabled: false },
    browse: { enabled: false },
    qzone: { enabled: false },
    reply: { debounceMs: 50, privateDelayMs: 0, groupDelayMs: 0 },
    memory: { digest: false, embed: { on: false } },
    norms: { enabled: false },
    dev: { noSleep: true },
  }, null, 2));

  child = spawn(process.execPath, [path.join(SRC, 'bridge.mjs')], {
    env: {
      ...process.env,
      QQBOT_DATA: DATA,
      QQBOT_API_FILE: API,
      QQBOT_LOCAL_PORT: String(LOCAL_PORT),
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

  {
    const a = await say('别提前女友', '好，前女友的事我记下了');
    check('当轮就写进禁忌', activeNow().includes('前女友'), JSON.stringify(activeNow()));
    check('当轮提示词里有禁令', a.prompts.some((p) => p.includes('【他让你别再提的事】') && p.includes('前女友')));
    check('当轮嘴上又提，发出去的没有这个词', !a.said.includes('前女友') && a.said.trim().length > 0, a.said);
  }
  {
    const a = await say('今天干嘛呢', '你前女友最近怎么样\n吃饭了吗');
    check('下一轮提示词还在', a.prompts.some((p) => p.includes('【他让你别再提的事】') && p.includes('前女友')));
    check('下一轮只留下没碰到的那句', a.said.includes('吃饭了吗') && !a.said.includes('前女友'), a.said);
    check('日志记了改掉', /回复里碰到了不该提的/.test(log));
  }
  {
    const a = await say('前女友找我了', '前女友又怎么了');
    check('他先说开，这一轮可以接', a.said.includes('前女友'), a.said);
  }
  {
    const a = await say('在干嘛', '那前女友后来呢');
    check('他没再提，禁忌还在', !a.said.includes('前女友') && a.said.includes(taboos.REDIRECT), a.said);
    check('还没解开', activeNow().includes('前女友'));
  }
  {
    const a = await say('可以说了', '那前女友的事我还记得');
    check('可以说了之后文件里解开了', !activeNow().includes('前女友'), JSON.stringify(tabooFile().items));
    check('解开之后回复可以出现这个词', a.said.includes('前女友'), a.said);
  }
  {
    await say('别提多好看了', '嗯');
    await say('别提交代码', '好');
    check('别提多 / 别提交 不会新立一条', activeNow().length === 0, JSON.stringify(activeNow()));
  }
  {
    await say('别提工资，也别提前女友', '行');
    check('一句两件都留下', activeNow().includes('工资') && activeNow().includes('前女友'), JSON.stringify(activeNow()));
    await say('没事了可以提', '嗯');
    check('没事了可以提解开最近一件', activeNow().length === 1, JSON.stringify(activeNow()));
    await say('都可以说了', '好');
    check('都可以说了清干净', activeNow().length === 0, JSON.stringify(activeNow()));
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
