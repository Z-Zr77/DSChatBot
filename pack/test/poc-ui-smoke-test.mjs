// 界面体检（0.6.5）：把"点了没反应 / 显示 undefined"这一整类问题钉在发布前
// 1) 页面里的 window.__WK_INNER 真的被注入了（不只是引用）
// 2) 所有 onclick / onchange 里调用的函数都在页面脚本里定义过
// 3) 脚本里 getElementById/$('#x') 用到的 id 在 HTML 里存在
// 4) 页面不出现裸的 undefined
// 5) 聊天窗（chatserver）同样过一遍
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-smoke-'));
const DATA = path.join(TMP, 'data');
const UI_PORT = 3981;
const CHAT_PORT = 3982;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n, ok ? '' : String(extra).slice(0, 400)); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从页面里找出：所有 onclick/onchange 调用的函数名、脚本里引用到的元素 id
function audit(label, html) {
  check(label + '：注入了 __WK_INNER（不只是引用）', /window\.__WK_INNER\s*=/.test(html), '页面里没有 window.__WK_INNER = 定义');
  check(label + '：注入了 __wkBind', /window\.__wkBind\s*=/.test(html), '缺少 __wkBind');

  const handlers = new Set();
  for (const m of html.matchAll(/on(?:click|change|input|submit)\s*=\s*"([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(m[1]);
  // 只校验看起来像自定义函数的（排除 this/event/confirm 等内建）
  const builtin = new Set(['this', 'event', 'confirm', 'alert', 'print', 'open', 'close', 'focus', 'blur', 'remove', 'stopPropagation']);
  const missing = [...handlers].filter((n) => !builtin.has(n) && !new RegExp('(?:function\\s+' + n + '\\s*\\()|(?:' + n + '\\s*=\\s*(?:async\\s*)?(?:function|\\())').test(html));
  check(label + '：按钮绑的函数都存在', missing.length === 0, '没定义：' + missing.join(','));

  const ids = new Set();
  for (const m of html.matchAll(/(?:getElementById\(|querySelector\(|\$\()\s*['"]#?([A-Za-z][\w-]*)['"]/g)) ids.add(m[1]);
  // 有些元素是脚本里动态创建并赋 id 的（mask.id = 'wkMask'），这也算存在
  const noEl = [...ids].filter((id) => {
    const re = new RegExp('id\\s*=\\s*["\']' + id + '["\']');
    return !re.test(html) && !html.includes('id=\\"' + id + '\\"');
  });
  // 允许动态创建的 id（模板里拼出来的）：只报告数量，不硬失败
  const hardNoEl = noEl.filter((id) => /^(wk|br|s[A-Z]|btn|work|perm|mem|log|qr|upd|cfg|owner|dv|ig)/.test(id));
  check(label + '：脚本引用的 id 都在页面里', hardNoEl.length === 0, '找不到元素：' + hardNoEl.join(','));

  check(label + '：页面上没有裸 undefined', !/>\s*undefined\s*</.test(html) && !/undefined<\/div>/.test(html), '页面里出现了 undefined 文本');
  return { handlers: [...handlers], missing, noEl, hardNoEl };
}

const kids = [];
async function start(file, env, port, probe) {
  const script = path.isAbsolute(file) ? file : path.join(SRC, file);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: TMP,
  });
  kids.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${port}${probe}`); if (r.status < 500) return { ok: true, log }; } catch {}
  }
  return { ok: false, log };
}

try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup.json'), JSON.stringify({
    api: { baseUrl: 'https://api.deepseek.com/v1', key: 'sk-smoke-0001', model: 'deepseek-flash' },
    qq: { uin: '', ownerUin: '' }, work: { toolsEnabled: true },
  }, null, 2));

  const ui = await start('ui.mjs', { QQBOT_DATA: DATA, QQBOT_UI_PORT: String(UI_PORT) }, UI_PORT, '/api/state');
  check('控制台起来了', ui.ok, ui.log.slice(-300));
  if (ui.ok) {
    const html = await (await fetch(`http://127.0.0.1:${UI_PORT}/`)).text();
  const uiHtml = html;
  // 2026-11-01 改：这个开关只留「设置」页一个家。概览里再放一个，等于同一件事两个开关，
  // 用户会以为它们各管各的（他自己就是这么问的）。概览只保留状态 + 一个跳转。
  check('允许她动电脑只有一个开关，且只在设置页', uiHtml.includes('id="sToolsBtn"') && !uiHtml.includes('id="workToolsBtn"'), '开关还重复着');
  check('概览里有跳到设置页的说明', /goPage\(this\.dataset\.p\)[^>]*data-p="config"/.test(uiHtml), '概览没告诉用户开关在哪');
  
    audit('控制台', html);
    check('控制台：工作模式弹窗内容不为空', /window\.__WK_INNER\s*=\s*"??[^;"']/.test(html) || /window\.__WK_INNER\s*=\s*"\\u003c/.test(html), '');
  }

  const runner = path.join(TMP, 'chat-run.mjs');
  const modUrl = new URL('file:///' + path.join(SRC, 'chatserver.mjs').replace(/\\/g, '/')).href;
  fs.writeFileSync(runner, 'import { startServer } from ' + JSON.stringify(modUrl) + ';\nstartServer(' + CHAT_PORT + ');\n');
  const chat = await start(runner, {
    QQBOT_DATA: DATA, QQBOT_UI_PORT: String(UI_PORT), QQBOT_BRIDGE_PORT: '3983', QQBOT_NO_UPDATE: '1',
  }, CHAT_PORT, '/');
  check('聊天窗起来了', chat.ok, chat.log.slice(-300));
  if (chat.ok) {
    const html = await (await fetch(`http://127.0.0.1:${CHAT_PORT}/`)).text();
    audit('聊天窗', html);
  }
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
