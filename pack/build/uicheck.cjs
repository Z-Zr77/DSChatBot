// 用真实 Electron 打开控制台，点遍每个页签，收集前端报错。
// 用法：先起 ui.mjs（QQBOT_UI_PORT=3099），再 `electron.exe build\uicheck.cjs`
const { app, BrowserWindow } = require('electron');

const PORT = process.env.UICHECK_PORT || '3099';
const TABS = ['status', 'persona', 'memory', 'stickers', 'interests', 'budget', 'config', 'log'];
const errors = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 950 });
  win.webContents.on('console-message', (...args) => {
    const d = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const level = d ? d.level : args[1];
    const msg = d ? d.message : args[2];
    const m = String(msg || '');
    if (m.includes('Electron Security Warning')) return;
    if (level === 'error' || level === 3 || level === 2) errors.push('console: ' + m);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-gone: ' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('load-fail: ' + code + ' ' + desc));

  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
  } catch (e) {
    errors.push('load: ' + e.message);
  }
  await new Promise(r => setTimeout(r, 1500));

  const result = {};
  for (const t of TABS) {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const b = document.querySelector('[data-t="${t}"]');
      if (!b) return 'NO-TAB';
      b.click();
      await new Promise(r => setTimeout(r, 700));
      const box = document.getElementById('cfgBox');
      const visible = box ? box.innerText.length : -1;
      return { tab: '${t}', cfgLen: visible };
    })()`).catch(e => ({ tab: t, err: e.message }));
    result[t] = r;
  }

  const probe = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-t="config"]').click();
    await new Promise(r => setTimeout(r, 800));
    const inputs = [...document.querySelectorAll('input[data-p$=".model"], #brModel')];
    const byInput = {};
    for (const inp of inputs) {
      const row = inp.closest('.row');
      const btn = row ? [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '拉取') : null;
      byInput[inp.getAttribute('data-p') || inp.id] = !!btn;
    }
    const out = {
      dKey: !!document.querySelector('#dKey'),
      pullButtons: byInput,
      showModelMenu: typeof showModelMenu,
      pullModels: typeof pullModels,
      drawKeyPh: (document.querySelector('[data-p="draw.key"]') || {}).placeholder || '',
    };
    const drawInput = document.querySelector('[data-p="draw.model"]');
    const drawRow = drawInput ? drawInput.closest('.row') : null;
    const drawBtn = drawRow ? [...drawRow.querySelectorAll('button')].find(b => b.textContent.trim() === '拉取') : null;
    if (drawBtn) {
      drawBtn.click();
      await new Promise(r => setTimeout(r, 2500));
      const menus = [...document.querySelectorAll('div')].filter(d => d.style && d.style.zIndex === '9999');
      out.menuOpen = menus.length;
      out.menuItems = menus.length ? menus[0].querySelectorAll('.mi').length : 0;
      if (menus.length && out.menuItems) {
        const first = menus[0].querySelector('.mi');
        out.firstItem = first.textContent;
        first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        first.click();
        await new Promise(r => setTimeout(r, 300));
        out.picked = drawInput.value;
        out.menuClosedAfterPick = ![...document.querySelectorAll('div')].some(d => d.style && d.style.zIndex === '9999');
      }
    }
    return out;
  })()`).catch(e => ({ err: e.message }));

  console.log('[uicheck] tabs ' + JSON.stringify(result));
  console.log('[uicheck] probe ' + JSON.stringify(probe));
  console.log('[uicheck] errors ' + JSON.stringify(errors));
  console.log(errors.length === 0 && probe && probe.menuOpen > 0 && probe.picked ? '[uicheck] PASS' : '[uicheck] FAIL');
  app.exit(errors.length === 0 ? 0 : 1);
});
