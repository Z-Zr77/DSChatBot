// 控制台局部交互；随 ui.mjs 注入页面，不依赖第三方绘图库。
const THEME_KEY = 'DSChatBot.console.theme.v1';
const THEME_PRESETS = {
  night: { bg: '#10151f', card: '#192230', fg: '#edf2fb', dim: '#a5b4c9', acc: '#447ff5' },
  warm: { bg: '#211c20', card: '#30262e', fg: '#f5ecef', dim: '#c4b1bc', acc: '#bc607b' },
  light: { bg: '#f1f5fa', card: '#ffffff', fg: '#18283f', dim: '#52657d', acc: '#2865cf' }
};
const THEME_FONTS = { system: 'system-ui,"Microsoft YaHei",sans-serif', serif: 'Georgia,"SimSun",serif', mono: 'Consolas,"Microsoft YaHei",monospace' };
const THEME_DENSITY = { compact: 14, normal: 20, relaxed: 28 };
let consoleTheme = defaultTheme();
function defaultTheme() { return { version: 1, preset: 'night', colors: { ...THEME_PRESETS.night }, radius: 16, density: 'normal', font: 'system', css: '' }; }
function validateTheme(value) {
  if (!value || value.version !== 1 || !Object.hasOwn(THEME_PRESETS, value.preset)) throw new Error('不是有效的 DSChatBot 主题');
  const colors = {};
  for (const key of Object.keys(THEME_PRESETS.night)) {
    if (!/^#[0-9a-f]{6}$/i.test(value.colors && value.colors[key])) throw new Error('颜色必须是六位十六进制色值');
    colors[key] = value.colors[key];
  }
  if (!Number.isFinite(value.radius) || value.radius < 0 || value.radius > 24 || !Object.hasOwn(THEME_DENSITY, value.density) || !Object.hasOwn(THEME_FONTS, value.font)) throw new Error('圆角、密度或字体不合法');
  if (typeof value.css !== 'string' || value.css.length > 20000) throw new Error('自定义 CSS 最多 20000 字符');
  return { version: 1, preset: value.preset, colors, radius: value.radius, density: value.density, font: value.font, css: value.css };
}
function applyTheme() {
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(consoleTheme.colors)) style.setProperty('--' + key, value);
  style.setProperty('--r', consoleTheme.radius + 'px');
  style.setProperty('--r2', Math.max(0, consoleTheme.radius - 4) + 'px');
  style.setProperty('--space', THEME_DENSITY[consoleTheme.density] + 'px');
  style.setProperty('--font', THEME_FONTS[consoleTheme.font]);
  document.documentElement.style.colorScheme = consoleTheme.preset === 'light' ? 'light' : 'dark';
  let css = document.getElementById('consoleCustomCss');
  if (!css) { css = document.createElement('style'); css.id = 'consoleCustomCss'; document.head.appendChild(css); }
  // textContent 避免导入的 CSS 被当成 HTML/脚本解释。
  css.textContent = consoleTheme.css;
}
function persistTheme() {
  localStorage.setItem(THEME_KEY, JSON.stringify(consoleTheme));
  applyTheme();
  document.getElementById('themeMessage').textContent = '主题已保存';
}
function loadThemeForm() {
  const labels = { bg: '背景', card: '卡片', fg: '文字', dim: '辅助文字', acc: '强调色' };
  const box = document.getElementById('themeColors');
  box.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const wrapper = document.createElement('label'), input = document.createElement('input');
    wrapper.textContent = label;
    input.type = 'color'; input.dataset.color = key; input.value = consoleTheme.colors[key];
    input.setAttribute('aria-label', label + '颜色'); input.oninput = saveTheme;
    wrapper.appendChild(input); box.appendChild(wrapper);
  }
  for (const [id, value] of Object.entries({ themePreset: consoleTheme.preset, themeRadius: consoleTheme.radius, themeDensity: consoleTheme.density, themeFont: consoleTheme.font, themeCss: consoleTheme.css })) document.getElementById(id).value = value;
  document.getElementById('themeRadiusValue').textContent = consoleTheme.radius + ' px';
}
function saveTheme() {
  try {
    const colors = Object.fromEntries([...document.querySelectorAll('[data-color]')].map(el => [el.dataset.color, el.value]));
    consoleTheme = validateTheme({ ...consoleTheme, colors, radius: Number(document.getElementById('themeRadius').value), density: document.getElementById('themeDensity').value, font: document.getElementById('themeFont').value, css: document.getElementById('themeCss').value });
    persistTheme();
    document.getElementById('themeRadiusValue').textContent = consoleTheme.radius + ' px';
  } catch (e) { document.getElementById('themeMessage').textContent = e.message; }
}
function chooseTheme(name) {
  if (!Object.hasOwn(THEME_PRESETS, name)) return;
  consoleTheme = { ...consoleTheme, preset: name, colors: { ...THEME_PRESETS[name] } };
  try { persistTheme(); loadThemeForm(); } catch (e) { document.getElementById('themeMessage').textContent = e.message; }
}
function resetTheme() {
  consoleTheme = defaultTheme();
  try { persistTheme(); loadThemeForm(); } catch (e) { document.getElementById('themeMessage').textContent = e.message; }
}
async function importTheme(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    if (file.size > 100000) throw new Error('主题文件过大');
    const next = validateTheme(JSON.parse(await file.text()));
    // 完整校验后才覆盖，损坏文件不会丢掉当前主题。
    localStorage.setItem(THEME_KEY, JSON.stringify(next));
    consoleTheme = next; applyTheme(); loadThemeForm();
    document.getElementById('themeMessage').textContent = '主题已导入';
  } catch (e) { document.getElementById('themeMessage').textContent = '导入失败：' + e.message; }
  input.value = '';
}
function exportTheme() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(consoleTheme, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'DSChatBot-theme.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
try { const saved = localStorage.getItem(THEME_KEY); if (saved) consoleTheme = validateTheme(JSON.parse(saved)); } catch {}
applyTheme();

let __qrOpen = false;
function showQqScan() {
  __qrOpen = !__qrOpen;
  document.getElementById('qrSlot').hidden = !__qrOpen;
  if (__qrOpen) loadState();
}
function toggleQrPin() {
  const button = document.getElementById('qrPin');
  const on = button.getAttribute('aria-pressed') !== 'true';
  try { localStorage.setItem('DSChatBot.console.qrPin', String(on)); } catch {}
  paintQrPin(on);
}
function paintQrPin(on) {
  const button = document.getElementById('qrPin');
  button.setAttribute('aria-pressed', String(on)); button.textContent = on ? '取消固定' : '固定扫码入口';
  document.getElementById('scanEntry').classList.toggle('pinned', on);
}
try { paintQrPin(localStorage.getItem('DSChatBot.console.qrPin') === 'true'); } catch {}

let memoryNodes = [], memoryEdges = [], memoryCamera = { x: 0, y: 0, scale: 1 }, selectedMemory = null;
function memorySourceLabel(it) {
  if (it.origin === 'chat') return '聊天抽取';
  if (it.origin === 'legacy') return '旧数据';
  return it.src ? '聊天' : '手动/未知';
}
function memoryTab(id) {
  document.querySelectorAll('#memory [role="tab"]').forEach(button => {
    const on = button.getAttribute('aria-controls') === id;
    button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
    document.getElementById(button.getAttribute('aria-controls')).hidden = !on;
  });
  if (id === 'lessonsPane') loadLessons();
  if (id === 'skillsPane') loadSkills();
}
document.querySelector('#memory [role="tablist"]').onkeydown = event => {
  const tabs = [...document.querySelectorAll('#memory [role="tab"]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
};
function toggleMemoryView() {
  const graph = document.getElementById('memGraphView'), list = document.getElementById('memListView');
  graph.hidden = !graph.hidden; list.hidden = !graph.hidden;
  document.getElementById('memViewBtn').textContent = graph.hidden ? '关系图' : '列表编辑';
}
function explicitMemoryEdges(items) {
  const known = new Set(items.map(it => it.id).filter(Boolean)), edges = new Map();
  const add = (from, to, kind) => {
    if (from !== to && known.has(from) && known.has(to)) edges.set(kind + ':' + from + ':' + to, { from, to, kind });
  };
  for (const it of items) {
    for (const old of Array.isArray(it.supersedes) ? it.supersedes : []) add(old, it.id, 'correction');
    if (it.supersededBy) add(it.id, it.supersededBy, 'correction');
    // 因果只读取明确记录的 ID；没有记录就不推断，也不按文字相似度连线。
    for (const cause of Array.isArray(it.causedBy) ? it.causedBy : []) add(cause, it.id, 'cause');
    for (const result of Array.isArray(it.causes) ? it.causes : []) add(it.id, result, 'cause');
  }
  return [...edges.values()];
}
function renderMemoryGraph(items) {
  memoryNodes = items.map((item, i) => ({ ...item, x: 500 + Math.cos(i * 2.4) * Math.sqrt(i) * 74, y: 300 + Math.sin(i * 2.4) * Math.sqrt(i) * 64, radius: item.kind === 'core' ? 30 : 19 }));
  memoryEdges = explicitMemoryEdges(items);
  document.getElementById('memGraphEmpty').textContent = items.length ? '' : '还没有记忆。切到「列表编辑」添加，或在聊天后回来查看。';
  closeMemoryDetail(); fitMemory();
}
function drawMemoryGraph() {
  const svg = document.getElementById('memGraph'), byId = new Map(memoryNodes.map(it => [it.id, it]));
  const lines = memoryEdges.map(edge => {
    const a = byId.get(edge.from), b = byId.get(edge.to), dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1;
    return '<line data-edge="' + edge.kind + '" x1="' + (a.x + dx / distance * a.radius) + '" y1="' + (a.y + dy / distance * a.radius) + '" x2="' + (b.x - dx / distance * (b.radius + 6)) + '" y2="' + (b.y - dy / distance * (b.radius + 6)) + '" marker-end="url(#memoryArrow)"/>';
  }).join('');
  const nodes = memoryNodes.map((it, i) => '<g class="memory-node' + (it.stale ? ' stale' : '') + '" data-node="' + i + '" role="button" tabindex="0" aria-label="' + esc(it.text).replace(/"/g, '&quot;') + '" transform="translate(' + it.x + ',' + it.y + ')"><title>' + esc(it.text) + '</title><circle r="' + it.radius + '"/><text text-anchor="middle" y="5">' + (it.kind === 'core' ? '核心' : '记忆') + '</text><text class="node-caption" text-anchor="middle" y="' + (it.radius + 20) + '">' + esc(String(it.text).slice(0, 10)) + (String(it.text).length > 10 ? '…' : '') + '</text></g>').join('');
  svg.innerHTML = '<defs><marker id="memoryArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--dim)"/></marker></defs><g transform="translate(' + memoryCamera.x + ',' + memoryCamera.y + ') scale(' + memoryCamera.scale + ')">' + lines + nodes + '</g>';
}
function fitMemory() {
  const xs = memoryNodes.map(it => it.x), ys = memoryNodes.map(it => it.y);
  const minX = Math.min(400, ...xs) - 90, maxX = Math.max(600, ...xs) + 90, minY = Math.min(200, ...ys) - 70, maxY = Math.max(400, ...ys) + 90;
  const scale = Math.min(1.6, 1000 / (maxX - minX), 600 / (maxY - minY));
  memoryCamera = { scale, x: 500 - (minX + maxX) / 2 * scale, y: 300 - (minY + maxY) / 2 * scale };
  drawMemoryGraph();
}
function zoomMemory(factor) {
  const scale = Math.max(0.08, Math.min(5, memoryCamera.scale * factor)), ratio = scale / memoryCamera.scale;
  memoryCamera = { scale, x: 500 - (500 - memoryCamera.x) * ratio, y: 300 - (300 - memoryCamera.y) * ratio };
  drawMemoryGraph();
}
function closeMemoryDetail() { document.getElementById('memDetail').hidden = true; selectedMemory = null; }
function inspectMemory(index) {
  selectedMemory = memoryNodes[index];
  if (!selectedMemory) return;
  document.getElementById('memDetail').hidden = false;
  document.getElementById('memDetailText').textContent = selectedMemory.text;
  document.getElementById('memDetailMeta').textContent = memorySourceLabel(selectedMemory) + ' · 强度 ' + selectedMemory.score + (selectedMemory.stale ? ' · 已被更正，不再用' : '');
}
function editSelectedMemory() {
  if (!selectedMemory) return;
  const index = selectedMemory.index;
  if (!document.getElementById('memGraphView').hidden) toggleMemoryView();
  const row = document.getElementById('k' + index);
  if (row) { row.scrollIntoView({ block: 'center' }); row.focus(); }
}
const memorySvg = document.getElementById('memGraph');
let memoryDrag = null;
function memoryPoint(event) {
  const point = memorySvg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(memorySvg.getScreenCTM().inverse());
}
memorySvg.onpointerdown = event => {
  if (event.button !== 0) return;
  const node = event.target.closest('[data-node]');
  memoryDrag = { index: node ? Number(node.dataset.node) : null, point: memoryPoint(event), moved: false };
  memorySvg.setPointerCapture(event.pointerId);
};
memorySvg.onpointermove = event => {
  if (!memoryDrag) return;
  const point = memoryPoint(event), dx = point.x - memoryDrag.point.x, dy = point.y - memoryDrag.point.y;
  if (!memoryDrag.moved && Math.hypot(dx, dy) < 3) return;
  memoryDrag.moved = true;
  if (memoryDrag.index === null) { memoryCamera.x += dx; memoryCamera.y += dy; }
  else { memoryNodes[memoryDrag.index].x += dx / memoryCamera.scale; memoryNodes[memoryDrag.index].y += dy / memoryCamera.scale; }
  memoryDrag.point = point; drawMemoryGraph();
};
memorySvg.onpointerup = () => {
  if (memoryDrag && !memoryDrag.moved && memoryDrag.index !== null) inspectMemory(memoryDrag.index);
  memoryDrag = null;
};
memorySvg.onpointercancel = () => { memoryDrag = null; };
memorySvg.onkeydown = event => {
  const node = event.target.closest('[data-node]');
  if (node && ['Enter', ' '].includes(event.key)) { event.preventDefault(); inspectMemory(Number(node.dataset.node)); }
  if (event.key === 'Escape') closeMemoryDetail();
};
memorySvg.addEventListener('wheel', event => { event.preventDefault(); zoomMemory(event.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });

function humanLog(line) {
  const text = String(line), at = text.match(/^\[([^\]]+)\]/), time = at && !Number.isNaN(Date.parse(at[1])) ? new Date(at[1]).toLocaleTimeString('zh-CN', { hour12: false }) + ' · ' : '';
  const labels = { memo: '更新了记忆', persona: '更新了人格设定', plan: '安排了今天的日程', journal: '写下了日记', draw: '处理了一次画图请求', selfie: '处理了一次自拍请求', sticker: '处理了表情包', keep: '整理了表情包', proactive: '检查了主动消息', budget: '更新了花费记录', send: '处理了一条待发送消息', sleep: '更新了休息状态', work: '更新了文件操作状态', 'local-chat': '处理了软件内聊天' };
  const tag = text.match(/\[([a-z-]+)\]/i);
  if (/fail|error|失败|异常|没发出去/i.test(text)) return time + ((tag && labels[tag[1]]) || '运行过程') + '时出现问题，请查看运行日志';
  if (tag && labels[tag[1]]) return time + labels[tag[1]];
  if (/connected|连接成功|桥接.*启动/i.test(text)) return time + '连接已建立';
  if (/disconnect|连接断开/i.test(text)) return time + '连接已断开';
  return time + '记录了一条运行信息，详情见运行日志';
}
