// 打包前自检：把控制台页面渲染一遍，抽出内嵌 <script> 做语法检查。
// 目的：ui.mjs 的 HTML 是拼在 JS 字符串里的，语法错在 node --check 阶段查不出来，
//       只有浏览器执行时才炸（表现为控制台整页空白）。这里提前拦一道。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-check-'));

function fail(msg) {
  console.error('[check] FAIL: ' + msg);
  process.exit(1);
}

async function main() {
  const child = spawn(process.execPath, [path.join(HERE, 'src', 'ui.mjs')], {
    env: { ...process.env, QQBOT_UI_PORT: String(PORT), QQBOT_DATA: path.join(tmp, 'data') },
    stdio: 'ignore',
  });
  try {
    let html = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) { html = await res.text(); break; }
      } catch {}
    }
    if (!html) fail('控制台页面没起来（端口 ' + PORT + '）');

    // 页面里可能有多段 <script>（首段很小、主逻辑在第二段），必须全部检查
    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((x) => x[1]);
    if (!scripts.length) fail('页面里找不到 <script>');
    for (let i = 0; i < scripts.length; i++) {
      const file = path.join(tmp, 'client-' + i + '.js');
      fs.writeFileSync(file, scripts[i], 'utf8');
      const chk = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      chk.stderr.on('data', (d) => { err += d.toString(); });
      const code = await new Promise((r) => chk.on('close', r));
      if (code !== 0) fail('控制台第 ' + (i + 1) + ' 段脚本有语法错：\n' + err.split('\n').slice(0, 8).join('\n'));
    }
    console.log('[check] OK 内联脚本 ' + scripts.length + ' 段语法正常');

    // 顺手确认几个关键接口都有响应
    for (const p of ['/api/state', '/api/config', '/api/draw/info']) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) fail(p + ' 返回 ' + r.status);
      } catch (e) {
        fail(p + ' 请求失败：' + e.message);
      }
    }
    console.log('[check] OK 页面 ' + html.length + ' 字节，前端脚本 ' + scripts.reduce((a, b) => a + b.length, 0) + ' 字节，接口正常');
  } finally {
    child.kill();
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 500);
  }
}

main().catch((e) => fail(e.message));
