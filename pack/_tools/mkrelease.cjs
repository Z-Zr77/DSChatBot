// 重建发布包：E:\DSChatBot-发布包
// 用法（在仓库根执行）：node pack/_tools/mkrelease.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.env.QQBOT_RELEASE_DIR || String.raw`E:\DSChatBot-发布包`;
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'pack', 'package.json'), 'utf8'));
const VER = 'v' + pkg.version;

const sh = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 << 20 });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

// 只重建源码与安装包两部分；03-发布说明 / 04-操作步骤 保留（人手写的）
for (const d of [ '01-源码仓库', '02-安装包' ]) fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'SHA256SUMS.txt'), { force: true });
for (const d of [ '01-源码仓库/源码', '02-安装包', '03-发布说明', '04-操作步骤' ]) mkdir(path.join(OUT, d));

// 1) bundle
fs.writeFileSync(path.join(OUT, '01-源码仓库', `DSChatBot-${VER}.bundle`), sh([ 'bundle', 'create', '-', '--all' ]));

// 2) 源码副本（按 git 索引）
const files = sh([ 'ls-files', '-z' ]).toString('utf8').split('\0').filter(Boolean);
for (const rel of files) {
  const dst = path.join(OUT, '01-源码仓库', '源码', rel);
  mkdir(path.dirname(dst));
  fs.copyFileSync(path.join(REPO, rel), dst);
}

// 3) 安装包
const dist = path.join(REPO, 'pack', 'dist');
const exe = `DSChatBot-Setup-${pkg.version}.exe`;
for (const f of [ exe, exe + '.blockmap' ]) {
  const src = path.join(dist, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, '02-安装包', f));
  else console.warn('缺文件（先打包）:', f);
}

// 4) 校验和
const lines = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else lines.push(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '  ' + path.relative(OUT, p).replace(/\\/g, '/'));
  }
})(OUT);
lines.sort((a, b) => a.split('  ')[1].localeCompare(b.split('  ')[1]));
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

console.log('version', VER, '| tracked', files.length, '| sums', lines.length);
