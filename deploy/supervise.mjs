// 极简 supervisor：同时跑 bridge 和 ui，谁挂了就 3 秒后重拉（容器不需要 systemd）
import { spawn } from 'node:child_process';

const TASKS = [
  ['bridge', ['src/bridge.mjs']],
  ['ui', ['src/ui.mjs']],
];

function start(name, args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  child.on('exit', (code, sig) => {
    console.log(`[supervise] ${name} 退出 code=${code} sig=${sig || '-'}，3 秒后重启`);
    setTimeout(() => start(name, args), 3000);
  });
  child.on('error', (e) => {
    console.error(`[supervise] ${name} 启动失败`, e.message);
    setTimeout(() => start(name, args), 5000);
  });
}

for (const [name, args] of TASKS) start(name, args);

const bye = () => { console.log('[supervise] 收到退出信号'); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
