// 控制台设置页回归（0.6.4）：
// 1) 「保存」按钮必须调用读 s* 字段的那个函数（曾经被同名函数覆盖成读 br*，点了没反应）
// 2) 文件里不能有重名函数（同名后一个会静默覆盖前一个）
// 3) /api/brain 的 PUT 真能把 key 写进 setup.json
// 4) QQ 卡片在没装 NapCat 时要给出安装引导
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-ui-'));
const DATA = path.join(TMP, 'data');
const PORT = 3977;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n, ok ? '' : extra); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync(path.join(SRC, 'ui.mjs'), 'utf8');
check('页面「保存」按钮调用 saveBrainPage', /onclick="saveBrainPage\(this\)"/.test(src), '找不到按钮绑定');
check('saveBrainPage 读的是 s* 字段', /async function saveBrainPage[\s\S]{0,400}getElementById\("sUrl"\)/.test(src));
check('面板那份叫 saveBrainCfgBox 且读 br*', /async function saveBrainCfgBox[\s\S]{0,400}getElementById\("brUrl"\)/.test(src));
{
  const names = [...src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]).filter((n) => !/_legacy$/.test(n));
  const seen = new Map();
  const dup = [];
  for (const n of names) { seen.set(n, (seen.get(n) || 0) + 1); }
  for (const [n, c] of seen) if (c > 1) dup.push(n + '×' + c);
  check('没有重名函数（会静默覆盖）', dup.length === 0, dup.join(','));
}
check('状态里带 napcatReady', /napcatReady:\s*ncReady/.test(src));
check('状态里带 snowlumaReady', /snowlumaReady:\s*slReady/.test(src));
check('SnowLuma 引导不再写未接上', !/还没接上/.test(src) && !/TODO\(backend\)/.test(src) && /打开登录页/.test(src));
check('没装内核时给安装引导', /function napcatGuide\(S\)/.test(src) && /NapCatQQ\/releases/.test(src));
check('QQ 页有从零指南和协议开关', /从零接上 QQ/.test(src) && /id="qqProtocol"/.test(src) && /value="snowluma"/.test(src) && /value="napcat"/.test(src));
check('没出码时不只有一句确认路径', !src.includes('确认路径') && /qqNoQrHelp/.test(src) && /主人号/.test(src) && /launcher\.bat/.test(src));
{
  const brain = src.slice(src.indexOf('id="gBrain"'), src.indexOf('id="gMedia"'));
  const seq = ["providerOptions('brProvider'", 'id="brKey"', "customUrlBlock('brUrlAdv'", 'id="brUrl"', 'id="brModel"'];
  let at = -1; let brainOk = src.includes('<summary>自定义接口地址</summary>');
  for (const token of seq) {
    const i = brain.indexOf(token);
    if (i < 0 || i <= at) brainOk = false;
    at = i;
  }
  check('大脑顺序：供应商 → Key → 自定义地址 → 模型', brainOk);
  const media = src.slice(src.indexOf('id="gMedia"'), src.indexOf('id="gAuto"'));
  const rows = [
    ['data-p="tts.provider"', 'data-p="tts.key"', 'data-p="tts.baseUrl"', 'data-p="tts.model"'],
    ['data-p="asr.provider"', 'data-p="asr.key"', 'data-p="asr.baseUrl"', 'data-p="asr.model"'],
    ['data-p="draw.provider"', 'data-p="draw.key"', 'data-p="draw.baseUrl"', 'data-p="draw.model"'],
    ["providerOptions('viProvider'", 'data-p="vision.key"', 'data-p="vision.baseUrl"', 'data-p="vision.model"'],
  ];
  for (const row of rows) {
    let pos = -1; let ok = true;
    for (const token of row) {
      const i = media.indexOf(token);
      if (i < 0 || i <= pos) ok = false;
      pos = i;
    }
    check('模型页顺序 ' + row[0], ok);
  }
}

let child = null;
try {
  fs.mkdirSync(DATA, { recursive: true });
  child = spawn(process.execPath, [path.join(SRC, 'ui.mjs')], {
    env: { ...process.env, QQBOT_DATA: DATA, QQBOT_UI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: TMP,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/state`); up = r.ok; } catch {}
  }
  check('控制台起来了', up, log.slice(-300));

  const r = await fetch(`http://127.0.0.1:${PORT}/api/brain`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', key: 'sk-regress-0001' }),
  });
  const j = await r.json();
  check('PUT /api/brain 返回 ok', j && j.ok, JSON.stringify(j));
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'setup.json'), 'utf8'));
  check('key 真的落到 setup.json', saved.api && saved.api.key === 'sk-regress-0001', JSON.stringify(saved.api));
  check('baseUrl/model 也落了', saved.api.baseUrl === 'https://api.deepseek.com/v1' && saved.api.model === 'deepseek-flash');

  const g = await (await fetch(`http://127.0.0.1:${PORT}/api/brain`)).json();
  check('GET 回读是 keySet', g.keySet === true && /sk-reg/.test(g.keyMask), JSON.stringify(g));

  for (const relationship of ['女友', '老婆', '朋友', '写作搭档']) {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relationship }),
    });
    const result = await response.json();
    const persona = fs.readFileSync(path.join(DATA, 'persona.md'), 'utf8');
    const setup = await (await fetch(`http://127.0.0.1:${PORT}/api/setup`)).json();
    check('身份保存接口写入并回读：' + relationship,
      result.ok && persona.includes('关系/身份：' + relationship) && setup.relationship === relationship);
  }

  const snow = await fetch(`http://127.0.0.1:${PORT}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'snowluma', clientDir: 'D:/SnowLuma' }),
  });
  const snowSaved = await snow.json();
  const snowRead = await (await fetch(`http://127.0.0.1:${PORT}/api/setup`)).json();
  const snowFile = JSON.parse(fs.readFileSync(path.join(DATA, 'setup.json'), 'utf8'));
  check('SnowLuma 选择和路径能记下', snowSaved.ok && snowRead.protocol === 'snowluma' && snowRead.snowlumaDir === 'D:/SnowLuma' && snowFile.qq.protocol === 'snowluma', JSON.stringify(snowRead));
  const nap = await fetch(`http://127.0.0.1:${PORT}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'napcat', clientDir: 'D:/NapCat/shell' }),
  });
  const napRead = await (await fetch(`http://127.0.0.1:${PORT}/api/setup`)).json();
  check('切回 NapCat 写 napcat.dir 且不丢 SnowLuma 路径', nap.ok && napRead.protocol === 'napcat' && napRead.napcatDir === 'D:/NapCat/shell' && napRead.snowlumaDir === 'D:/SnowLuma');

  const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  check('state 里有 napcatReady', typeof st.napcatReady === 'boolean', JSON.stringify(st.napcatReady));
  check('state 里有 snowlumaReady', typeof st.snowlumaReady === 'boolean', JSON.stringify(st.snowlumaReady));
} catch (e) {
  console.log('FAIL 异常', e.message); fail++;
} finally {
  try { child && child.kill('SIGKILL'); } catch {}
  if (!process.env.KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  await sleep(200);
  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
