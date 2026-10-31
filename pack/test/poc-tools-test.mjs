// poc-tools-test.mjs — 方案 A 测例（原 9 条 + 新增反例），结果落盘到 notes\工具层PoC-方案A-测例.txt
// 用法：node pack\poc-tools-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as toolsMod from '../src/tools.mjs';

const call = toolsMod.call;
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
import os from 'node:os';
const REPO = path.join(HERE, '..', '..');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-tools-out-'));
const OUT_FILE = path.join(OUT_DIR, '工具层PoC-方案A-测例.txt');
const TMP_SCRIPT = path.join(HERE, '_tmp_echo.mjs');
const NOTES = path.join(REPO, 'notes');
const WIN_INI = 'C:\\Windows\\win.ini';
// P1-1 起 run_cmd 必须给工作区（真实调用由 bridge 传 writeRoot/wsId）
const RC = { writeRoot: REPO, roots: [ REPO ], base: REPO, deny: [], wsId: 'poc-tools', execMode: 'workspace' };

const lines = [];
function rec(s = '') { lines.push(s); }

function setApprove(v) {
  if (v === undefined) delete process.env.QQBOT_APPROVE;
  else process.env.QQBOT_APPROVE = v;
}
function setNodeEnv(v) {
  if (v === undefined) delete process.env.QQBOT_TOOLS_NODE;
  else process.env.QQBOT_TOOLS_NODE = v;
}

