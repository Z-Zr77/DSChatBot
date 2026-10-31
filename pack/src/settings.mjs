// 统一配置：C:\qqbot\config.json
// 网页界面（ui.mjs）改的就是这个文件；桥接启动时读一次。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

export const FILE = path.join(RQ, 'config.json');

export const DEFAULTS = {
  voice: 'longwan_v2',
  voiceName: 'B · 中文女声',
  tts: {
    provider: 'aliyun',        // aliyun | openai（OpenAI 兼容 /audio/speech）| edge（免费兜底）
    baseUrl: '',               // 留空 = 阿里云官方 / OpenAI 官方
    model: 'cosyvoice-v2',     // 阿里云模型名，可改 cosyvoice-v3-plus 等
    key: '',                   // 留空则用 aliyun.key 文件 / 环境变量
    voiceId: '',               // 留空则用上面 voice 字段
  },
  draw: {
    enabled: true,
    provider: 'auto',      // auto | dashscope | ark | openai
    baseUrl: '',           // 留空 = 用该后端默认地址
    model: '',             // 留空 = 用该后端默认模型
    key: '',               // 留空 = data\aliyun.key / data\ark.key / 环境变量
    perDay: 3,
    ref: true,             // 有参考图就带上（火山 Seedream 支持）
    sendRef: false,        // OpenAI 兼容网关是否也带图（多数不支持，默认关）
    keepMin: 60,           // 接着上一张自拍的窗口（分钟）；0 = 从不接着拍
    ownerPush: false,      // 主人要照片时是否“别一直拒”（默认 false = 完全由她心情）
  },
  proactive: {
    enabled: true,
    maxPerDay: 5,
    minGapMin: 45,
    quietMin: 15,
    chance: 0.5,
    activeFrom: '10:00',
    activeTo: '04:00',
    tickMin: 5,
    morningBoost: true,
  },
  browse: {
    enabled: true,
    perDay: 1,
    fromTime: '10:00',
    toTime: '23:00',
  },
  reply: {
    debounceMs: 4500,
    privateDelayMs: 2000,   // 私聊"打字"延迟
    groupDelayMs: 4000,     // 群聊"打字"延迟
    maxConsecutive: 3,
  },
  // 工具层（只读为主）：开了她才会真的去看文件/查目录，而不是嘴上说"我去看看"
  tools: {
    enabled: true,        // false = 完全不给她工具
    maxRounds: 6,        // 一轮对话里最多连续调几次（含重复调用被拦的那次）
    ownerOnly: true,      // 只有主人能用（群里别人问也不给）
  },
  // 工作模式：首期只做文件（读/写/预览/恢复/停止）。执行、联网、桌面默认关闭。
  dev: { noSleep: false },   // 开发测试期：true 时她不会真的去睡、也不提困
  work: {
    defaultMode: 'write',
    approval: 'ask',     // ask=每条命令/联网都问；never=工作区内的命令不问（越权仍然问）
    lastRoot: '',
    ledgerDays: 30,       // 撤销账本（dataledgersnapshots）保留几天，启动时清一次
    readRoots: [],        // 空 = 用默认（项目根 + 数据目录）；写死在服务端 deny 清单里的仍然读不到
    timeoutMin: 30,       // 授权有效期（分钟）；只按"人"的操作续期
    exec: { mode: 'workspace', allow: [], timeoutMs: 60000, maxOutput: 8000 },
    // 执行命令：mode=off|workspace|full；workspace=只能在选定的工作区里跑、参数路径必须落在工作区内。
    // 这不是进程沙箱（Windows 上没有便宜的进程级文件隔离）：命令一律要人工审批。
    // 联网：只读抓网页（fetch_url）。allowHosts 里的主机可以放开「本机/内网」限制。
    net: { enabled: true, allowHosts: [], maxBytes: 2097152, timeoutMs: 20000 },
    desktop: false,
    suggestRoot: '',      // 空 = <data>\work\sessions；建议路径只算不建
  },
  // 备份：把记忆/经验库/技能库/配置/聊天记录复制到 <数据目录上一级>\backups
  backup: { enabled: true, dir: '', keep: 7, mode: 'normal', dailyHour: 4 },
  names: [],          // 她被叫的其他名字（群里叫这些也算叫她）
  blacklist: {
    uins: [],          // 拉黑的 QQ 号
    mode: 'curse',     // curse = 见一次骂一次 / ignore = 完全不理
  },
  // 称呼：亲密度到了以后，对主人可以叫这个；对其他人可称兄道弟
  owner: { gender: '' }, // 你的性别：male=男(她写女) / female=女(她写男) / 空=不指定
  addr: { ownerClose: '', ownerCloseAt: 60, othersBro: true },
  groups: {
    enabled: true,    // 总开关：要不要在群里说话
    allow: [],        // 只在这些群说话（空 = 不限制）
    block: [],        // 这些群一律不理
    needCall: true,   // 必须 @ 或叫名字才理
    followMin: 5,     // 被叫到之后，这个群还能接着聊几分钟（0 = 每条都要叫）
    followAuto: true, // 续聊时由她自己决定接不接（false = 窗口内一律回）
    maxChain: 6,      // 一轮最多连着说几句，防刷屏
    joinSec: 8,          // 群里连着发：等这么多秒合成一轮再看（0 = 不合并）
    maxJoin: 8,          // 一轮最多合并几条
    recallCount: 8,      // 被叫到时，补上前面几条群消息当上下文（0 = 不补）
    gapSec: 15,          // 她两次发言之间至少隔几秒（不够就等）
    spicy: 2,         // 对群友的毒舌程度：0 温和 / 1 正常 / 2 毒
    dayCap: 0,        // 群聊每天最多花多少元（0 = 不限）
    monthCap: 0,      // 群聊每月最多花多少元（0 = 不限）；和总预算共用同一个池子
  },
  stickers: {
    max: 300,
    collectFromUser: true,
    collectFromGroup: true,
  },
  qzone: {
    enabled: true,
    perDay: 1,
    fromTime: '10:00',
    toTime: '23:00',
    chance: 0.7,
  },
  napcat: { host: '127.0.0.1' }, // NapCat 所在主机（跑在同一台就是 127.0.0.1）
  guard: { auto: true },
  qq: { enabled: true },
  danger: { delPwdHash: '' },   // 删主人号用的密码（只存 sha256；空 = 没设，主人号就不许删）
  notify: { channel: 'off', url: '', topic: '', when: 'local' },     // 允许守护自动重启内核 / 自动换码（风控期间建议关）
  // 控制台手机访问：开启后监听 0.0.0.0 并要求密码（手机和电脑要连同一个 Wi-Fi）
  // 每个模块是否允许“自己找退路”（关掉 = 只用你指定的，失败就失败，不偷偷换）
  fallback: { chat: true, vision: true, draw: false, asr: true, tts: true },
  ui: { lan: false, pass: '' },
  life: { plan: true, journal: true, events: true, reviewMin: 150 },  // 她自己的生活；reviewMin=她自己复查日程的间隔
  // 出图相关的提示词（都可改，改完下一条消息生效；不会写死在源码里）
  drawStyle: 'anime',   // anime 二次元 / semi 半写实 / real 写实：只影响出图的画风描述
  prompts: {
    style: '二次元动漫插画风格，线条干净、上色柔和。',
    selfie: '手机前置摄像头自拍：单人，近景，脸占画面主导，半身构图；画面里不要出现手机本身、不要屏幕边框、不要镜子或画中画。',
    selfieFull: '全身照：手机放在支架上定时拍摄，从头到脚完整入画，头顶和脚都不裁掉，能看见脚下地面。',
    selfieBan: '禁止：文字、边框、多格拼图、贴纸、设定稿或立绘、画面里出现手机或屏幕、镜子与画中画、畸形手指。',
    ref: '参考图只用来参考长相、发型、服装和配色，不要复制它的白色背景、三视图排版或立绘风格。',
    scene: '环境细节要有生活痕迹，构图自然，像随手拍的。',
    sceneBan: '禁止：人物、人脸、文字、水印、边框、多格拼图。',
  },
  talk: {
    pokeLines: ['别戳', '戳啥戳', '手欠啊', '有话说', '干嘛', '……', '戳我干嘛', '再戳咬你'],
    fallbackPlan: [
      '08:00 卧室｜刚醒，赖在床上',
      '09:30 厨房｜弄点吃的',
      '11:00 书桌前｜忙自己的事',
      '14:00 客厅｜歇一会儿，刷会儿手机',
      '18:30 餐桌｜吃饭',
      '22:30 卧室｜躺床上刷手机',
    ],
    lifePool: [
      '在忙自己的事', '刚吃完饭', '在刷手机', '在收拾屋子', '出门买点东西',
      '在听歌', '刚睡醒还有点懵', '在发呆', '在做饭', '在看剧',
      '在外面散步', '在整理东西',
    ],
  },
  budget: {
    enabled: true,
    monthlyCap: 20,      // 月度预算（元）；超过开始降耗
    notifyExtra: 10,     // 在预算之上再多花这么多 → QQ 通知并停止
    prices: {
      // 单价只用于本地估算，和真实账单会有偏差；官方调价请在这里改
      inputPerM: 2.0,      // 元 / 百万 token（未命中缓存）
      cacheHitPerM: 0.5,   // 元 / 百万 token（命中缓存）
      outputPerM: 8.0,     // 元 / 百万 token（输出）
      ttsPerKChar: 0.2,    // 元 / 千字符（CosyVoice）
      asrPerSec: 0.0007,   // 元 / 秒（语音识别）
      visionPerCall: 0.01, // 元 / 次（看图）
    },
  },
};

