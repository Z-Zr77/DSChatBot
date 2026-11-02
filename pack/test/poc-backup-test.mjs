// 备份模块：白名单外的排除、清单、保留份数、每日自动
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const t = (name, fn) => {
  try { fn(); console.log('PASS', name); return true; }
  catch (e) { console.log('FAIL', name, '::', e.message); return false; }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-bk-'));
const DATA = path.join(TMP, 'data');
const BK = path.join(TMP, 'bk');
process.env.QQBOT_DATA = DATA;
process.env.QQBOT_BACKUP_DIR = BK;   // 测试别写到用户真实的备份目录
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'people'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'agent-home', 'memory', 'lessons'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'chat', 'tmp'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'drawn'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'work', '.trash'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ok: 1 }));
fs.writeFileSync(path.join(DATA, 'persona.md'), '她是大肥鱼');
fs.writeFileSync(path.join(DATA, 'agent-home', 'memory', 'people', '111.json'), JSON.stringify({ items: [{ text: '他下周三面试' }] }));
fs.writeFileSync(path.join(DATA, 'agent-home', 'memory', 'lessons', '111.json'), JSON.stringify({ items: [] }));
fs.writeFileSync(path.join(DATA, 'chat', '111.jsonl'), '{"type":"text"}\n');
fs.writeFileSync(path.join(DATA, 'chat', 'tmp', 'up-1.jpg'), Buffer.alloc(1024, 7));
fs.writeFileSync(path.join(DATA, 'drawn', 'a.png'), Buffer.alloc(2048, 9));
fs.writeFileSync(path.join(DATA, 'work', '.trash', 'old.txt'), 'x');
fs.writeFileSync(path.join(DATA, 'bridge.log'), 'x'.repeat(4096));

const backup = await import(new URL('../src/backup.mjs', import.meta.url).href);
const settings = await import(new URL('../src/settings.mjs', import.meta.url).href);

let pass = 0, total = 0;
const T = (n, f) => { total++; if (t(n, f)) pass++; };

T('默认目录在数据目录上一级', () => {
  delete process.env.QQBOT_BACKUP_DIR;
  assert.equal(path.basename(backup.dirOf()), 'DSChatBot-backups');
  process.env.QQBOT_BACKUP_DIR = BK;
  assert.ok(!backup.dirOf().startsWith(DATA), '备份不能放在数据目录里');
});

let first;
T('跑一次：目录/清单都在', () => {
  first = backup.run({ reason: 'manual' });
  assert.equal(first.ok, true, first.err);
  assert.ok(fs.existsSync(path.join(first.dir, 'manifest.json')));
  const man = JSON.parse(fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8'));
  assert.equal(man.reason, 'manual');
  assert.ok(man.files >= 4);
});

T('该备的都备了（配置/人格/记忆/经验库/聊天）', () => {
  for (const f of ['config.json', 'persona.md', path.join('agent-home', 'memory', 'people', '111.json'), path.join('agent-home', 'memory', 'lessons', '111.json'), path.join('chat', '111.jsonl')]) {
    assert.ok(fs.existsSync(path.join(first.dir, f)), '缺 ' + f);
  }
});

T('normal 模式跳过 tmp/trash/log/drawn', () => {
  assert.ok(!fs.existsSync(path.join(first.dir, 'chat', 'tmp', 'up-1.jpg')));
  assert.ok(!fs.existsSync(path.join(first.dir, 'work', '.trash', 'old.txt')));
  assert.ok(!fs.existsSync(path.join(first.dir, 'bridge.log')));
  assert.ok(!fs.existsSync(path.join(first.dir, 'drawn', 'a.png')));
});

T('full 模式才带她的画', () => {
  const r = backup.run({ reason: 'manual', mode: 'full' });
  assert.equal(r.ok, true, r.err);
  assert.ok(fs.existsSync(path.join(r.dir, 'drawn', 'a.png')));
});

T('status 能报份数/上次/目录', () => {
  const s = backup.status();
  assert.ok(s.count >= 2);
  assert.ok(s.lastAt > 0);
  assert.equal(s.dir, backup.dirOf());
  assert.ok(s.last && s.last.files >= 1);
});

T('保留份数生效（keep=2）', () => {
  settings.patch({ backup: { keep: 2 } });
  backup.run({ reason: 'manual' });
  const s = backup.status();
  assert.ok(s.count <= 2, 'count=' + s.count);
});

T('关闭后自动不再跑，手动仍可', () => {
  settings.patch({ backup: { enabled: false } });
  const auto = backup.run({ reason: 'auto' });
  assert.equal(auto.ok, false);
  const man = backup.run({ reason: 'manual' });
  assert.equal(man.ok, true, man.err);
  settings.patch({ backup: { enabled: true } });
});

T('due()：没备份过就该跑；刚备份完不该跑', () => {
  const s = backup.status();
  assert.equal(backup.due(20, s.lastAt + 1000), false);
  assert.equal(backup.due(20, s.lastAt + 21 * 3600e3), true);
});

T('备份内容是字节级复制（能直接还原）', () => {
  const made = backup.run({ reason: 'manual' });
  assert.equal(made.ok, true, made.err);
  const dir = made.dir;
  const a = fs.readFileSync(path.join(DATA, 'agent-home', 'memory', 'people', '111.json'));
  const b = fs.readFileSync(path.join(dir, 'agent-home', 'memory', 'people', '111.json'));
  assert.deepEqual(a, b);
});

T('settings 有 backup 默认值', () => {
  const d = settings.DEFAULTS.backup || {};
  assert.equal(d.enabled, true);
  assert.equal(d.keep, 7);
  assert.equal(d.mode, 'normal');
});

T('bridge 接了备份路由与自动任务', () => {
  const src = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("if (p === '/backup' && req.method === 'GET')"));
  assert.ok(src.includes("if (p === '/backup/run' && req.method === 'POST')"));
  assert.ok(src.includes('backup.due(20)'));
  assert.ok(src.includes("backup.run({ reason: 'auto' })"));
});

T('控制台有备份卡片与按钮', () => {
  const ui = fs.readFileSync(new URL('../src/ui.mjs', import.meta.url), 'utf8');
  assert.ok(ui.includes('立刻备份'));
  assert.ok(ui.includes('完整备份'));
  assert.ok(ui.includes('async function runBackup(full)'));
  assert.ok(ui.includes('async function loadBackup()'));
  
  assert.ok(ui.includes("p === '/api/backup'"));
  assert.ok(ui.includes("p === '/api/backup/run'"));
});

T('源码统一用 LF（CRLF 会让跨行正则断言假失败）', () => {
  for (const f of ['bridge.mjs', 'ui.mjs', 'backup.mjs', 'settings.mjs']) {
    const src = fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    assert.ok(!src.includes('\r\n'), f + ' 里有 CRLF');
  }
});

console.log('\n套件：备份 → PASS ' + pass + ' / FAIL ' + (total - pass));
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass === total ? 0 : 1);
