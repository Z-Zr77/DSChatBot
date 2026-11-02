// QQ 登录：不做扫码，走"密码登录"。
//
// 为什么要绕一圈：NapCat 本身没有登录接口——它是挂在**真的 QQ 客户端**上的壳。
// 登录这一步只能发生在 QQ 窗口里：左下角「账号密码登录」→ 输密码 → 手机点「是我本人」。
// 所以这里做的是"把人引导到位 + 盯住结果"，不是替他输密码（密码也不落在我们这边）。
//
// 判断依据：
//   core   NapCat 内核进程在不在（NapCatWinBootMain.exe）
//   qq     QQ 客户端窗口/进程在不在（QQ.exe 有几个）
//   ws     桥接有没有连上 OneBot（这才是真正的"登录成功"）
import { execFile } from 'node:child_process';

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve(String(stdout || '')));
  } catch {
    resolve('');
  }
});

// 用 tasklist 数进程。CSV 输出，行数 - 1 就是进程数。
async function count(image) {
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH']);
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/没有运行的任务|No tasks are running/i.test(l));
  return lines.length;
}

export async function status() {
  const [core, qq] = await Promise.all([count('NapCatWinBootMain.exe'), count('QQ.exe')]);
  let ws = false;
  try {
    const r = await fetch('http://127.0.0.1:3098/qq', { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    // 只看 QQ 这条通道：local（本地窗口）永远是通的，把它算进来会永远显示"已登录"。
    const chs = (j && Array.isArray(j.channels)) ? j.channels : [];
    ws = !!(j && (j.online === true || chs.some((c) => c && c.id === 'qq' && c.online)));
  } catch {}
  return {
    core, qq, ws,
    stage: ws ? 'online' : (qq > 0 ? 'waiting' : (core > 0 ? 'booting' : 'idle')),
  };
}

// 拉起内核（计划任务里已经装好了 QQ 内核守护与路径），并把 QQ 窗口提到前面。
export async function start() {
  await run('schtasks.exe', ['/run', '/tn', 'QQBotNapCatCore'], 20000);
  await new Promise((r) => setTimeout(r, 2500));
  // 把 QQ 窗口提到前台：登录要人操作，窗口被压在最底下等于没登录
  const ps = [
    '$w = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;',
    'if ($w) { Add-Type -Name W -Namespace N -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\'; ',
    '[N.W]::SetForegroundWindow($w.MainWindowHandle) | Out-Null }',
  ].join(' ');
  await run('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], 10000);
  return status();
}

// 给界面的三步文案（写死在这里，前端只负责显示，别两边各写一份）
export const STEPS = [
  '点下面的「启动 QQ」——会在你屏幕上开一个 QQ 登录窗口（它就是这个号的真客户端）。',
  '在那个窗口左下角点「账号密码登录」，输入这个小号的 QQ 号和密码，勾上「记住密码」。',
  '如果手机 QQ 弹出「是否本人登录」，点「是我本人」；之后 QQ 会自己连上，这里的状态会变成「已登录」。',
];
