// 冷启动验收：把一个"全新用户"的数据目录造出来，让桥接在里面跑一遍，看它自己能不能立起来。
// 用法：node pack/tools/coldstart-check.mjs
// 判据（缺一条就是"新人第一次打开就是坏的"）：
//   1. 没有任何 setup.json 也能启动，且不崩
//   2. 第一次启动自动写出 persona.md（不是空壳）
//   3. AGENTS.md 能写进还没建的 agent-home
//   4. 没有 OneBot/NapCat（死端口）时，本地通道能收到她说的话
//   5. 日志里没有 ENOENT / 未捕获异常
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = path.resolve();
const BRIDGE = path.join(ROOT, 'pack', 'src', 'bridge.mjs');
const PORT = 3387;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coldstart-'));
const data = path.join(tmp, 'userdata');
fs.mkdirSync(data, { recursive: true });

const results = [];
const ok = (n, pass, detail = '') => { results.push({ n, pass, detail }); console.log(pass ? 'PASS' : 'FAIL', n, detail ? '→ ' + detail : ''); };

// 全新用户：只抄一把能调通的 key（真要发给人用时，这里该是他的 key）
try {
  const real = JSON.parse(fs.readFileSync('E:/DSChatBot/data/setup.json', 'utf8'));
  fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify({
    api: real.api, qq: { ...real.qq, name: '测试小鱼', persona: '' },
    onebot: { wsPort: 3998, httpPort: 3998 }, features: real.features,
    napcat: { dir: path.join(tmp, 'no-napcat') }, ui: { port: 3997 },
  }, null, 2), 'utf8');
} catch (e) { console.log('（没找到真 setup.json，走纯默认）', e.message); }

const child = spawn(process.execPath, [BRIDGE], {
  cwd: ROOT,
  env: { ...process.env, QQBOT_DATA: data, QQBOT_LOCAL_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/say', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 45000 }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ code: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, err: 'timeout' }); });
    req.end(JSON.stringify(body));
  });
}

await sleep(6000);
ok('死端口下进程还活着（没崩）', child.exitCode === null, child.exitCode === null ? '' : 'exit ' + child.exitCode);
ok('第一次启动写出了 persona.md', fs.existsSync(path.join(data, 'persona.md')));
const persona = fs.existsSync(path.join(data, 'persona.md')) ? fs.readFileSync(path.join(data, 'persona.md'), 'utf8') : '';
ok('persona 里没有未替换的占位符', persona && !/\{NAME\}|\{AGE\}|\{CITY\}|\{PERSONA\}/.test(persona));
ok('AGENTS.md 写进了还没建的 agent-home', fs.existsSync(path.join(data, 'agent-home', 'AGENTS.md')));

const r = await post({ text: '在吗？' });
ok('本地通道能收下这句话', r.code === 200, JSON.stringify(r));
// 第一条消息必须是快的：新人等 15 分钟会以为程序坏了
let replied = false;
for (let i = 0; i < 40 && !replied; i++) {
  if (/-> reply local:/.test(out)) { replied = true; break; }
  await sleep(1000);
}
ok('第一句话在 40 秒内回了（没有任何通信软件）', replied);
const replyLine = (out.split('\n').find(l => l.includes('-> reply local:')) || '').slice(0, 200);
ok('日志里没有 ENOENT', !/ENOENT/.test(out), (out.match(/ENOENT[^\n]*/) || [''])[0].slice(0, 120));
ok('日志里没有未捕获异常', !/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(out));

try { child.kill(); } catch {}
await sleep(500);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const bad = results.filter(x => !x.pass);
console.log('\n%s', '—'.repeat(40));
console.log(bad.length ? `冷启动不通过：${bad.length} 项` : '冷启动全过');
if (replyLine) console.log('她说的：' + replyLine);
process.exit(bad.length ? 1 : 0);
