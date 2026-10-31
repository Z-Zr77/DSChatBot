#!/usr/bin/env node
// 一条命令发版：test → 升版本 → 打包 → 重建发布包 → commit/tag/push → （有 gh 时）建 Release
//
// 用法：
//   node pack/_tools/release.cjs patch          # 0.5.1 -> 0.5.2
//   node pack/_tools/release.cjs minor --dry    # 只看会做什么，不动手
//   node pack/_tools/release.cjs patch --no-push
//
// 约定：
//   - 仓库根 = 本文件的 ../../（即 qq-bot）
//   - 版本号只有一处真源：pack/package.json
//   - 发布包目录：默认 ~/DSChatBot-发布包（可用 QQBOT_RELEASE_DIR 覆盖）
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const PACK = path.join(REPO, 'pack');
const RELEASE_DIR = process.env.QQBOT_RELEASE_DIR || path.join(require('node:os').homedir(), 'DSChatBot-发布包');

const argv = process.argv.slice(2);
const level = (argv.find((a) => /^(patch|minor|major)$/.test(a)) || 'patch');
const dry = argv.includes('--dry');
const noPush = argv.includes('--no-push');
const noGh = argv.includes('--no-gh');

const log = (...a) => console.log('[release]', ...a);
const die = (msg) => { console.error('[release] 失败：' + msg); process.exit(1); };
function run(cmd, args, opts = {}) {
  if (dry) { log('(dry)', cmd, args.join(' ')); return { status: 0, stdout: '' }; }
  log('$', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO, stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0 && !opts.allowFail) die(cmd + ' ' + args.join(' ') + ' 退出码 ' + r.status);
  return r;
}
function runOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO, encoding: 'utf8', shell: false });
  if (r.status !== 0 && !opts.allowFail) die(cmd + ' ' + args.join(' ') + ' 失败：' + (r.stderr || ''));
  return String(r.stdout || '').trim();
}

// ---------- 0. 前置检查 ----------
if (!fs.existsSync(path.join(REPO, '.git'))) die('仓库根不是 git 仓库：' + REPO);
if (runOut('git', ['status', '--porcelain'])) log('注意：工作区有未提交改动，会一起进这次提交');

// ---------- 1. 测试 ----------
log('跑测试…');
run('npm', ['test'], { cwd: PACK });

// ---------- 2. 升版本 ----------
const pkgFile = path.join(PACK, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const oldVer = String(pkg.version || '0.0.0');
const [maj, min, pat] = oldVer.split('.').map((n) => parseInt(n, 10) || 0);
const next = level === 'major' ? `${maj + 1}.0.0`
  : level === 'minor' ? `${maj}.${min + 1}.0`
    : `${maj}.${min}.${pat + 1}`;
log('版本 ' + oldVer + ' → ' + next + '（' + level + '）');
if (!dry) {
  pkg.version = next;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}

// ---------- 3. 打包 ----------
log('打 Windows 安装包（这一步要几分钟）…');
run('npx', ['electron-builder', '--win', 'nsis'], { cwd: PACK });

const exeRel = `dist/DSChatBot-Setup-${next}.exe`;
if (!dry && !fs.existsSync(path.join(PACK, exeRel))) die('没找到安装包：' + exeRel);

// ---------- 4. 重建发布包 ----------
log('重建发布包：' + RELEASE_DIR);
if (!noPush || true) run('node', [path.join('pack', '_tools', 'mkrelease.cjs')], { allowFail: true });

// ---------- 5. 提交 + 打 tag ----------
const msg = `v${next}`;
run('git', ['add', '-A']);
run('git', ['commit', '-m', msg, '--allow-empty']);
run('git', ['tag', '-a', 'v' + next, '-m', msg]);

// ---------- 6. 推送 ----------
if (noPush) {
  log('跳过推送（--no-push）。手动：git push origin HEAD --tags');
} else {
  const remotes = runOut('git', ['remote'], { allowFail: true });
  if (!remotes.includes('origin')) die('没有 origin 远端：先 git remote add origin <url>');
  run('git', ['push', 'origin', 'HEAD', '--tags'], { allowFail: true });
}

// ---------- 7. Release（有 gh 且有登录态时才做） ----------
if (noGh || noPush) {
  log('跳过 Release 上传。');
} else {
  const gh = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: false });
  if (gh.status !== 0) {
    log('本机没有 gh CLI，Release 请手工建：仓库 → Releases → Draft a new release → 选 tag v' + next + ' → 上传 ' + exeRel);
  } else {
    const notes = path.join(RELEASE_DIR, '03-发布说明', `v${next}.md`);
    const args = ['release', 'create', 'v' + next, path.join(PACK, exeRel), '--title', `v${next}`];
    if (fs.existsSync(notes)) args.push('--notes-file', notes); else args.push('--generate-notes');
    run('gh', args, { allowFail: true });
  }
}

log('完成：v' + next);
log('  安装包：' + path.join(PACK, exeRel));
log('  发布包：' + RELEASE_DIR);
log('  下一步：把 Release 页链接发给用户；应用启动时会自己检查新版本');
