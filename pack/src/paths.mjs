// 路径与配置：所有模块只从这里拿路径，保证“拷到哪都能跑”。
// DATA 默认放在程序目录旁的 data\，可用环境变量 QQBOT_DATA 覆盖。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = process.env.QQBOT_ROOT || path.resolve(HERE, '..');   // 资源根（打包后在 asar 内，只读）
const EXE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || (process.execPath ? path.dirname(process.execPath) : APP);
export const PACKAGED = !!process.versions.electron || process.env.QQBOT_IS_PACKAGED === '1';
// 三种形态：
//   便携版（portable）  → 数据就在 exe 旁边的 data\
//   安装版（nsis 装的） → 数据放 %LOCALAPPDATA%\QQChatBot\data（安装目录可能没写权限）
//   开发版（直接 node） → 数据在项目里的 data\
export const INSTALLED = PACKAGED && !process.env.PORTABLE_EXECUTABLE_DIR;
// 数据默认就放 exe 同级的 data\（安装版 = 安装目录下，便携版 = exe 旁边，开发版 = 项目里）
const HOME_DIR = PACKAGED ? EXE_DIR : APP;
// 用户在向导/控制台里选了别的目录，就记在 data-location.txt，下次启动读它
export const LOC_FILE = path.join(HOME_DIR, 'data-location.txt');
let LOCATED = '';
try { LOCATED = fs.readFileSync(LOC_FILE, 'utf8').trim(); } catch {}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wtest');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

const EXE_DATA = path.join(EXE_DIR, 'data');
const FALLBACK_DATA = path.join(process.env.LOCALAPPDATA || EXE_DIR, 'QQChatBot', 'data');
// 安装到 Program Files 这类没写权限的目录时，自动退到 %LOCALAPPDATA%，不硬失败
let resolved = process.env.QQBOT_DATA || LOCATED;
export const DATA_READONLY_FALLBACK = (() => {
  if (resolved) return false;
  if (!PACKAGED) return false;
  return !canWrite(EXE_DATA);
})();
if (!resolved) {
  resolved = PACKAGED ? (canWrite(EXE_DATA) ? EXE_DATA : FALLBACK_DATA) : path.join(APP, 'data');
}
export const DATA = resolved;
export const AGENT = path.join(DATA, 'agent-home');

export const PATHS = {
  app: APP,
  data: DATA,
  agent: AGENT,
  config: path.join(DATA, 'config.json'),
  setup: path.join(DATA, 'setup.json'),
  persona: path.join(DATA, 'persona.md'),
  emoticons: path.join(DATA, 'emoticons.json'),
  stickers: path.join(DATA, 'stickers'),
  stickersMeta: path.join(DATA, 'stickers.json'),
  log: path.join(DATA, 'bridge.log'),
  sessions: path.join(DATA, 'sessions.json'),
  inbox: path.join(DATA, 'inbox'),
  life: path.join(DATA, 'life.json'),
  lifeDir: path.join(DATA, 'life'),
  lifeSeen: path.join(DATA, 'life-seen.jsonl'),
  mind: path.join(DATA, 'mind'),
  state: path.join(DATA, 'state'),
  memory: path.join(AGENT, 'memory'),
  memoryPeople: path.join(AGENT, 'memory', 'people'),
  memoryLog: path.join(AGENT, 'memory', 'log'),
  proactive: path.join(DATA, 'proactive.json'),
  proactiveOnce: path.join(DATA, 'proactive.once'),
  qzoneOnce: path.join(DATA, 'qzone.once'),
  lock: path.join(DATA, 'bridge.pid'),
  drawn: path.join(DATA, 'drawn'),
  interests: path.join(DATA, 'interests.json'),
  browseState: path.join(DATA, 'browse-state.json'),
  ttsUsage: path.join(DATA, 'tts-usage.json'),
  aliyunKey: path.join(DATA, 'aliyun.key'),
  asrServer: path.join(APP, 'src', 'asr_server.py'),
  // 应用自己的“账本”：授权记录、撤销快照、执行/联网审计。放在同一个目录下，
  // 一是方便查看和备份，二是工作模式里整目录禁读禁写（不逐个列文件）。
  ledger: path.join(DATA, 'ledger'),
};

// 老版本把账本放在 data\\work 下，这里一次性搬到 data\\ledger（只搬一次，失败不影响启动）
export function migrateLedger() {
  const oldDir = path.join(DATA, 'work');
  const newDir = PATHS.ledger;
  const moves = [ [ 'grants.json', 'grants.json' ], [ 'audit.jsonl', 'audit.jsonl' ], [ 'snapshots', 'snapshots' ] ];
  for (const [ from, to ] of moves) {
    const a = path.join(oldDir, from);
    const b = path.join(newDir, to);
    try {
      if (!fs.existsSync(a) || fs.existsSync(b)) continue;
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(a, b);
    } catch {}
  }
}

export function ensureDirs() {
  migrateLedger();
  for (const d of [DATA, AGENT, PATHS.stickers, PATHS.inbox, PATHS.mind, PATHS.state,
    PATHS.memoryPeople, PATHS.memoryLog, PATHS.drawn, PATHS.lifeDir, PATHS.ledger]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

const DEFAULT_SETUP = {
  api: { baseUrl: 'https://api.deepseek.com/v1', key: '', model: 'deepseek-chat', temperature: 0.85, maxTokens: 900 },
  qq: { uin: '', ownerUin: '', name: '' },
  onebot: { wsPort: 3001, httpPort: 3000 },
  features: { voice: false, draw: false, qzone: false, browse: false, proactive: true },
  napcat: { dir: '' },
  ui: { port: 3070 },
};

export function loadSetup() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(PATHS.setup, 'utf8')); } catch {}
  return {
    ...DEFAULT_SETUP, ...j,
    api: { ...DEFAULT_SETUP.api, ...(j.api || {}) },
    qq: { ...DEFAULT_SETUP.qq, ...(j.qq || {}) },
    onebot: { ...DEFAULT_SETUP.onebot, ...(j.onebot || {}) },
    features: { ...DEFAULT_SETUP.features, ...(j.features || {}) },
    napcat: { ...DEFAULT_SETUP.napcat, ...(j.napcat || {}) },
    ui: { ...DEFAULT_SETUP.ui, ...(j.ui || {}) },
  };
}

export function saveSetup(patch) {
  const cur = loadSetup();
  const next = { ...cur, ...patch, api: { ...cur.api, ...(patch.api || {}) }, qq: { ...cur.qq, ...(patch.qq || {}) }, onebot: { ...cur.onebot, ...(patch.onebot || {}) }, features: { ...cur.features, ...(patch.features || {}) }, napcat: { ...cur.napcat, ...(patch.napcat || {}) }, ui: { ...cur.ui, ...(patch.ui || {}) } };
  ensureDirs();
  fs.writeFileSync(PATHS.setup, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export const isConfigured = () => { const s = loadSetup(); return !!(s.api.key && s.qq.uin); };
