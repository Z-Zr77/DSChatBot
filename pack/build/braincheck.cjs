// 无头点一遍所有「拉取」按钮，回报每个模块的提示文字与菜单条数
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
    const btns = [...document.querySelectorAll('[data-kind]')];
    for (const b of btns) {
      const kind = b.dataset.kind;
      b.click();
      await new Promise(r => setTimeout(r, 3500));
      const menu = document.querySelector('.mi');
      const wrap = menu ? menu.parentElement : null;
      const items = wrap ? [...wrap.querySelectorAll('.mi')].map(x => x.textContent) : [];
      // 找这个消息框：按钮往上找最近的 row 之后的提示
      let msg = '';
      const card = b.closest('div').parentElement;
      const cand = card ? [...card.querySelectorAll('span.dim')].map(s => s.textContent).filter(t => /拉到|失败|没拉|拉取/.test(t)) : [];
      if (cand.length) msg = cand[cand.length - 1];
      res.push({ kind, items: items.slice(0, 4), count: items.length, msg });
      // 关掉菜单
      document.body.click();
      await new Promise(r => setTimeout(r, 200));
    }
    return res;
  })()`);
  console.log(JSON.stringify({ out, errs }, null, 2));
  app.quit();
});