// 判定：'' = 通过，其它 = 失败原因
const cases = [
  { id: 1, title: '列 仓库根', env: undefined,
    run: () => call('list_dir', { path: REPO }, RC),
    judge: (r) => (r.ok ? '' : '应成功：' + r.err) },

  { id: 2, title: '读 notes\\整理汇报-20261029.md', env: undefined,
    run: () => call('read_file', { path: path.join(NOTES, '整理汇报-20261029.md') }, RC),
    judge: (r) => (r.ok && r.out.length > 100 ? '' : '应成功且非空') },

  { id: 3, title: 'dir 仓库根（已审批）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', REPO ] }, RC),
    judge: (r) => (r.ok ? '' : '应成功：' + r.err) },

  { id: 4, title: 'dir E:\\（未审批）', env: undefined,
    run: () => call('run_cmd', { cmd: [ 'dir', 'E:\\' ] }, RC),
    judge: (r) => (r.needApproval === true ? '' : '应返回 needApproval') },

  { id: 5, title: 'dir E:\\（用户拒绝）', env: '0',
    run: () => call('run_cmd', { cmd: [ 'dir', 'E:\\' ] }, RC),
    judge: (r) => (!r.ok && /用户拒绝/.test(r.err) ? '' : '应被拒绝：' + JSON.stringify(r)) },

  { id: 6, title: 'read_file C:\\Windows\\win.ini', env: undefined,
    run: () => call('read_file', { path: WIN_INI }),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '应拒绝路径') },

  { id: 7, title: 'del E:\\a.txt', env: '1',
    run: () => call('run_cmd', { cmd: [ 'del', 'E:\\a.txt' ] }, RC),
    judge: (r) => (!r.ok ? '' : '应拒绝') },

  { id: 8, title: 'powershell -c rm E:\\x -Recurse', env: '1',
    run: () => call('run_cmd', { cmd: [ 'powershell', '-c', 'rm E:\\x -Recurse' ] }, RC),
    judge: (r) => (!r.ok ? '' : '应拒绝') },

  { id: 9, title: 'cmd.exe /c dir', env: '1',
    run: () => call('run_cmd', { cmd: [ 'cmd.exe', '/c', 'dir' ] }, RC),
    judge: (r) => (!r.ok ? '' : '应拒绝') },

  // —— 方案 A 新增反例 ——
  { id: 10, title: '【回归】type C:\\Windows\\win.ini（原可读出根外文件）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'type', WIN_INI ] }, RC),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '必须拒绝，实际：' + JSON.stringify(r).slice(0, 200)) },

  { id: 11, title: 'dir /s E:\\（全盘扫描）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', '/s', 'E:\\' ] }, RC),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '必须拒绝') },

  { id: 12, title: 'where /r C:\\ cmd（全盘扫描）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'where', '/r', 'C:\\', 'cmd' ] }, RC),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '必须拒绝') },

  { id: 13, title: 'node -e（内联执行）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'node', '-e', "require('fs').writeFileSync('E:\\\\hack.txt','x')" ] }, RC),
    judge: (r) => (!r.ok ? '' : '必须拒绝') },

  { id: 14, title: 'node <根目录内脚本>（合法用途，需 QQBOT_TOOLS_NODE=1）', env: '1', node: '1',
    run: () => call('run_cmd', { cmd: [ 'node', TMP_SCRIPT ] }, RC),
    judge: (r) => (r.ok && /TOOLS_TEST_MARK/.test(r.out) ? '' : '应成功输出标记：' + JSON.stringify(r).slice(0, 200)) },

  { id: 15, title: 'python -c（已移除白名单）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'python', '-c', 'print(1)' ] }, RC),
    judge: (r) => (!r.ok ? '' : '必须拒绝') },

  { id: 16, title: 'git -c core.pager=calc.exe log（注入外部命令）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'git', '-c', 'core.pager=calc.exe', 'log' ] }, RC),
    judge: (r) => (!r.ok && /git 参数被拒绝/.test(r.err) ? '' : '必须拒绝：' + JSON.stringify(r).slice(0, 160)) },

  { id: 17, title: 'git status（合法只读）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'git', 'status' ] }, RC),
    // 当前目录不是 git 仓库，git 自己会报错；这里只验证"校验层没拦"
    judge: (r) => (/git 参数被拒绝|只允许只读子命令|不在白名单/.test(String(r.err || '')) ? '被校验层误拦：' + r.err : '') },

  { id: 18, title: 'dir C:\\Users', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', 'C:\\Users' ] }, RC),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '必须拒绝') },

  { id: 19, title: 'dir <中文目录>（编码）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', '/b', NOTES ] }, RC),
    judge: (r) => {
      if (!r.ok) return '应成功：' + r.err;
      if (r.out.includes('\uFFFD')) return '仍有替换字符（解码失败）';
      if (!/整理汇报/.test(r.out)) return '未见中文文件名，无法判定编码';
      return '';
    } },

  { id: 20, title: 'dir E:\\&whoami（cmd 注入）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', 'C:\qqbot&whoami' ] }, RC),
    judge: (r) => (!r.ok && /不允许的字符/.test(r.err) ? '' : '必须拒绝') },

  { id: 21, title: 'dir /s notes（合法递归）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'dir', '/s', '/b', NOTES ] }, RC),
    judge: (r) => (r.ok ? '' : '合法用途被误伤：' + r.err) },

  { id: 22, title: 'read_file 路径穿越 ..\\..\\Windows\\win.ini', env: undefined,
    run: () => call('read_file', { path: 'C:\qqbot\\..\\Windows\\win.ini' }),
    judge: (r) => (!r.ok && /不在允许范围/.test(r.err) ? '' : '必须拒绝') },

  // —— 复查后新增（2026-10-29 20:10）——
  { id: 24, title: 'node 默认可跑（P1-1：不再要求 QQBOT_TOOLS_NODE 开关）', env: '1', node: '0',
    run: () => call('run_cmd', { cmd: [ 'node', TMP_SCRIPT ] }, RC),
    judge: (r) => (r.ok && /TOOLS_TEST_MARK/.test(r.out) ? '' : '应能跑：' + JSON.stringify(r).slice(0, 160)) },

  { id: 25, title: 'git branch -D main（会删分支）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'git', 'branch', '-D', 'main' ] }, RC),
    judge: (r) => (!r.ok && /只允许查看|参数被拒绝/.test(String(r.err)) ? '' : '必须拒绝：' + JSON.stringify(r).slice(0, 160)) },

  { id: 26, title: 'git branch newbranch（会建分支）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'git', 'branch', 'newbranch' ] }, RC),
    judge: (r) => (!r.ok && /只允许查看|不接受改名/.test(String(r.err)) ? '' : '必须拒绝：' + JSON.stringify(r).slice(0, 160)) },

  { id: 27, title: 'git branch --list（合法只读）', env: '1',
    run: () => call('run_cmd', { cmd: [ 'git', 'branch', '--list' ] }, RC),
    judge: (r) => (/分支名|参数被拒绝|只允许只读子命令|不在白名单/.test(String(r.err || '')) ? '被校验层误拦：' + r.err : '') },

  { id: 28, title: 'read_file 相对路径（校验与读取基准一致）', env: undefined,
    run: () => call('read_file', { path: path.join(path.basename(REPO), 'notes', '整理后复查-20261029.md') }, { ...RC, base: path.dirname(REPO) }),
    judge: (r) => (r.ok ? '' : '应相对仓库父目录读到：' + r.err) },
];

