// 答应发照片却没写 [[自拍]] / [[画]] / [[场景]]：不能只嘴上说「好，我发」。
// 出不了图（画图关了、张数用尽、生成失败）时，同一轮必须给人话，不能再被 10 分钟静音吃掉。
// 跑法：node pack/test/poc-photo-promise-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as imageintent from '../src/imageintent.mjs';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log('PASS', name); pass++; }
  else { console.log('FAIL', name, extra); fail++; }
}

check('没人要照片时，「好，我发」不算在交照片', imageintent.claimsIncomingPhoto('好，我发', { asked: false }) === false);
check('他刚要了照片，「好，我发」算答应', imageintent.claimsIncomingPhoto('好，我发', { asked: true }) === true);
check('「我发现你不在」不是在发照片', imageintent.claimsIncomingPhoto('我发现你不在', { asked: true }) === false);
check('明确拒绝不算答应', imageintent.claimsIncomingPhoto('不拍，别催', { asked: true }) === false);
check('推到以后不算现在就发', imageintent.claimsIncomingPhoto('明天再拍', { asked: true }) === false);
check('把照片说清楚，即使没标 asked 也算在交图', imageintent.claimsIncomingPhoto('拍一张给你', { asked: false }) === true);
check('答应发的是文件，不是照片', imageintent.claimsIncomingPhoto('我发你那个文件', { asked: true }) === false);
check('场景从答应的那句里摘，空话摘不到', imageintent.sceneHintFromReply('好，我发') === '');
check('场景留下地点', imageintent.sceneHintFromReply('在楼下，好，我发').includes('楼下'));

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-photo-'));
const DATA = path.join(TMP, 'data');
const U = '10086001';
const LOCAL_PORT = 3791;
const API = path.join(TMP, 'api.json');

let nextReply = '嗯';
let imageMode = 'ok';
let imageHits = 0;
let lastPrompt = '';
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = req.url || '';
    if (u.includes('/images/')) {
      imageHits++;
      try { lastPrompt = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt || ''); } catch { lastPrompt = ''; }
      if (imageMode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
      return;
    }
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
let BASE = '';

function chatFile() { return path.join(DATA, 'chat', U + '.jsonl'); }
function readRows() {
  try {
    return fs.readFileSync(chatFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function writeCfg(draw) {
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    draw,
    proactive: { enabled: false },
    browse: { enabled: false },
    qzone: { enabled: false },
    reply: { debounceMs: 50, privateDelayMs: 0, groupDelayMs: 0 },
    memory: { digest: false, embed: { on: false } },
    norms: { enabled: false },
    dev: { noSleep: true },
  }, null, 2));
}
function drawCfg(over) {
  return {
    enabled: true,
    provider: 'openai',
    baseUrl: BASE,
    model: 'stub-image',
    key: 'sk-test',
    perDay: 3,
    keepMin: 0,
    ref: false,
    ...over,
  };
}

async function say(text, reply) {
  nextReply = reply;
  const before = readRows().length;
  const hits0 = imageHits;
  const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (r.status !== 200) throw new Error('say HTTP ' + r.status);
  let lastN = -1;
  let lastHits = -1;
  let stable = 0;
  let sawOut = false;
  for (let i = 0; i < 70; i++) {
    await sleep(250);
    const rows = readRows();
    const freshOut = rows.slice(before).filter((x) => x.dir === 'out');
    if (freshOut.length) sawOut = true;
    if (rows.length === lastN && imageHits === lastHits) stable++;
    else { stable = 0; lastN = rows.length; lastHits = imageHits; }
    if (sawOut && stable >= 3) return { rows: rows.slice(before), hits: imageHits - hits0 };
  }
  throw new Error('没等到回复：「' + text + '」\n' + log.slice(-800));
}

try {
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  BASE = 'http://127.0.0.1:' + stub.address().port + '/v1';
  fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(API, JSON.stringify({
    enabled: true, baseUrl: BASE, model: 'stub-model', key: 'sk-stub', maxTokens: 200,
  }));
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({ qq: { ownerUin: U } }));
  writeCfg(drawCfg());

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

  {
    const a = await say('在吗', '拍一张给你');
    const imgs = a.rows.filter((x) => x.dir === 'out' && x.type === 'image');
    check('他没要照片，她自己说拍一张也不出图', a.hits === 0 && imgs.length === 0, 'hits=' + a.hits);
  }
  {
    const a = await say('拍张自拍给我', '等一下');
    check('要了照片但她没答应，不出图', a.hits === 0, 'hits=' + a.hits);
  }
  {
    const a = await say('那你到底发不发', '好，我发');
    const imgs = a.rows.filter((x) => x.dir === 'out' && x.type === 'image');
    const said = a.rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n');
    check('口头答应 + 还开着的自拍要求 → 去拍', a.hits === 1 && imgs.length === 1, 'hits=' + a.hits + ' imgs=' + imgs.length + ' text=' + said);
    check('日志记了补拍', /没有图标签，补拍/.test(log));
  }
  {
    const a = await say('再拍一张自拍', '在楼下，好，我发');
    check('补拍用了她这句话里的地点', a.hits === 1 && /楼下/.test(lastPrompt), lastPrompt.slice(0, 180));
  }
  {
    const hits0 = imageHits;
    const a = await say('再拍一张', '不拍，别催');
    check('她拒绝时不补拍', a.hits === 0 && imageHits === hits0, 'hits=' + a.hits);
  }
  {
    const a = await say('拍张自拍', '行\n[[自拍: 小区门口]]');
    check('已经写了自拍标签就只拍一张，不重复补', a.hits === 1 && /小区门口/.test(lastPrompt), 'hits=' + a.hits + ' ' + lastPrompt.slice(0, 120));
  }

  async function reload(over) {
    const mark = log.length;
    writeCfg(drawCfg(over));
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (log.slice(mark).includes('热加载')) return;
    }
    throw new Error('配置没热加载\n' + log.slice(-500));
  }

  await reload({ enabled: false });
  {
    const hits0 = imageHits;
    const a = await say('拍张照片给我', '好，我发');
    const said = a.rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n');
    check('画图关了仍答应要发 → 当轮说明，且不去请求出图', a.hits === 0 && imageHits === hits0 && /拍不了，相机没开/.test(said), said);
  }

  imageMode = 'fail';
  await reload({ enabled: true });
  {
    const a = await say('拍张自拍', '好，我发');
    const said = a.rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n');
    check('出图失败会说明', a.hits === 1 && /拍不出来/.test(said), said);
  }
  {
    const a = await say('再来一张自拍', '嗯我发');
    const said = a.rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n');
    check('十分钟内再失败一次也要说明', a.hits === 1 && /拍不出来/.test(said), said);
  }

  imageMode = 'ok';
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(DATA, 'agent-home'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'agent-home', 'draw-count.json'), JSON.stringify({ day, n: 999 }));
  {
    const hits0 = imageHits;
    const a = await say('拍张自拍给我看看', '好，我发');
    const said = a.rows.filter((x) => x.dir === 'out' && x.type === 'text').map((x) => x.text).join('\n');
    check('张数用尽会说明，且不再出图', a.hits === 0 && imageHits === hits0 && /今天不拍了，手酸|明天吧，今天没心情拍|不拍了，脸都没洗/.test(said), said);
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