let cache = null;

// ---- 时间：统一用 24 小时制 "HH:MM"，内部比较用「当天第几分钟」 ----
export function toMinutes(v, fallback = -1) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 兼容老配置：整数当小时（0–23）
    if (v < 0 || v > 24) return fallback;
    return Math.round(v) * 60;
  }
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

export function fmtTime(v, fallback = '00:00') {
  const mins = toMinutes(v, -1);
  if (mins < 0) return fallback;
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

const clamp = (n, lo, hi, dflt) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, x));
};

// 把配置里不合法/过期的写法收拾干净（时间字段、数值范围）
export function sanitize(cfg) {
  const p = cfg.proactive || (cfg.proactive = {});
  p.maxPerDay = Math.round(clamp(p.maxPerDay, 0, 50, 5));
  p.minGapMin = Math.round(clamp(p.minGapMin, 0, 1440, 45));
  p.quietMin = Math.round(clamp(p.quietMin, 0, 1440, 15));
  p.chance = clamp(p.chance, 0, 1, 0.5);
  p.tickMin = Math.round(clamp(p.tickMin, 1, 120, 5));
  p.activeFrom = fmtTime(p.activeFrom, '10:00');
  p.activeTo = fmtTime(p.activeTo, '04:00');

  const b = cfg.browse || (cfg.browse = {});
  b.perDay = Math.round(clamp(b.perDay, 0, 20, 1));
  if (b.fromHour !== undefined) { b.fromTime = fmtTime(b.fromHour, '10:00'); delete b.fromHour; }
  if (b.toHour !== undefined) { b.toTime = fmtTime(b.toHour, '23:00'); delete b.toHour; }
  b.fromTime = fmtTime(b.fromTime, '10:00');
  b.toTime = fmtTime(b.toTime, '23:00');

  const q = cfg.qzone || (cfg.qzone = {});
  q.perDay = Math.round(clamp(q.perDay, 0, 10, 1));
  q.chance = clamp(q.chance, 0, 1, 0.7);
  if (q.fromHour !== undefined) { q.fromTime = fmtTime(q.fromHour, '10:00'); delete q.fromHour; }
  if (q.toHour !== undefined) { q.toTime = fmtTime(q.toHour, '23:00'); delete q.toHour; }
  q.fromTime = fmtTime(q.fromTime, '10:00');
  q.toTime = fmtTime(q.toTime, '23:00');

  const r = cfg.reply || (cfg.reply = {});
  r.debounceMs = Math.round(clamp(r.debounceMs, 300, 120000, 4500));
  r.maxConsecutive = Math.round(clamp(r.maxConsecutive, 1, 10, 3));
  r.privateDelayMs = Math.round(clamp(r.privateDelayMs, 0, 60000, 2000));
  r.groupDelayMs = Math.round(clamp(r.groupDelayMs, 0, 60000, 4000));

  const mem = cfg.memory || (cfg.memory = {});
  mem.logKeep = Math.round(clamp(mem.logKeep, 10, 400, 80));
  mem.halfLifeFact = Math.round(clamp(mem.halfLifeFact, 1, 3650, 45));
  mem.halfLifeTrivia = Math.round(clamp(mem.halfLifeTrivia, 1, 3650, 14));
  mem.digest = mem.digest !== false;
  const me = mem.embed || (mem.embed = {});
  me.on = me.on !== false;
  me.enabled = me.enabled !== false;
  me.baseUrl = String(me.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  me.model = String(me.model || 'text-embedding-v3');
  me.dim = Math.round(clamp(me.dim, 64, 2048, 512));
  mem.autoCorrect = mem.autoCorrect !== false;

  const linesOf = (v, cap, fb) => {
    const arr = Array.isArray(v) ? v : String(v || '').split(/\r?\n/);
    const keep = arr.map(x => String(x || '').trim()).filter(Boolean).slice(0, cap);
    return keep.length ? keep : fb;
  };
  const talk = cfg.talk || (cfg.talk = {});
  talk.pokeLines = linesOf(talk.pokeLines, 40, DEFAULTS.talk.pokeLines);
  talk.fallbackPlan = linesOf(talk.fallbackPlan, 20, DEFAULTS.talk.fallbackPlan);
  talk.lifePool = linesOf(talk.lifePool, 60, DEFAULTS.talk.lifePool);

  const nap = cfg.napcat || (cfg.napcat = {});
  nap.host = String(nap.host || '127.0.0.1').trim().slice(0, 64) || '127.0.0.1';

  const lfz = cfg.life || (cfg.life = {});
  lfz.plan = lfz.plan !== false;
  lfz.journal = lfz.journal !== false;
  lfz.events = lfz.events !== false;
  lfz.reviewMin = Math.round(clamp(lfz.reviewMin, 30, 720, 150));
  cfg.drawStyle = ['anime', 'semi', 'real', 'custom'].includes(cfg.drawStyle) ? cfg.drawStyle : 'anime';
  const pr = cfg.prompts || (cfg.prompts = {});
  const PD = DEFAULTS.prompts;
  for (const k of ['style', 'selfie', 'selfieFull', 'selfieBan', 'ref', 'scene', 'sceneBan']) {
    const v = String(pr[k] ?? '').trim();
    pr[k] = (v || PD[k]).slice(0, 900);
  }

  const g = cfg.groups || (cfg.groups = {});
  const listOf = (v) => {
    const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
    return arr.map(x => String(x).trim()).filter(x => /^\d{5,12}$/.test(x)).slice(0, 100);
  };
  g.allow = listOf(g.allow);
  g.block = listOf(g.block);
  g.followMin = Math.round(clamp(g.followMin, 0, 120, 5));
  cfg.names = (Array.isArray(cfg.names) ? cfg.names : String(cfg.names || '').split(/[,，\s]+/))
    .map(x => String(x).trim()).filter(x => x.length >= 1 && x.length <= 12).slice(0, 10);

  const blk = cfg.blacklist || (cfg.blacklist = {});
  const rawBl = Array.isArray(blk.uins) ? blk.uins : String(blk.uins || '').split(/[,，\s]+/);
  blk.uins = rawBl.map(x => String(x).trim()).filter(x => /^\d{5,12}$/.test(x)).slice(0, 100);
  if (!['curse', 'ignore'].includes(blk.mode)) blk.mode = 'curse';
  g.needCall = g.needCall !== false;
  g.followAuto = g.followAuto !== false;
  g.enabled = g.enabled !== false;
  g.maxChain = Math.round(clamp(g.maxChain, 1, 30, 6));
  g.gapSec = Math.round(clamp(g.gapSec, 0, 600, 15));
  g.spicy = Math.round(clamp(g.spicy, 0, 2, 2));
  g.dayCap = Math.round(clamp(g.dayCap, 0, 10000, 0) * 100) / 100;
  g.monthCap = Math.round(clamp(g.monthCap, 0, 10000, 0) * 100) / 100;

  const s = cfg.stickers || (cfg.stickers = {});
  s.max = Math.round(clamp(s.max, 10, 1000, 300));

  const bud = cfg.budget || (cfg.budget = {});
  bud.monthlyCap = clamp(bud.monthlyCap, 0, 100000, 20);

  const dw = cfg.draw || (cfg.draw = {});
  {
    const pv = String(dw.provider || 'auto').toLowerCase();
    dw.provider = ['auto', 'dashscope', 'ark', 'openai'].includes(pv) ? pv : 'auto';
    dw.baseUrl = String(dw.baseUrl || '').trim().replace(/\/+$/, '').slice(0, 200);
    dw.model = String(dw.model || '').trim().slice(0, 80);
    dw.key = String(dw.key || '').trim().slice(0, 200);
    dw.perDay = Math.round(clamp(dw.perDay, 0, 100, 3));
    dw.ref = dw.ref !== false;
    dw.sendRef = dw.sendRef === true;
    dw.keepMin = Math.round(clamp(dw.keepMin, 0, 1440, 60));
    dw.ownerPush = dw.ownerPush === true;
  }

  const t = cfg.tts || (cfg.tts = {});
  t.provider = ['edge', 'openai'].includes(t.provider) ? t.provider : 'aliyun';
  t.baseUrl = String(t.baseUrl || '').trim().slice(0, 200);
  t.model = String(t.model || 'cosyvoice-v2').trim().slice(0, 64) || 'cosyvoice-v2';
  t.key = String(t.key || '').trim().slice(0, 200);
  t.voiceId = String(t.voiceId || '').trim().slice(0, 64);

  const lf = cfg.life || (cfg.life = {});
  for (const k of ['plan', 'journal', 'events']) lf[k] = lf[k] !== false;
  lf.reviewMin = Math.round(clamp(lf.reviewMin, 30, 720, 150));
  // guard.auto：关掉后守护只记录状态，绝不自动重启内核 / 自动换码
  const nm = cfg.norms || (cfg.norms = {});
  nm.enabled = nm.enabled !== false;
  nm.time = nm.time !== false;
  nm.body = nm.body !== false;
  nm.owner = nm.owner !== false;
  nm.memory = nm.memory !== false;
  nm.schedule = nm.schedule !== false;
  nm.relation = nm.relation !== false;
  nm.social = nm.social !== false;
  nm.repeat = nm.repeat !== false;
  const gd = cfg.guard || (cfg.guard = {});
  gd.auto = gd.auto !== false;
  // notify：手机推送通道
  const nf = cfg.notify || (cfg.notify = {});
  const NCH = ['off', 'ntfy', 'wecom', 'dingtalk', 'bark'];
  nf.channel = NCH.includes(String(nf.channel)) ? String(nf.channel) : 'off';
  nf.url = String(nf.url || '').slice(0, 400);
  nf.topic = String(nf.topic || '').slice(0, 120);
  nf.when = ['local', 'all'].includes(String(nf.when)) ? String(nf.when) : 'local';
  const nc = cfg.napcat || (cfg.napcat = {});
  nc.host = String(nc.host || '127.0.0.1').trim().slice(0, 64) || '127.0.0.1';

  const qq = cfg.qq || (cfg.qq = {});
  qq.enabled = qq.enabled !== false;
  const ui = cfg.ui || (cfg.ui = {});
  const fb = (cfg.fallback && typeof cfg.fallback === 'object') ? cfg.fallback : {};
  cfg.fallback = {
    chat: fb.chat !== false,
    vision: fb.vision !== false,
    draw: fb.draw === true,
    asr: fb.asr !== false,
    tts: fb.tts !== false,
  };
  ui.lan = ui.lan === true;
  ui.pass = String(ui.pass == null ? '' : ui.pass).trim().slice(0, 64);
  ui.qrToken = String(ui.qrToken == null ? '' : ui.qrToken).trim().slice(0, 64);
  return cfg;
}

// 上海时间的「当天第几分钟」
export function nowMinutes() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 「当天第几分钟」→ HH:MM（nowMinutes 这类分钟值用它，别用 fmtTime——那个会把数字当小时）
export function fmtMinutes(m) {
  const v = Math.max(0, Math.min(1439, Math.floor(Number(m) || 0)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

export function inWindow(from, to, at = nowMinutes()) {
  const a = toMinutes(from, 0);
  const b = toMinutes(to, 24 * 60 - 1);
  return a <= b ? (at >= a && at < b) : (at >= a || at < b);
}

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

const stripBom = (t) => String(t || '').replace(/^\uFEFF/, '');

export function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(stripBom(fs.readFileSync(FILE, 'utf8'))); } catch {}
  cache = sanitize(merge(DEFAULTS, raw));
  return cache;
}

// 能不能当作"上一版"来备份：主文件写坏了的时候，千万别拿它盖掉最后一份好的 .bak
function backupSafe() {
  try {
    const cur = stripBom(fs.readFileSync(FILE, 'utf8'));
    const obj = JSON.parse(cur);
    return obj && typeof obj === 'object';
  } catch { return false; }
}

export function save(next) {
  // 以"当前配置"为底再合并，而不是以 DEFAULTS 为底：控制台只提交页面上的字段，
  // 用 DEFAULTS 当底会把没提交的字段（画图 Key/模型、语色、自定义日程…）静默重置成默认值。
  // 2026-10-29 18:43 就是这样把她的画图 Key 和模型清空的，别再犯。
  cache = sanitize(merge(merge(DEFAULTS, load()), next));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 每次落盘前留一份上一版，写坏了还能捞回来；主文件已坏就保留旧 .bak 不动
  try { if (fs.existsSync(FILE) && backupSafe()) fs.copyFileSync(FILE, FILE + '.bak'); } catch {}
  // 先写临时文件再替换：半截 JSON 不会留在盘上
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return cache;
}

export function patch(part) {
  return save(merge(load(), part));
}

export function reload() {
  cache = null;
  return load();
}