async function main() {
  rec('工具层 方案 A 测例');
  rec('时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  rec('Node：' + process.version + '  CWD：' + process.cwd());
  rec('被测文件：' + path.join(HERE, '..', 'src', 'tools.mjs'));
  rec('');
  rec('='.repeat(70));

  // 准备 14 号用例用的小脚本
  fs.writeFileSync(TMP_SCRIPT, "console.log('TOOLS_TEST_MARK', process.env.QQBOT_TOOLS_TEST || 'no-env');\n", 'utf8');

  let pass = 0, fail = 0;
  const failed = [];

  for (const c of cases) {
    setApprove(c.env);
    setNodeEnv(c.node);
    let r;
    try { r = await c.run(); } catch (e) { r = { ok: false, err: 'THROW ' + (e && e.message) }; }
    const bad = c.judge(r);
    if (bad) { fail++; failed.push(c.id + ' ' + c.title + ' → ' + bad); } else pass++;

    rec('');
    rec(`[${bad ? 'FAIL' : 'PASS'}] #${c.id} ${c.title}   (approve=${String(c.env)})`);
    rec('  ok=' + r.ok + '  needApproval=' + String(r.needApproval));
    if (r.err) rec('  err: ' + String(r.err).slice(0, 400));
    if (r.out) rec('  out: ' + String(r.out).slice(0, 300).replace(/\n/g, '\n       '));
    if (bad) rec('  ✗ ' + bad);
  }

  // 附加：符号链接能否绕过根目录（无权限则跳过）
  rec('');
  rec('='.repeat(70));
  let linkPath = path.join('C:\qqbot', '_tmp_win_ini.txt');
  try {
    try { fs.unlinkSync(linkPath); } catch {}
    fs.symlinkSync(WIN_INI, linkPath);
    const r = await call('read_file', { path: linkPath });
    const ok = !r.ok && /不在允许范围/.test(String(r.err));
    rec(`[${ok ? 'PASS' : 'FAIL'}] #23 符号链接指向根外文件 → ${ok ? '已拒绝' : '未拒绝：' + JSON.stringify(r).slice(0, 200)}`);
    if (!ok) { fail++; failed.push('#23 符号链接绕过未被拦截'); } else pass++;
    fs.unlinkSync(linkPath);
  } catch (e) {
    rec(`[SKIP] #23 符号链接用例：创建失败（${e.code || e.message}），realpath 分支未能实测`);
  }

  try { fs.unlinkSync(TMP_SCRIPT); } catch {}

  // 附加：换个工作目录，相对路径还能不能读到根外文件（复查报告 P1-2 的复现场景）
  rec('');
  rec('='.repeat(70));
  try {
    const probe = path.join(HERE, '_tmp_cwd_probe.mjs');
    const toolsUrl = new URL('../src/tools.mjs', import.meta.url).href;
    fs.writeFileSync(probe, [
      `import * as t from ${JSON.stringify(toolsUrl)};`,
      `const r = await t.call('read_file', { path: 'win.ini' });`,
      `console.log(JSON.stringify({ ok: r.ok, err: r.err || '', head: String(r.out || '').slice(0, 60) }));`,
    ].join('\n'), 'utf8');
    const { execFileSync } = await import('node:child_process');
    const raw = execFileSync(process.execPath, [ probe ], { cwd: 'C:\\Windows', encoding: 'utf8', timeout: 20000 });
    const j = JSON.parse(String(raw).trim().split('\n').pop());
    const leak = j.ok && /fonts|16-bit|mci extensions/i.test(j.head);
    const ok = !leak;
    rec(`[${ok ? 'PASS' : 'FAIL'}] #29 cwd=C:\\Windows 时 read_file('win.ini') → ${ok ? '未读到根外文件（ok=' + j.ok + '）' : '读到了根外文件：' + JSON.stringify(j).slice(0, 200)}`);
    if (!ok) { fail++; failed.push('#29 相对路径按 cwd 解析，能读到根外文件'); } else pass++;
    try { fs.unlinkSync(probe); } catch {}
  } catch (e) {
    rec(`[SKIP] #29 cwd 绕过用例：${e.code || e.message}`);
  }

  rec('');
  rec('='.repeat(70));
  rec(`合计：PASS ${pass} / FAIL ${fail}`);
  if (failed.length) { rec('失败项：'); failed.forEach((f) => rec('  - ' + f)); }

  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log(' - ' + f)); }
  console.log('详情：' + OUT_FILE);
  process.exit(fail ? 1 : 0);
}

main();
