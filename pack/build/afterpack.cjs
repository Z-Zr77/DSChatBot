// electron-builder 的 afterPack 钩子：给打包出来的 QQChatBot.exe 写图标。
// 因为 package.json 里开着 signAndEditExecutable:false（绕非管理员下 winCodeSign 解压符号链接失败），
// builder 自己不写图标；这里直接调缓存里的 rcedit 补上，安装版 & 便携版都能继承这个图标。
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function findRcedit() {
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign'));
  roots.push(path.join(process.cwd(), 'node_modules', 'electron-builder', 'Cache', 'winCodeSign'));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
        const p = path.join(root, d, name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return '';
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const ico = path.join(context.packager.info.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exe) || !fs.existsSync(ico)) {
    console.warn('[afterPack] 跳过写图标：exe 或 icon.ico 不存在');
    return;
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('[afterPack] 跳过写图标：没找到 rcedit（winCodeSign 缓存）');
    return;
  }
  execFileSync(rcedit, [exe, '--set-icon', ico], { stdio: 'inherit' });
  console.log('[afterPack] 已写入图标 →', path.basename(exe));
};
