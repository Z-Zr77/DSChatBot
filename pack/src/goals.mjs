// goals.mjs —— 她的长期目标（跨天、能积累、能放弃）
// 设计原则：文件即真相，模型只能通过标记改它；所有字段都可被用户手工编辑。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

const FILE = () => path.join(PATHS.data, 'goals.json');
const MAX = 8;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch {}
  return { items: [], updated: 0 };
}
function save(j) {
  j.updated = Date.now();
  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(j, null, 2));
  } catch (e) { console.error('[goals] save fail', e.message); }
}
const uid = () => 'g' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);

export function list(filter) {
  const j = load();
  return (filter === 'all' ? j.items : j.items.filter((x) => x.status !== 'dropped'));
}

// 新建：title 必填；why 是可选的“她为什么想做”
export function add({ title, why = '', steps = [], due = '' }) {
  const j = load();
  if (!title) return null;
  if (j.items.filter((x) => x.status === 'active').length >= MAX) {
    // 满了就把最旧的、进度最低的降级为 paused
    const cand = j.items.filter((x) => x.status === 'active').sort((a, b) => (a.progress || 0) - (b.progress || 0))[0];
    if (cand) cand.status = 'paused';
  }
  const item = {
    id: uid(), title: String(title).slice(0, 40), why: String(why).slice(0, 120),
    steps: (steps || []).slice(0, 8).map((s) => String(s).slice(0, 40)),
    progress: 0, due, status: 'active',
    created: Date.now(), last: Date.now(), logs: [],
  };
  j.items.push(item);
  save(j);
  return item;
}

export function find(needle) {
  const q = String(needle || '').trim();
  if (!q) return null;
  const j = load();
  return j.items.find((x) => x.title === q)
    || j.items.find((x) => x.status !== 'dropped' && (x.title.includes(q) || q.includes(x.title)))
    || null;
}

// 推进：delta 可以为负（倒退），note 是她自己的一句话
export function step(needle, delta = 0.1, note = '') {
  const it = find(needle);
  if (!it) return null;
  const d = Number(delta) || 0;
  it.progress = Math.max(0, Math.min(1, Math.round(((it.progress || 0) + d) * 100) / 100));
  it.last = Date.now();
  it.logs = (it.logs || []).concat([{ at: Date.now(), d, note: String(note).slice(0, 100), p: it.progress }]).slice(-40);
  if (it.progress >= 1) it.status = 'done';
  save(loadMut(it));
  return it;
}
function loadMut(it) {
  const j = load();
  const i = j.items.findIndex((x) => x.id === it.id);
  if (i >= 0) j.items[i] = it; else j.items.push(it);
  return j;
}

export function drop(needle, why = '') {
  const it = find(needle);
  if (!it) return null;
  it.status = 'dropped';
  it.last = Date.now();
  it.logs = (it.logs || []).concat([{ at: Date.now(), d: 0, note: '放弃：' + String(why).slice(0, 80), p: it.progress }]).slice(-40);
  save(loadMut(it));
  return it;
}

export function set(idOrTitle, patch) {
  const it = find(idOrTitle);
  if (!it) return null;
  Object.assign(it, patch || {});
  it.last = Date.now();
  save(loadMut(it));
  return it;
}

// 给提示词用：她自己看到“我在忙什么、走到哪了”
export function render(max = 600) {
  const items = list().filter((x) => x.status === 'active' || x.status === 'paused');
  if (!items.length) return '';
  const lines = items.map((x) => {
    const pct = Math.round((x.progress || 0) * 100);
    const lastLog = (x.logs || []).slice(-1)[0];
    const tail = lastLog && lastLog.note ? `，最近：${lastLog.note}` : '';
    const st = x.status === 'paused' ? '（搁置中）' : '';
    return `- ${x.title}${st}：进度 ${pct}%${x.why ? `；为什么：${x.why}` : ''}${tail}`;
  });
  let out = '【你长期在忙的事】\n' + lines.join('\n');
  if (out.length > max) out = out.slice(0, max) + '…';
  return out;
}

// 今天可以往哪件事上使劲（给日程生成用）
export function todayHint() {
  const items = list().filter((x) => x.status === 'active');
  if (!items.length) return '';
  const pick = items.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0))[0];
  return `今天可以安排一件和「${pick.title}」有关的小事（现在 ${Math.round((pick.progress || 0) * 100)}%）`;
}

// 初次启用：从人格里抠一点线索，生成 2-3 个目标（不给就空着）
export function seed(fromPersona = '') {
  const j = load();
  if (j.items.length) return j.items;
  const txt = String(fromPersona || '');
  const picked = [];
  const rules = [
    [/吉他|音乐|唱/, '学会弹一首完整的吉他曲', '一直喜欢，但总拖着'],
    [/画|漫画|插画/, '画完一本自己的短篇', '想试试能不能讲完整一个故事'],
    [/游戏/, '把手上那部游戏打到通关', '不想永远停在第三章'],
    [/写|小说/, '写完一篇能拿给人看的东西', '憋了很久'],
    [/健身|跑步|运动/, '连续一个月每天动一动', '想让身体别那么虚'],
    [/猫|狗/, '把家里那只照顾得更好一点', '它只有你'],
  ];
  for (const [re, title, why] of rules) {
    if (re.test(txt) && picked.length < 3) picked.push({ title, why });
  }
  if (!picked.length) picked.push({ title: '把日子过出点样子来', why: '不想每天只是刷手机' });
  const items = picked.map((p) => ({
    id: uid(), title: p.title, why: p.why, steps: [], progress: 0, due: '',
    status: 'active', created: Date.now(), last: Date.now(), logs: [],
  }));
  const out = { items, updated: Date.now() };
  save(out);
  return items;
}

export function stats() {
  const items = list('all');
  return {
    active: items.filter((x) => x.status === 'active').length,
    paused: items.filter((x) => x.status === 'paused').length,
    done: items.filter((x) => x.status === 'done').length,
    dropped: items.filter((x) => x.status === 'dropped').length,
  };
}
