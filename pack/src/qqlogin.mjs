// QQ 登录：不做扫码，走"密码登录"。
//
// 关键事实（2026-11-02 真机验证）：
//   NapCat 拉起 QQ 时是**无窗口**的（它靠注入 hook 把二维码写成文件），
//   所以"点一下让 NapCat 弹出 QQ 登录框"根本不可能——实测 4 个 QQ.exe 全都没有窗口，
//   用户点了按钮只看到"什么都没发生"。
//
// 所以这里分两步，这也正是用户要的"密码登一次，以后自动"：
//   ① 打开**普通的 QQ 客户端**（注册表里找 QQ.exe），它有真窗口，在里面用账号密码登录，
//      勾「记住密码 / 自动登录」——登录态写进 QQ 自己的凭证库。
//   ② 点「接上她」：再启动 NapCat 内核，它复用 QQ 记住的凭证快速登录，不用扫码。
//
// 密码不经过我们、不落盘。
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve(String(stdout || '')));
  } catch {
    resolve('');
  }
});

async function count(image) {
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH']);
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/没有运行的任务|No tasks are running/i.test(l));
  return lines.length;
}

// 有没有带标题栏的 QQ 窗口（NapCat 那种无窗口的不算）
async function hasWindow() {
  const ps = '(Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Measure-Object).Count';
  const out = await run('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], 6000);
  return Number(String(out).trim() || 0) > 0;
}

// QQ 装在哪：先问注册表，再试几个常见位置
export function findQqExe() {
  const reg = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ];
  for (const key of reg) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'UninstallString'], { windowsHide: true, timeout: 5000 }).toString();
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m) {
        const dir = path.dirname(String(m[1]).trim().replace(/"/g, ''));
        const exe = path.join(dir, 'QQ.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch {}
  }
  for (const p of ['E:\\QQ\\QQ.exe', 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe', 'D:\\QQ\\QQ.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

export async function status() {
  const [core, qq, win] = await Promise.all([count('NapCatWinBootMain.exe'), count('QQ.exe'), hasWindow()]);
  let ws = false;
  try {
    const r = await fetch('http://127.0.0.1:3098/qq', { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    // 只看 QQ 这条通道：local（本地窗口）永远是通的，把它算进来会一直显示"已登录"
    const chs = (j && Array.isArray(j.channels)) ? j.channels : [];
    ws = !!(j && (j.online === true || chs.some((c) => c && c.id === 'qq' && c.online)));
  } catch {}
  const stage = ws ? 'online' : (win ? 'login' : (core > 0 ? 'booting' : 'idle'));
  return { core, qq, window: win, ws, stage };
}

// ① 打开普通 QQ 客户端（有窗口，能输密码）
export async function openClient() {
  const exe = findQqExe();
  if (!exe) return { ok: false, err: '找不到 QQ.exe：这台机器上没装电脑版 QQ，或者装在别的位置' };
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch (e) {
    return { ok: false, err: '打不开 QQ：' + String((e && e.message) || e) };
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (await hasWindow()) break;
  }
  const ps = [
    '$w = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;',
    'if ($w) { Add-Type -Name W -Namespace N -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\';',
    '[N.W]::SetForegroundWindow($w.MainWindowHandle) | Out-Null }',
  ].join(' ');
  await run('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], 8000);
  return { ok: true, exe };
}

// 关掉"桌面上那个 QQ 窗口"（只关有窗口的，NapCat 的无窗口实例不动）。
// 同一个号同时登两处会被互相顶下线，所以接上之前必须先把桌面客户端退掉。
async function closeDesktopClient() {
  const ps = 'Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | ForEach-Object { $_.CloseMainWindow() | Out-Null }';
  await run('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], 8000);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    if (!(await hasWindow())) break;
  }
}

// ② 登录好了以后：先退掉桌面 QQ，再把 NapCat 内核拉起来（它复用 QQ 记住的凭证）
export async function attach() {
  await closeDesktopClient();
  await run('schtasks.exe', ['/run', '/tn', 'QQBotNapCatCore'], 20000);
  await new Promise((r) => setTimeout(r, 2500));
  return status();
}

export const STEPS = [
  '点「打开 QQ」——会开出电脑版 QQ 的登录窗口（这个号真正的客户端）。',
  '在窗口里用账号密码登录，勾上「记住密码 / 自动登录」；手机 QQ 弹「是否本人登录」就点「是我本人」。',
  '点「接上她」——会先退出桌面上这个 QQ 窗口（同一个号不能两处同时登），再让 NapCat 在后台连上；以后开机自动登录，不用再输密码。',
];
