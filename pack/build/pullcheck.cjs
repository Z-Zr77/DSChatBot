// 无头点一遍四个模块的「拉取」（tts/asr/vision/draw），回报菜单条数与提示
const { app, BrowserWindow } = require('electron');
const PORT = process.env.PORT || '3099';

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000 });
  const errs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (/Security Warning|Electron Security/.test(message)) return;
    if (level >= 2) errs.push(message);
  });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await new Promise(r => setTimeout(r, 1500));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const res = [];
    const kinds = ['tts', 'asr', 'vision', 'draw'];
    for (const k of kinds) {
      const pre = { tts: 'tmMsg', asr: 'amMsg', vision: 'vmMsg', draw: 'dmMsg' }[k];
      const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('onclick') || '').includes("'" + k + "'"));
      if (!btn) { res.push({ k, err: '按钮没找到' }); continue; }
      btn.click();
      await new Promise(r => setTimeout(r, 6000));
      const items = [...document.querySelectorAll('.mi')].map(x => x.textContent);
      res.push({ k, count: items.length, sample: items.slice(0, 3), msg: (document.getElementById(pre) || {}).textContent });
      document.body.click();
      await new Promise(r => setTimeout(r, 300));
    }
    return res;
  })()`);
  console.log(JSON.stringify({ out, errs }, null, 2));
  app.quit();
});
