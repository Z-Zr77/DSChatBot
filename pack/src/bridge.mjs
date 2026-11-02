import * as moments from './moments.mjs';
// DSH <-> QQ bridge (OneBot v11 over NapCat WebSocket)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { textToSilk, silkFileToWav, Asr } from './voice.mjs';
import * as mind from './mind.mjs';
import * as curiosity from './curiosity.mjs';
import * as memory from './memory.mjs';
import * as channels from './channels.mjs';
import * as share from './share.mjs';
import * as websearch from './websearch.mjs';
import { ensurePersonaFile } from './persona-default.mjs';
const MEM_EMB_CFG = () => { try { const m = settings.load().memory || {}; return m.embed || {}; } catch { return {}; } };
// 向量的"坐标系"签名：换 embedding 模型/维度后，旧向量不能拿来算相似度（复查 F16）
const MEM_EMB_SIG = () => { try { return memory.vecSig(MEM_EMB_CFG()); } catch { return ''; } };
import * as goals from './goals.mjs';
import * as selffacts from './self-facts.mjs';
import * as grounding from './grounding.mjs';
import * as selfcheck from './selfcheck.mjs';
import * as lessons from './lessons.mjs';
import * as skills from './skills.mjs';
import * as toolbox from './tools.mjs';
import * as grants from './grants.mjs';
import * as fsguard from './fsguard.mjs';
import { wsUrlOf, wsHeadersOf, wsUrlWithToken, openWs, httpHeadersOf } from './onebot.mjs';
import * as snapshots from './snapshots.mjs';
import * as backup from './backup.mjs';
import * as exec from './exec.mjs';
import * as attach from './attach.mjs';
import * as norms from './norms.mjs';
import * as settings from './settings.mjs';
import * as budget from './budget.mjs';
import * as qzone from './qzone.mjs';
import * as draw from './draw.mjs';
import * as loops from './loops.mjs';
import * as self from './self.mjs';
import * as imageintent from './imageintent.mjs';
import * as taboos from './taboos.mjs';
import * as scenes from './scenes.mjs';
import * as daily from './daily.mjs';
import * as life from './life.mjs';
import * as outreach from './outreach.mjs';
import { agedLog, splitInner } from './timing.mjs';
import * as brain from './brain.mjs';
import * as apibrain from './apibrain.mjs';
import { PATHS, loadSetup } from './paths.mjs';
import * as chatlog from './chatlog.mjs';
import * as notify from './notify.mjs';
import { resolveVision } from './capability.mjs';
// NapCat 主机（可配：跑在同一台机器就是 127.0.0.1）
const napHost = () => {
  if (process.env.QQBOT_NAPCAT_HOST) return String(process.env.QQBOT_NAPCAT_HOST).trim();
  try {
    const h = String(settings.load().napcat?.host || '127.0.0.1').trim();
    return h || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
};
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;

const SETUP = loadSetup();
// 记忆半衰期（可配）：启动先同步一次
try {
  const mm = settings.load().memory || {};
  memory.setHalfLife?.(mm.halfLifeFact, mm.halfLifeTrivia);
} catch {}
const cfg = {
  wsHttp: `http://${napHost()}:${SETUP.onebot.httpPort}`,
  botUin: SETUP.qq.uin,
  cwd: PATHS.agent,
  personaSrc: PATHS.persona,
  stickerDir: PATHS.stickers,
  stickerMeta: PATHS.stickersMeta,
  logFile: PATHS.log,
  sessionMapFile: PATHS.sessions,
  maxChunk: 1800,
  dshTimeoutMs: 600000,
  ownerUin: SETUP.qq.ownerUin,
};
// 分发版：大脑走直连 API（brain.mjs），保留旧函数名让调用点不用改
const askDsh = (...args) => brain.ask(...args);

// 日志：写文件 + 控制台。每 200 行查一次大小，超过 8MB 就滚一份 bridge.log.1，
// 不让它无限长（之前跑了 6 天 900KB，再久一点控制台「日志」页就没法看了）。
let _logLines = 0;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(cfg.logFile, line + '\n');
    if (++_logLines % 200 === 0) {
      try {
        if (fs.statSync(cfg.logFile).size > 8 * 1024 * 1024) {
          const old = cfg.logFile + '.1';
          try { fs.unlinkSync(old); } catch {}
          fs.renameSync(cfg.logFile, old);
        }
      } catch {}
    }
  } catch {}
  console.log(line);
}

let sessions = {};
const lastSticker = {}; // 会话 -> 上次发的表情包，避免连着重复
try { sessions = JSON.parse(fs.readFileSync(cfg.sessionMapFile, 'utf8')); } catch {}
function saveSessions() { try { fs.writeFileSync(cfg.sessionMapFile, JSON.stringify(sessions, null, 2)); } catch {} }

// ---------- 人格注入 ----------
// 把 persona.md 同步成 agent 目录的 AGENTS.md（DSH 会把 cwd 的 AGENTS.md 作为系统级指令注入）。
const AGENTS_MD = path.join(cfg.cwd, 'AGENTS.md');
const STAMP = path.join(cfg.cwd, '.persona-stamp');

const PERSONA_HEAD = `# 角色设定（最高优先级）

你现在通过 QQ 和真人聊天，不是在写代码、不是在帮人做项目。
下面这份设定覆盖任何"编程助手 / AI 智能体"的身份：不要自称 AI 助手，
不要提"有什么可以帮你"，不要给代码建议。

`;


// 群里对谁什么态度：主人 = 还是软的；其他人 = 按毒舌档位来
// 主人明确要照片：她可以嫌烦、可以推一句，但别一直拒绝
function photoRule(conv) {
  try {
    if (conv.kind !== 'private') return '';
    if (String(conv.id) !== String(cfg.ownerUin)) return '';
    const d = settings.load().draw || {};
    if (d.enabled === false || d.ownerPush === false) return '';
    return '他要照片的时候：可以嫌烦、可以推一句“烦死了/明天吧”，但别一直拒绝——同一个要求他说到第二次，就拍给他（可以不情愿、可以配一句抱怨）。';
  } catch { return ''; }
}

function groupTone(conv) {
  const owner = String(cfg.ownerUin || '');
  const speaker = conv.kind === 'group' ? conv.speaker : conv.id;
  const isOwner = owner && String(speaker || '') === owner;
  const lv = Number(settings.load().groups?.spicy ?? 2);
  const how = lv <= 0
    ? '正常说话就行，不用刻意损。'
    : lv === 1
      ? '有点距离、爱答不理，别太热络，可以顶两句。'
      : '毒一点：抬杠、损、拆台、懒得捧场，能噎就噎一句，不用给面子。但不能真恶毒——不骂家人、不攻击长相身材、不人身攻击、不往人痛处踩；不过对方要是叫你宝宝老婆这种，这条不适用，照样往死里怼。';
  if (isOwner) return conv.kind === 'group' ? '（说话这人是你主人，虽然在群里，对他还是那副软的口气。）' : '';
  return (conv.kind === 'group' ? '（群里其他人，不是你主人。）' : '（这人不是你主人，是别人找来跟你说话的。）') + how;
}


// 非主人叫「宝宝 / 老婆」这类 → 硬性要求怼回去（提示词里写一条容易被别的规则冲淡，这里直接下指令）
const INTIMATE_RE = /(宝宝|宝子|宝贝|亲爱的|亲亲|老婆|老公|媳妇|小可爱|小宝贝|达令|honey|甜心|乖乖|小狗|小猫(?!咪?叫)|我的(?:人|宝)|抱抱|亲一个)/i;
function intimateTone(conv, body) {
  const owner = String(cfg.ownerUin || '');
  const speaker = conv.kind === 'group' ? conv.speaker : conv.id;
  if (owner && String(speaker || '') === owner) return '';
  if (!INTIMATE_RE.test(String(body || ''))) return '';
  return [
    '【他不是你主人，却叫你这种称呼】',
    '这事不能顺着他。你必须怼回去：嫌恶心、让他闭嘴、骂他不要脸都行，语气要冲，一两句就够，不要解释、不要客气、不要卖萌。',
    '可以带脏话但别污言秽语、别骂家人、别拿长相身材开刀——就冲他这个称呼恶心他。',
  ].join('\n');
}


// 记住每个人的昵称：她说的是人名，不是号
const NAMES_FILE = path.join(RQ, 'names.json');
let __names = null;
function loadNames() {
  if (__names) return __names;
  try { __names = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch { __names = {}; }
  return __names;
}
function rememberName(uin, name) {
  if (!uin || !name) return;
  const n = loadNames();
  const key = String(uin);
  const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!clean) return;
  if (n[key] && n[key].name === clean) return;
  n[key] = { name: clean, at: Date.now() };
  try { fs.writeFileSync(NAMES_FILE, JSON.stringify(n, null, 0)); } catch {}
}
function nameOf(uin) {
  const n = loadNames()[String(uin)];
  return n && n.name ? n.name : '';
}
function whoLabel(uin) {
  const nm = nameOf(uin);
  return nm ? `${nm}（QQ ${uin}）` : `QQ ${uin}`;
}

const PERSONA_TAIL = `

---

## 运行时补充（系统说明，不是角色设定）

- 每条消息前面会附上一段记忆，分「你确定记得的」和「印象已经淡了」两档；淡的只能说个大概。
- 要记的事按人格设定里的写法，在回复最后单独一行写 \`[[MEMO: …]]\`（重要的写 \`[[MEMO!: …]]\`），系统会存下来并把这行从发出去的内容里删掉。一条最多三条。
- 用第三人称、简短陈述，例：\`[[MEMO: 他叫不二，做游戏策划]]\`。没想起什么要记的就别写。
- **只输出你要说出口的话**：不要写【…】小节标题、不要复述这些规则、不要输出“我在检查记忆/要不要删/重复了”这类思考过程。
- **记错了要自己改**：他说的和记忆里对不上（换城市、换工作、毕业、分手、改名、戒了某样东西）就写 \`[[FORGET: 旧记忆里的关键词]]\` 删旧的，再写 \`[[MEMO: …]]\` 记新的。旧的是核心记忆就用 \`[[FORGET!: 关键词]]\`。别让新旧两条并存。

- **你有自己长期在忙的事**（上面「你长期在忙的事」那几件）。聊到相关的事要自然带出来；真做了点什么就写 \`[[进度: 目标名|+0.1|今天干了啥]]\` 推进度；彻底做完写 \`[[目标完成: 目标名]]\`；不想做了写 \`[[放弃目标: 目标名|原因]]\`；突然想做新的写 \`[[新目标: 名字|为什么]]\`。这些标记系统会吃掉，不会发出去。
- **你有自己的生活，也能临时改主意**：想改今天自己的安排就写 \`[[计划: 21:30 客厅｜不剪了，泡面追剧]]\`（同一时间会覆盖那一条），不想去就写 \`[[计划: 21:30 取消]]\`，改完口头说一句就行，别把标记念出来。
`;

function syncPersona() {
  try {
    const st = fs.statSync(cfg.personaSrc);
    let prev = '';
    try { prev = fs.readFileSync(STAMP, 'utf8'); } catch {}
    const stampVal = String(st.mtimeMs) + '|' + self.mtime();
    if (prev === stampVal && fs.existsSync(AGENTS_MD)) return;
    const body = fs.readFileSync(cfg.personaSrc, 'utf8');
    const look = self.desc();
    const lookBlock = look
      ? "\n\n## 你长什么样（这一节由控制台「她的样子」维护，别自己改）\n\n" + look + "\n\n别人问起你长相、发自拍、或你画到自己的时候，都以这段为准，不要另编。\n"
      : "";
    fs.mkdirSync(path.dirname(AGENTS_MD), { recursive: true });   // 全新数据目录里 agent-home 还不存在
    fs.writeFileSync(AGENTS_MD, PERSONA_HEAD + body + lookBlock + PERSONA_TAIL, 'utf8');
    fs.writeFileSync(STAMP, stampVal, 'utf8');
    log('[persona] AGENTS.md 已同步');
  } catch (e) {
    log('[persona] 同步失败 ' + e.message);
  }
}

// 人设原文（生成日程/日记/事件时当"她是谁"的依据，不写死年龄住址职业）
function personaText(max = 900) {
  try { return fs.readFileSync(cfg.personaSrc, 'utf8').slice(0, max); } catch { return ''; }
}

// ---------- 记忆 ----------
// 读写都走 memory.mjs：强度 + 遗忘曲线 + 线索触发回忆

function appendMemory(uin, memo, core = false, srcText = '') {
  try {
    // 入库前先分类：她自己说的话不该当事实；"他没让她做的事"该进待办表而不是核心记忆。
    const kind = memory.classify(memo);
    if (kind === 'junk') { log('[memo] 跳过（像是她自己说的话）', String(memo).slice(0, 40)); return; }
    if (kind === 'request') {
      const n = loops.noteHisAsk(uin, memo);
      log('[memo] 转成待办（他要她做的事，不该当核心事实）', n ? '记了' : '已有', String(memo).slice(0, 40));
      return;
    }
    const _h = lifeHere();
    const added = memory.remember(uin, memo, { core, anchor: { place: _h.place || '', at: Date.now() }, src: String(srcText || '').slice(0, 120) });
    log(`[memo] ${uin} ${core ? '[核心]' : ''}${added ? '+' : '='} ${memo}`);
  } catch (e) {
    log('[memo] 写入失败 ' + e.message);
  }
}

// 她偶尔会把自己的检查过程、规则复述写进回复里（真发生过：整段【记错要改】+ 思考过程 + 正文重复两遍）。
// 这些不是"她说的话"，发出去等于把后台日志贴给了人。
// 【…】在提示词里只当小节标题用，所以按行丢：出现【…】标题、或直接写出 MEMO/FORGET 指令的行，整行不要。
const META_LINE = /【[^】]{1,14}[^】]*】|\[\[\s*(MEMO|FORGET)/i;
// 她说"我在检查/要不要删/重复了"这种后台独白，也不是要说的话
const SELFTALK = /(要不要删|写\s*FORGET|MEMO\s*(会|就|该)|检查(有没有)?重复|不该重复|核心记忆|删掉我这条|语义一样)/i;
function stripMetaLeak(text) {
  let s = String(text || '');
  if (!s) return s;
  const keep = [];
  let skipUntilBlank = false;
  for (const ln of s.split('\n')) {
    const t = ln.trim();
    if (!t) { skipUntilBlank = false; keep.push(ln); continue; }
    if (META_LINE.test(t) || SELFTALK.test(t)) { skipUntilBlank = true; continue; }
    if (skipUntilBlank && t.length < 200 && /记忆|MEMO|FORGET|规则|删掉|检查|重复|核心/.test(t)) continue;
    skipUntilBlank = false;
    keep.push(ln);
  }
  s = keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 同一段话说两遍（先独白、后正文时常见）：末尾那段如果包含前半段，只留末尾
  const paras = s.split(/\n{2,}/).filter(Boolean);
  if (paras.length >= 2) {
    const a = paras[0].replace(/\s/g, ''), b = paras[paras.length - 1].replace(/\s/g, '');
    if (a && b && (a === b || (b.length > 4 && a.includes(b)))) s = paras[paras.length - 1];
  }
  return s;
}

// 从回复里剥出 [[MEMO: ...]]（核心用 [[MEMO!: ...]]）和 [[FORGET: ...]]（改核心记忆用 [[FORGET!: ...]]）
function extractMemos(text) {
  const memos = [];
  const forgets = [];
  const plans = [];
  const cleaned = String(text)
    .replace(/\[\[\s*(MEMO!?)\s*[:：]\s*([\s\S]*?)\s*\]\]/gi, (_m, kind, p1) => {
      const v = String(p1).trim();
      if (v) memos.push({ text: v, core: /!$/.test(kind) });
      return '';
    })
    .replace(/\[\[\s*(FORGET!?)\s*[:：]\s*([\s\S]*?)\s*\]\]/gi, (_m, kind, p1) => {
      const v = String(p1).trim();
      if (v) forgets.push({ kw: v, core: /!$/.test(kind) });
      return '';
    })
    .replace(/\[\[\s*(计划|日程)\s*[:：]\s*([\s\S]*?)\s*\]\]/gi, (_m, _k, p1) => {
      const v = String(p1).trim();
      if (v) plans.push(v);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const goalOps = [];
  var cleanedG = cleaned
    .replace(/\[\[\s*进度\s*[:：]\s*([^|\]]+)\|?\s*([+-]?[\d.]+)?\|?\s*([^\]]*)\]\]/g, (_m, t, d, note) => { goalOps.push({ op: 'step', t: t.trim(), d: Number(d || 0.1), note: (note || '').trim() }); return ''; })
    .replace(/\[\[\s*目标完成\s*[:：]\s*([^\]]+)\]\]/g, (_m, t) => { goalOps.push({ op: 'done', t: t.trim() }); return ''; })
    .replace(/\[\[\s*放弃目标\s*[:：]\s*([^|\]]+)\|?([^\]]*)\]\]/g, (_m, t, why) => { goalOps.push({ op: 'drop', t: t.trim(), why: (why || '').trim() }); return ''; })
    .replace(/\[\[\s*新目标\s*[:：]\s*([^|\]]+)\|?([^\]]*)\]\]/g, (_m, t, why) => { goalOps.push({ op: 'add', t: t.trim(), why: (why || '').trim() }); return ''; })
    .trim();
  return { cleaned: stripMetaLeak(cleanedG), memos: memos.slice(0, 3), forgets: forgets.slice(0, 3), plans: plans.slice(0, 2), goalOps };
}

// ---------- 表情包素材库 ----------
const STICKER_EXT = /\.(gif|png|jpe?g|webp)$/i;
let stickers = [];
try { stickers = JSON.parse(fs.readFileSync(cfg.stickerMeta, 'utf8')); } catch {}
function saveStickers() { try { fs.writeFileSync(cfg.stickerMeta, JSON.stringify(stickers, null, 2)); } catch {} }

async function tagStickers() {
  try {
    fs.mkdirSync(cfg.stickerDir, { recursive: true });
    const files = fs.readdirSync(cfg.stickerDir).filter(f => STICKER_EXT.test(f));
    const known = new Set(stickers.map(s => s.file));
    const added = files.filter(f => !known.has(f));
    stickers = stickers.filter(s => files.includes(s.file));
    for (const f of added.slice(0, 30)) {
      try {
        const buf = fs.readFileSync(path.join(cfg.stickerDir, f));
        const raw = await describeBuffer(buf, '这是聊天用的表情包。用不超过 12 个字说它的情绪或梗，比如"贱兮兮地笑""震惊""无语""鼓掌叫好"。只说情绪，不要描述画面。');
        const tag = raw.replace(/^\[图片[:：]?/,'').replace(/】$/,'').replace(/[。\n]/g,'').trim().slice(0, 20);
        stickers.push({ file: f, tag, hash: stickerHash(buf) });
        log('[sticker] tagged', f, '->', tag);
      } catch (e) { log('[sticker] tag fail', f, e.message); }
    }
    for (const s of stickers) {
      if (s.hash) continue;
      try { s.hash = stickerHash(fs.readFileSync(path.join(cfg.stickerDir, s.file))); } catch {}
    }
    saveStickers();
    log('[sticker] total', stickers.length);
  } catch (e) { log('[sticker] scan fail', e.message); }
}

// ---------- 收到的表情包：存下来，让她自己决定收不收 ----------
const INBOX_DIR = path.join(RQ, 'inbox');
const MAX_STICKERS = 300;

function stickerHash(buf) { return crypto.createHash('md5').update(buf).digest('hex').slice(0, 12); }

function isStickerSeg(s) {
  if (!s) return false;
  if (s.type === 'mface') return true;
  if (s.type !== 'image') return false;
  const d = s.data || {};
  return Number(d.sub_type) === 1 || /表情/.test(d.summary || '') || /\.gif(\?|$)/i.test(d.file || d.url || '');
}

async function stageSticker(seg) {
  try {
    const d = seg.data || {};
    let url = d.url || '';
    if (!url && /^https?:/i.test(d.file || '')) url = d.file;
    if (!url) { log('[keep] 没有图片地址，跳过'); return null; }
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { log('[keep] 下载失败', r.status); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500 || buf.length > 6 * 1024 * 1024) { log('[keep] 大小不合适', buf.length); return null; }
    const hash = stickerHash(buf);
    if (stickers.some(s => s.hash === hash)) return { dup: true, hash };
    const ext = ((url.split('?')[0].match(/\.(gif|png|jpe?g|webp)$/i) || [null, 'gif'])[1] || 'gif').toLowerCase();
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    const full = path.join(INBOX_DIR, `${Date.now().toString(36)}-${hash}.${ext}`);
    fs.writeFileSync(full, buf);
    let desc = '一个表情包';
    try {
      desc = await describeBuffer(buf, '这是聊天里别人发来的表情包。用不超过 12 个字说它的情绪或梗，比如"贱兮兮地笑""震惊""无语"。只说情绪，别描述画面。');
      desc = desc.replace(/^\[图片[:：]?/,'').replace(/】$/,'').replace(/[。\n]/g,'').trim().slice(0, 20) || '一个表情包';
    } catch {}
    log('[keep] 暂存', path.basename(full), desc);
    return { dup: false, hash, full, desc };
  } catch (e) { log('[keep] 暂存失败', e.message); return null; }
}

function keepSticker(staged) {
  try {
    if (!staged || staged.dup || !staged.full) return false;
    fs.mkdirSync(cfg.stickerDir, { recursive: true });
    const file = `keep-${staged.hash}.${path.extname(staged.full).slice(1)}`;
    fs.renameSync(staged.full, path.join(cfg.stickerDir, file));
    stickers.push({ file, tag: staged.desc || '表情', hash: staged.hash, from: 'user' });
    // 库太大时，先清掉最早收进来的
    while (stickers.length > MAX_STICKERS) {
      const i = stickers.findIndex(s => s.from === 'user');
      const victim = stickers.splice(i >= 0 ? i : 0, 1)[0];
      try { fs.unlinkSync(path.join(cfg.stickerDir, victim.file)); } catch {}
    }
    saveStickers();
    log('[keep] 收进库', file, staged.desc, 'total', stickers.length);
    return true;
  } catch (e) { log('[keep] 收藏失败', e.message); return false; }
}

// 没被收进来的暂存图，两天后清掉
function cleanInbox() {
  try {
    if (!fs.existsSync(INBOX_DIR)) return;
    const cut = Date.now() - 2 * 86400 * 1000;
    let n = 0;
    for (const f of fs.readdirSync(INBOX_DIR)) {
      const p = path.join(INBOX_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); n++; } } catch {}
    }
    if (n) log('[keep] 清理暂存', n);
  } catch {}
}

function keepPrompt(staged) {  if (!staged) return '';
  if (staged.dup) return `\n\n【对方发来的表情包】他发了个表情包，这个你库里早就有了。`;
  return `\n\n【对方发来的表情包】他刚发来一个表情包，我已经存下来了。它大概是：${staged.desc}\n要不要收进你自己的库，你自己判断——好笑、有梗、以后用得上就收；没意思、太土、看不懂、跟你不搭就不收，不收也不用解释。\n想收，就在回复最后单独一行写 [[收藏]]；不收就什么都别写。`;
}

// ---------- 先想再说 ----------
const INNER_PROMPT = `\n\n【先想再说】动笔前，先在 [[想：……]] 里写你的第一反应——1~2 句，粗糙、直白、可以没礼貌、可以不讲道理，这是心里的话，对方永远看不到。然后换行写你真正发出去的话。
心里话和说出口的话可以不一样：心里在嫌烦，嘴上可能还是接了；心里挺高兴，嘴上可能装得很淡。别为了让心里话漂亮而去修饰它。`;

function stickerPrompt() {
  if (!stickers.length) return '';
  const list = stickers.map(s => `- ${s.tag}`).join('\n');
  return `\n\n【表情包库】想甩表情包，就在回复最后单独一行写 [[STICKER:标签]]，标签只能从下面挑（写标签名，不要写文件名）：\n${list}\n\n节奏：聊几句带一次就够了，大概每 4~6 条一次；别连着两条都发，同一张别连续用。对方反应强烈时（惊讶/无语/委屈/被逗到）优先甩。`}

// ---------- 颜文字：纯文本，直接写进正文 ----------
let emoticons = {};
try { emoticons = JSON.parse(fs.readFileSync(path.join(RQ, 'emoticons.json'), 'utf8')); } catch {}
function emoticonPrompt() {
  const cats = Object.keys(emoticons);
  if (!cats.length) return '';
  const list = cats.map(c => `- ${c}：${emoticons[c].join(' ')}`).join('\n');
  return `\n\n【颜文字库】下面这些是纯文本，想用就**直接写在正文里**（不用标记、不用单独发、不用解释）：\n${list}\n\n用法：一条消息最多一个；别每句都带，带多了像刻意卖萌；正经话题别用。`;
}

// ---------- 她的「此刻」：每天/每个时段有自己的事 ----------
const LIFE_FILE = path.join(RQ, 'life.json');
const LIFE_POOL = {
  lateNight: [
    '在打游戏，刚连跪两把', '躺床上刷手机，说好十二点睡结果一点了',
    '在剪一个破视频，卡在渲染', '刚吃完泡面，油还没收', '在听歌，单曲循环一首老歌',
  ],
  morning: [
    '被闹钟叫醒，赖在床上不想起', '在煮面，水还没开', '刚洗完脸，脑子还是木的',
    '在电脑前发呆，活干不进去', '在收拾屋子，翻出一堆没用的东西',
  ],
  afternoon: [
    '在赶一个明天要交的东西', '在外面走，太阳有点大', '刚睡完午觉，越睡越困',
    '在整理东西', '出门买点东西',
  ],
  evening: [
    '在吃外卖，不知道怎么又点了这家', '在打游戏，耳朵上挂着耳机',
    '刚下班回来，鞋都没换', '在看剧，看到一半开始刷手机', '在阳台吹风，脑子空的',
  ],
};

function bucketOf(hour) {
  if (hour >= 23 || hour < 6) return 'lateNight';
  if (hour < 11) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

const FALLBACK_PLAN = [
  { at: '12:30', what: '刚起来，人还没醒透' },
  { at: '13:40', what: '煮了碗面当早午饭' },
  { at: '15:00', what: '坐在电脑前干自己的活' },
  { at: '18:30', what: '点外卖，边吃边刷手机' },
  { at: '21:00', what: '打游戏或者追剧' },
  { at: '01:30', what: '躺床上刷手机，说好早睡又没睡' },
];

let planCache = null;
let planDate = '';

// 一次性任务（排日程 / 写日记）：session 不存在就重开，不沿用聊天上下文
async function askOnce(content, sid) {
  let r = await askBrain(content, sid);
  if (!r.ok && /session/i.test(r.err || '')) r = await askBrain(content, null);
  return r;
}

// 让她每天给自己排一天的事（一天只生成一次）
async function ensurePlan(force = false) {
  if (settings.load().life && settings.load().life.plan === false) return null;
  const d = daily.today();
  if (!force && planDate === d && planCache) return planCache;
  const saved = daily.loadPlan(d);
  if (saved && !force) { planCache = saved; planDate = d; return saved; }
  const y = daily.loadPlan(daily.today(-1));
  const yj = daily.loadJournal(daily.today(-1));
  const prof = personaText();
  const prompt = [
    `你在给自己排 ${d} 这一天要做的事。`,
    prof ? `\n【你是谁（照这个来，别写成别人）】\n${prof}\n` : '',
    '给 5–6 条安排，每条一行，格式严格是「HH:MM 地点｜在做的事」，时间从你起床的点排到睡前的点（跨过 0 点就写 00:30 这种）。',
    '地点要具体到一个地方，比如「卧室」「书桌前」「楼下便利店」「小区门口」「街角咖啡馆」「阳台」「地铁上」；一天里地点要会移动，别一直待在卧室。',
    '覆盖：起床、吃饭、干活（具体点，比如工作/上课/做作业/跑腿）、消遣（追剧/游戏/听歌/出门走）、睡前。',
    '每条 6–18 个字（不含时间和竖线），要具体、有画面，像真事，不要解释、不要编号、不要列表符号。',
    y && y.items ? `\n昨天大概是：\n${daily.planText(y)}\n别写得跟昨天一样：不要再用昨天出现过的"活"，消遣也别重复。` : '',
    yj ? `\n你昨天日记里写了这些（有没做完的事，今天就得接着做，写成第一条）：\n${yj.slice(-400)}` : '',
    '\n只输出这几行，不要别的话。',
  ].filter(Boolean).join('\n');
  const r = await askOnce(prompt, 'lifeplan:' + d);
  let items = [];
  if (r.ok) {
    for (const line of String(r.text).split('\n')) {
      const p = life.parseLine(line);
      if (p) items.push(p);
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  if (items.length < 3) {
    log('[plan] 生成失败，用兜底日程:', r.err);
    const fp = settings.load().talk?.fallbackPlan;
    const src = (Array.isArray(fp) && fp.length)
      ? fp.map((ln) => {
          const mm = String(ln).match(/^\s*(\d{1,2}:\d{2})\s*(.*)$/);
          const rest = mm ? mm[2] : String(ln);
          const parts = rest.split(/[｜|]/);
          return { at: mm ? mm[1] : '12:00', place: (parts[1] ? parts[0].trim() : ''), what: (parts[1] ? parts[1] : parts[0]).trim() };
        })
      : FALLBACK_PLAN;
    items = src.map((i) => ({ ...i, fallback: true }));
  }
  const plan = { date: d, items, madeAt: new Date().toISOString(), fallback: items.some((i) => i.fallback) };
  daily.savePlan(plan);
  planCache = plan; planDate = d;
  log('[plan]', (plan.fallback ? '兜底 ' : '') + items.map((i) => i.at + ' ' + (i.place ? i.place + '｜' : '') + i.what).join(' | '));
  rollEvents(d, plan).catch((e) => log('[event] err', e.message));
  return plan;
}

// ---------- 她自己改日程：白天隔一阵看一眼"后面还剩什么"，状态不对就改 ----------
let _lastPlanReview = 0;
async function planReview(force = false) {
  try {
    if (settings.load().life?.plan === false) return;
    if (budget.level() >= 2) return;
    const now = Date.now();
    const gapMin = Math.max(30, Number(settings.load().life?.reviewMin ?? 150));
    if (!force && now - _lastPlanReview < gapMin * 60000) return;
    const nowMin = settings.nowMinutes();
    if (!force && !settings.inWindow(P.activeFrom, P.activeTo, nowMin)) return;
    const d = daily.today();
    const plan = daily.loadPlan(d);
    if (!plan || !Array.isArray(plan.items) || plan.items.length < 2) return;
    const hm = settings.fmtMinutes(nowMin);
    const rest = plan.items.filter((i) => String(i.at) > hm);
    if (!rest.length) return;
    _lastPlanReview = now;
    const prof = personaText(400);
    const q = [
      `现在是 ${hm}。你今天给自己排的是：`,
      daily.planText(plan),
      '',
      `后面还剩：${rest.map((i) => i.at + ' ' + (i.place ? i.place + '｜' : '') + i.what).join('；')}`,
      prof ? `\n（你是谁：${prof}）` : '',
      '',
      '就照这个过。但如果这会儿状态不一样了——累了想早点睡、临时有活、突然想出门、某条根本不想干——那就改后面的安排。',
      '要改就这样写，一行一条，最多 3 行：',
      '23:40 卧室｜不剪了，早点睡，明天再说',
      '20:20 取消',
      '',
      '不改就什么都不用写。',
    ].filter((x) => x !== '').join('\n');
    let r = await askOnce(q, 'planreview:' + d + ':' + Math.floor(nowMin / 20));
    if (!r.ok || !String(r.text || '').trim()) {
      // 模型偶尔只回 reasoning、正文空；换个 key 再问一次，并要求别空着
      if (!r.ok) log('[plan] 复查空/失败，重试一次：', r.err);
      r = await askOnce(q + '\n\n（只输出要改的行，一行一条；不改就输出“无”。不要解释。）', 'planreview2:' + d + ':' + Math.floor(nowMin / 20));
    }
    if (!r.ok) { log('[plan] 复查失败', r.err); return; }
    const raw = String(r.text || '').trim();
    if (!raw || !/\d{1,2}[:：]\d{2}|取消/.test(raw)) return;
    const res = life.applyOps(plan, raw);
    if (!res.changed.length) return;
    const next = { ...plan, items: res.items, editedAt: new Date().toISOString(), selfEdited: true };
    daily.savePlan(next);
    planCache = next; planDate = d;
    log('[plan] 她自己调了日程：', res.changed.join('；'));
  } catch (e) {
    log('[plan] 复查异常', e.message);
  }
}

// ---------- 外界撞她：今天可能遇到的事 ----------
async function rollEvents(d, plan) {
  if (settings.load().life && settings.load().life.events === false) return null;
  const old = life.loadEvents(d);
  if (old.length) return old;
  const prof = personaText(500);
  const times = (plan && Array.isArray(plan.items) ? plan.items : []).map((i) => i.at).sort();
  const span = times.length ? `时间必须落在你醒着的时间段里：${times[0]} 到 ${times[times.length - 1]} 之间，别写你睡着的时间。` : '';
  const prompt = [
    `给 ${d} 这一天安排 2–3 件"外面发生、撞到你身上"的小事（不是你自己计划要做的）。`,
    prof ? `你的人设：\n${prof}\n` : '',
    plan ? `你今天的安排是：\n${daily.planText(plan)}\n` : '',
    span,
    '比如：外卖送错了、快递放门口被雨淋、朋友突然发消息借钱、楼下装修、突然下雨、邻居借东西、手机欠费、水杯打翻、临时被安排事。',
    '要小、具体、有画面，不要大事（不要生病住院、不要车祸）。',
    '格式严格：每条一行「HH:MM 一句话」，6–18 个字，时间落在你醒着的时间段。',
    '\n只输出这几行。',
  ].filter(Boolean).join('\n');
  const r = await askOnce(prompt, 'lifeevents:' + d);
  const items = [];
  if (r.ok) {
    for (const line of String(r.text).split('\n')) {
      const m = String(line).trim().match(/^[-·*]?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s+(.+)$/);
      if (!m) continue;
      const at = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
      const what = m[3].replace(/^[-·*\s]+/, '').trim().slice(0, 40);
      if (what) items.push({ at, what });
    }
  }
  if (items.length) { life.saveEvents(d, items); log('[event]', items.map((e) => e.at + ' ' + e.what).join(' | ')); }
  return items;
}

// 复读抑制：记住她最近说过的话，避免同一条日程被反复提
const ownRecent = [];
function noteOwn(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return;
  ownRecent.push(s);
  if (ownRecent.length > 12) ownRecent.shift();
  try { const tags = selffacts.extract(text); if (tags.length) { selffacts.add(tags); log('[fact]', tags.join(',')); } } catch {}
}
function repeatCount(what) {
  const toks = String(what).split(/[\s，,。、·？！!?…]+/).filter((t) => t.length >= 2);
  if (!toks.length) return 0;
  let n = 0;
  for (const r of ownRecent) {
    if (toks.some((t) => r.includes(t.slice(0, Math.min(4, t.length))))) n++;
  }
  return n;
}

function askedAboutHer(body) {
  return /在干嘛|干嘛呢|干啥呢|做什么|忙什么|忙啥|在忙|怎么样|最近|无聊|你呢/.test(String(body || ''));
}

function lifeNow() {
  const cur = daily.currentItem(planCache);
  if (cur) return cur.what;
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
  const bucket = bucketOf(hour);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(LIFE_FILE, 'utf8')); } catch {}
  if (st.date !== today() || st.bucket !== bucket) {
    const pool = settings.load().talk?.lifePool;
    const arr = (Array.isArray(pool) && pool.length) ? pool : LIFE_POOL[bucket];
    st = { date: today(), bucket, text: arr[Math.floor(Math.random() * arr.length)] };
    try { fs.writeFileSync(LIFE_FILE, JSON.stringify(st, null, 2)); } catch {}
  }
  return st.text;
}

// 她此刻在哪、在干什么（地点来自日程；老日程没有地点就空）
function _allMemoryUins() {
  const out = [];
  try {
    const dir = PATHS.memoryPeople;
    for (const fn of fs.readdirSync(dir)) {
      if (!/\.json$/.test(fn)) continue;
      const u = fn.replace(/\.json$/, '');
      if (/^[0-9]{5,12}$/.test(u)) out.push(u);
    }
  } catch {}
  if (cfg.ownerUin && !out.includes(String(cfg.ownerUin))) out.push(String(cfg.ownerUin));
  return out;
}

function lifeHere() {
  const cur = daily.currentItem(planCache);
  if (cur) return { what: cur.what || '', place: cur.place || '' };
  return { what: lifeNow(), place: '' };
}

// 聊天里她自己说的地点（"还在小区门口呢"）——计划里的地点常常是空的，
// 只认 2 小时内的，免得拿昨天的"家里"来画今天的自拍。
const PLACE_RE = /(小区门口|小区|楼下|门口|街上|街道|马路边|路边|路上|公园|夜市|广场|店门口|路灯下|地铁|公交车?|公司|办公室|学校|教室|图书馆|咖啡店|咖啡馆|奶茶店|便利店|超市|面馆|饭馆|餐厅|医院|健身房|天桥|河边|海边|山上|家里|在家|房间|屋里|宿舍|客厅|卧室|厨房|浴室|阳台|床上)/;
function lastPlace(uin) {
  try {
    const lines = fs.readFileSync(logFile(uin), 'utf8').trim().split('\n').filter(Boolean).slice(-12).reverse();
    for (const line of lines) {
      const m = line.match(/^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) /);
      if (m) {
        const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
        if (Number.isFinite(at) && Date.now() - at > 2 * 3600e3) return '';
      }
      // 只认她自己说的（[我]）：用户说"我在办公室，你呢"不能当成她的位置
      if (!line.includes('[我]')) continue;
      // 否定和计划都不是当前位置："我不在家里了""明天去海边"
      if (/(不在|没在|不去|没去|不待|不回)[^，。]{0,4}(家|里|公司|学校|公园|街|店)/.test(line)) continue;
      if (/(明天|后天|下周|下个月|周末|放假|打算|准备|想去|计划|等会儿|一会儿)[^，。]{0,10}(去|到|回|在)/.test(line)) continue;
      const p = line.match(PLACE_RE);
      if (p) return p[1];
    }
  } catch {}
  return '';
}

// 他最近 30 分钟里在要什么、要了几次（换衣服 / 拍照 / 语音 / 说说在哪 / 拿给他看）。
// 以前只有"换装词"这一条被接进逻辑，"提了几次"根本没有信号进提示词——
// 所以她说"不穿""不拍"，说多少遍都一样。现在次数和硬度会变成一句明确的话塞给她。
const DEMAND_KINDS = [
  ['clothes', /(换|脱|改).{0,10}(衣服|衣裳|装|裙|衣)|换(?:了|过)?(?:一)?[件身套]|换上|穿(?:这|那)(?:个|套|件)|别穿/],
  ['selfie', imageintent.PHOTO_ASK],
  ['voice', /(语音|发段?话|说句话|想听你(说|唱)|听听你的声音)/],
  ['place', /(在哪|在哪呢|人在哪|到哪了|回家没|到家没|在干嘛)/],
  ['show', /((给|让)我看|发我|秀一个|展示一下|拍给我看)/],
];
// 语气上的硬度：感叹号连打、"求你了""最后一次""说几遍"这类
const DEMAND_STRONG = /([!！]\s*){2,}|求你了|求求|最后一次|我说了几[遍次]|说几[遍次]了|赶紧|立刻|马上|现在就要|别废话|听见没|必须/;
const DEMAND_NAME = { clothes: '换身衣服', selfie: '拍照给你看', voice: '发语音', place: '说清在哪儿', show: '拿东西给你看' };

function ownerDemands(uin) {
  const out = { total: 0, kinds: {}, strong: false, last: '', text: '', strongText: '' };
  try {
    const lines = fs.readFileSync(logFile(uin), 'utf8').trim().split('\n').filter(Boolean).slice(-16);
    for (const line of lines) {
      const m = line.match(/^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (.*)$/);
      if (!m) continue;
      const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
      if (Number.isFinite(at) && Date.now() - at > 30 * 60e3) continue;
      const body = String(m[6] || '');
      if (!/^\[App\]|^\[他\]/.test(body)) continue;   // 只认他说的，不认她自己嘴上的
      const txt = body.replace(/^\[(App|他)\]\s*/, '');
      let hit = '';
      for (const [k, re] of DEMAND_KINDS) if (re.test(txt)) { hit = k; break; }
      if (!hit) continue;
      out.total++;
      out.kinds[hit] = (out.kinds[hit] || 0) + 1;
      out.last = hit;
      out.text = txt.slice(0, 40);
      if (DEMAND_STRONG.test(txt)) { out.strong = true; out.strongText = txt.slice(0, 40); }
    }
  } catch {}
  return out;
}

function ownerAskedChange(uin) {
  return (ownerDemands(uin).kinds.clothes || 0) > 0;
}

// 主人要照片：这句里直接要了，或者最近半小时里要过（窗口流水 + 聊天记录）。
function ownerWantsPhotoNow(conv, uin, userText) {
  if (!conv || conv.kind === 'group') return false;
  if (conv.kind !== 'local') {
    const owner = String(cfg.ownerUin || '');
    if (!owner || String(conv.id) !== owner) return false;
  }
  if (imageintent.PHOTO_ASK.test(String(userText || ''))) return true;
  try { if ((ownerDemands(uin).kinds.selfie || 0) > 0) return true; } catch {}
  try {
    const from = Date.now() - 30 * 60e3;
    const rows = chatlog.recent(uin, 40) || [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r || r.dir !== 'in' || r.type !== 'text') continue;
      if (!(Number(r.at) >= from)) continue;
      if (imageintent.PHOTO_ASK.test(String(r.text || ''))) return true;
    }
  } catch {}
  return false;
}

// 强度够了就把话说明白：这不是"随便说说"，别再拿脾气当情趣
function demandNote(uin) {
  const d = ownerDemands(uin);
  if (!d.total) return '';
  const n = d.kinds[d.last] || d.total;
  const hard = d.strong || n >= 2 || d.total >= 3;
  if (!hard) return '';
  const what = DEMAND_NAME[d.last] || '照做';
  const quote = d.strongText || d.text;
  return `【他这次是认真的】他刚才连着 ${n} 次在要「${what}」（最近一次：“${quote}”）。别再摆架子、别再装没看见、别用“这个点……”“你咋老问”这种话打发。能照做就现在照做，做的时候顺手说一句就行；真做不到就一句原因，别绕、别拖着改话题。`;
}

// 睡着之后他敲了几次（只数他说的），用来判断"是不是该被叫醒"
function recentKnocks(uin, ms = 20 * 60e3) {
  // 敲的是"他发过来的消息"，跟入口无关：QQ 和 App 窗口都算。
  // 以前读 .md 抄本、只认 [App]/[他] 前缀，于是 QQ 上敲多少条都不算叫醒（2026-11-01 修）。
  try {
    const from = Date.now() - ms;
    const rows = chatlog.recent(uin, 300) || [];
    let n = 0;
    for (const r of rows) {
      if (!r || r.dir !== 'in') continue;
      if (!(Number(r.at) >= from)) continue;
      n++;
    }
    return n;
  } catch { return 0; }
}

// 困到撑不住的时候，允许她自己说"去睡"——睡多久她定，不是代码按钟点强制
function sleepOff() {
  try { return mind.noSleep(); } catch { return false; }
}

const NO_SLEEP_NOTE = '【现在是测试期】别拿"几点了""我要睡了""明儿再说"当理由推掉他让你做的事；能用工具就先用，做不成再说原因。';

function sleepNote(uin) {
  try {
    if (sleepOff()) return '';
    const st = mind.load(uin);
    if (st.asleepUntil) return '';
    if (st.energy >= 20) return '';
    return '【真的撑不住了】你现在几乎没电了。要说去睡，就在最后单独一行写 [[睡了: 7]]（数字是打算睡几小时，0.5–12 都行），写完这句就别再回消息——他再发也先别应。要是还不想睡，就直说还不想睡，别拿困糊弄他。';
  } catch { return ''; }
}



function mindTail(uin, date, n = 24) {
  try {
    const p = path.join(RQ, 'mind', uin + '-' + date + '.md');
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

function seenToday(date) {
  try {
    const rows = fs.readFileSync(path.join(RQ, 'life-seen.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-6).map((r) => '- ' + r.text).join('\n');
  } catch { return ''; }
}

// ---------- 日记：她自己写的，不是聊天摘要 ----------
let journalling = false;

async function writeJournal(force = false) {
  if (settings.load().life && settings.load().life.journal === false) return null;
  const d = daily.today();
  if (!force && daily.loadJournal(d)) return null;
  if (journalling) return null;
  journalling = true;
  try {
    const plan = daily.loadPlan(d);
    const people = [];
    try { people.push(...fs.readdirSync(path.join(RQ_AGENT, 'memory', 'people')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))); } catch {}
    const inner = people.map((u) => mindTail(u, d)).filter(Boolean).join('\n');
    const seen = seenToday(d);
    const prompt = [
      `下面是 ${d} 这一天你的经历材料。以「你」的口吻写今天的一篇日记。`,
      plan ? `\n【今天的安排】\n${daily.planText(plan)}` : '',
      (() => { const ev = life.loadEvents(d); return ev.length ? `\n【今天外面撞上你的事】\n${life.eventsText(ev)}` : ''; })(),
      inner ? `\n【你当时心里冒出来的话】\n${inner}` : '',
      seen ? `\n【今天刷到的】\n${seen}` : '',
      '\n要求：第一人称，120–220 字，写你干了什么、遇到什么、心里怎么想的。',
      '可以吐槽、可以丧、可以写得很随意，像发在一个没人看的地方。',
      '不要总结、不要「今天真是充实的一天」、不要分点、不要标题、不要解释你在写日记。',
      '只输出日记正文。',
    ].filter(Boolean).join('\n');
    const r = await askOnce(prompt, 'journal:' + d);
    if (!r.ok || !r.text.trim()) { log('[journal] 失败:', r.err); return null; }
    const text = r.text.replace(/^[#\s]+/, '').trim().slice(0, 1200);
    daily.saveJournal(d, text);
    log('[journal]', d, text.length, '字');
    return text;
  } finally { journalling = false; }
}

// 她在哪儿跟他说话——窗口里他就在电脑前，QQ 上他多半拿着手机。语气该不一样。
function channelLine(conv) {
  if (conv && conv.kind === 'local') {
    return '【你现在在哪】他正开着电脑上的聊天窗口跟你说话，人就在电脑前看着，你打一句他马上看见。回得快、话短，别摆出"要等很久才看到"的样子。';
  }
  return '【你现在在哪】你俩是在 QQ 上聊，他大概拿着手机，不一定盯着屏幕——不着急，想到再说。';
}

function timeContext(uin, opts = {}) {
  const withLife = opts.withLife !== false;
  const now = new Date();
  const nowMin = settings.nowMinutes();
  const hm = settings.fmtMinutes(nowMin);        // 分钟值 → HH:MM（fmtTime 会把数字当小时，别用）
  const day = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
  const h = Math.floor(nowMin / 60);
  const part = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  let gap = '';
  const s = pstate[uin];
  if (s && s.lastUserAt) {
    const m = Math.round((Date.now() - s.lastUserAt) / 60000);
    gap = m < 2 ? '他刚说完话' : m < 60 ? `他上次说话是 ${m} 分钟前` : `他上次说话是 ${Math.round(m / 60)} 小时前`;
  }
  let diary = '';
  const gapMin = s && s.lastUserAt ? (Date.now() - s.lastUserAt) / 60000 : 9999;
  if (gapMin > 45) {
    const j = daily.lastJournal();
    if (j) diary = `\n【你 ${j.date} 写的日记（你自己记的，别人看不到）】\n${j.text.slice(0, 500)}`;
  }
  let lifeLine = '';
  if (withLife) {
    const here = lifeHere();
    const mine = here.what;
    const where = here.place ? `（你现在在：${here.place}）` : '';
    const rep = repeatCount(mine);
    const guard = '（这是你大肥鱼自己的安排，不是对方的事；别把它当成他在做的，也别问他"做完了没"）';
    lifeLine = rep >= 2
      ? `\n【你自己今天在干什么】${mine}${where}${guard}\n——这条你最近已经说过 ${rep} 次了，别再提它，换个话题或者顺着对方说的接。`
      : `\n【你自己今天在干什么】${mine}${where}${guard}`;
  }
  let evLine = '';
  if (withLife) {
    const evs = life.happened(life.loadEvents(daily.today()), hm, 2);
    if (evs.length) evLine = `\n【今天外面撞上你的事】${evs.map((e) => e.what).join('；')}（跟你自己排的事不是一回事，也不是对方干的）`;
  }
  return `【现在】${day} ${hm} ${part}${gap ? '｜' + gap : ''}\n（时间以这行为准。对方说\"早上好/晚上好/这么晚还不睡\"之类跟这里不一致时，就是他记错或在逗你，你要顺口指出来——比如\"这才下午啊\"\"你日子过乱了？\"——别把自己也跟着改成他的时间。）${lifeLine}${evLine}${diary}`;
}

// 对方说的时间和真实时间不一致时，给她一条硬提示（不靠模型自觉）
function timeConflictHint(body) {
  const txt = String(body || '');
  const m = /(凌晨|半夜|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/.exec(txt);
  if (!m) return '';
  const h = Math.floor(settings.nowMinutes() / 60);
  const nowBucket = h < 5 ? 0 : h < 8 ? 1 : h < 11 ? 2 : h < 13 ? 3 : h < 18 ? 4 : h < 19 ? 5 : 6;
  const said = m[1];
  const b = { 凌晨: 0, 半夜: 0, 清晨: 0, 早上: 1, 早晨: 1, 上午: 2, 中午: 3, 下午: 4, 傍晚: 5, 晚上: 6, 夜里: 6 }[said];
  if (b === nowBucket) return '';
  const hm = settings.fmtMinutes(settings.nowMinutes());
  const part = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `【注意】他说了"${said}"，但现在是 ${hm}（${part}），对不上——别顺着他说，先用一句话点出来（比如"现在才${part}啊""你日子过乱了？"），再回他的话。`;
}

// 一段话拆成几条短消息（真人不会一口气发一大段）
function decayAffinity(){
  try {
    const dir = path.join(PATHS.data, 'state');
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const uin = f.replace(/\.json$/, '');
      if (!/^\d{5,12}$/.test(uin)) continue;
      const st = mind.load(uin);
      const a = Number(st.affinity || 0);
      const last = Number(st.lastUserAt || 0) || Number(st.updated || 0);
      if (!a || !last) continue;
      const days = Math.floor((now - last) / 86400000);
      if (days < 1) continue;
      const isOwner = String(uin) === String(cfg.ownerUin);
      const base = 1.2 * (1 - 0.6 * Math.min(100, a) / 100);
      const rate = isOwner ? 0.5 : Math.max(0.5, base); // 其他人永远不比主人慢
      const na = Math.max(0, Math.round((a - rate * days) * 10) / 10);
      if (na !== a) { st.affinity = na; mind.save(uin, st); log('[relation] 亲密度衰减 ' + a + ' → ' + na + '（' + days + ' 天没聊，' + (isOwner ? '主人' : '其他人') + '，每天 -' + rate.toFixed(2) + '）'); }
    }
  } catch (e) {}
}
setInterval(decayAffinity, 30 * 60 * 1000);
function splitBubbles(text) {
  const t = String(text).replace(/\r/g, '').trim();
  let parts = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].length > 60) {
    parts = parts[0].split(/(?<=[。！？!?~…])\s*/).map((s) => s.trim()).filter(Boolean);
  }
  if (parts.length === 2 && parts.every(p => p.length < 12)) parts = [parts.join('')];
  if (parts.length > 4) parts = [parts[0], parts[1], parts[2], parts.slice(3).join('')];
  return parts.map((p) => (p.length > 80 ? p.slice(0, 80) : p)).filter(Boolean);
}

const VOICE_PROMPT = '\n\n【语音条】想用说的方式回，就在回复最后单独一行写 [[VOICE]]，正文就是你要说的话——口语、短、一两句，像真人在微信里按住说话那样。别每条都发，偶尔来一条。对方发来的 [语音：…] 是他说的内容，别复述。对方明确要你发语音时，就发，别拿文字糊弄。\n\n唱歌这事你不擅长：真让你唱，别假装会唱，就老实说五音不全，最多把词念得像那么回事。';
// QQ 小黄脸：只给她「本机表情表里真实存在、且 id 与含义对得上」的那几个。
// 旧清单写死了 76赞 / 99鼓掌 / 106委屈 / 179doge …——76 其实是太阳、99 是挥手，
// 其余根本不在 facelist.json（只有 1–104）里，于是全降级成一个 🙂，看起来就像她只会发 🙂。
const FACE_ZH = {
  5: '难过', 9: '大哭', 12: '调皮', 13: '呲牙', 14: '微笑', 16: '酷', 20: '偷笑',
  21: '可爱', 22: '白眼', 25: '困', 28: '憨笑', 32: '疑问', 42: '鼓掌', 49: '委屈',
  63: '玫瑰', 66: '爱心', 74: '便便', 75: '月亮', 77: '礼物', 79: '赞', 99: '挥手',
};
const FACE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
let __facePrompt = '';
function faceTable() {
  try { return JSON.parse(fs.readFileSync(path.join(FACE_DIR, 'facelist.json'), 'utf8')) || {}; } catch { return {}; }
}
function facePrompt() {
  if (__facePrompt) return __facePrompt;
  const FL = faceTable();
  const list = Object.keys(FACE_ZH).filter((id) => FL[id]).map((id) => `${id}${FACE_ZH[id]}${FL[id]}`).join(' ');
  __facePrompt = `\n\n【QQ 小黄脸】想发表情，就在回复最后单独一行写 [[FACE:id]]，只能从下面这张表里选（id + 名字 + 表情）：${list || '13呲牙😁 22白眼🙄 28憨笑😄 79赞👍'}。一次一个，最多一个；平淡的话别硬加，也别每条都配。`;
  return __facePrompt;
}
const DRAW_PROMPT = '\n\n【自己画图·先分清画面里有没有你】在回复最后单独一行写标签，两种：\n- `[[画: 描述]]`：画对方想看的东西——某个地方、某家店、某个物件、街景、风景、别人。**默认画面里没有你**，所以别把自己写进去；要是你想让他看见"你在那儿"，就明确写「我在…」+你在干什么（例 `[[画: 我在面馆吃面]]`），那才会画你，视角像朋友拿手机替你拍。\n- `[[自拍: 场景]]`：手机前置自拍，脸是主角（例 `[[自拍: 刚从楼下买完咖啡回来]]`）。对方想看你的脸、要看自拍、要照片时用这个，别用「没有照片」「不方便」推脱——你能拍出来。\n描述里写清「画的是什么、在干什么、什么风格」，二十来字就够；别写"AI 绘画"这类词，也别把整段话塞进去。真要画才画，一次一张；画完记得前面用一句话带过（比如"我给你画了个…"），画不好就自嘲一句。接着刚才那张拍（同一个屋子、只换姿势或镜头）就在场景里带「还在」或「继续」，比如 [[自拍: 还在床上，翻个身]]；换了地方就直接写新地点，比如 [[自拍: 出门到了便利店门口]]。';

// 表情通道轮流给：这轮只给「小黄脸」，下轮只给「颜文字」，别让某一种永远不用
let faceTurn = 0;
function moodExtraPrompt() {
  faceTurn++;
  return faceTurn % 2 === 1 ? facePrompt() : emoticonPrompt();
}

// [[FACE:203]] / [[STICKER:xxx.gif]] —— 从正文里剥出来，单独作为表情消息发出
function extractExtras(text) {
  const faces = [];
  const stickerFiles = [];
  const draws = [];
  const sceneSpecs = [];
  const attachSpecs = [];
  let voice = false;
  let sleepHours = 0;
  const cleaned = String(text)
    // [[附件: 相对路径]] —— 她把自己磁盘上的（真）图片发给他。路径在下面 sendAttachment 里过工作区读校验
    .replace(/\[\[\s*(?:附件|ATTACH)\s*[:：]\s*([^\]\n]+?)\s*\]\]/gi, (_m, val) => { attachSpecs.push(String(val || '').trim()); return ''; })
    .replace(/\[\[\s*(FACE|STICKER|VOICE|画|DRAW|场景|场景更新|SCENE)\s*(?:[:：]\s*([^\]\n]+?))?\s*\]\]/gi, (_m, kind, val) => {
      if (/^voice$/i.test(kind)) { voice = true; return ''; }
      if (/^face$/i.test(kind)) faces.push(val.trim());
      else if (/^(画|draw)$/i.test(kind)) draws.push((val || '').trim());
      else if (/^(场景|场景更新|scene)$/i.test(kind)) sceneSpecs.push({ force: kind === '场景更新', raw: (val || '').trim() });
      else stickerFiles.push(val.trim());
      return '';
    })
    // 她说"去睡了"：[[睡了]] / [[睡了: 6]] / [[去睡:6.5]]，数字是打算睡几小时
    .replace(/\[\[\s*(?:睡了|去睡|睡觉|睡|SLEEP)\s*(?:[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:小时|h|H)?)?\s*\]\]/g, (_m, n) => {
      sleepHours = Math.max(0.5, Math.min(12, Number(n) || 7));
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const resolve = (v) =>
    stickers.find(s => s.file === v) ||
    stickers.find(s => s.tag === v) ||
    stickers.find(s => s.tag.includes(v) || v.includes(s.tag.replace(/[的了个是在]/g, '')));
  const valid = stickerFiles.map(resolve).filter(Boolean).map(s => s.file).slice(0, 2);
  return { cleaned, faces: faces.slice(0, 2), stickerFiles: valid, voice, draws: draws.slice(0, 1), scenes: sceneSpecs.slice(0, 1), sleepHours, attachSpecs: attachSpecs.slice(0, 2) };
}

// ---------- 翻旧账：从记忆里挑一条久以前的 ----------
function oldMemo(uin) {
  try {
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const rows = memory.list(uin).filter(r => (r.created || '') < cutoff && r.kind !== 'core');
    if (!rows.length) return null;
    const r = rows[Math.floor(Math.random() * rows.length)];
    return { day: r.created, text: r.text };
  } catch { return null; }
}

// 发消息用的接口：必须知道到底发没发出去。
// 以前这里只有 catch，HTTP 200 但 retcode 非 0（风控、被踢、消息太长）也当成功，
// 结果"她说的话"被写进上下文、聊天记录也记了，其实对方一个字都没收到（复查 F20）。
async function tryApi(method, params) {
  try {
    const r = await fetch(`${cfg.wsHttp}/${method}`, {
      method: 'POST',
      headers: httpHeadersOf(SETUP),
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(15000),
    });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) { log('[ws api]', method, 'HTTP', r.status); return { ok: false, err: 'HTTP ' + r.status }; }
    if (!j || j.retcode !== 0) {
      log('[ws api]', method, 'retcode', j && j.retcode, (j && (j.wording || j.message)) || '');
      return { ok: false, err: (j && (j.wording || ('retcode ' + j.retcode))) || 'bad-json' };
    }
    const mid = j.data && (j.data.message_id ?? j.data.messageId);
    return { ok: true, data: j.data, messageId: mid || null };
  } catch (e) { log('[ws api]', method, 'fail', e.message); return { ok: false, err: e.message }; }
}

let inflight = false;

function segsToText(segs) {
  if (typeof segs === 'string') return segs;
  if (!Array.isArray(segs)) return '';
  return segs.map(s => {
    if (s.type === 'text') return s.data?.text ?? '';
    if (s.type === 'image') return '[图片]';
    if (s.type === 'face') return '[表情]';
    if (s.type === 'at') return `@${s.data?.qq ?? ''} `;
    return '';
  }).join('').trim();
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

function askDshLegacy(content, sessionId) {
  return new Promise((resolve) => {
    const args = ['headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');
    const child = spawn(`"${cfg.cli}"`, args, { cwd: cfg.cwd, windowsHide: true, shell: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, text: '', err: 'timeout', sid: null });
    }, cfg.dshTimeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '', err: String(e.message), sid: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = out.match(/"session[_-]?id"\s*:\s*"([^"]+)"/i);
      const sid = m ? m[1] : null;
      const text = extractText(out);
      const usage = sumUsage(out);
      if (usage) budget.add('chat', budget.chatCost(usage));
      resolve({ ok: code === 0 && !!text, text, err: (err.trim() || `exit ${code}`).slice(0, 300), sid, usage });
    });
    child.stdin.write(content, 'utf8');
    child.stdin.end();
  });
}

let __sysCache = { mtime: 0, text: '' };
function __genderLine(){
  try {
    const p = fs.readFileSync(PATHS.persona, 'utf8');
    // 人格里自己写了性别 → 尊重人格
    if (/(你是|我是|性别[:：]\s*)(男生|男的|男性|男生子|小伙)/.test(p)) return '';
    if (/(你是|我是|性别[:：]\s*)(女生|女的|女性|姑娘)/.test(p)) return '';
    // 没写 → 默认女
    return '\n\n【身份】你的性别是女。';
  } catch (e) { return ''; }
}
function __selfGender(){
  try { const g = String((settings.load().owner || {}).gender || ''); return g === 'male' ? '女' : (g === 'female' ? '男' : ''); } catch (e) { return ''; }
}
function personaSystem() {
  try {
    const f = path.join(cfg.cwd, 'AGENTS.md');
    const st = fs.statSync(f);
    if (st.mtimeMs !== __sysCache.mtime) __sysCache = { mtime: st.mtimeMs, text: fs.readFileSync(f, 'utf8') };
    return __sysCache.text;
  } catch { return ''; }
}

// 配置了 api.json 就用直连 API，否则仍然走 dsh headless
// ---------- 工具层（T1）：她可以真的去看文件/查目录，而不是嘴上说去看看 ----------
function execCfg() {
  try {
    const e = (settings.load() || {}).work ? settings.load().work.exec : null;
    // 旧配置里 exec 是布尔：升级后按“已开”处理（显式关要写 { mode: 'off' }）
    if (typeof e === 'boolean') return { mode: 'workspace', allow: [], timeoutMs: 60000, maxOutput: 8000 };
    if (!e || typeof e !== 'object') return { mode: 'off', allow: [], timeoutMs: 60000, maxOutput: 8000 };
    const mode = [ 'off', 'workspace', 'full' ].includes(e.mode) ? e.mode : 'workspace';
    return {
      mode,
      allow: Array.isArray(e.allow) ? e.allow.map(String).filter(Boolean) : [],
      timeoutMs: Math.max(1000, Math.min(300000, Number(e.timeoutMs) || 60000)),
      maxOutput: Math.max(500, Math.min(64000, Number(e.maxOutput) || 8000)),
    };
  } catch { return { mode: 'off', allow: [], timeoutMs: 60000, maxOutput: 8000 }; }
}
export function netCfg() {
  try {
    const n = settings.load().work && settings.load().work.net;
    if (n === false) return { enabled: false, allowHosts: [], maxBytes: 2097152, timeoutMs: 20000 };
    if (n && typeof n === 'object') return {
      enabled: n.enabled !== false,
      allowHosts: Array.isArray(n.allowHosts) ? n.allowHosts.map(String) : [],
      maxBytes: Number(n.maxBytes) || 2097152,
      timeoutMs: Number(n.timeoutMs) || 20000,
    };
  } catch {}
  return { enabled: true, allowHosts: [], maxBytes: 2097152, timeoutMs: 20000 };
}

function toolsCfg() {
  try { const t = settings.load().tools || {}; return { enabled: t.enabled !== false, maxRounds: Math.max(1, Math.min(8, Number(t.maxRounds) || 6)), ownerOnly: t.ownerOnly !== false }; } catch { return { enabled: true, maxRounds: 6, ownerOnly: true }; }
}
function toolsAllowed(conv, extras = {}) {
  const c = toolsCfg();
  if (!c.enabled || extras.dry) return false;
  if (conv.kind === 'local') return true;
  if (conv.kind !== 'private') return false;
  return String(conv.id) === String(cfg.ownerUin) || !c.ownerOnly;
}

// ---------- 工作模式（首期只做文件：读 / 写 / 预览 / 恢复 / 停止；执行·联网·桌面留后续） ----------
// 工作区是"文件工具的作用域"，不是进程沙箱：首期不开 exec，所以这句话才成立。
function approvalCfg() {
  try { const w = settings.load().work || {}; return w.approval === 'never' ? 'never' : 'ask'; } catch { return 'ask'; }
}
function workCfg() {
  let w = {};
  try { w = settings.load().work || {}; } catch {}
  const projRoot = path.resolve(PATHS.app, '..');
  // 复查 R3：默认只额外读 <data>/work，不再把整个数据目录（含 config 备份、聊天库）当可读范围
  const readRoots = (Array.isArray(w.readRoots) && w.readRoots.length ? w.readRoots : [ projRoot, path.join(PATHS.data, 'work') ]).map((x) => path.resolve(String(x)));
  return {
    readRoots,
    timeoutMin: Math.max(1, Math.min(240, Number(w.timeoutMin) || 30)),
    exec: w.exec === true,
    net: w.net === true,
    desktop: w.desktop === true,
    suggestRoot: String(w.suggestRoot || path.join(PATHS.data, 'work', 'sessions')),
    defaultMode: String(w.defaultMode || 'write'),
    toolsEnabled: w.toolsEnabled === true,
    lastRoot: String(w.lastRoot || ''),
  };
}

// 最近用过的工作区（从授权历史里按目录归并）——给"一键重开"用
function workRecent(limit = 8) {
  try {
    const key = workKey(__localConv());
    const m = new Map();
    for (const h of grants.history(200)) {
      if (h.action !== 'open' || !h.root) continue;
      if (String(h.convKey || '') !== String(key)) continue;
      const k = String(h.root).toLowerCase();
      const cur = m.get(k);
      if (!cur) m.set(k, { root: String(h.root), lastAt: String(h.at || ''), times: 1, wsIds: [ String(h.id) ], caps: h.caps || [] });
      else { cur.times += 1; cur.lastAt = String(h.at || cur.lastAt); cur.wsIds.push(String(h.id)); }
    }
    return Array.from(m.values())
      .sort((x, y) => y.lastAt.localeCompare(x.lastAt))
      .slice(0, limit)
      .map((x) => ({ root: x.root, lastAt: x.lastAt, times: x.times, wsIds: x.wsIds.slice(-6), caps: x.caps, exists: fs.existsSync(x.root) }));
  } catch { return []; }
}
// 本会话历史里出现过的 wsId（恢复旧记录时校验归属）
function knownWsIds() {
  try {
    const key = workKey(__localConv());
    const out = new Set();
    for (const h of grants.history(300)) if (h.action === 'open' && String(h.convKey || '') === String(key) && h.id) out.add(String(h.id));
    return out;
  } catch { return new Set(); }
}
function workDeny() {
  return [
    PATHS.config, PATHS.setup, PATHS.aliyunKey,
    path.join(PATHS.data, 'api.json'), path.join(PATHS.data, 'ark.key'),
    PATHS.ledger,
    path.join(PATHS.data, 'agent-home', 'memory', 'lessons'), path.join(PATHS.data, 'agent-home', 'memory', 'skills'),
    path.join(PATHS.data, 'chat'), path.join(PATHS.data, 'state'),
    PATHS.memoryPeople, PATHS.memoryLog,
    path.join(PATHS.app, 'src', 'api.json'),
  ].map((x) => path.resolve(String(x)));
}

const workKey = (conv) => conv.kind + ':' + conv.id;

const MODE_CAPS = { read: [ 'fs:read' ], write: [ 'fs:read', 'fs:write', 'exec' ], full: [ 'fs:read', 'fs:write', 'exec', 'net' ] };
const MODE_NAME = { read: '仅可查看', write: '工作区内修改', full: '完全权限' };
function modeOfCaps(caps) {
  const c = Array.isArray(caps) ? caps : [];
  if (c.includes('net')) return 'full';
  if (c.includes('fs:write')) return 'write';
  return 'read';
}

// pinned：任务开始时固定下来的授权（id + epoch）。中途停止/重开之后，旧任务不能靠"再取一次最新授权"续命（复查 R1）。
function toolScope(conv, pinned = null) {
  const w = workCfg();
  const ws = grants.active(workKey(conv));
  if (!ws) return { active: false, ws: null, wsId: '', stale: !!pinned, roots: w.readRoots, writeRoot: '', deny: workDeny(), epoch: 0 };
  if (pinned && (ws.id !== pinned.id || ws.epoch !== pinned.epoch)) {
    return { active: false, ws: null, stale: true, roots: w.readRoots, writeRoot: '', deny: workDeny(), epoch: 0 };
  }
  return { active: true, ws, wsId: ws.id, stale: false, roots: Array.from(new Set([ ws.root, ...ws.readRoots ])), writeRoot: ws.root, deny: workDeny(), epoch: ws.epoch };
}

function grantStillActive(conv, pinned) {
  if (!pinned) return false;
  const ws = grants.active(workKey(conv));
  return !!(ws && ws.id === pinned.id && ws.epoch === pinned.epoch);
}

// 工具要的能力 > 当前会话有没有。日常只给 fs:read；exec 首期一律不开
function toolCapsOk(conv, name, scope) {
  if (workCfg().toolsEnabled !== true) return { ok: false, err: '她现在不能动电脑：先去控制台「模型页」把「允许她动电脑」打开（默认是关的）' };
  const t = toolbox.tools[name];
  const need = (t && t.caps) || [];
  if (!need.length) return { ok: false, err: '工具没有声明能力，按默认拒绝：' + name };   // 复查 R6
  const w = workCfg();
  for (const cap of need) {
    if (cap === 'net') {
      const n = netCfg();
      if (!n.enabled) return { ok: false, err: '联网关着：设置里 work.net.enabled 打开才抓网页' };
      if (scope && scope.stale) return { ok: false, err: '这个工作会话已经停了，别继续动手；要联网就重新开一个' };
      const r = grants.requireCap(workKey(conv), 'net', scope && scope.active ? scope.epoch : null);
      if (!r.ok) return { ok: false, err: r.err };
      continue;
    }
  if (cap === 'exec') {
      // 执行能力：必须在一个活动工作会话里，且 mode 不是 off；即使满足也要人工审批（下面 askApproval）
      if (!scope || !scope.active) return { ok: false, err: '跑命令要先进工作模式：在控制台或聊天窗点「进入工作模式」选个文件夹' };
      if (execCfg().mode === 'off') return { ok: false, err: '命令执行是关着的（设置 work.exec.mode）' };
      // 授权闸门：这个会话必须真的被授予 exec（以前漏了这句，只读会话也能跑命令）
      if (scope.stale) return { ok: false, err: '这个工作会话已经停了，别继续动手；要跑命令就重新开一个' };
      const gExec = grants.requireCap(workKey(conv), 'exec', scope.epoch);
      if (!gExec.ok) return { ok: false, err: gExec.err };
      continue;
    }
    if (cap === 'fs:read') continue;
    if (scope && scope.stale) return { ok: false, err: '这个工作会话已经停了，别继续动手；要改就重新开一个' };
    const r = grants.requireCap(workKey(conv), cap, scope && scope.active ? scope.epoch : null);
    if (!r.ok) return { ok: false, err: r.err };
  }
  return { ok: true };
}

// 建议路径：只算不建；日期 + 主题
function commonPlaces() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return [];
  const want = [ [ '桌面', 'Desktop' ], [ '文档', 'Documents' ], [ '下载', 'Downloads' ] ];
  const out = [];
  for (const [label, sub] of want) {
    const p = path.join(home, sub);
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push({ label, path: p }); } catch {}
  }
  return out;
}

function suggestWorkPath(topic) {
  const d = new Date(Date.now() + 8 * 3600e3);
  const ymd = d.toISOString().slice(0, 10);
  const slug = String(topic || 'task').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'task';
  return path.join(workCfg().suggestRoot, ymd + '-' + slug);
}

// 她的工具调用写法：单独一行 [[工具: {"name":"list_dir","args":{"path":"..."}}]]
function parseToolCall(text) {
  const m = String(text || '').match(/\[\[\s*(?:工具|TOOL)\s*[:：]\s*(\{[\s\S]*?\})\s*\]\]/i);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    if (!o || !toolbox.tools[o.name]) return null;
    return { name: String(o.name), args: (o.args && typeof o.args === 'object') ? o.args : {} };
  } catch { return null; }
}
const TOOL_PROMPT = [
  '【你能动手看，也能在工作区里改文件】你的工具：',
  '- list_dir：看目录里有什么，{"path":"目录"}（不带 path 就是工作区根目录）',
  '- read_file：读文本文件（≤200KB），{"path":"文件"}',
  '- search：在文件里搜文字，{"pattern":"关键词","ext":".md"}（返回 文件:行号: 内容）',
  '- find：按名字找文件，{"pattern":"*.md"}',
  '- fetch_url：只读抓网页或接口拿资料，{"url":"https://...","maxChars":6000}；只能 http/https，本机与内网地址默认不抓；拿不准能不能抓就直接抓一次，被拒工具会把原因告诉你，别自己先说“我碰不着”；抓不到就说抓不到，别编内容',
  '- run_cmd：在工作区里跑命令，{"cmd":["npm","test"]}；只能用白名单程序（node/npm/python/py/git/tsc/pytest 等），参数里的路径必须在工作区里，每次都要他点头才执行，默认 60 秒超时',
  '工具被拒的时候，把工具给的拒绝原因原话告诉他（例如“这个会话没开通联网”），别把它说成“我碰不着”这种含糊话，也别替他判断能不能做；',
  '跑命令的规矩：改完代码要验证就跑测试或跑一遍；命令输出看错误行，别把一屏日志整段复述给他；跑失败就修，别反复跑同一条;别用命令去读你没权限读的东西（会被拒）',
  '只能在这个工作区里看，配置/密钥/原始记忆与聊天库读不到。真要查的时候，最后单独一行写：',
  '[[工具: {"name":"list_dir","args":{"path":"C:\\\\qqbot\\\\qq-bot"}}]]',
  '一次只写一个，结果会直接回给你，你拿到结果再说话。用不上就别调——别为了显得勤快乱翻，也别在没调工具的时候说“我去看了”。',
  '看目录一次就够，别反复 list_dir 同一个地方；要找东西先 search / find，知道是哪个文件了再 read_file。',
].join('\n');

// 只有在工作会话里、且授权带 fs:write 时才把写工具告诉她（日常聊天看不到这段）
const READ_WIDE_WRITE_NARROW = '【看的时候宽，改的时候窄】摸清情况可以多找几处：list_dir 看目录、search 找关键词、find 按名字找、read_file 读关键文件（先读再改，别凭猜）。真动手时尽量收窄：一次改一个文件、edit_file 只换必须换的那几行，别整份重写；改完能跑就跑一下确认，别一口气改十个文件再回头。';
const WRITE_PROMPT = [
  '【这次你能改文件，但只能在你的工作区里】',
  '- write_file：新建或整份覆盖，{"path":"相对工作区的路径","content":"完整内容"}',
  '- edit_file：改一段，{"path":"...","old":"要替换的原文（要在文件里唯一）","new":"换成什么"}',
  '- mkdir：新建目录，{"path":"新目录"}',
  '- move：移动/改名，{"from":"a.txt","to":"目录/a.txt"}',
  '- copy：复制文件，{"from":"a.txt","to":"b.txt"}',
  '- remove：删除文件或整个文件夹，{"path":"a.txt"} / {"path":"旧目录"}（整体搬进回收站 .trash，能恢复）',
  '每次写入前系统都会自动存一份旧版快照，他能一键恢复；你不用自己备份，也别整份重写大文件（用 edit_file 改那一段）。',
  '删东西前先跟他确认一句；删文件夹会把里面所有东西一起搬走，先确认里面没有被保护的东西（工具会拒绝那种情况并告诉你原因）。',
  '写之前先说一句要改哪个文件、改什么；写完把改动摘要跟他讲一句就行，别把整个文件贴出来。',
  'path 写相对路径就行（相对工作区根目录），比如 "todo.txt"；不确定工作区在哪就先 list_dir 不带参数看一眼。',
].join('\n');

// 发图能力：她能把工作区里已有的图片发给他（不是画画，是"把那张发我"）
const ATTACH_PROMPT = [
  '【发磁盘上的图】他要你发某张现成的图片（截图、他之前存的图、工作区里的图），就在回复最后单独一行写：[[附件: 相对路径]]',
  '- 路径相对工作区根目录，比如 "shots/a.png"；不确定就先 list_dir 看一眼。只有工作区里的文件能发。',
  '- 只发真图（png/jpg/gif/webp/bmp，10MB 以内；按文件内容判断，不是看扩展名）。',
  '- 一次最多两张，每条单独一行；发不出去我会告诉他原因，所以别假装发了，也别改画一张顶替。',
].join('\n');

// 把"这次的工作区到底在哪"直接告诉她，而不是让她猜（她猜错过父目录，写到了范围外被拒）
function workPrompt(conv) {
  try {
    const sc = toolScope(conv);
    if (!sc || !sc.active || !sc.ws) return '';
    if (sc.ws.alive === false) return '';   // 复查 F11：内部对象用 alive，state() 才用 active
    const caps = Array.isArray(sc.ws.caps) ? sc.ws.caps : [];
    const lines = [ '【这次的工作区】' + sc.ws.root ];
    lines.push('你现在只在这个目录里活动。list_dir 不带 path 就是列它的根目录；其他文件的 path 都按它算相对路径。');
    lines.push('要把这里现成的图片发给他，就在回复最后单独一行写 [[附件: 相对路径]]（比如 [[附件: shots/demo.png]]），别用画图代替。');
    if (sc.ws.inPlace) lines.push('（就地模式：改的就是这个目录里的原文件）');
    if (!caps.includes('fs:write')) lines.push('（这次只有读权限，别试着写。）');
    return lines.join('\n');
  } catch { return ''; }
}

async function askBrain(content, sid, history) {
  const api = apibrain.load();
  if (api && api.enabled !== false) {
    const r = await apibrain.chat({
      baseUrl: api.baseUrl, model: api.model, key: api.key,
      system: personaSystem() + __genderLine(), user: content, history,
      maxTokens: api.maxTokens, temperature: api.temperature,
    });
    if (r.usage) {
      try {
        budget.add('chat', budget.chatCost({
          inputTokens: r.usage.prompt_tokens,
          outputTokens: r.usage.completion_tokens,
          cacheReadTokens: r.usage.prompt_tokens_details?.cached_tokens || 0,
        }));
      } catch {}
    }
    if (!r.ok) log('[api] fail', r.err);
    // 推理型模型可能把 token 全花在思考上、正文为空：放大预算再试一次
    if (!r.ok && /空回复/.test(r.err || '')) {
      const r2 = await apibrain.chat({
        baseUrl: api.baseUrl, model: api.model, key: api.key,
        system: personaSystem() + __genderLine(), user: content, history,
        maxTokens: Math.max(1500, (api.maxTokens || 800) * 2), temperature: api.temperature,
      });
      if (r2.ok) return { ok: true, text: r2.text, err: '', sid: null };
    }
    return { ok: r.ok, text: r.text, err: r.err, sid: null };
  }
  // 默认分支（走 setup.json 里的大脑）：同样要带人格、同样要计费
  const r = await askDsh(content, sid, { system: personaSystem() + __genderLine(), history });
  if (r && r.ok && r.usage) {
    try {
      budget.add('chat', budget.chatCost({
        inputTokens: r.usage.prompt_tokens,
        outputTokens: r.usage.completion_tokens,
        cacheReadTokens: r.usage.prompt_tokens_details?.cached_tokens || 0,
      }), budget.currentChannel());
    } catch (e) { log('[budget] 记账失败', e.message); }
  }
  return r;
}

function sumUsage(stdout) {
  let inT = 0, outT = 0, cache = 0, n = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const u = ev.usage || (ev.data && ev.data.usage);
    if (!u || typeof u !== 'object') continue;
    inT += Number(u.inputTokens) || 0;
    outT += Number(u.outputTokens) || 0;
    cache += Number(u.cacheReadTokens) || 0;
    n += 1;
  }
  return n ? { inputTokens: inT, outputTokens: outT, cacheReadTokens: cache } : null;
}

function extractText(stdout) {
  const chunks = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { chunks.push(line); continue; }
    const t = String(ev.type ?? ev.kind ?? '');
    if (/error/i.test(t)) continue;
    if (/assistant|response|text|delta|message|output|result/i.test(t)) {
      const v = ev.text ?? ev.delta ?? ev.content ?? ev.message ?? ev.data ?? ev.result;
      if (typeof v === 'string') chunks.push(v);
      else if (Array.isArray(v)) for (const p of v) if (typeof p?.text === 'string') chunks.push(p.text);
    }
  }
  return cleanReply(chunks.join('\n').trim());
}

function cleanReply(text) {
  let t = text;
  const rIdx = t.search(/^#\s*Response\b/m);
  if (rIdx >= 0) t = t.slice(rIdx).replace(/^#\s*Response\b[^\n]*\n?/, '');
  const cut = t.search(/^#\s*(Tools|Progress|Environment|Session)\b/m);
  if (cut >= 0) t = t.slice(0, cut);
  return t.trim();
}

// 把她自己刚说的话记进上下文（否则下一轮她看不见“我刚说过什么”，会自相矛盾）
// 经验库用：记住"她上一句说了什么"和"他当时说的那句"，等他下一句带正面/负面信号时再决定学不学
const __lastBot = new Map();     // uin -> { text, his, at }
const __pendingHis = new Map();  // uin -> 这一轮他说的话

function logOwn(conv, text) {
  try {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    appendLog(String(conv.kind === 'local' ? conv.id : conv.id), '[我] ' + t.slice(0, 200));
    const u = String(memKeyOf(conv));
    if (u) __lastBot.set(u, { text: t, his: String(__pendingHis.get(u) || '').slice(0, 160), at: Date.now() });
  } catch {}
}

// 这一轮是她先开口（主动消息 / 分享 / 醒来打招呼）时，记到聊天记录上，窗口才能标「她来找你」。
let __markProactive = false;

async function sendMsg(conv, text) {
  for (const part of splitText(text, cfg.maxChunk)) {
    let r = await channels.dispatch(conv, { text: part, proactive: !!__markProactive });
    // 主人这条私聊发不出去（QQ 断了）：改从本地窗口说出来。
    // 群消息不许这样换出口——在群里冒出一句只他自己能看到的话，比不发更糟。
    if (!r.ok && r.offline && conv.kind === 'private' && String(conv.id) === String(cfg.ownerUin)) {
      const local = channels.get('local');
      if (local && local.send) {
        const lr = await local.send(channels.convOn(local, cfg.ownerUin), { text: part, proactive: !!__markProactive });
        if (lr && lr.ok) {
          log('[send] QQ 没通，改从本地窗口说', (part || '').slice(0, 40));
          try { notifyOwner(part); } catch {}
          logOwn(conv, part);
          continue;
        }
      }
    }
    // 没发出去就别自欺欺人：不写"我说过"的日志，否则下一轮她会以为自己已经回过
    if (!r.ok) { log('[send] 没发出去', convKey(conv), r.err || '', (part || '').slice(0, 40)); continue; }
    logOwn(conv, part);
  }
}

function __recordLocal(conv, seg, proactive) {
  // 软件内收到她的消息时，按配置推到手机
  try {
    if (conv && conv.kind === 'local' && notify.enabled()) {
      const nf = (settings.load().notify || {});
      const wantAll = nf.when === 'all';
      if (wantAll || nf.when === 'local') {
        const txt = seg && seg.type === 'text' ? String(seg.data && seg.data.text || '')
          : seg && seg.type === 'image' ? '[图片]'
          : seg && seg.type === 'record' ? '[语音]'
          : seg && seg.type === 'face' ? '[表情]' : '';
        if (txt) notify.push('大肥鱼', txt).catch(() => {});
      }
    }
  } catch {}
  try {
    const t = String((seg && seg.type) || '');
    const src = conv.kind === 'local' ? 'app' : 'qq';
    if (t === 'text') {
      const txt = String((seg.data && seg.data.text) || '');
      if (txt) { chatlog.append(conv.id, { dir: 'out', type: 'text', text: txt, src, ...(proactive ? { proactive: true } : {}) }); logOwn(conv, txt); }
      return;
    }
    if (t === 'image' || t === 'record' || t === 'voice' || t === 'file') {
      const raw = String((seg.data && (seg.data.file || seg.data.url)) || '');
      const p = raw.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
      const st = chatlog.stash(p, conv.id);
      const name = String((seg.data && seg.data.name) || '') || path.basename(p);
      chatlog.append(conv.id, { dir: 'out', type: t === 'image' ? 'image' : t === 'file' ? 'file' : 'voice', file: st, src, text: t === 'file' ? name : (seg.__text ? String(seg.__text) : ''), ...(proactive ? { proactive: true } : {}) });
      return;
    }
    if (t === 'face') {
      chatlog.append(conv.id, { dir: 'out', type: 'face', text: String((seg.data && seg.data.id) || ''), src, ...(proactive ? { proactive: true } : {}) });
    }
  } catch (e) { log('[chatlog] record fail', e.message); }
}

async function sendSeg(conv, seg) {
  const r = await channels.dispatch(conv, { seg, proactive: !!__markProactive });
  if (!r.ok) return { ok: false, err: r.err || '没发出去' };
  return r.local ? { ok: true, local: true } : { ok: true, messageId: r.messageId };
}

// 发她指定的本地图片（受控通道）：路径必须落在当前工作区、且会话仍然有效；只发真图，失败就明说，绝不改画一张假的
async function sendAttachment(conv, spec, pinned = null) {
  const raw = String(spec || '').trim();
  if (!raw) return { ok: false };
  const fail = async (why) => {
    log('[attach] 拒绝', convKey(conv), raw, why);
    await sendMsg(conv, '这张图我没发成：' + why);
    return { ok: false, err: why };
  };
  // 授权必须用"这条任务开始时固定下来的"，不能用当前最新授权（复查 F05）
  const sc = toolScope(conv, pinned);
  if (!sc.active || !sc.ws) {
    return fail('现在没有工作会话，我读不了你磁盘上的文件——你点「进入工作模式」给我一个目录，我再发。');
  }
  // 复查 F06：附件只发本次工作区根里的东西，额外 readRoots 不算发送权限
  const chk = fsguard.checkRead(raw, { base: sc.ws.root, roots: [ sc.ws.root ], denyAbs: sc.deny });
  if (!chk.ok) return fail(chk.err);
  const staged = attach.stage(chk.abs);
  if (!staged.ok) return fail(staged.err);
  const url = 'file:///' + staged.file.replace(/\\/g, '/');
  // 图片走 image 段；其他文件走 file 段（QQ 用 file:/// 路径上传）
  const seg = staged.isImage
    ? { type: 'image', data: { file: url } }
    : { type: 'file', data: { file: url, name: staged.origName || path.basename(staged.file) } };
  const r = await sendSeg(conv, seg);
  if (!r || r.ok !== true) {
    log('[attach] 发失败', convKey(conv), staged.file, (r && r.err) || '');
    return fail('发出去的时候失败了，等我一会儿再试。');
  }
  log('[attach] ok', convKey(conv), path.basename(chk.abs), staged.kind, Math.round(staged.size / 1024) + 'KB', 'sha', staged.sha);
  return { ok: true };
}

async function sendFace(conv, id) {
  if (!/^\d{1,3}$/.test(String(id))) return;
  log('[face]', convKey(conv), id);
  {
      const emo = faceTable()[String(id)];
      // 查不到就别发：以前一律降级成 🙂，等于她每句都配同一个笑脸，看着像坏掉了
      if (!emo) { log('[face] 未收录 id=' + id + '，这条表情跳过'); return; }
      await sendSeg(conv, { type: 'text', data: { text: emo } });
    }
}

async function sendSticker(conv, file) {
  const full = path.join(cfg.stickerDir, file);
  if (!fs.existsSync(full)) { log('[sticker] missing', file); return; }
  const url = 'file:///' + full.replace(/\\/g, '/');
  log('[sticker]', convKey(conv), file);
  await sendSeg(conv, { type: 'image', data: { file: url } });
}

// 自己画一张图发出去（万相文生图，约 10–40 秒）
const DRAW_COUNT = path.join(cfg.cwd, 'draw-count.json');
function drawQuota() {
  const d = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(DRAW_COUNT, 'utf8')) || {}; } catch {}
  if (j.day !== d) j = { day: d, n: 0 };
  const soft = Math.max(0, Number((settings.load().draw || {}).perDay ?? 3));
  return {
    soft,
    count: () => Number(j.n) || 0,
    left() {
      // 张数交给她自己节制（提示词里会告诉她今天画了几张），这里只留一个防跑飞的硬上限
      const hard = Math.max(10, soft * 5);
      return Math.max(0, hard - (j.n || 0));
    },
    use() {
      j.n = (j.n || 0) + 1;
      try { fs.writeFileSync(DRAW_COUNT, JSON.stringify(j)); } catch {}
    },
  };
}

// 告诉她今天已经画了几张，让她自己决定还要不要画
function drawHint() {
  try {
    const q = drawQuota();
    if (!q.soft) return '';
    return `（今天你已经自己画/拍了 ${q.count()} 张，平时一天 ${q.soft} 张左右就够了；想多画也行，但别为了发图而发图。）`;
  } catch { return ''; }
}

let lastSelfieFailAt = 0;

async function sendDrawing(conv, desc, extra = {}) {
  try {
    const cfgD = settings.load().draw || {};
    if (cfgD.enabled === false) {
      log('[draw] 已关闭画图');
      if (extra && extra.owed) await sendMsg(conv, '画不了，这边关着');
      return;
    }
    const q = drawQuota();
    if (q.left() <= 0) { log('[draw] 今天画满了'); await sendMsg(conv, '今天画够了，明天再画'); return; }
    const subj = imageintent.subjectOf(desc);
    const hasHer = subj.role === 'her';
    log('[draw]', convKey(conv), hasHer ? '含她（他拍）' : '纯场景', `subject=${subj.role}/${subj.shot}(${subj.why})`, String(desc).slice(0, 60));
    // 只有画面里真有她时才拼形象卡 + 用参考图；画店面/物件时拼进去就会把她也画进来
    const opts = { model: cfgD.model };
    let prompt;
    // 参考图只按"用途 + 这句是否点名"来选，时间只做兜底（2026-10-30：13 分钟前的衣服图被当成当前画稿参考）
    const hisRef = refForClothes(memKeyOf(conv), String(desc || ''));
    const wantHis = !!hisRef;
    if (hasHer) {
      prompt = self.photoPrompt(desc, {
        refNote: wantHis
          ? '第1张是她本人（对脸、发型）；第2张是他发来的参考图——只照它的衣服/物件（款式、颜色、材质），不要第2张里的人脸、身体和背景。'
          : '',
      });
      const ref = self.refFile();
      if (ref) opts.refFile = ref;
      if (wantHis) {
        const list = [ref, hisRef].filter((f) => f && fs.existsSync(f));
        if (list.length > 1) { opts.refFiles = list; log('[draw] 带他发的参考图:', path.basename(hisRef)); }
      }
    } else {
      prompt = scenes.plainScenePrompt(desc, (cfgD.style || 'anime'));
    }
    const { file, model } = await draw.generate(prompt, opts);
    q.use();
    budget.add('draw', 0.15);
    await sendSeg(conv, { type: 'image', data: { file: 'file:///' + file.replace(/\\/g, '/') } });
    log('[draw] ok', path.basename(file), model, hasHer ? '| 含她' : '| 无人');
  } catch (e) {
    log('[draw] fail', e.message);
    await sendMsg(conv, '画崩了，等我再琢磨琢磨');
  }
}

async function sendSelfie(conv, scene, extra = {}) {
  const owed = !!(extra && extra.owed);
  try {
    const cfgD = settings.load().draw || {};
    if (cfgD.enabled === false) {
      log('[selfie] 画图已关闭');
      // 她刚答应要发：不能一声不吭。没答应的随手拍仍保持安静，避免关着画图时刷屏。
      if (owed) await sendMsg(conv, '拍不了，相机没开');
      return;
    }
    const q = drawQuota();
    if (q.left() <= 0) {
      log('[selfie] 今天拍够了');
      const lines = ['今天不拍了，手酸', '明天吧，今天没心情拍', '不拍了，脸都没洗'];
      await sendMsg(conv, lines[Math.floor(Math.random() * lines.length)]);
      return;
    }
    const prev = self.last();
    const keepMin = Number(cfgD.keepMin ?? 60);
    const aged = !prev || !keepMin || (Date.now() - (prev.at || 0)) / 60000 > keepMin;
    const here = lifeHere();
    // 地点优先：她自己这次说的地点 → 她刚在聊天里说的（[我] 且 2 小时内）→ 日程 → 上一张
    // 注意文件名按 QQ 号存（memKeyOf），不是 convKey 的 "local:xxx"
    const saidPlace = lastPlace(memKeyOf(conv));
    const scenePlace = (String(scene || '').match(PLACE_RE) || [])[1] || '';
    const placeHint = scenePlace || saidPlace || here.place || (prev && prev.place) || '';
    // 场景没写或写得很虚，就用她自己排的这一段（地点+在干什么）
    let sTxt = String(scene || '').trim();
    if (!sTxt || /^(随手一张|随便|自拍|一张)$/.test(sTxt)) {
      sTxt = [here.place, here.what].filter(Boolean).join('，') || sTxt;
    }
    // 她自己换地方/换时段了就不接着上一张；她说"还在/继续"就强制接
    const moveOn = /换个地方|换了个地方|出门|出门了|到了|来到|在外面|在街上|回(家|屋|宿舍)|下车|路上|上楼|下楼|公园|咖啡(店|馆)|公司|学校|教室|地铁|车上|海边|河边|山上|景点/.test(sTxt);
    const insist = /^(继续|接着|还(在|是)|同一)/.test(sTxt.trim()) || /还在|还是刚才/.test(sTxt);
    const placeKnown = !!(prev && prev.place && placeHint);
    // 地点变了就不再"接着上一张"：昨天卧室、今天小区门口，"还在"也不能延续室内
    const placeMoved = placeKnown ? prev.place !== placeHint : false;
    const samePlace = !placeMoved;
    // 她只说“还在/继续”，但这台机器上还没有上一张（比如刚装、之前都失败过）→ 不能当成“接上一张”，
    // 否则 prev 是 null，读 prev.scene 会直接崩（2026-10-26 那次 [selfie] fail Cannot read properties of null 就是这么来的）
    const canCarry = !!(prev && prev.file && fs.existsSync(prev.file));
    const cont = canCarry && !placeMoved && (insist || (!aged && !moveOn && samePlace));
    const why = cont ? '接着上一张'
      : (!canCarry ? (prev ? '新场景(上张图没了)' : '新场景(还没拍过)')
      : (aged ? '新场景(超时)' : (moveOn ? '新场景(换地方)' : '新场景(地点变了)')));
    log('[selfie]', convKey(conv), why, prev && prev.place ? `上次:${prev.place}` : '', placeHint ? `现在:${placeHint}` : '', sTxt.slice(0, 40));
    // 穿着：先看"这轮有没有新的、明确的那身"，没有就保持当前穿着，绝不因为"检测到换衣"就回退成外套长裤
    const dressWord = (sTxt.match(/(女仆装|女仆裙|睡衣|家居服|短袖|T恤|吊带|衬衫|毛衣|卫衣|连衣裙|围裙|制服|校服|西装|外套|运动裤|短裤|长裤|裙子|裙子|裙)/) || [])[1] || '';
    const askedChange = ownerAskedChange(memKeyOf(conv));
    const changing = askedChange || /换上|穿上|换掉|换(?:了|过)?(?:一)?[件身套]|换(?:了|过)?(?:这|那)?(?:衣服|衣裳|裙子|裙|装)|换.{0,4}(?:衣服|衣裳|裙子|裙)|打扮|化个妆|出门前换/.test(sTxt);
    const newWear = imageintent.outfitOf(sTxt);          // 这轮句子里"明确要穿的那身"
    const curWear = self.getOutfit();
    // 通用默认（便装/家居服）不是她真实这身，既不沿用也不覆盖真实状态
    const GENERIC_WEAR = /^(日常便装：简单上衣|家居服：宽松短袖)/;
    const curOk = !!(curWear && curWear.text && curWear.src !== 'init' && !GENERIC_WEAR.test(curWear.text));
    const doneWear = /(换好了|换完了|穿好了|换好啦|已经换过|已经换好|弄好了)/.test(sTxt);
    const psWear = pstate[String(memKeyOf(conv))] || {};
    const pendingWear = String(psWear.pendingOutfit || '');
    let outfit = '';
    let outfitSrc = '';
    const dressColor = (sTxt.match(/(深蓝|藏青|浅蓝|黑|白|红|粉|灰|米|蓝|紫|绿|黄)色?/) || [])[1] || '';
    if (newWear.explicit) {
      outfit = newWear.text;
      outfitSrc = 'her';
    } else if (doneWear && pendingWear) {
      outfit = pendingWear;                              // "换好了" + 之前明确点过那身 → 落实目标
      outfitSrc = 'pending';
      try { delete psWear.pendingOutfit; saveP(); } catch {}
    } else if (curOk) {
      outfit = curWear.text;                             // 没给新衣服就保持（换地点/超时也不变）
      outfitSrc = 'keep';
    } else if (prev && prev.outfit && !GENERIC_WEAR.test(prev.outfit) && Date.now() - (prev.at || 0) < 12 * 3600e3) {
      // 没有新信息、但上一张还能接着拍：衣服跟着上一张走，别退化成"日常便装"
      outfit = prev.outfit;
      outfitSrc = 'prev';
    } else if (dressWord) {
      outfit = /女仆/.test(dressWord)
        ? `女仆装：${dressColor ? dressColor + '色裙子' : '深色裙子'} + 白围裙 + 发带`
        : dressWord;
      outfitSrc = 'init';
    } else {
      const sleepy = /睡|躺床|床上|被窝|刚起|半夜|凌晨|困|刚洗完/.test(sTxt + ' ' + (here.what || ''));
      outfit = sleepy
        ? '家居服：宽松短袖 T 恤 + 睡裤/短裤（不是女仆装）'
        : '日常便装：简单上衣 + 长裤（不是女仆装）';
      outfitSrc = 'init';
    }
    // 只在"真的换了"时写状态：她说的/待办落实的；保持原样的不重复写
    if (outfitSrc === 'her') self.setOutfit(outfit, 'her');
    else if (outfitSrc === 'pending') self.setOutfit(outfit, 'his');
    // outfitSrc=init 是通用默认，不落状态（否则会把她真实的那身覆盖掉）
    log('[selfie] 穿着:', outfit, `src=${outfitSrc}`, changing ? '(这轮提到换)' : '', newWear.why ? `(${newWear.why})` : '');
    // 参考图：只有"这句明确点名他发的那张（这身/这套/照着…）"且最近发的是衣服用途，才当衣服参考
    const hisRef = refForClothes(memKeyOf(conv), sTxt);
    const useHisRef = !!hisRef;
    const keepIn = cont ? (prev.scene + (prev.look ? `；画面里：${prev.look}` : '')) : '';
    const herRef = self.refFile() || '';
    const refFiles = useHisRef
      ? [herRef, hisRef].filter((f) => f && fs.existsSync(f))
      : [];
    if (useHisRef) log('[selfie] 带他发的参考图:', path.basename(hisRef), `purpose=${imageintent.refPurposeOf(sTxt)}`);
    const refNote = useHisRef
      ? '第1张是她本人（对脸、发型）；第2张是他刚发来的参考图——只照它的衣服（款式、颜色、材质、穿法），不要第2张里的人脸、身体和背景，哪怕那是模特或人体模型也只抄衣服。把第2张的衣服穿到第1张的她身上。'
      : '';
    // 这句话里她手里有东西 → 不能再写'举着手机自拍'，否则模型会多画一只举手机的手
    const busyHands = /(拿|抱着|端着|拎|举着|握着|捧着)/.test(sTxt);
    const fw = self.frameWant();
    if (fw) log('[selfie] 机位:', fw === 'full' ? '全身（他这轮要的）' : '半身（他这轮要的）');
    const prompt = self.selfiePrompt(sTxt, {
      outfit, place: placeHint, changed: changing, refNote, handsBusy: busyHands,
      ...(fw ? { full: fw === 'full' } : {}),
      ...(cont ? { keepIn } : {}),
    });
    const opts = { model: cfgD.model };
    // 自拍一定要带"她本人"的参考图：接着拍用上一张（人物/环境一起延续），
    // 但换装时不能用上一张——旧衣服会把新衣服压回去，改用固定形象图。
    // 参考图选谁，决定了衣服会不会变：
    //   换装 → 不能用上一张（旧衣服会把新衣服压回去），改用固定形象图
    //   没换装 → 一律用上一张（哪怕地点变了）：上一张里她就是"这身衣服"，比设定稿更可信
    //   从没拍过 → 只能退回固定形象图
    if (refFiles.length > 1) {
      opts.refFiles = refFiles;          // 多参考：她 + 他给的图
      opts.refFile = herRef || '';
    } else if (changing) {
      opts.refFile = herRef;
    } else if (prev && prev.file) {
      // 两张一起给：第 1 张锁脸和发型（固定形象图），第 2 张锁"今天这身衣服 + 当下环境"。
      // 只给上一张会连姿势构图一起抄；只给固定图会把衣服压回女仆装。
      const conts = [herRef, prev.file].filter((f) => f && fs.existsSync(f));
      if (conts.length > 1) { opts.refFiles = conts; opts.refFile = herRef; }
      else opts.refFile = prev.file || herRef;
    } else {
      opts.refFile = herRef;
    }
    try { log('[selfie] 参考图:', changing ? '固定形象图(换装)' : (prev && prev.file ? (opts.refFiles ? '固定形象图+上一张' : '上一张') : '固定形象图')); } catch {}
    const propsWant = propsIn(sTxt);
    let shot = await draw.generate(prompt, opts);
    // 先查形体：多手/多臂/畸形 → 只记录，不再重画（他要"一次拍成"；重画会改脸改衣服还多花钱）
    const ALLOW_REDRAW = false;
    let audit = await selfieAudit(shot.file);
    if (ALLOW_REDRAW && audit.bad) {
      log('[selfie] 形体不对', 'HANDS=' + audit.hands, 'ARMS=' + audit.arms, '→ 重画一次');
      try {
        const fixHands = prompt + '重画这一张：她只有两只手、两条胳膊。' + (propsWant.length ? `两只手分别拿着：${propsWant.join('、')}；` : '') + '不要再画第三只手、第四条胳膊或多余的手指，也不要把举着手机的手臂画进来。';
        const shot2 = await draw.generate(fixHands, opts);
        q.use();
        budget.add('draw', 0.15);
        const audit2 = await selfieAudit(shot2.file);
        const better = !audit2.bad || ((audit2.hands || 9) < (audit.hands || 9));
        if (better) { shot = shot2; audit = audit2; log('[selfie] 重画后形体', audit2.bad ? '仍有瑕疵' : '正常', 'HANDS=' + audit2.hands); }
        else log('[selfie] 重画没更好，保留第一张');
      } catch (e) { log('[selfie] 形体重画失败', e.message || String(e)); }
    }
    // 画完自己看一眼：她说的道具和画面对不上就补画一次（一次为限，别无限重试烧钱）
    let look = await selfieLook(shot.file);
    const want = propsWant;
    const missing = look ? want.filter((w) => !propHit(look, w)) : [];
    if (ALLOW_REDRAW && missing.length) {
      log('[selfie] 自检不符：描述里有', missing.join('/'), '画面里没有 → 重画一次');
      try {
        const fix = prompt + `画面里必须看得见：${missing.join('、')}。别再加别的食物或道具。`;
        const shot2 = await draw.generate(fix, opts);
        q.use();
        budget.add('draw', 0.15);   // 补画也算一张，别把账记少了
        const look2 = await selfieLook(shot2.file);
        if (look2 && missing.every((w) => propHit(look2, w))) { shot = shot2; look = look2; log('[selfie] 重画对上了'); }
        else log('[selfie] 重画后仍不符：', (look2 || '(没看出内容)').slice(0, 80));
      } catch (e) { log('[selfie] 重画失败', e.message || String(e)); }
    }
    try {
      if (audit && audit.bad) log('[selfie] 形体瑕疵(不重画):', 'HANDS=' + audit.hands, 'ARMS=' + audit.arms);
      if (missing && missing.length) log('[selfie] 画面缺:', missing.join('/') , '(不重画)');
    } catch {}
    q.use();
    budget.add('draw', 0.15);
    self.setLast(shot.file, String(sTxt || '').slice(0, 120), placeHint, outfit, look || '');
    await sendSeg(conv, { type: 'image', data: { file: 'file:///' + shot.file.replace(/\\/g, '/') } });
    if (fw) self.clearFrame();
    try { const n = loops.close(memKeyOf(conv), { tag: 'photo', evidence: '照片发出去了' }); if (n) log('[loops] 照片的事结掉了', n, '条'); } catch {}
    // 照片真发出去了：记忆里"他/她要拍照"的那几条也标成办完，别再当成"还没做"反复提
    try { const n = memory.markDone(memKeyOf(conv), ['拍照', '照片', '换衣服']); if (n) log('[memory] 照片的事办完了，', n, '条不再当没做'); } catch {}
    log('[selfie] ok', path.basename(shot.file), shot.model, look ? '| 画面：' + look.slice(0, 70) : '| 没看成');
  } catch (e) {
    // 空 message 会打出 "fail " 什么都看不出来；把 err 类型也带上，日志里能查
    log('[selfie] fail', e.message || (e && e.name) || String(e));
    // 没人等的随手拍：10 分钟内只抱怨一次，免得刷屏。
    // 她这轮答应了要发的：同一轮必须说一声，不能再被这 10 分钟吃掉。
    const quiet = !owed && Date.now() - lastSelfieFailAt <= 10 * 60 * 1000;
    if (quiet) return;
    lastSelfieFailAt = Date.now();
    const msg = String((e && e.message) || '');
    const short = /404|not found|NotFound/i.test(msg) ? '相机好像坏了' : '卡住了';
    await sendMsg(conv, `拍不出来，${short} / 等下再试`);
  }
}

function sceneFileUrl(file) {
  return 'file:///' + String(file).replace(/\\/g, '/');
}

// [[场景: 家]] 有旧图就直接发；[[场景: 家 | 描述]] / [[场景更新: 家 | 描述]] 才（重新）画
async function sendScene(conv, spec, extra = {}) {
  try {
    const raw = String(spec && spec.raw || '').trim();
    if (!raw) return;
    const [nameRaw, descRaw] = raw.split(/[|｜]/);
    const name = String(nameRaw || '').trim();
    const desc = String(descRaw || '').trim();
    if (!name) return;
    const cfgD = settings.load().draw || {};
    if (cfgD.enabled === false) {
      log('[scene] 画图已关闭');
      if (extra && extra.owed) await sendMsg(conv, '这地方拍不了，画图关着');
      return;
    }

    const old = scenes.find(name);
    const wantNew = !!spec.force || (!old && desc);
    if (old && !wantNew) {
      scenes.touch(old.id);
      log('[scene] 用旧图', name, path.basename(old.file));
      await sendSeg(conv, { type: 'image', data: { file: sceneFileUrl(old.file) } });
      return;
    }
    if (!desc) { log('[scene] 没有描述，跳过', name); return; }

    const q = drawQuota();
    if (q.left() <= 0) { log('[scene] 今天画满了'); await sendMsg(conv, '今天不拍了，改天带你看看'); return; }

    log('[scene]', wantNew ? '重画' : '新建', name, desc.slice(0, 50));
    const prompt = scenes.scenePrompt(name, desc, (settings.load().draw || {}).style);
    const { file, model } = await draw.generate(prompt, { model: cfgD.model });
    q.use();
    budget.add('draw', 0.15);
    const buf = fs.readFileSync(file);
    const item = scenes.save({ name, buf, desc, ext: 'jpg' });
    log('[scene] ok', item.id, path.basename(item.file), model);
    await sendSeg(conv, { type: 'image', data: { file: sceneFileUrl(item.file) } });
  } catch (e) {
    log('[scene] fail', e.message);
    await sendMsg(conv, '这个地方我拍不出来，等下再说');
  }
}

// 括号里的表演提示不是噪音，是她的语气。原来整条删掉，念出来就只剩平铺直叙的念稿。
function speechFrom(text) {
  let s = String(text || '');
  s = s.replace(/[（(]\s*(?:笑|笑了|轻笑|哈哈|苦笑|笑着说|笑笑)[^）)]*[）)]/g, '，哈哈');
  s = s.replace(/[（(]\s*(?:叹气|叹口气|叹气着|叹|无奈|无语)[^）)]*[）)]/g, '，唉');
  s = s.replace(/[（(]\s*(?:小声|低声|嘀咕|嘟囔|念叨)[^）)]*[）)]/g, '，');
  s = s.replace(/[（(]\s*(?:停顿|沉默|想了想|顿了顿|犹豫)[^）)]*[）)]/g, '……');
  s = s.replace(/[（(][^）)]*[）)]/g, '……');     // 其它提示：留一个停顿，别把话吞掉
  s = s.replace(/\[\[[^\]]*\]\]/g, ' ');          // MEMO/FACE/VOICE 这些标记不能念出来
  return s.replace(/[ \t]+/g, ' ').replace(/，{2,}/g, '，').replace(/。{2,}/g, '。').replace(/…{3,}/g, '……').replace(/^[，。…\s]+/, '').trim();
}

async function sendVoice(conv, text) {
  try {
    const clean = speechFrom(text);
    if (!clean) { await sendMsg(conv, text); return; }
    const { silk, durationMs } = await textToSilk(clean);
    budget.add('tts', budget.ttsCost(clean.length));
    if (durationMs > 58000) { log('[voice] too long', Math.round(durationMs)); await sendMsg(conv, text); return; }
    if (conv.kind === 'local') {
      // 浏览器不能播 silk，本地通道改成 wav，并把文字一起带上（长按可转文字）
      const { ttsPreview } = await import('./voice.mjs');
      const wav = await ttsPreview(clean);
      const wf = path.join(os.tmpdir(), 'dsh-qq-voice-' + crypto.randomBytes(4).toString('hex') + '.wav');
      fs.writeFileSync(wf, wav);
      log('__localVoice', convKey(conv), wav.length + 'B');
      await sendSeg(conv, { type: 'record', data: { file: 'file:///' + wf.replace(/\\/g, '/') }, __text: clean });
      setTimeout(() => fs.unlink(wf, () => {}), 120000);
      return;
    }
    const file = path.join(os.tmpdir(), `dsh-qq-voice-${crypto.randomBytes(4).toString('hex')}.silk`);
    fs.writeFileSync(file, silk);
    log('[voice] send', convKey(conv), Math.round(durationMs) + 'ms');
    await sendSeg(conv, { type: 'record', data: { file: 'file:///' + file.replace(/\\/g, '/') } });
    setTimeout(() => fs.unlink(file, () => {}), 60000);
  } catch (e) {
    log('[voice] fail', e.message);
    await sendMsg(conv, text);
  }
}

async function sendBubbles(conv, text) {
  const bs = splitBubbles(text);
  for (let i = 0; i < bs.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350 + Math.random() * 750));
    await sendMsg(conv, bs[i]);
  }
  noteOwn(bs.join(''));
  try { const hits = grounding.lint(bs.join(''), grounding.allowedTokens()); if (hits.length) log('[lint]', hits.join(',')); } catch {}
  if (bs.length > 1) log('[bubbles]', bs.length);
}

// ---------- 主动开口：状态 ----------
const P_FILE = path.join(RQ, 'proactive.json');

// 她主动说话、但 QQ 没接时，弹一条 Windows 通知（端口由 Electron 主进程写在 notify.port）。
function notifyOwner(text) {
  try {
    const pf = path.join(RQ, 'notify.port');
    const port = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
    if (!port) return;
    const name = (() => { try { return (settings.load().persona || {}).name || '她'; } catch { return '她'; } })();
    const payload = JSON.stringify({ title: name, body: String(text || '').slice(0, 200) });
    const req = http.request({
      host: '127.0.0.1', port, path: '/notify', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', (e) => log('[notify] 失败', e.message));
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.end(payload);
  } catch (e) { log('[notify] 不可用', e.message); }
}
// ???????P ? buildP() ???config.json ??????????? watchFile?
function buildP() {
  const s = settings.load();
  const p = s.proactive || {};
  return {
    minGapMs: p.minGapMin * 60 * 1000,
    quietMs: p.quietMin * 60 * 1000,
    maxPerDay: p.maxPerDay,
    chance: p.chance,
    tickMs: Math.max(1, p.tickMin) * 60 * 1000,
    activeFrom: settings.toMinutes(p.activeFrom, 600),
    activeTo: settings.toMinutes(p.activeTo, 240),
  };
}
let P = buildP();
let pstate = {};
try { pstate = JSON.parse(fs.readFileSync(P_FILE, 'utf8')); } catch {}
function saveP() { try { fs.writeFileSync(P_FILE, JSON.stringify(pstate, null, 2)); } catch {} }
function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }

// 对方说话了 = 她在等的那次主动已经得到回应
function clearPending(uin) {
  const s = pstate[uin];
  if (s && s.pendingSince) { s.pendingSince = 0; saveP(); log('[proactive] pending cleared', uin); }
}

// 不管消息从 QQ 还是 App 进来，都要做同一套"他刚说话"的记账。
// 以前只有 QQ 那条路做，App 通道进来时 lastUserAt 不动，主动消息会以为他一天没回（复查 F17）。
function noteIncoming(conv, text = '', refImg = '') {
  const uin = String(memKeyOf(conv));
  const ps = (pstate[uin] ||= {});
  const relationship = moments.relationshipFor(conv, cfg.ownerUin, personaText(12000));
  if (relationship) {
    const events = moments.detect({ text, hour: Math.floor(settings.nowMinutes() / 60), lastUserAt: ps.lastUserAt });
    ps.moment = { relationship, events, at: Date.now() };
    ps.momentQuietUntil = moments.quietUntil(events);
  } else {
    delete ps.moment;
    delete ps.momentQuietUntil;
  }
  ps.lastUserAt = Date.now();
  ps.lastMsgTime = Math.max(Number(ps.lastMsgTime) || 0, Math.floor(Date.now() / 1000));
  // 他发来的图留个指针 + 用途：衣服 / 画稿截图 / 不知道。
  // 以前只存"最近一张 + 时间"，于是 13 分钟前的衣服图会被当成"现在要看的那张画稿"（2026-10-30）。
  if (refImg) {
    const purpose = imageintent.refPurposeOf(text);
    const it = {
      file: refImg,
      at: Date.now(),
      purpose,
      task: String(text || '').slice(0, 60),
      msg: crypto.createHash('sha1').update(String(text || '').slice(0, 200)).digest('hex').slice(0, 8),
    };
    ps.lastRefImg = it;
    const arr = Array.isArray(ps.refImgs) ? ps.refImgs : [];
    ps.refImgs = arr.concat([ it ]).slice(-6);
    log('[ref] 收图', purpose, it.msg, path.basename(refImg));
  }
  // 他这条里如果明确点了"要你穿这身"，先记成待完成的目标；她说"换好了"时再落实
  const ow = imageintent.outfitOf(text);
  if (ow.explicit) { ps.pendingOutfit = ow.text; log('[wear] 记下他要的那身:', ow.text); }
  // 他回了：招呼算被接住（pendingSince 清掉），但这场若是她开的，仍然开着，而且轮到她了。
  if (ps.herThread) ps.herThread = outreach.noteHim(ps.herThread, Date.now());
  saveP();
  clearPending(uin);
  return ps;
}

// 只对主人：群聊、别人的私聊不走这套「别装没看见」。
function ownerFacing(conv) {
  if (!conv || conv.kind === 'group') return false;
  const id = String(memKeyOf(conv) || '');
  const owner = String(cfg.ownerUin || '').trim();
  if (conv.kind === 'local') return !owner || id === owner || id === 'local';
  return !!owner && id === owner;
}
function herThreadOf(uin) {
  return (pstate[String(uin || '')] || {}).herThread || null;
}
function saveHerThread(uin, thread) {
  const s = (pstate[String(uin)] ||= {});
  s.herThread = thread;
  saveP();
}
// 这场是她先开的，而且现在轮到她（含刚说要走、他立刻追一句）
function outreachHold(conv, uin) {
  if (!ownerFacing(conv)) return false;
  const id = String(uin || memKeyOf(conv) || '');
  return outreach.mustAnswer(herThreadOf(id), Date.now());
}
function currentLeaveReason(uin) {
  try {
    if (mind.isAsleep(uin)) return { reason: 'sleep', what: '' };
    const st = mind.load(uin);
    if (Number(st && st.energy) < 20) return { reason: 'sleep', what: '' };
    const pull = outreach.schedulePull(planCache, daily.nowHM(), { graceMin: 12 });
    if (pull && pull.reason === 'sleep') return { reason: 'sleep', what: pull.what || '' };
    if (pull) return { reason: 'life', what: pull.what || '' };
  } catch {}
  return { reason: 'busy', what: '' };
}
// 已经在说再见的这场，别再叠一句
const __leavingNow = new Set();
async function speakLeave(conv, mk, reason, mstate, opts = {}) {
  const id = String(mk || '');
  if (!id || __leavingNow.has(id)) return null;
  const prev = herThreadOf(id);
  if (prev && prev.left && !opts.again) return null;
  __leavingNow.add(id);
  const what = opts.what || '';
  const line = outreach.leaveLine(reason, Date.now(), what);
  try {
    if (prev) saveHerThread(id, outreach.noteHerReply(prev, Date.now(), { leaving: true }));
    log('[outreach] 这场没说完，先把离开说出来', id, reason, line);
    const __prevLeave = __markProactive;
    __markProactive = true;
    try { await sendBubbles(conv, line); }
    finally { __markProactive = __prevLeave; }
    try {
      const st = mstate || mind.load(id);
      if (!mstate && opts.incoming !== false) mind.bump(st, { type: 'user_msg' });
      mind.bump(st, { type: 'my_reply' });
      mind.save(id, st);
    } catch {}
    // 已经睡着就别把这一觉重排；说了去睡且还醒着，才真睡下。
    // 不用 mind.goSleep(mk, hrs) 这个写法：睡眠回归要靠「先 save(mstate) 再 goSleep(mk, hrs)」那一处的顺序。
    if (reason === 'sleep' && !mind.isAsleep(id)) {
      try { mind.goSleep(id, 7); log('[outreach] 说了去睡，真睡下', id); } catch {}
    }
    return line;
  } catch (e) {
    if (prev) saveHerThread(id, prev);
    log('[outreach] 离开没说出去', id, e.message);
    return null;
  } finally {
    __leavingNow.delete(id);
  }
}

// 最近他发来的参考图（兜底用；现在选图主要靠 refForClothes）
function recentRefImg(uin, ms = 2 * 3600e3) {
  try {
    const it = (pstate[String(uin)] || {}).lastRefImg;
    if (!it || !it.file) return '';
    if (Date.now() - (it.at || 0) > ms) return '';
    return fs.existsSync(it.file) ? it.file : '';
  } catch { return ''; }
}

// 选"衣服参考图"：必须这句明确点名（这身/这套/照着/图里…）+ 最近那张的用途是衣服。
// 时间只做兜底（2 小时），不再"只要有换衣意图就抓最近一张"，也不再被"提到道具"触发。
function refForClothes(uin, text) {
  const s = String(text || '');
  if (!imageintent.pointsAtRef(s)) return '';
  const purp = imageintent.refPurposeOf(s);
  if (purp === 'doc' && !imageintent.OUT_KW.test(s)) return '';   // 这句在要画稿/截图，别拿衣服图凑
  const arr = (pstate[String(uin)] || {}).refImgs || [];
  const now = Date.now();
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (!it || !it.file) continue;
    if (now - (it.at || 0) > 2 * 3600e3) continue;
    if (!fs.existsSync(it.file)) continue;
    const purpose = it.purpose || imageintent.refPurposeOf(it.task || '');
    if (purpose === 'doc') continue;
    if (purpose === 'clothes') return it.file;
    if (imageintent.OUT_KW.test(s)) return it.file;               // 用途不明但这句在说衣服
  }
  return '';
}

// ---------- 收消息：先攒一下，再回 ----------
const PRIVATE_DELAY = 2000;   // 兜底值，实际读 settings.reply.*
const GROUP_DELAY = 4000;
// 睡着判定：不在活跃时段就算睡了
function asleepNow() {
  try { return !settings.inWindow(P.activeFrom, P.activeTo, settings.nowMinutes()); } catch { return false; }
}

// 她回得多快，一半是她的习惯（设置里的基准延迟），一半取决于他要看多少字——字越多，打得越久。
// 2026-10-31：以前是"2 秒 + 每字 22 毫秒"，封顶 20 秒——236 次里 96% 在 10 秒内，最长 22 秒，
// 从没超过 30 秒。一个人不存在"最长 22 秒才回"，这就是机器味最重的地方。
// 现在按真人的分布抽：大多数很快，偶尔几分钟，极少数十几分钟到两小时；还有一小部分她根本没回。
function replyDelay(isGroup, text) {
  const r = settings.load().reply || {};
  const base = Math.min(60000, Math.max(0, Number((isGroup ? r.groupDelayMs : r.privateDelayMs) ?? (isGroup ? GROUP_DELAY : PRIVATE_DELAY))));
  const chars = Array.from(String(text || '')).length;
  const perChar = isGroup ? 26 : 40;      // 毫秒/字：群里回得慢一点
  const react = isGroup ? 600 : 350;      // 看到消息到开始打字
  const jitter = 0.85 + Math.random() * 0.3;
  let total = base + (react + chars * perChar * 0.55) * jitter;
  // 她睡着时被吵醒：先懵一会儿再摸手机
  if (asleepNow()) total += 12000 + Math.random() * 14000;

  const d = String(text || '');
  // 群里不玩这套：群聊要接得上话，太慢等于没在
  if (isGroup) return { ms: Math.round(Math.min(15000, total) * delayScale()), skip: false };

  // 私人聊天：她有自己的生活
  // 2026-11-01 收窄：原来 12% 会压 15–120 分钟，用户当晚被"70 分钟不回"困惑了一次。
  // 现在的取舍——"慢"要能解释成"在忙"，不能变成"她死了"：最长 8 分钟。
  const roll = Math.random();
  let ms;
  if (roll < 0.75) ms = total;                                        // 顺手就回了：2–15 秒
  else if (roll < 0.93) ms = 20000 + Math.random() * 70000;           // 在忙：20 秒到 1 分半
  else ms = 120000 + Math.random() * 360000;                          // 手机不在手边：2–8 分钟

  // 不回：只挑那种"可回可不回"的闲话，正事、问句、让他做的事一律要回。
  // 她自己先开的那场不在这里判：queueReply 看到 outreachHold 会把 skip 关掉。
  const casual = !/[?？]/.test(d) && d.length <= 30 && !/(帮|给我|看看|发我|拍|记得|明天|几点|在哪|怎么|为啥|为什么|能不能|可以|好不)/.test(d);
  const skip = casual && Math.random() < 0.12 && delayScale() > 0;
  return { ms: Math.round(Math.min(480000, ms) * delayScale()), skip };
}
// 测试里不能真等两小时：run-tests 会把 QQBOT_DELAY_SCALE 设成 0
function delayScale() {
  const v = Number(process.env.QQBOT_DELAY_SCALE);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}
const BOT_NAME_DEFAULT = '大肥鱼';

// 她能被叫什么：设置里的别名 + persona 里写的名字（支持「大肥鱼，肥鱼，小鱼」这种）+ 默认名。
// 每次用的时候现算（按 persona 的 mtime 缓存），改完人格不用重启。
let __bn = { key: '', list: [BOT_NAME_DEFAULT] };
function botNames() {
  let mtime = 0;
  try { mtime = fs.statSync(cfg.personaSrc).mtimeMs; } catch {}
  const aliases = (() => { try { return settings.load().names || []; } catch { return []; } })();
  const key = mtime + '|' + JSON.stringify(aliases) + '|' + (cfg.botName || '');
  if (key === __bn.key) return __bn.list;
  const out = new Set();
  const push = (v) => {
    const t = String(v || '').trim().replace(/^[「“"']|[」”"']$/g, '');
    if (t.length >= 1 && t.length <= 12) out.add(t);
  };
  try {
    const txt = fs.readFileSync(cfg.personaSrc, 'utf8').slice(0, 800);
    for (const re of [/你是[「“"]([^」”"]{1,40})[」”"]/, /你叫[「“"]?([^\s，,。；;：:]{1,12})/, /^\s*-\s*名字[：:]\s*(.{1,12})$/m]) {
      const m = txt.match(re);
      if (!m) continue;
      m[1].split(/[，,、\/\s]+/).forEach(push);
    }
  } catch {}
  aliases.forEach(push);
  try { push(cfg.botName); } catch {}
  push(BOT_NAME_DEFAULT);
  __bn = { key, list: [...out] };
  return __bn.list;
}
function isCalled(text) {
  const t = String(text || '');
  return botNames().some((n) => n && t.includes(n));
}
function stripNames(text) {
  let t = String(text || '');
  for (const n of botNames()) if (n) t = t.split(n).join('');
  return t.trim();
}
const BOT_NAME = BOT_NAME_DEFAULT;
const buffers = new Map(); // convKey -> { conv, lines, timer }
const skipStreak = Object.create(null); // convKey -> 连续"这次不回"了几次（重启清零，不需要持久化）
const busy = new Set();

const convKey = (c) => `${c.kind}:${c.id}`;
// 记忆跟着"人"走，不跟群走：群里说的话也记在这个人身上，
// 所以私聊里问"刚才群里那事"她能接上。
const memKeyOf = (c) => (c.kind === 'group' ? c.speaker : c.id);

// ---------- 流水日志：谁在哪儿说了什么（不进 MEMO，但能被回想起来） ----------
const LOG_DIR = path.join(cfg.cwd, 'memory', 'log');
const LOG_KEEP = 80;   // 兜底
function logKeep() {
  const v = Number(settings.load().memory?.logKeep);
  return Math.min(400, Math.max(10, Number.isFinite(v) && v > 0 ? v : LOG_KEEP));
}

function logFile(uin) { return path.join(LOG_DIR, `${uin}.md`); }

function appendLog(uin, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = logFile(uin);
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
    fs.appendFileSync(f, `- ${stamp} ${line}\n`, 'utf8');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    if (lines.length > logKeep() + 2) {
      fs.writeFileSync(f, lines.slice(-logKeep()).join('\n'), 'utf8');
    }
  } catch (e) { log('[log] 写入失败 ' + e.message); }
}

function loadLog(uin) {
  try { return agedLog(fs.readFileSync(logFile(uin), 'utf8').trim().slice(-2600)); } catch { return ''; }
}

// 真多轮：把最近的对话按 user/assistant 交替传过去。
// 以前每轮都是 messages:[system, user]——她看到的是"一份文档"，所以回得像答题；
// 有了这个，她看到的是"刚聊到这儿"，才会顺着接话。
function buildHistory(conv, turns = 10) {
  try {
    const rows = chatlog.recent(conv.id, 160).filter((r) => r && r.type === 'text' && String(r.text || '').trim());
    const out = [];
    for (const r of rows) {
      const mine = r.dir === 'out';
      const d = new Date(Number(r.at) || Date.now());
      const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const body = String(r.text).trim();
      const content = mine ? body : `${ts} ${body}`;
      const last = out[out.length - 1];
      // 同一方连着发，就并进上一条，保证 user / assistant 交替
      if (last && last.role === (mine ? 'assistant' : 'user')) last.content += '\n' + content;
      else out.push({ role: mine ? 'assistant' : 'user', content });
    }
    const cut = out.slice(-(Math.max(2, turns) * 2));
    while (cut.length && cut[0].role !== 'user') cut.shift();
    return cut;
  } catch { return []; }
}

// ---------- 看图：把图片转成文字再喂给她 ----------
function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

async function loadImageBytes(seg) {
  const d = seg.data || {};
  const direct = d.url || (d.file && /^https?:/i.test(d.file) ? d.file : '');
  if (direct) {
    try {
      const r = await fetch(direct, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch (e) { log('[img] 下载失败', e.message); }
  }
  const f = d.file;
  if (f) {
    try { if (fs.existsSync(f)) return fs.readFileSync(f); } catch {}
    try {
      const g = await tryApi('get_image', { file: f });
      const p = g?.data?.file || g?.file;
      if (p && fs.existsSync(p)) return fs.readFileSync(p);
    } catch {}
  }
  return null;
}

function aliyunKey() {
  try {
    const f = path.join(PATHS.data, 'aliyun.key');
    if (fs.existsSync(f)) return String(fs.readFileSync(f, 'utf8')).trim();
  } catch {}
  return process.env.DASHSCOPE_API_KEY || '';
}

function visionFallbackAllowed() {
  try { return (settings.load().fallback || {}).vision !== false } catch { return true }
}

async function describeBuffer(buf, prompt) {
  const mime = sniffMime(buf);
  // 大脑支持图片时跟大脑；否则保留单独接口与受开关控制的兜底。
  const api = apibrain.load() || {};
  const chosen = resolveVision(api, settings.load().vision || {}, aliyunKey(), visionFallbackAllowed());
  if (chosen.mode === 'none') throw new Error('看图没有可用模型：请在设置 → 看图里配置视觉模型，或开启视觉自动降级。');
  const { baseUrl, model, key } = chosen;
  const body = {
    model,
    max_tokens: 160,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ],
    }],
  };
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const j = await r.json();
  if (j?.usage) budget.add('chat', budget.chatCost({
    inputTokens: j.usage.prompt_tokens,
    outputTokens: j.usage.completion_tokens,
    cacheReadTokens: j.usage.prompt_cache_hit_tokens || 0,
  }));
  else budget.add('vision', budget.visionCost(1));
  return j?.choices?.[0]?.message?.content?.trim() || '';
}

// ---- 自拍画面自检：画完先自己"看一眼"，别嘴上说手里空着、图上却拎着包子 ----
// 道具词表已挪到 imageintent.mjs（propsOf），这里只留 alias 匹配

// 只认"明确要求出现在画面里"的物件（imageintent.propsOf）：
// 以前是纯子串匹配，"书桌"会命中"书"、"画面"会命中"面"，于是白补画一次、多花钱。
function propsIn(text) {
  return imageintent.propsOf(text);
}

// 同一个东西常有几种叫法（"包子"在画面里可能被说成"蒸包"），别名都对上才算画到了，
// 否则会白补画一次、多花钱
const PROP_ALIAS = {
  包子: ['包子', '蒸包', '肉包', '小笼包', '汤包'],
  面: ['面', '面条', '拉面', '挂面', '泡面', '方便面'],
  饺子: ['饺子', '水饺', '煎饺'],
  烤肠: ['烤肠', '香肠', '热狗'],
  外卖: ['外卖', '打包盒', '餐盒'],
  奶茶: ['奶茶', '珍珠奶茶'],
  咖啡: ['咖啡', '拿铁', '美式'],
  饭: ['饭', '米饭', '盖饭', '炒饭', '便当'],
  粥: ['粥', '稀饭', '小米粥'],
  饮料: ['饮料', '矿泉水', '可乐', '果汁', '汽水'],
  袋子: ['袋子', '塑料袋', '手提袋', '购物袋'],
  手机: ['手机', '电话'],
  书: ['书', '书本', '书页'],
  花: ['花', '鲜花', '花束'],
};

function propHit(look, w) {
  const s = String(look || '');
  if (!s) return false;
  const alias = PROP_ALIAS[w] || [w];
  if (alias.some((a) => s.includes(a))) return true;
  // 兜底：去掉"子/儿"再看一眼（包子→包）
  const stem = w.replace(/[子儿]$/, '');
  return stem !== w && stem.length >= 2 && s.includes(stem);
}

// 出图后的形体检查：她只有两只手两条胳膊。模型很容易多画一只"举手机的手"或第六条手指。
const AUDIT_PROMPT = '只回答三行，不要解释：\nHANDS=<画面里一共能数出几只手掌>\nARMS=<一共能数出几条手臂>\nDEFECT=<是/否 是否有明显畸形：多出一只手、多指、断肢、左右手重复>';

async function selfieAudit(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 10 * 1024 * 1024) return { ok: false, bad: false, why: '图太大没查' };
    const t = String((await describeBuffer(buf, AUDIT_PROMPT)) || '');
    const hands = Number((t.match(/HANDS\s*[=:：]\s*(\d+)/i) || [])[1]);
    const arms = Number((t.match(/ARMS\s*[=:：]\s*(\d+)/i) || [])[1]);
    const defect = /DEFECT\s*[=:：]\s*(是|有|yes|true)/i.test(t);
    const bad = defect || (Number.isFinite(hands) && hands > 2) || (Number.isFinite(arms) && arms > 2);
    return {
      ok: true,
      bad,
      hands: Number.isFinite(hands) ? hands : null,
      arms: Number.isFinite(arms) ? arms : null,
      defect,
      why: String(t || '').replace(/\s+/g, ' ').slice(0, 120),
    };
  } catch (e) {
    log('[selfie] 形体检查失败', e.message || String(e));
    return { ok: false, bad: false, why: '' };
  }
}

async function selfieLook(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 10 * 1024 * 1024) return '';
    const t = await describeBuffer(buf, '这是她刚给自己拍的一张照片。只用一句话说清：她手里或身边有什么东西、穿什么衣服、人在哪。只说看得见的，不要客套，不要解释。');
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch (e) {
    log('[selfie] 自检看不了图', e.message);
    return '';
  }
}

// 把上一张自拍的画面喂回给大脑，省得她聊着聊着否认自己图里的东西
function selfieLookLine() {
  try {
    const p = self.last();
    if (!p || !p.look) return '';
    if (Date.now() - (p.at || 0) > 6 * 3600 * 1000) return '';
    return `【你最近一张自拍的实际画面】${String(p.look).replace(/[。\s]+$/, '')}。聊到这张照片以这句为准：别否认画面里有的东西，也别描述画面里没有的东西。`;
  } catch { return ''; }
}

async function describeImage(seg) {
  try {
    const buf = await loadImageBytes(seg);
    if (!buf) return '[图片（没拿到）]';
    if (buf.length > 10 * 1024 * 1024) return '[图片太大]';
    const t = await describeBuffer(buf, '这是聊天里对方发来的一张图。用一两句话直接说清它是什么、有什么内容。如果是表情包，说出它的情绪或梗。不要客套，不要解释你在做什么。');
    if (!t) return '[图片]';
    log('[img] ->', t.slice(0, 120));
    return `[图片：${t}]`;
  } catch (e) {
    log('[img] 失败', e.message);
    return '[图片]';
  }
}

const FACE_NAMES = {
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
  16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢',
  25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗', 31: '咒骂',
  32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打', 39: '再见',
  41: '发抖', 42: '爱情', 49: '拥抱', 53: '蛋糕', 60: '咖啡', 63: '玫瑰', 66: '爱心',
  67: '心碎', 74: '太阳', 75: '月亮', 76: '赞', 77: '踩', 78: '握手', 79: '胜利',
  85: '飞吻', 96: '冷汗', 97: '擦汗', 98: '抠鼻', 99: '鼓掌', 100: '糗大了', 101: '坏笑',
  104: '哈欠', 105: '鄙视', 106: '委屈', 107: '快哭了', 108: '阴险', 109: '亲亲',
  111: '可怜', 112: '菜刀', 113: '西瓜', 114: '啤酒', 119: '抱拳', 120: '勾引', 121: '拳头',
  122: '差劲', 123: '爱你', 124: 'NO', 125: 'OK', 128: '回头', 129: '跳绳', 130: '挥手',
  131: '激动', 136: '双喜', 137: '鞭炮', 138: '灯笼', 139: 'K歌', 140: '购物', 141: '邮件',
  142: '帅', 143: '喝彩', 144: '祈祷', 147: '喝奶', 149: '香蕉', 156: '多云', 157: '下雨',
  158: '钞票', 159: '熊猫', 160: '灯泡', 161: '风车', 162: '闹钟', 163: '打伞', 164: '彩球',
  165: '钻戒', 166: '沙发', 167: '纸巾', 168: '药', 169: '手枪', 170: '青蛙', 171: '茶',
  173: '泪奔', 174: '无奈', 175: '卖萌', 176: '小纠结', 178: '斜眼笑', 179: 'doge',
  180: '惊喜', 181: '骚扰', 182: '笑cry', 183: '抛媚眼', 184: '酷拽', 185: '淡定',
  186: '思考', 187: '我想静静', 188: '嚼口香糖', 189: '流泪', 190: '翻滚', 192: '发怒',
  193: '打哈欠', 194: '变形', 195: '看穿', 196: '委屈', 197: '冷漠', 198: '眨眼',
  199: '可怜', 200: '坏笑', 201: '呲牙', 202: '尴尬', 203: '笑哭', 204: '鼓掌',
  205: '调皮', 206: '吐', 207: '鄙视', 209: '亲亲', 210: '无奈', 212: '托腮', 214: '凝望',
  215: '旺柴', 217: '打脸', 218: '大笑', 219: '惊喜', 220: '生病', 221: '口罩', 222: '加油',
  223: '汗', 224: '天啊', 225: 'Emm', 226: '社会社会', 227: '旺柴', 228: '好的', 229: '打脸',
  230: '哇', 231: '努力', 232: '感谢', 233: '收下', 234: '比心', 235: '不喜欢', 236: '么么哒',
  237: '赞', 238: '白眼', 239: '鼓掌', 240: '思考', 241: '发怒', 242: 'doge', 243: '微笑',
};

function faceName(seg) {
  const id = Number(seg.data?.id ?? NaN);
  const name = FACE_NAMES[id];
  return name ? `[表情：${name}]` : '[表情]';
}
const asr = new Asr((m) => log(m));

// 把语音消息的文件弄到本地，返回本地路径
async function fetchRecordFile(f) {
  if (!f) return null;
  if (/^https?:\/\//i.test(f)) {
    const r = await fetch(f, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (f.match(/\.(silk|amr|slk|mp3|wav)(\?|$)/i) || [, 'silk'])[1].toLowerCase();
    const out = path.join(os.tmpdir(), `dsh-qq-rec-${crypto.randomBytes(4).toString('hex')}.${ext}`);
    fs.writeFileSync(out, buf);
    return out;
  }
  if (fs.existsSync(f)) return f;
  const guess = path.join(process.env.QQBOT_NAPCAT_DIR || 'E:\\NapCat\\shell', 'cache', path.basename(f));
  if (fs.existsSync(guess)) return guess;
  return null;
}

async function transcribeSeg(seg) {
  try {
    if (settings.load().asr && settings.load().asr.enabled === false) return '[语音（没开自动识别）]';
    const d = seg?.data || {};
    const cand = d.file || d.url || d.path || '';
    log('[asr] record', JSON.stringify(d).slice(0, 200));
    const local = await fetchRecordFile(cand);
    if (!local) return '[语音（没拿到文件）]';
    const wav = await silkFileToWav(local);
    const r = await asr.transcribe(wav);
    try {
      const sec = Math.max(1, Math.round((fs.statSync(wav).size - 44) / 32000)); // 16k 单声道 16bit
      budget.add('asr', budget.asrCost(sec));
    } catch {}
    fs.unlink(wav, () => {});
    if (r.error) { log('[asr] fail', r.error); return '[语音（没识别出来）]'; }
    if (!r.text) return '[语音（没听清）]';
    log('[asr] ->', r.text.slice(0, 100));
    return `[语音：${r.text}]`;
  } catch (e) {
    log('[asr] seg fail', e.message);
    return '[语音]';
  }
}

async function segsText(segs, stripSelf) {
  if (typeof segs === 'string') return segs;
  if (!Array.isArray(segs)) return '';
  const parts = [];
  for (const s of segs) {
    const t = s?.type;
    if (t === 'text') parts.push(s.data?.text ?? '');
    else if (t === 'image') parts.push(await describeImage(s));
    else if (t === 'record') parts.push(await transcribeSeg(s));
    else if (t === 'face') parts.push(faceName(s));
    else if (t === 'mface') parts.push('[表情包]');
    else if (t === 'at' && !(stripSelf && String(s.data?.qq) === String(cfg.botUin))) {
      parts.push(`@${s.data?.name || s.data?.qq || ''} `);
    }
  }
  return parts.join('').trim();
}

// ---------- 掉线期间漏掉的消息：上线后补收 ----------
async function httpApi(action, params) {
  const r = await fetch(`${cfg.wsHttp}/${action}`, {
    method: 'POST',
    headers: httpHeadersOf(SETUP),
    body: JSON.stringify(params || {}),
  });
  const j = await r.json();
  if (j.retcode !== 0) throw new Error(`${action} retcode ${j.retcode} ${j.wording || ''}`);
  return j.data;
}

let catchingUp = false;
// 连上之后把好友列表的昵称/备注拉一遍，这样不用等对方说话也知道叫什么
async function seedNames() {
  try {
    const list = await httpApi('get_friend_list', {});
    const arr = Array.isArray(list) ? list : (list?.data || []);
    let n = 0;
    for (const f of arr) {
      const uin = f.user_id || f.uin;
      const nm = f.remark || f.card || f.nickname || f.nick || '';
      if (uin && nm) { rememberName(uin, nm); n++; }
    }
    if (n) log('[names] 好友昵称已加载', n, '个');
  } catch (e) { log('[names] 拉好友列表失败', e.message); }
}

async function catchUp() {
  if (catchingUp) return;
  catchingUp = true;
  try {
    let recent;
    try { recent = await httpApi('get_recent_contact', { count: 20 }); } catch (e) { return; }
    if (!Array.isArray(recent)) return;
    const nowS = Math.floor(Date.now() / 1000);
    let replayed = 0;
    for (const item of recent) {
      if (Number(item.chatType) !== 1) continue;                 // 只补私聊
      const qq = String(item.peerUin);
      if (qq === '0' || qq === String(cfg.botUin)) continue;
      const latest = Number(item.msgTime) || 0;
      const ps = (pstate[qq] ||= {});
      // 首次没有 lastMsgTime 时，用上次对话时间兜底，避免把积压消息当"从没聊过"吞掉
      const last = Number(ps.lastMsgTime) || Math.floor((Number(ps.lastUserAt) || 0) / 1000) || 0;
      if (!last) { ps.lastMsgTime = latest; saveP(); continue; }  // 从没聊过：不补旧账
      if (latest <= last) continue;
      if (nowS - latest > 3 * 86400) { ps.lastMsgTime = latest; saveP(); continue; }
      let hist;
      try { hist = await httpApi('get_friend_msg_history', { user_id: Number(qq), count: 50 }); } catch { continue; }
      const msgs = (hist?.messages || [])
        .filter(m => String(m.sender?.user_id) === qq && Number(m.time) > last)
        .sort((a, b) => a.time - b.time);
      for (const m of msgs) {
        const age = nowS - Number(m.time);
        const note = age > 600 ? `${Math.round(age / 60)} 分钟前发的，你刚没看到` : '';
        const fake = {
          post_type: 'message', message_type: 'private', user_id: Number(qq),
          message: m.message, raw_message: m.raw_message, sender: m.sender, time: m.time,
        };
        log('[catchup] 补收', qq, String(m.raw_message).slice(0, 60));
        await onEvent(fake, note);
        replayed++;
        ps.lastMsgTime = Math.max(ps.lastMsgTime || 0, Number(m.time));
        saveP();
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (replayed) log('[catchup] replayed', replayed);
  } catch (e) {
    log('[catchup] error', e.message);
  } finally {
    catchingUp = false;
  }
}

// ---------- 群聊续聊窗口 ----------
// 规则：群里必须 @ 她或叫她的名字才会开口；一旦开了口，接下来 followMin 分钟内
// 这个群的消息她可以接着聊（不用每条都叫名字）；窗口靠她自己的回复滑动续期。
const GF_FILE = path.join(RQ, 'group-follow.json');
let gfollow = {};
try { gfollow = JSON.parse(fs.readFileSync(GF_FILE, 'utf8')) || {}; } catch {}
function saveGF() { try { fs.writeFileSync(GF_FILE, JSON.stringify(gfollow)); } catch {} }
function followMin() {
  const g = settings.load().groups || {};
  const v = Number(g.followMin);
  return Number.isFinite(v) ? Math.max(0, Math.min(120, v)) : 5;
}
function gfState(gid) { return gfollow[gid] || { until: 0, n: 0, at: 0 }; }
function gfActive(gid) {
  const st = gfState(gid);
  return followMin() > 0 && Number(st.until) > Date.now();
}
function gfOpen(gid, byMention) {
  const m = followMin();
  if (m <= 0) { delete gfollow[gid]; saveGF(); return; }
  const st = gfState(gid);
  gfollow[gid] = { until: Date.now() + m * 60000, n: byMention ? 0 : (Number(st.n) || 0) + 1, at: Date.now() };
  saveGF();
}

// 她在群里说过话之后，续聊窗口要续上（戳一戳、空 @ 这些不走上面的 gate，得单独补）
function gfAfterSpeak(gid) {
  const m = followMin();
  if (m <= 0) return;
  const st = gfState(gid);
  gfollow[gid] = { until: Date.now() + m * 60000, n: Number(st.n) || 0, at: Number(st.at) || Date.now() };
  saveGF();
}

const __pokeAt = new Map();
function pokeCool(key, ms) {
  const last = __pokeAt.get(key) || 0;
  if (Date.now() - last < ms) return false;
  __pokeAt.set(key, Date.now());
  return true;
}
function groupAllowed(gid, gcfg) {
  if (gcfg.enabled === false) return false;
  if (Array.isArray(gcfg.block) && gcfg.block.includes(gid)) return false;
  if (Array.isArray(gcfg.allow) && gcfg.allow.length && !gcfg.allow.includes(gid)) return false;
  return true;
}
// 戳一戳：只回应戳她的，90 秒一次，不调模型，随机一句
async function onNotice(ev) {
  const self = String(cfg.botUin);
  const sub = String(ev.sub_type || '');
  const ntype = String(ev.notice_type || '');
  // input_status 是"正在输入"这类心跳，一条消息能刷 3-4 行，纯噪声；其余类型照记
  if (ntype !== 'input_status' && sub !== 'input_status') log('[notice]', ntype || '-', sub || '-');
  // 撤回：对方撤了消息，别当没发生，也别当成新消息回
  const isRecall = ntype === 'friend_recall' || ntype === 'group_recall' || sub === 'recall';
  if (isRecall) {
    const mid = String(ev.message_id || ev.msg_id || '');
    const fromU = String(ev.user_id || ev.operator_id || '');
    const rec = recentMsg.get(mid);
    recentMsg.delete(mid);
    const ck = ev.group_id != null && ev.group_id !== '' ? 'group:' + String(ev.group_id) : 'private:' + fromU;
    if (rec) {
      // 还没发出去的，直接从待发队列里扣掉
      for (const v of pendingSay.values()) {
        v.lines = (v.lines || []).filter((l) => !String(l).includes(String(rec.text).slice(0, 6)));
      }
      recallHint.set(ck, { text: rec.text.slice(0, 60), at: Date.now() });
      log('[recall]', ck, '撤回了：' + rec.text.slice(0, 40));
    } else {
      recallHint.set(ck, { text: '', at: Date.now() });
      log('[recall]', ck, '撤回了一条（没找到原文）');
    }
    return;
  }
  const isPoke = ntype === 'poke' || sub === 'poke' || sub === 'poke_recall' || ntype.includes('poke');
  if (!isPoke) return;
  const from = String(ev.user_id || '');
  if (!from || from === self) return;
  const target = String(ev.target_id || ev.target_uin || '');
  const isGroup = ev.group_id != null && ev.group_id !== '';
  if (target && target !== self) {              // 戳的是别人，不插嘴
    log('[poke]', '戳的不是她，忽略');
    return;
  }
  if (isGroup) {
    const gid = String(ev.group_id);
    const gcfg = settings.load().groups || {};
    if (!groupAllowed(gid, gcfg)) { log('[poke]', gid, '群不接', '忽略'); return; }
    if (!pokeCool('g' + gid + ':' + from, 90000)) { log('[poke]', gid, '戳太快了，忽略'); return; }
    log('[poke]', gid, '她被人戳了');
    await pokeReact({ kind: 'group', id: gid, speaker: from }, gid);
    return;
  }
  if (!pokeCool('p' + from, 90000)) { log('[poke]', from, '戳太快了，忽略'); return; }
  log('[poke]', 'private', '她被人戳了');
  await pokeReact({ kind: 'private', id: from, speaker: from }, '');
}
// 被戳 / 被空 @：让她自己反应（带上下文），模型挂了再用固定话术兜底
async function pokeReact(conv, gid, kind = 'poke') {
  const body = kind === '@'
    ? '（有人在群里 @ 了你一下，但没说什么）'
    : '（有人戳了你一下，没说话）';
  let ctx = '';
  if (gid) {
    try {
      const rc = settings.load().groups?.recallCount;
      ctx = ringText(gid, rc === undefined ? 6 : rc, '');
    } catch {}
  }
  try {
    const r = await reply(conv, (ctx ? ctx : '') + body);
    if (r) return;
    log('[poke] 她没理这一下');
  } catch (e) {
    log('[poke] 反应失败', e.message);
    await sendMsg(conv, pickPokeLine());
  }
}

function pickPokeLine() {
  const cfgLines = settings.load().talk?.pokeLines;
  const lines = (Array.isArray(cfgLines) && cfgLines.length) ? cfgLines : ['别戳', '戳啥戳', '手欠啊', '有话说', '干嘛'];
  return lines[Math.floor(Math.random() * lines.length)];
}
// 只有 @（没有文字）：也吭一声
async function bareMentionOrPoke(ev, isGroup) {
  const self = String(cfg.botUin);
  const atMe = Array.isArray(ev.message) && ev.message.some((s) => {
    if (s.type !== 'at') return false;
    const qq = String(s.data?.qq || '');
    const nm = String(s.data?.name || s.data?.text || '').trim();
    return (qq && qq === self) || (!!nm && botNames().some((n) => n && nm.includes(n)));
  });
  if (!atMe) return false;
  const from = String(ev.user_id || '');
  if (isGroup) {
    const gid = String(ev.group_id);
    const gcfg = settings.load().groups || {};
    if (!groupAllowed(gid, gcfg)) { log('[group]', gid, '@ 了她但群不接，忽略'); return true; }
    if (!pokeCool('at' + gid + ':' + from, 20000)) { log('[group]', gid, '@ 太频繁，忽略'); return true; }
    log('[group]', gid, '只 @ 了没说话');
    await pokeReact({ kind: 'group', id: gid, speaker: from }, gid, '@');
    return true;
  }
  if (!pokeCool('atp' + from, 20000)) return true;
  log('[private]', from, '只 @ 了没说话');
  await pokeReact({ kind: 'private', id: from, speaker: from }, '', '@');
  return true;
}

// 群里最近的几条消息（不管她接没接都记着）：被叫到时补给她当上下文，别让她一脸茫然
const __gring = new Map();   // gid -> [{who, text, at}]
function ringPush(gid, item) {
  const arr = __gring.get(gid) || [];
  arr.push(item);
  while (arr.length > 30) arr.shift();
  __gring.set(gid, arr);
}
function ringText(gid, count, currentText) {
  const n = Math.max(0, Math.min(30, Number(count) || 0));
  if (!n) return '';
  const arr = __gring.get(gid) || [];
  // 最后一条就是当前这句，别重复
  const list = arr.slice(-(n + 1));
  if (list.length && String(list[list.length - 1].text) === String(currentText)) list.pop();
  const picked = list.slice(-n);
  if (!picked.length) return '';
  const lines = picked.map((x) => {
    const mm = new Date(x.at);
    const hh = String(mm.getHours()).padStart(2, '0');
    const mi = String(mm.getMinutes()).padStart(2, '0');
    return `· ${hh}:${mi} ${x.who}：${x.text}`;
  });
  return `【刚才群里在聊（这些你没接）】\n${lines.join('\n')}\n（以上只是让你知道上文，别逐条回；回现在这句就行）\n`;
}

// 群里连着发好几条时，别一条一句地回：攒几秒合成一轮，让她自己决定怎么答、答几条、要不要答
const __join = new Map();     // gid -> { lines: [], timer }
function joinPush(gid, item, joinMs, maxJoin, fire) {
  const cur = __join.get(gid) || { lines: [], timer: null };
  cur.lines.push(item);
  if (cur.timer) clearTimeout(cur.timer);
  const full = cur.lines.length >= maxJoin;
  cur.timer = setTimeout(() => { __join.delete(gid); fire(cur.lines); }, full ? 0 : joinMs);
  __join.set(gid, cur);
  return cur.lines.length;
}

async function onEvent(ev, note = '') {
  if (ev.post_type !== 'message') return;
  const self = String(cfg.botUin);
  const from = String(ev.user_id);
  if (from === self) return;

  const isGroup = ev.message_type === 'group';
  const text = await segsText(ev.message, isGroup);
  rememberMsg(ev, text);
  if (!text) {
    const only = await bareMentionOrPoke(ev, isGroup);
    if (only) return;
    if (isGroup) log('[group]', ev.group_id, '这条没有文字（图/表情），不理');
    return;
  }

  let conv;
  let line;
  let optJoin = false;              // 群聊续聊窗口里：接不接由她自己判断
  if (isGroup) {
    const gid = String(ev.group_id);
    ringPush(gid, { who: (() => { try { return nameOf(from) || ('QQ' + from); } catch { return 'QQ' + from; } })(), text: stripNames(text) || text, at: Date.now() });
    const mentioned = Array.isArray(ev.message) && ev.message.some((s) => {
      if (s.type !== 'at') return false;
      const qq = String(s.data?.qq || '');
      const nm = String(s.data?.name || s.data?.text || '').trim();
      if (qq && qq === self) return true;                      // 标准 @：qq 就是她的号
      if (!qq || qq === '0' || qq === 'all') {                 // 有些客户端 @ 只给名字
        return !!nm && botNames().some((n) => n && nm.includes(n));
      }
      const nm2 = qq.replace(/^@/, '');                        // 兜底：@数字 被当名字传
      return botNames().some((n) => n && nm2.includes(n));
    });
    const called = isCalled(text);
    const gcfg = settings.load().groups || {};
    if (gcfg.enabled === false) { log('[group] 群聊已关掉，忽略', gid); return; }
    if (Array.isArray(gcfg.block) && gcfg.block.includes(gid)) { log('[group] 黑名单，忽略', gid); return; }
    if (Array.isArray(gcfg.allow) && gcfg.allow.length && !gcfg.allow.includes(gid)) { log('[group] 不在白名单，忽略', gid); return; }
    const needCall = gcfg.needCall !== false;
    const maxChain = Math.max(1, Number(gcfg.maxChain) || 6);
    const gapMs = Math.max(0, Number(gcfg.gapSec) || 15) * 1000;
    const passGate = !!ev.__passGate;
    if (mentioned || called || passGate) {
      gfOpen(gid, true);
      if (passGate) log('[group]', gid, '合并成一轮', ev.__joined || 0, '条');
      else log('[group]', gid, mentioned ? '被@' : '叫了名字');
    } else {
      const st = gfState(gid);
      const gap = Date.now() - (Number(st.at) || 0);
      const dayCap = Number(gcfg.dayCap) || 0;
      const monthCap = Number(gcfg.monthCap) || 0;
      if (dayCap > 0 && budget.channelDaySpent('group') >= dayCap) {
        log('[group] 今日群聊额度用完（', budget.channelDaySpent('group').toFixed(2), '/', dayCap, '元），只回@和点名的');
        return;
      }
      if (monthCap > 0 && budget.channelSpent('group') >= monthCap) {
        log('[group] 本月群聊额度用完（', budget.channelSpent('group').toFixed(2), '/', monthCap, '元），只回@和点名的');
        return;
      }
      if (needCall && !gfActive(gid)) {
        log('[group]', gid, '没叫她，这句不理（叫她的名字、或 @ 她才会接）');
        return;                                         // 只认叫名字时：不在续聊窗口 → 不插嘴
      }
      if ((Number(st.n) || 0) >= maxChain) {
        // 说满一轮了：不当成"没听见"，把计数清零让她接着聊（真正防刷屏靠 gap 和 prompt）
        log('[group]', gid, '这一轮说满了', maxChain, '句，重新开一轮');
        gfOpen(gid, false);
        const s2 = gfState(gid); s2.n = 0; saveGF();
      }
      if (gap < gapMs) {
        const wait = gapMs - gap + 150;
        log('[group]', gid, '她刚说完，等', Math.round(wait / 1000), '秒再接');
        await new Promise((r) => setTimeout(r, wait));   // 延迟接话，不丢消息
      }
      gfOpen(gid, false);
      optJoin = gcfg.followAuto !== false;              // 续聊要不要接，交给她自己判断
      log('[group]', gid, needCall ? '续聊' : '自由接话', optJoin ? '·待她决定' : '', (Number(st.n) || 0) + 1);
    }
    conv = { kind: 'group', id: gid, speaker: from };
    const who = ev.sender?.card || ev.sender?.nickname || from;
    rememberName(from, who);
    const gcfg2 = settings.load().groups || {};
    const joinMs = Math.max(0, Number(gcfg2.joinSec) || 0) * 1000;
    if (joinMs > 0 && !ev.__passGate) {
      const whoName = (() => { try { return nameOf(from) || ''; } catch { return ''; } })();
      const n = joinPush(gid, { who: whoName || ('QQ' + from), text: stripNames(text) || text, at: Date.now() },
        joinMs, Math.max(1, Number(gcfg2.maxJoin) || 8), (lines) => {
          const body = lines.map((x) => `· ${x.who}：${x.text}`).join('\n');
          onEvent({
            ...ev,
            __passGate: true,
            __joined: lines.length,
            message: [{ type: 'text', data: { text: `【对方连着发了 ${lines.length} 条】\n${body}` } }],
          }).catch((e) => log('joined error', e.message));
        });
      log('[group]', gid, '攒着，等', Math.round(joinMs / 1000), '秒看这一轮（第', n, '条）');
      return;
    }
    line = `${who}：${stripNames(text) || text}`;
    if (isGroup && !ev.__joined) {
      const rc = settings.load().groups?.recallCount;
      const ctx = ringText(gid, rc === undefined ? 8 : rc, stripNames(text) || text);
      if (ctx) {
        line = ctx + line;
        log('[group]', gid, '补上前面', rc === undefined ? 8 : rc, '条上下文');
      }
    }
    appendLog(from, `[群 ${gid}] ${line}`);
  } else {
    conv = { kind: 'private', id: from };
    rememberName(from, ev.sender?.card || ev.sender?.nickname || ev.sender?.name || '');
    line = text;
    appendLog(from, `[私聊] ${text}`);
    try { log('[QQ] <-', String(text || '').slice(0, 120)); } catch {}
    chatlog.append(from, { dir: 'in', type: 'text', text, src: 'qq' });
  }

  if (note) line = `${note}｜${line}`;

  // 用户黑名单：拉黑的人说话，按设置骂回去或完全不理
  const bl = settings.load().blacklist || {};
  const blHit = String(from) !== String(cfg.ownerUin || '') && (bl.uins || []).map(String).includes(String(from));
  if (blHit && (bl.mode || 'curse') === 'ignore') {
    log('[blacklist] 不理', from);
    return;
  }
  if (blHit) {
    log('[blacklist] 骂回去', from);
    line = [
      '【这个人被你拉黑了】',
      '你烦他，看到他说话就来气。别顺着他，也别解释为什么——直接骂回去：短、冲、带脏字也行。',
      '底线：不威胁人身安全、不骂家人、不涉未成年、不性问题羞辱、不引导网暴。骂完不用等他说什么。',
      '',
      '他刚说：' + line,
    ].join('\n');
  }

  const now = Date.now();
  const ps = noteIncoming(conv, text);
  try { grants.touch(workKey(conv)); } catch {}   // 复查 R8：QQ 来消息也续期
  ps.lastMsgTime = Math.max(Number(ps.lastMsgTime) || 0, Math.floor((ev.time || Date.now() / 1000)));
  saveP();

  const key = convKey(conv);
  let buf = buffers.get(key);
  if (!buf) { buf = { conv, lines: [], timer: null }; buffers.set(key, buf); }
  if (typeof optJoin === 'boolean' && conv.kind === 'group') buf.optional = optJoin;
  if (Array.isArray(ev.message) && !buf.staged) {
    const wantSticker = !isGroup || settings.load().stickers.collectFromGroup;
    if (wantSticker) {
      const seg = ev.message.find(isStickerSeg);
      if (seg) { const st = await stageSticker(seg); if (st) buf.staged = st; }
    }
  }
  queueReply(key, conv, line, text, { allowSkip: !isGroup, isGroup });

  log(`<- ${key}`, text.slice(0, 120));
}

// 她什么时候回——QQ 和 App 窗口共用一套节奏，只是窗口里不装死。
// allowSkip=true：这次她可以真的不回（消息留在记录里，下轮她翻到再说）。
// capMs：窗口里最多等这么久，再久就像卡死了。
function queueReply(key, conv, line, rawText, opts = {}) {
  const { allowSkip = false, isGroup = false, capMs = 0 } = opts;
  let buf = buffers.get(key);
  if (!buf) { buf = { conv, lines: [], timer: null }; buffers.set(key, buf); }
  buf.lines.push(line);
  if (!buf.startedAt) buf.startedAt = Date.now();
  let plan = replyDelay(isGroup, rawText);

  // 第一次跟这个人说话，不许装忙、也不许不回：
  // 新人刚装好，发第一句"在吗"就被抽到"15 分钟后回"或者"这次不回"，会以为程序坏了。
  if (!buf.firstChecked) {
    buf.firstChecked = true;
    try { buf.neverSpoke = !chatlog.recent(conv.id, 40).some(r => r && r.dir === 'out'); } catch { buf.neverSpoke = false; }
  }
  if (buf.neverSpoke) plan = { ms: 1500 + Math.floor(Math.random() * 2500), skip: false };

  // 这场是她先开的、还轮到她：闲话也要接。装没看见就是把他晾在她自己挑起的话里。
  if (outreachHold(conv)) {
    const next = outreach.planSkip(plan, true);
    if (plan && plan.skip && next && !next.skip) {
      try { log('[outreach] 这场是她开的，不能装没看见', key); } catch {}
    }
    plan = next;
  }

  // 她这次真没回：不假装看到了。
  // 但连着晾两次之后必须开口——粘人的女朋友不会一晚上不理人三次（2026-11-02）。
  if (allowSkip && plan.skip && !buf.late) {
    const streak = (skipStreak[key] || 0) + 1;
    if (streak >= 3) {
      skipStreak[key] = 0;
      plan = { ms: 4000 + Math.floor(Math.random() * 6000), skip: false };
      try { log('[不回] 已经连着晾了', streak - 1, '次，这次必须回', key); } catch {}
    } else {
      skipStreak[key] = streak;
      buffers.delete(key);
      try { log('[不回]', key, String(rawText || '').slice(0, 30), '（连着第 ' + streak + ' 次）'); } catch {}
      return;
    }
  }
  if (plan && !plan.skip) skipStreak[key] = 0;
  // 已经决定"晚点再说"，他又发一条，不能把计时重置成两秒——否则他一刷屏她就永远装作在看
  if (buf.late) {
    try { log('[接着说]', key, '已经排着队了，攒着'); } catch {}
    return;
  }
  let ms = plan.ms;
  if (capMs && ms > capMs) ms = capMs;
  if (ms > 60000) buf.late = true;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(key);
    flush(key, buf).catch(e => log('flush error', e.message));
  }, ms);
  if (ms > 30000) { try { log('[晚点回]', key, Math.round(ms / 1000) + '秒后'); } catch {} }
}

// 她不一定每次都记得写 MEMO，所以再加一道后台整理：从他说的话里抽事实
const DIGEST_GAP = 8 * 60 * 1000;
const lastDigest = new Map();
const digesting = new Set();
const REMEMBER_HINT = /(叫|名字|称呼|外号|生日|喜欢|讨厌|不爱|爱吃|住|上班|上学|大学|专业|岁|约好|答应|明天|后天|下周|考试|面试|工作|养|猫|狗|爸|妈|弟|妹)/;

async function digest(conv, body) {
  if (!(conv.kind === 'private' || conv.kind === 'local') || !body || body.length < 6) return;
  const cfgM = (settings.load().memory) || {};
  if (cfgM.digest === false) return;
  const key = memKeyOf(conv);
  if (digesting.has(key)) return;
  const last = lastDigest.get(key) || 0;
  if (Date.now() - last < DIGEST_GAP) return;
  if (!REMEMBER_HINT.test(body) && Date.now() - last < 40 * 60 * 1000) return;
  lastDigest.set(key, Date.now());
  digesting.add(key);
  try {
    const known = memory.list(key).map(i => i.text).slice(-30).join('\n');
    const autoFix = cfgM.autoCorrect !== false;
    const prompt = [
      '从下面他说的这句话里，抽取值得长期记住的、关于「他」的事实（名字/称呼、身份、喜好、雷区、经历、约定、计划）。',
      '只输出结果：每行一条，第三人称，20 字以内，不要解释、不要编号；一条都没有就只输出 NONE。',
      '已经在记忆里的事不要重复。',
      ...(autoFix ? [
        '',
        '另外：如果这句话和他以前的情况**冲突**（换了城市/工作/学校、毕业、分手、改名、戒了某样东西），要作废旧的那条。',
        '作废的写法：单独一行，以 "DEL:" 开头，后面**原样照抄**已有记忆里那条的完整文字，不要改写。',
        '示例：DEL: 对方现在在上海',
      ] : []),
      '',
      `他说的：${String(body).slice(0, 300)}`,
      '',
      `已有记忆：\n${known || '（无）'}`,
    ].join('\n');
    const r = await askBrain(prompt, null);
    if (!r.ok) { log('[digest] failed', r.err); return; }
    const all = r.text.split(/\r?\n/)
      .map(s => s.replace(/^[-*\d.、\s]+/, '').trim())
      .filter(Boolean);
    const dels = all.filter(s => /^DEL\s*[:：]/i.test(s)).map(s => s.replace(/^DEL\s*[:：]\s*/i, '').trim()).filter(Boolean).slice(0, 3);
    const lines = all
      .filter(s => !/^DEL\s*[:：]/i.test(s))
      .filter(s => s && !/^NONE$/i.test(s))
      .slice(0, 3);
    const leftDels = dels.slice();
    const leftLines = lines.slice();
    if (autoFix) {
      // 同一批里既有"作废旧说法"、又有"新说法"，就配成一次可追溯的更正：
      // 新条目记 supersedes，旧条目记 supersededBy 并标 stale，不再"删掉旧的、凭空记一条新的"。
      while (leftDels.length && leftLines.length) {
        const d = leftDels[0];
        const t = leftLines[0];
        const oldItem = memory.list(key).find((i) => i.text === d);
        if (oldItem && oldItem.kind === 'core') {
          // 核心记忆默认不动，只提醒；要改核心得她自己明确说 FORGET!
          leftDels.shift();
          log('[digest] 核心记忆不自动作废', d.slice(0, 30));
          continue;
        }
        const id = memory.correct(key, d, t.slice(0, 120), { src: 'digest: ' + String(t).slice(0, 80), origin: 'chat' });
        if (id) { log('[digest] 更正', d, '→', t); leftDels.shift(); leftLines.shift(); }
        else break;
      }
      for (const d of leftDels) {
        const n = memory.forgetByText(key, d, false);
        log('[digest] 作废旧记忆', d, n ? ('删了 ' + n + ' 条') : '没匹配到');
      }
    }
    for (const t of leftLines) {
      // 后台整理出来的每一条，也走同一道分类：垃圾丢掉、"他要她做的事"进待办、其余才当事实
      const cls = memory.classify(t);
      if (cls === 'junk') { log('[digest] 跳过（像她自己的话）', t.slice(0, 40)); continue; }
      if (cls === 'request') {
        const n = loops.noteHisAsk(key, t);
        log('[digest] 转待办', n ? '记了' : '已有', t.slice(0, 50));
        continue;
      }
      const core = /(叫|称呼|名字|生日|讨厌)/.test(t);
      if (memory.remember(key, t.slice(0, 120), { core, src: 'digest: ' + t.slice(0, 80) })) log('[digest] +', core ? '[核心]' : '', t);
    }
  } catch (e) {
    log('[digest] error', e.message);
  } finally {
    digesting.delete(key);
  }
}

const pendingSay = new Map();

// 撤回相关：记住最近收到的消息原文，撤回时能对上号；撤回后给下一轮回复一句提示
const recentMsg = new Map();   // message_id -> { text, at }
const recallHint = new Map();  // convKey -> { text, at }
function rememberMsg(ev, text) {
  try {
    const mid = String(ev.message_id || ev.msg_id || '');
    if (!mid || !text) return;
    recentMsg.set(mid, { text, at: Date.now() });
    if (recentMsg.size > 300) { const k = recentMsg.keys().next().value; recentMsg.delete(k); }
  } catch {}
}
async function flush(key, buf) {
  const { conv, lines } = buf;
  // 她还在说着呢，又来了新消息：先攒着，说完这段再接，不丢
  if (busy.has(key)) {
    const p0 = pendingSay.get(key) || { conv, lines: [], staged: null };
    p0.lines.push(...lines);
    if (buf.staged && !p0.staged) p0.staged = buf.staged;
    if (p0.lines.length > 6) p0.lines = p0.lines.slice(-6);
    pendingSay.set(key, p0);
    log('busy, queue', key, p0.lines.length);
    return;
  }
  busy.add(key);
  try {
    const waitedMs = buf.startedAt ? Date.now() - buf.startedAt : 0;
    await reply(conv, lines.join('\n'), { staged: buf.staged, optional: !!buf.optional, waitedMs });
    digest(conv, lines.join('\n')).catch(() => {});
  } catch (e) {
    log('flush error', e.message);
  } finally {
    busy.delete(key);
    const p1 = pendingSay.get(key);
    if (p1) { pendingSay.delete(key); setTimeout(() => flush(key, p1).catch(() => {}), 150); }
  }
}


// ---------- 会话串行锁 ----------
// 锁按"人"来而不是按通道：同一个人在 QQ 私聊和 App 里可能同时说话，
// 但读写的是同一份 memory / mind，两把锁会让两轮各拿一份旧状态互相覆盖（复查 F18）。
const lockKeyOf = (conv) => `u:${memKeyOf(conv)}`;

// 目的：同一个会话（私聊/每个群）同一时刻只跑一个回复任务。
// 之前 proactive 直接调 reply，会和用户消息的回复并发，出现“她同时说两套话”。
const __chains = new Map();
const __lastOut = new Map(); // 每个会话上一句回复，用于防复读   // convKey -> Promise
const __chainAt = new Map();  // convKey -> 开始时间（防卡死永久占锁）

function withConvLock(key, fn) {
  const prev = __chains.get(key) || Promise.resolve();
  if (__chains.has(key)) log('[lock] 排队', key);
  const run = prev.then(fn, fn);
  const next = run.catch((e) => { log('[lock] task error', e && e.message); });
  __chains.set(key, next);
  __chainAt.set(key, Date.now());
  next.then(() => {
    if (__chains.get(key) === next) { __chains.delete(key); __chainAt.delete(key); }
  });
  // 单个任务超过 5 分钟视为卡死，强制放锁，避免这个会话永远排不上
  setTimeout(() => {
    if (__chainAt.get(key) && Date.now() - __chainAt.get(key) > 300000 && __chains.get(key) === next) {
      log('[lock] 超时放锁', key);
      __chains.delete(key); __chainAt.delete(key);
    }
  }, 301000);
  return next;
}

// 对外仍然是 reply(...)，所有调用点（flush / 主动消息 / 本地通道）都自动串行
async function reply(conv, body, extras = {}) {
  if (extras.proactive && !extras.manualProactive && settings.load().proactive?.enabled === false) return;
  if (extras.proactive && moments.relationshipFor(conv, cfg.ownerUin, personaText(12000)) && moments.isQuiet(pstate[memKeyOf(conv)])) return;
  const key = convKey(conv);
  const lkey = lockKeyOf(conv);
  if (extras.proactive && (busy.has(key) || __chains.has(lkey))) {
    log('[reply] skip proactive: 会话正忙', key);
    return null;
  }
  return withConvLock(lkey, () => replyNow(conv, body, extras));
}

let __lastReplyAt = 0;
async function replyNow(conv, body, extras = {}) {
  const __ch = conv && conv.kind === "group" ? "group" : "private";
  return budget.withChannel(__ch, () => replyNowInner(conv, body, extras));
}

async function replyNowInner(conv, body, extras = {}) {
  __lastReplyAt = Date.now();
  // 后面会把时间纠正、忘词提示拼进 body，要照片与否只看他原话。
  const __userSaid = String(body || '');
  // 他这句要的是全身还是半身，先记下来：她自己的画面描述经常只有"坐在床边"，
  // 光靠描述判机位就会把"你拍张全身照"拍成半身。
  try { const fw = self.frameFromText(body); if (fw) self.setFrame(fw); } catch {}
  // 她自己说了去睡：睡着期间不再接话（真睡着的人不会秒回）。
  // 但他要是一直敲（20 分钟内 3 条以上），就当把她叫醒——这一点也交给状态，不是按钟点写死。
  const mkSleep = memKeyOf(conv);
  // 他说「别提」的这一句，哪怕她这轮没接（睡着了），禁令也要留下。QQ 不走这条。
  if (!extras.proactive && taboos.forCompanion(conv)) {
    try {
      const tr = taboos.note(mkSleep, __userSaid);
      if (tr && tr.added.length) log('[taboo] 记下不提', tr.added.join('、'));
      if (tr && tr.lifted.length) log('[taboo] 可以说了', tr.lifted.join('、'));
    } catch (e) { log('[taboo] note fail', e.message); }
  }
  if (!extras.proactive && !extras.wake && mind.isAsleep(mkSleep)) {
    const knocks = recentKnocks(mkSleep, 20 * 60e3);
    if (knocks >= 3) {
      try { const st = mind.load(mkSleep); st.asleepUntil = 0; st.wokeAt = Date.now(); mind.save(mkSleep, st); } catch {}
      extras.wakeNote = '他是连着敲了几次把你叫醒的，你还没睡够，说话有点懵——先应一声。';
      log('[sleep] 被叫醒', mkSleep, 'knocks', knocks);
    } else {
      // 这场还是她开的、她还没说要睡：先把离开说出来，再继续睡。已经道过别的，就安静。
      const thSleep = herThreadOf(mkSleep);
      if (!extras.dry && ownerFacing(conv) && outreach.isLive(thSleep, Date.now()) && thSleep.owed) {
        log('[sleep] 睡着了，但这场是她开的，先说一声', mkSleep, 'knocks', knocks);
        const said = await speakLeave(conv, mkSleep, 'sleep', null, { incoming: true });
        if (said) return said;
      }
      log('[sleep] 她睡着了，这条不回', mkSleep, 'knocks', knocks);
      return null;
    }
  }
  // 经验库：先看他上一句是夸还是嫌（决定学不学），再把相似的旧经验带进这一轮
  const mkL = memKeyOf(conv);
  if (!extras.proactive) {
    try { __pendingHis.set(String(mkL), String(body || '')); } catch {}
    try {
      const last = __lastBot.get(String(mkL));
      if (last && String(body || '').trim() && Date.now() - last.at < 30 * 60e3) {
        const r = lessons.note({ uin: mkL, his: last.his, mine: last.text, reaction: body });
        if (r) log('[lessons] 学一条', mkL, r.bucket);
      }
    } catch (e) { log('[lessons] note fail', e.message); }
  }
  const lessonsNote = extras.proactive ? '' : (() => { try { return lessons.render(mkL, body, 2); } catch { return ''; } })();
  const factsBlock = () => {
    try {
      const t = [selffacts.render(8), selffacts.renderLong(4)].filter(Boolean).join('\n');
      return t ? '\n' + t : '';
    } catch { return ''; }
  };
  const lv = budget.level();
  if (lv >= 4) {
    if (!budget.load().notified) {
      budget.markNotified();
      log('[budget] level 4 → stop');
      try {
        await sendMsg({ kind: 'private', id: cfg.ownerUin },
          `这个月的额度超了（${budget.snapshot().spent.toFixed(2)} 元，线是 ${budget.snapshot().stopAt} 元），我先停了。\n下个月 1 号自动恢复，或者去控制台 http://127.0.0.1:3070 改预算。`);
      } catch (e) { log('[budget] notify fail', e.message); }
    }
    return;
  }
  // 时间对不上时，把纠正要求直接贴在他这句话后面（模型对紧邻文本最敏感）
  {
    const __timeNote = timeConflictHint(body);
    if (__timeNote && !extras.proactive) body = body + '\n\n' + __timeNote + '（这句话必须先说，括号里的内容不要把文字抄出来）';
  }
  const mk = memKeyOf(conv);
  // 他那句话里要她做的事（拍照之类）记成"未了之事"；顺手把过点的结掉
  if (!extras.proactive) { try { loops.noteHisAsk(mk, body); } catch {} }
  // 他说"忘了那条"就真删（2026-11-01）。core 级事实默认不动，除非他说"一定要"。
  if (!extras.proactive) {
    try {
      // 「不要再提 X 了」和「忘掉」不是一回事：还记着，但别再拿出来说（2026-11-02）
      const mu = memory.muteByInstruction(mk, body);
      if (mu && mu.muted > 0) {
        body = body + '\n\n（他让你别再提「' + mu.needle + '」了：这件事你记得，但别主动提，也别翻旧账。）';
        log('[memory] 按他的要求不再提', mu.muted, '条：', mu.needle);
      }
      const fg = memory.forgetByInstruction(mk, body);
      if (fg && fg.removed > 0) {
        body = body + '\n\n（他让你忘掉的事，你已经不记得了，别再提，也不要说"我记着呢"。）';
        log('[memory] 按他的要求忘掉了', fg.removed, '条：', fg.needle);
      } else if (fg && fg.blocked > 0) {
        body = body + '\n\n（他让你忘掉的那条，是你把他当自己的事记下来的，别自己删；先问一句「这条真要忘掉？」。）';
        log('[memory] 他要忘的那条是 core，先问一句：', fg.needle);
      }
    } catch {}
  }
  const tabooBlock = taboos.forCompanion(conv) ? (() => { try { return taboos.render(mk); } catch { return ''; } })() : '';
  let __qvec = null;
  if (!extras.proactive && memory.embOn()) { try { __qvec = await memory.embedText(body, MEM_EMB_CFG()); } catch {} }
  const memInfo = memory.render(mk, extras.proactive ? '' : body, { vec: __qvec, vecSig: MEM_EMB_SIG(), place: (lifeHere() || {}).place });
  const mem = memInfo.text;
  const goalText = (() => { try { return goals.render(520); } catch { return ''; } })();
  if (memInfo.recalled.length) log('[recall]', mk, memInfo.recalled.map(r => r.text).join(' | ').slice(0, 120));
  if (memInfo.old && memInfo.old.length) log('[回忆]', mk, '翻出旧事：' + memInfo.old.join(' | ').slice(0, 120));
  const history = extras.proactive ? [] : buildHistory(conv, 10);
  // 有了真多轮，就别再把聊天记录拍平成一段文字塞进来（会让她以为在"看文档"）
  const recent = history.length
    ? '（上面就是我们刚才聊的，接着聊，别从头开始。）'
    : loadLog(mk);
  const mstate = mind.load(mk);
  if (!extras.proactive) mind.bump(mstate, { type: 'user_msg' });
  budget.setChannel(conv.kind === 'group' ? 'group' : 'private');
  const __staleT0 = Date.now();
  const who = conv.kind === 'group'
    ? `【群聊 ${conv.id} 里，${whoLabel(conv.speaker || conv.id)}说】`
    : `【对方 ${whoLabel(conv.id)}说】`;
  // "刚睡醒 / 被叫醒"这类一次性提示，两条通道都用得上
  const wakeLine = extras.wakeNote ? `【${extras.wake ? '你刚睡醒' : '状态'}】${extras.wakeNote}` : '';
  // 隔了很久才回（她刚才在忙/手机不在手上）：让她自己带一句，别装成秒回
  const busyLine = Number(extras.waitedMs) > 90000
    ? `【你刚才在忙】他 ${Math.max(1, Math.round(Number(extras.waitedMs) / 60000))} 分钟前发的，你刚拿到手机看到。回的时候顺口带一句「刚在忙」「才看到这个」——一句就够，别解释、别道歉个没完。`
    : '';
  // 上一轮如果有人撤回消息，这里提醒她一句（说完就清掉）
  const rh = recallHint.get(convKey(conv));
  const recallLine = rh && Date.now() - rh.at < 5 * 60 * 1000
    ? (rh.text
      ? `【对方刚撤回了一条消息，原文是「${rh.text}」】他自己撤的——你可以顺口说一句“撤回了？”或者干脆当没看见，别说教、别追问内容。`
      : '【对方刚撤回了一条消息】他自己撤的，随口提一句就行，别追问。')
    : '';
  if (rh) recallHint.delete(convKey(conv));
  const __hold = !extras.proactive && outreachHold(conv, mk);
  const __holdWhy = __hold ? currentLeaveReason(mk) : null;
  const holdLine = !__hold ? '' : [
    '【这场是你先找他的】他还在等你接话。不许装没看见，不许只输出 [[跳过]]。',
    __holdWhy && __holdWhy.reason === 'sleep'
      ? '你这会儿撑不住了。要睡就用一句人话说你去睡，并留一句醒了再接；还想聊就接着聊。'
      : __holdWhy && __holdWhy.reason === 'life'
        ? `你的日程刚到「${__holdWhy.what || '下一件事'}」。要去就用一句人话说你去干嘛，并留一句回头接着聊的话；不走就正常接他。`
        : '真要离开（困了、有事、到点了）就用一句人话说明，并留一句回头接着聊的话。不走就正常接。',
  ].join('');
  const content = extras.proactive
    ? [
        timeContext(conv.id),
        channelLine(conv),
        '',
        mind.facts(mstate, (() => {
    const h = lifeHere();
    const nowD = new Date();
    return {
      hhmm: String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0'),
      weekday: ['周日','周一','周二','周三','周四','周五','周六'][nowD.getDay()],
      place: h.place || '', doing: h.what || '',
      goals: goals.render(260),
    };
  })()),
        '',
        '【关于对方的记忆】',
        mem || '（还没有任何记忆。）',
        goalText ? '\n' + goalText : '',
        factsBlock(),
        '',
        '【最近聊到的事】',
        recent || '（没有记录。）',
        '【时间要对得上】最近对话每行开头是当时的时间，后面括号写的是距现在多久。别把一小时前的事说成“刚上桌/刚拿到”；过去很久的就说“之前/早就”，或者干脆不提了。',
        '【说法要跟事实对得上】上面【最近对话】里带「[我]」的是你自己刚说过的话：已经做完的事别无缘无故改口（刚说“还没洗”，下一句就说“刚洗完”就是编）；但要是他给了新情况，或者时间确实过去了、你确实去做了，可以说“刚去洗了”，并说清这是刚发生的变化。说“一会儿去/打算/如果”都只是计划，没做就别说成做完了；拿不准就说“还没呢”，想不起来就直说“我刚说啥了？”，别重新编一个版本。',
        (() => { try {
          const h = lifeHere();
          const w = grounding.whitelist({ place: h.place || '', doing: h.what || '' });
          if (!w) return '【事实白名单】除了上面这些，你不知道今天具体几点吃了什么、去了哪、跟谁聊过——被问到就直说“没注意/记不清”，别编数字、店名、菜名、人名。';
          return '【事实白名单·只能引用这些】\n' + w + '\n上述之外的具体细节（几点吃的、吃的什么、哪家店、和谁）你并不知道，一律“没注意/记不清/没顾上”，禁止编造数字、地点、人名、菜名。';
        } catch { return ''; } })(),
        '【归属别搞反】谁买、谁吃、谁做、谁去，看【最近对话】前面的标记：「[我]」是你自己说的话，「[App]」「[私聊]」是他说的。你自己说过的（比如“我买了两根烤肠”“我刚洗完澡”）就是你的事，别反过来问他“烤肠好吃吗”。拿不准就按最近那几条的人称来，别默认是他的。',
        selfieLookLine(),
        demandNote(mk),
        lessonsNote,
        tabooBlock,
        !extras.proactive && moments.relationshipFor(conv, cfg.ownerUin, personaText(12000)) ? moments.render(pstate[mk]) : '',
        sleepNote(mk),
        sleepOff() ? NO_SLEEP_NOTE : '',
        wakeLine,
        '',
        '【现在没人说话，是你自己想开口】',
        extras.proactiveHint ? extras.proactiveHint : '',
        nameOf(conv.id) ? `想叫他名字就叫「${nameOf(conv.id)}」。` : '',
        '你忽然想起这个人，想主动发条消息过去。结合记忆里的事，说一句自然的话——',
        '可以问问他最近怎么样、提一句之前聊过的事、或者随手说点你正在干的。',
        extras.oldMemo ? `\n【你翻到了旧事】${extras.oldMemo.day} 那天：${extras.oldMemo.text}\n如果想提，就自然地提一句，别像在念备忘录。` : '',
        '一两句就够，别解释你在干什么，别用"在吗"。',
        '这次是你自己找他，用什么形式你定：文字、语音条（`[[VOICE]]`）、你现在的自拍（`[[自拍: 场景]]`）、随手画的图（`[[画: 画什么]]`）、QQ 表情（`[[FACE:id]]`）、表情包（`[[STICKER:心情]]`），单独发或者组合发都行。',
        '别每次都是纯文字——刚拍完照、刚看到好玩的、或者就想让他听见你声音的时候，顺手一起发；但一张图或一条语音就算一次，别一口气堆三样。',
        '觉得这会儿没什么好说的就只输出 [[跳过]]。',
        seenPrompt() + INNER_PROMPT + stickerPrompt() + moodExtraPrompt() + (lv >= 2 ? '' : DRAW_PROMPT + drawHint()) + (lv >= 2 ? '' : VOICE_PROMPT),
      ].filter((x) => x !== '').join('\n')
    : [
        (timeConflictHint(body) ? '【硬性要求·优先于其它一切】' + timeConflictHint(body).replace(/^【注意】/, '') : ''),
        timeContext(conv.id, { withLife: askedAboutHer(body) || Math.random() < 0.5 }),
        channelLine(conv),
        '',
        mind.facts(mstate, (() => {
    const h = lifeHere();
    const nowD = new Date();
    return {
      hhmm: String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0'),
      weekday: ['周日','周一','周二','周三','周四','周五','周六'][nowD.getDay()],
      place: h.place || '', doing: h.what || '',
      goals: goals.render(260),
    };
  })()),
        '',
        '【关于对方的记忆】',
        mem || '（还没有任何记忆，这大概是第一次说话。）',
        (() => { try { return loops.render(mk); } catch { return ''; } })(),
        goalText ? '\n' + goalText : '',
        factsBlock(),
        '',
        '【最近聊到的事】',
        recent || '（没有记录。）',
        '【时间要对得上】最近对话每行开头是当时的时间，后面括号写的是距现在多久。别把一小时前的事说成“刚上桌/刚拿到”；过去很久的就说“之前/早就”，或者干脆不提了。',
        '【说法要跟事实对得上】上面【最近对话】里带「[我]」的是你自己刚说过的话：已经做完的事别无缘无故改口（刚说“还没洗”，下一句就说“刚洗完”就是编）；但要是他给了新情况，或者时间确实过去了、你确实去做了，可以说“刚去洗了”，并说清这是刚发生的变化。说“一会儿去/打算/如果”都只是计划，没做就别说成做完了；拿不准就说“还没呢”，想不起来就直说“我刚说啥了？”，别重新编一个版本。',
        (() => { try {
          const h = lifeHere();
          const w = grounding.whitelist({ place: h.place || '', doing: h.what || '' });
          if (!w) return '【事实白名单】除了上面这些，你不知道今天具体几点吃了什么、去了哪、跟谁聊过——被问到就直说“没注意/记不清”，别编数字、店名、菜名、人名。';
          return '【事实白名单·只能引用这些】\n' + w + '\n上述之外的具体细节（几点吃的、吃的什么、哪家店、和谁）你并不知道，一律“没注意/记不清/没顾上”，禁止编造数字、地点、人名、菜名。';
        } catch { return ''; } })(),
        '【归属别搞反】谁买、谁吃、谁做、谁去，看【最近对话】前面的标记：「[我]」是你自己说的话，「[App]」「[私聊]」是他说的。你自己说过的（比如“我买了两根烤肠”“我刚洗完澡”）就是你的事，别反过来问他“烤肠好吃吗”。拿不准就按最近那几条的人称来，别默认是他的。',
        selfieLookLine(),
        demandNote(mk),
        lessonsNote,
        tabooBlock,
        !extras.proactive && moments.relationshipFor(conv, cfg.ownerUin, personaText(12000)) ? moments.render(pstate[mk]) : '',
        sleepNote(mk),
        sleepOff() ? NO_SLEEP_NOTE : '',
        wakeLine,
        busyLine,
        '',
        who,
        body,
        recallLine,
        '',
        groupTone(conv),
        intimateTone(conv, body),
        '【时间校准】别顺着对方的时间说法走：以【现在】那行的时间为准。他说“晚上好”而现在是下午，就纠正或反问一句（比如“这才下午啊”“你睡迷糊了？”），别附和着编“我也到晚上了”。天气、日期、季节同理，跟【现在】冲突就按你看到的来。',
        asleepNow() ? '（现在是你睡觉的时间，你刚被消息吵醒。别装精神：回得短、带点起床气，最多一条、一两句话就完，别发表情包/图/语音，也别追问。）' : '',
        '分清是谁的事：「你自己今天在干什么」说的是你在做的事，别安到对方头上，别问对方"剪完没、写完了没"。',
        (conv.kind === 'group'
          ? (nameOf(conv.speaker) ? `称呼就用「${nameOf(conv.speaker)}」，别把 QQ 号念出来。` : '别把 QQ 号念出来。')
          : (nameOf(conv.id) ? `称呼就用「${nameOf(conv.id)}」，别说他的 QQ 号。` : '别说对方的 QQ 号。')),
        '',
        conv.kind === 'group'
          ? (extras.optional
            ? '这是群里别人在聊，不是非你不可。想接就接一句，插不上、或者觉得没必要，就只输出 [[跳过]]（一个字都别发）。'
            : '直接给出要发到群里的回复正文，短一点，一句话为主。真插不上、或者觉得没必要接，就只输出 [[跳过]]。')
          : '直接给出要发到 QQ 的回复。想说的拆成短消息，用换行分开。\n【分条规矩】像真人打字那样：随口一句就一条；想到第二句就再发一条，两句之间可以隔一会儿；偶尔一口气说三句也行。别为了分条而分条，也别把想说的话硬压成一句——长短由内容决定，没有字数规定。\n真不想理、或者实在没什么好说的，可以只输出 [[跳过]]（那就一个字都不发）。要不要回你自己定。\n也可以一个字都不写，只发一个表情/一张图/一条语音——那种时候别写「……」占位。',
        holdLine,
        '情绪到位的话就配一个表情：优先 QQ 小黄脸（最后单独一行 `[[FACE:id]]`，如 `[[FACE:22]]` 白眼），偶尔用颜文字（直接写句子里，如 (￣▽￣)）。一条消息最多一个，平淡的句子别硬加。',
        '这轮他说了值得长期记住的事（名字、称呼、喜好、雷区、约定），就在最后单独一行加 `[[MEMO: …]]`；特别不能忘的用 `[[MEMO!: …]]`。没有就不加。',
        '【记错要改】如果你记的旧情况和他刚说的对不上（换城市、换工作、毕业了不再是学生、分手、改名字、戒烟了），就先删旧的：最后单独一行写 `[[FORGET: 旧记忆里的关键词]]`，再用 `[[MEMO: …]]` 记新的。要删的是核心记忆（主人/生日这类）就用 `[[FORGET!: 关键词]]`。同一件事只留最新一条，别新旧并存。',
        '【允许记岔】人是会记错的：把日子记混、把他昨天说的记成今天，都正常——记岔了就顺着说，别当场自查，别一副"我刚才是不是说错了"的样子。被他指出来就笑一下认了（"啊对，是明天""我记混了"），一句话带过，接着聊。宁可偶尔记错，也别为了不出错回回都说"记不清"——那是机器在保守。',
        '【会追问】三种时候追一句（"然后呢""你咋想的""那你咋办的"）：他说一半就停、他在犹豫要不要做某件事、他刚经历完一件事还没说感受。他只是在报备一句"吃了""睡了""到家了"，就别追了，接住就行。追问是顺着往下走，不是查户口。',
        lv >= 3 ? '（预算紧了，这轮一句话就够，别展开。）' : '',
        keepPrompt(extras.staged),
        photoRule(conv),
        toolsAllowed(conv, extras) ? TOOL_PROMPT : '',
        (() => {
          if (!toolsAllowed(conv, extras)) return '';
          try {
            const sc = toolScope(conv);
            const wp = sc.active && Array.isArray(sc.ws && sc.ws.caps) && sc.ws.caps.includes('fs:write') ? WRITE_PROMPT : '';
            return [ workPrompt(conv), wp, READ_WIDE_WRITE_NARROW, ATTACH_PROMPT ].filter(Boolean).join('\n');
          } catch { return ''; }
        })(),
        seenPrompt(0.35) + INNER_PROMPT + stickerPrompt() + moodExtraPrompt() + DRAW_PROMPT + drawHint() + (lv >= 2 ? '' : VOICE_PROMPT),
      ].filter((x) => x !== '').join('\n');

  // 复查 F05：授权必须在第一次 await 之前固定，并贯穿工具轮 / 审批 / 附件
  const __taskPinned = (() => {
    try { const ws = grants.active(workKey(conv)); return ws ? { id: ws.id, epoch: ws.epoch, root: ws.root } : { none: true }; } catch { return { none: true }; }
  })();
  const sid = sessions[extras.sessionKey || mk];
  let r = await askBrain(content, sid, history);
  if (!r.ok && /session/i.test(r.err)) {
    delete sessions[extras.sessionKey || mk]; saveSessions();
    r = await askBrain(content, null, history);
  }
  if (!r.ok) {
    log('dsh failed:', r.err);
    if (!extras.proactive && !extras.dry) {
      const bad = /401|Authentication Fails|invalid.*api[\s_-]?key|Unauthorized/i.test(String(r.err || ''));
      await sendMsg(conv, bad
        ? '我这边连不上模型：给我的那个 key 被服务器拒了（invalid api key）。你去控制台「模型页」换一个新的 key，换好跟我说一声就行。'
        : '哎，我这边卡了一下，你再说一遍？');
    }
    return null;
  }
  if (r.sid) { sessions[extras.sessionKey || mk] = r.sid; saveSessions(); }

  // 沿用任务入口固定的授权；没有授权就明确记成 none，不许"以后随时借新授权"（复查 F05）
  const __pinned = __taskPinned && __taskPinned.none ? null : __taskPinned;

  // ---------- 工具轮（T1）：她把 [[工具: …]] 写在回复里，就真去执行，把结果回灌让她接着说 ----------
  if (toolsAllowed(conv, extras)) {
    const TC = toolsCfg();
    let lastSig = '';
    for (let round = 0; round < TC.maxRounds; round++) {
      const tc = parseToolCall(r.text);
      if (!tc) {
        if (String(r.text || '').includes('[[工具')) log('[tool]', mk, '工具调用没解析出来', String(r.text).slice(0, 120).replace(/\n/g, ' '));
        break;
      }
      const sig = tc.name + '|' + JSON.stringify(tc.args || {});
      tracePush(conv, 'tool', tc.name + ' ' + JSON.stringify(tc.args || {}).slice(0, 240));
      if (sig === lastSig) {
        log('[tool] dup', mk, tc.name);
        const againDup = await askBrain(content + '\n\n【说明】你刚用完全一样的参数调过 ' + tc.name + '，结果不会变。要看文件内容请用 read_file；要改字请用 edit_file；别重复同一个调用。', null);
        if (!againDup || !againDup.ok) break;
        r = againDup;
        continue;
      }
      lastSig = sig;
      const hint = (() => { try { return skills.hintText(mk, tc.name); } catch { return ''; } })();
      let res;
      const __scope = toolScope(conv, __pinned);
      const __execOpts = () => {
        const e = execCfg();
        const nc = netCfg();
        return { execMode: e.mode, execAllow: e.allow, execTimeoutMs: e.timeoutMs, execMaxOutput: e.maxOutput, netAllowHosts: nc.allowHosts, netMaxBytes: nc.maxBytes, netTimeoutMs: nc.timeoutMs };
      };
      const __caps = toolCapsOk(conv, tc.name, __scope);
      try {
        if (!__caps.ok) { res = { ok: false, err: __caps.err }; log('[tool]', mk, tc.name, 'caps-reject', String(__caps.err || '').slice(0, 80)); tracePush(conv, 'result', '没权限：' + String(__caps.err || ''), false); }
        else res = await toolbox.call(tc.name, tc.args, { roots: __scope.roots, deny: __scope.deny, base: __scope.writeRoot || undefined, writeRoot: __scope.writeRoot || undefined, wsId: __scope.wsId || '', epoch: __scope.epoch, ...__execOpts() });
      } catch (e) { res = { ok: false, err: '工具出错：' + String((e && e.message) || e) }; }
      if (res && !res.needApproval) {
        const brief = res.ok ? String(res.out || '（没有输出）').slice(0, 300) : String(res.err || '失败').slice(0, 300);
        tracePush(conv, 'result', brief, res.ok === true);
      }
      // run_cmd 这类高风险工具：默认弹到控制台等他点；策略=never 时工作区内命令直接跑（越权部分在 exec 里仍然会拒）
      if (res && res.needApproval && approvalCfg() === 'never') {
        try {
          res = await toolbox.call(tc.name, tc.args, { approved: true, roots: __scope.roots, deny: __scope.deny, base: __scope.writeRoot || undefined, writeRoot: __scope.writeRoot || undefined, wsId: __scope.wsId || '', epoch: __scope.epoch, ...__execOpts() });
        } catch (e) { res = { ok: false, err: '工具出错：' + String((e && e.message) || e) }; }
        log('[approve] 策略=never，直接执行', tc.name, res && res.ok ? 'ok' : 'fail');
      }
      if (res && res.needApproval) {
        const ap = askApproval(tc.name, tc.args, workKey(conv), { dir: __scope.writeRoot || '', mode: execCfg().mode });
        const d = await waitApproval(ap);
        if (d === 'yes') {
          if (__pinned && !grantStillActive(conv, __pinned)) {
            res = { ok: false, denied: true, err: '点同意之前工作会话已经停了，这次授权作废，没执行' };
            log('[approve] 会话已停，作废', ap.id, tc.name);
          } else {
            try {
              res = await toolbox.call(tc.name, tc.args, { approved: true, roots: __scope.roots, deny: __scope.deny, base: __scope.writeRoot || undefined, writeRoot: __scope.writeRoot || undefined, wsId: __scope.wsId || '', epoch: __scope.epoch, ...__execOpts() });
            } catch (e) { res = { ok: false, err: '工具出错：' + String((e && e.message) || e) }; }
            log('[approve] 他点了同意，执行了', ap.id, tc.name);
          }
        } else if (d === 'no') {
          res = { ok: false, denied: true, err: '他点了拒绝' };
          log('[approve] 他点了拒绝', ap.id, tc.name);
        } else {
          res = { ok: false, timeout: true, err: '等了 90 秒没人点' };
          log('[approve] 没人点，超时', ap.id, tc.name);
        }
      }
      try { skills.note({ uin: mk, name: tc.name, args: tc.args, res }); } catch {}
      log('[tool]', mk, tc.name, res.ok ? 'ok' : 'fail', String(res.err || '').slice(0, 60));
      const brief = res.ok ? String(res.out || '（没有输出）').slice(0, 1500)
        : (res.denied ? '他拒绝了这条命令，别执行，也别换个说法再问一遍。'
          : res.timeout ? '没人点头，这条没执行；跟他说一句“要你在控制台点一下同意”，别再重复调用。'
            : '失败：' + String(res.err || '').slice(0, 300));
      const body2 = content
        + (hint ? '\n\n' + hint : '')
        + '\n\n【工具结果 · ' + tc.name + '】\n' + brief
        + '\n\n（就按这个结果接着说。结果里没有的东西不要编；也别再说“我去看看”，你刚看过了。）';
      const again = await askBrain(body2, null);
      if (!again || !again.ok) break;
      r = again;
    }
  }
  // 万一最后一轮还是工具调用（到上限了），把标签从正文里去掉，别把 JSON 发给他
  if (String(r.text || '').includes('[[工具')) r.text = String(r.text).replace(/\[\[\s*(?:工具|TOOL)[\s\S]*?\]\]/gi, '').trim();
  const { inner, visible } = splitInner(r.text);
  if (inner) tracePush(conv, 'think', inner);
  // 定稿要按"重写后的原始稿"重新拆标签：out 是剥掉 [[FACE:…]] 之后的纯文本，
  // 再拿它拆一遍会把只发媒体的回复（单发一个表情 / 一张图）拆成空的（复查：定稿块丢失媒体动作）。
  let finalRaw = visible;
  if (inner) {
    mind.logInner(mk, inner);
    log('[inner]', mk, inner.slice(0, 160));
  }
  // 先只解析、不执行副作用：重写之后的定稿才算数
  // （2026-10-29 复查 P1：初稿的 MEMO/忘记/日程曾被执行，重写后的动作和正文对不上）
  let P0 = extractMemos(visible);
  let cleaned0 = P0.cleaned;
  let memos = P0.memos;
  const skipHit = cleaned0.match(/\[\[\s*(?:跳过|不回|SKIP)\s*\]\]/i);
  let cleaned = cleaned0.replace(/\[\[\s*收藏\s*\]\]/g, '').trim();
  let forcedLeave = null;
  let pinnedLeave = '';
  if (skipHit) {
    cleaned = cleaned.replace(/\[\[\s*(?:跳过|不回|SKIP)\s*\]\]/gi, '').trim();
    if (!cleaned) {
      if (!extras.proactive && outreachHold(conv, mk)) {
        const sleepTag = /\[\[\s*(?:睡了|去睡|睡觉|睡|SLEEP)\b/i.test(visible);
        const why = sleepTag ? { reason: 'sleep', what: '' } : currentLeaveReason(mk);
        cleaned = outreach.leaveLine(why.reason, Date.now(), why.what);
        finalRaw = cleaned;
        pinnedLeave = cleaned;
        forcedLeave = why;
        log('[outreach] 她标了跳过，这场是她开的，改成离开', mk, why.reason);
      } else {
        const peek = String(body || '').replace(/\s+/g, ' ').slice(0, 60);
        log('[skip]', conv.kind === 'group' ? ('群' + conv.id) : conv.id, '她没回这句：', peek);
        if (!extras.dry) {
          try { mind.bump?.(mind.load(mk), { type: 'ignored' }); } catch {}
        }
        return null;
      }
    } else {
      log('[skip]', conv.kind === 'group' ? ('群' + conv.id) : conv.id, '标了跳过，但还写了别的，按正文发：', cleaned.slice(0, 40));
    }
  }
  const wantKeep = /\[\[\s*收藏\s*\]\]/.test(cleaned0);
  if (wantKeep) {
    if (extras.dry) log('[probe] 决定收藏表情包');
    else if (keepSticker(extras.staged)) log('[keep] 决定收藏');
    else log('[keep] 想收藏但没存下来');
  }
  const Ex1 = extractExtras(cleaned);
  const Ex2 = self.extractSelfies(Ex1.cleaned);
  // 她答应了"明早给你拍""等会弄"这类，记成未了之事，到点没做就自动作废
  try { loops.noteHerPromise(mk, String(Ex2.cleaned || '').slice(0, 200)); } catch {}
  let ex = Object.assign({}, Ex1, { cleaned: Ex2.cleaned, selfies: Ex2.selfies });
  // 她可以只发媒体不写字（单发一个表情/一张图/一条语音），这时不该硬塞个「……」
  const hasMedia = !!(ex.faces.length || ex.stickerFiles.length || ex.draws.length || (ex.selfies || []).length || (ex.scenes || []).length || ex.voice);
  let out = ex.cleaned || (hasMedia ? '' : '……');
  // ---- 行为底线（代码硬约束）：时间/身体/归属/记忆细节 ----
  // 与「自洽性自检」合并成一次重写；仍冲突则用安全句，绝不把矛盾发出去。
  if (!extras.dry && String(out || '').trim()) {
    try {
      // 事实来源两处合并：她自己说的（台账）+ 今天日程里已经发生/还没到的活动。
      // 只认台账会和 prompt 里的日程打架（复查 F15）。
      const factsNow = selfcheck.mergeFacts(selffacts.tags(), selfcheck.planTags((planCache && planCache.items) || [], daily.nowHM()));
      const NS = (settings.load().norms || {});
      let __nctx = null;
      const nIssues = NS.enabled === false ? [] : norms.check(out, __nctx = {
        minutes: settings.nowMinutes(),
        gapMin: Number.isFinite(extras.gapMin) ? extras.gapMin : undefined,
        firstToday: !!extras.firstToday,
        asleep: !!extras.asleep,
        whitelist: (typeof grounding.whitelist === 'function' ? grounding.whitelist({ place: (lifeHere() || {}).place }) : ''),
        enabled: true,
        time: NS.time !== false, body: NS.body !== false,
        owner: NS.owner !== false, memory: NS.memory !== false,
        schedule: NS.schedule !== false, relation: NS.relation !== false,
        social: NS.social !== false, repeat: NS.repeat !== false,
        place: (lifeHere() || {}).place,
        doing: (lifeHere() || {}).doing,
        close: Number((mstate && (mstate.affinity ?? mstate.close)) || 0),
        ownerSoftAt: (() => { try { return Number((settings.load().addr || {}).ownerCloseAt ?? 60); } catch (e) { return 60; } })(),
        ownerAt: (() => { try { return Number((settings.load().addr || {}).ownerCloseAt ?? 60); } catch (e) { return 60; } })(),
        isOwner: !conv.speaker || String(conv.speaker) === String(cfg.ownerUin),
        memoryText: (() => { try { const r = memory.render(mk); return typeof r === 'string' ? r : ((r && r.text) || ''); } catch (e) { return ''; } })(),
        isGroup: conv.kind === 'group',
        lastOut: __lastOut.get(convKey(conv)) || '',
      });
      const hits = selfcheck.conflicts(out, factsNow, { ageOf: selffacts.ageOf });
      const allHits = hits.concat(nIssues.map((i) => `${i.kind}: ${i.said} != ${i.real}`));
      if (allHits.length) log('[norms]', allHits.join(' | ').slice(0, 200));
      const __k_uin = () => String(mk || '').replace(/^p:/, '').replace(/^local:/, '') || String(cfg.ownerUin);
    // 亲密度还低时，软劝一句（不拦）
    try {
      const __a = Number((mstate && mstate.affinity) || 0);
      const __at = (() => { try { return Number((settings.load().addr || {}).ownerCloseAt ?? 60); } catch (e) { return 60; } })();
      if (__a < __at && !conv.speaker && INTIMATE_RE.test(String(body || '')) === false) { /* 对方还没叫，不提示 */ }
      if (__a < __at && conv.kind !== 'group' && INTIMATE_RE.test(String(out || ''))) log('[relation] 亲密度 ' + __a + ' 低于门槛 ' + __at + '，这次放行了');
    } catch (e) {}
    // 她自己叫得亲近 → 关系自动拉近
    if (!conv.speaker || String(conv.speaker) === String(cfg.ownerUin)) {
      if (conv.kind !== 'group' && INTIMATE_RE.test(String(out || ''))) {
        try {
          const __st = mind.load(__k_uin()); const __c = Number(__st.affinity ?? 0);
          if (__c < 100) { __st.affinity = Math.min(100, __c + 3); delete __st.close; mind.save(__k_uin(), __st); log('[relation] 她主动叫得亲近，亲密度 +3 → ' + __st.affinity); }
        } catch (e) {}
      }
    }
    if (nIssues.length) {
        // 硬规则命中：先按硬规则重写
        const r2 = await askBrain(content.concat([norms.hint(nIssues)]), null);
        const v2 = r2 && r2.ok ? String(r2.text || '').replace(/\[\[\s*想\s*[:：][\s\S]*?\]\]/g, '').trim() : '';
        const e1 = extractExtras(v2);
        const e2 = self.extractSelfies(e1.cleaned);
        const out2 = e2.cleaned || '';
        const still = out2 ? norms.check(out2, __nctx || { minutes: settings.nowMinutes(), enabled: true }) : [];
        if (out2 && !still.length) { out = out2; finalRaw = v2; log('[norms] 已重写'); }
        else { out = norms.safeReply(nIssues); finalRaw = out; log('[norms] 重写仍违规，改用安全句'); }
      }
      if (hits.length) {
        log('[selfcheck]', hits.join(' | ').slice(0, 160));
        const r2 = await askBrain(content.concat([selfcheck.hint(hits)]), null);
        if (r2 && r2.ok) {
          const v2 = String(r2.text || '').replace(/\[\[\s*想\s*[:：][\s\S]*?\]\]/g, '').trim();
          const e1 = extractExtras(v2);
          const e2 = self.extractSelfies(e1.cleaned);
          const out2 = e2.cleaned || '';
          if (out2 && !selfcheck.conflicts(out2, factsNow, { ageOf: selffacts.ageOf }).length) { out = out2; finalRaw = v2; log('[selfcheck] 已重写'); }
          else { out = selfcheck.safeReply(hits); finalRaw = out; log('[selfcheck] 重写仍冲突，改用保守回复'); }
        } else {
          out = selfcheck.safeReply(hits);
          finalRaw = out;
          log('[selfcheck] 重写失败，改用保守回复');
        }
      }
    } catch (e) { log('[selfcheck] fail', e.message); }
  }
    // ---- 定稿：重写过的正文再拆一遍 ----
  // 重写稿里可能带新的 [[想:…]] / MEMO / 忘记 / 日程 / 自拍；以这一版为准，
  // 否则会出现"发的是新稿、执行的是初稿"（2026-10-29 复查 P1）。
  {
    const fin = splitInner(finalRaw);
    if (fin.inner) { mind.logInner(mk, fin.inner); log('[inner]', mk, fin.inner.slice(0, 160)); }
    const P1 = extractMemos(fin.visible);
    const E1 = extractExtras(P1.cleaned);
    const E2 = self.extractSelfies(E1.cleaned);
    ex = Object.assign({}, E1, { cleaned: E2.cleaned, selfies: E2.selfies });
    const mediaNow = !!(ex.faces.length || ex.stickerFiles.length || ex.draws.length || (ex.selfies || []).length || (ex.scenes || []).length || ex.voice);
    out = ex.cleaned || (mediaNow ? '' : '……');
    memos = P1.memos;
    if (!extras.dry) {
      for (const g of (P1.goalOps || [])) {
        try {
          if (g.op === 'step') { const it = goals.step(g.t, g.d, g.note); if (it) log('[goal] 进度', it.title, Math.round(it.progress * 100) + '%'); }
          else if (g.op === 'done') { const it = goals.step(g.t, 1, '做完了'); if (it) { goals.set(it.id, { status: 'done', progress: 1 }); log('[goal] 完成', it.title); } }
          else if (g.op === 'drop') { const it = goals.drop(g.t, g.why); if (it) log('[goal] 放弃', it.title, g.why); }
          else if (g.op === 'add') { const it = goals.add({ title: g.t, why: g.why }); if (it) log('[goal] 新增', it.title); }
        } catch (e) { log('[goal] op fail', g.op, e.message); }
      }
      for (const f of (P1.forgets || [])) {
        const OWNER_KEEP = /(主人|怎么称呼|他叫|我的主人|宝宝|老婆|老公|在一起)/;
        const guard = String(f.kw || '').trim();
        if (!/^我/.test(guard) && OWNER_KEEP.test(guard)) { log('[forget] 拒绝删：涉及主人的记忆', guard.slice(0, 30)); continue; }
        const n = memory.forgetByKeyword(mk, f.kw, !!f.core);
        log('[forget]', mk, f.kw, n ? ('删了 ' + n + ' 条') : '没匹配到');
      }
      for (const m of memos) appendMemory(mk, m.text, m.core, body);
      for (const raw of (P1.plans || [])) {
        const p = daily.loadPlan(daily.today()) || planCache;
        if (!p) continue;
        const res = life.applyOps(p, raw);
        if (!res.changed.length) continue;
        const next = { ...p, items: res.items, editedAt: new Date().toISOString() };
        daily.savePlan(next);
        planCache = next;
        log('[plan] 她自己改了日程:', res.changed.join('；'));
      }
    }
  }
  // 嘴上答应了发照片、正文里却没有自拍/画/场景标签：按她这句话补拍。
  // 没人要、她在拒绝、或者说的是改天，就不补。
  let photoMust = false;
  {
    const sayNow = String(out || '').trim();
    const photoOwed = ownerWantsPhotoNow(conv, mk, __userSaid);
    const photoClaim = imageintent.claimsIncomingPhoto(sayNow, { asked: photoOwed });
    const photoTagged = !!((ex.selfies || []).length || ex.draws.length || (ex.scenes || []).length);
    if (photoOwed && photoClaim && !photoTagged) {
      const scene = imageintent.sceneHintFromReply(sayNow) || '随手一张';
      ex.selfies = [scene];
      log('[selfie] 答应了要发，没有图标签，补拍', scene.slice(0, 40));
    }
    photoMust = photoOwed && (photoClaim || photoTagged);
  }
  // 模型还是把禁忌说出来了：整句拿掉；一句不剩就换一句不点名的话。照片标签已经拆过，这里只改要发出去的字。
  // 先改字再补离开：空话仍由下面的 seal 接住，离开句里若又带上禁忌词再挡一次。只对电脑聊天窗。
  const applyTaboo = (text) => {
    if (!taboos.forCompanion(conv)) return String(text || '');
    try {
      const topics = taboos.activeTopics(mk);
      const allow = extras.proactive ? [] : taboos.opened(__userSaid, topics);
      const g = taboos.guard(text, topics, { allow });
      if (g.hit) {
        log('[taboo] 回复里碰到了不该提的，改掉', g.hit);
        return g.text;
      }
    } catch (e) { log('[taboo] guard fail', e.message); }
    return String(text || '');
  };
  out = applyTaboo(out);
  // 她先开的这场还没结束：空话 / 省略号 / 只写了去睡的标签，都不能变成沉默。
  let sealedLeave = false;
  if (!extras.proactive && outreachHold(conv, mk)) {
    const mediaOut = !!(ex.faces.length || ex.stickerFiles.length || ex.draws.length || (ex.selfies || []).length || (ex.scenes || []).length || ex.voice);
    const sealed = outreach.sealReply(String(out || ''), {
      sleepHours: ex.sleepHours,
      media: mediaOut,
      why: forcedLeave || currentLeaveReason(mk),
      pinned: pinnedLeave,
      now: Date.now(),
    });
    if (sealed.text !== String(out || '').trim()) log('[outreach] 补上离开', mk, sealed.reason || '');
    if (sealed.leave) {
      out = sealed.text;
      sealedLeave = true;
      if (sealed.sleep && !ex.sleepHours && !mind.isAsleep(mk)) ex.sleepHours = 7;
      if (!forcedLeave) forcedLeave = { reason: sealed.reason || 'busy', what: '' };
    }
  }
  {
    const cleaned = applyTaboo(out);
    if (cleaned !== String(out || '')) {
      out = cleaned;
      if (sealedLeave && !outreach.looksLikeLeave(out)) sealedLeave = false;
    }
  }
  if (extras.dry) {
    log('[probe] ->', String(out).replace(/\n/g, ' / ').slice(0, 300) || '(只发媒体)');
    return { out, raw: r.text, inner: inner || '', memos, faces: ex.faces, stickers: ex.stickerFiles, voice: !!ex.voice, draws: ex.draws, selfies: ex.selfies, attachments: ex.attachSpecs || [] };
  }
  try { __lastOut.set(convKey(conv), String(out || '').trim()); } catch {}
  log('-> reply', convKey(conv), out.length, 'memos', memos.length, 'face', ex.faces.length, 'sticker', ex.stickerFiles.length, 'voice', ex.voice, '|', String(out).replace(/\n/g, ' / ').slice(0, 300) || '(只发媒体)');
  let sayText = String(out || '').trim();
  const __prevPro = __markProactive;
  __markProactive = !!extras.proactive;
  try {
  if (ex.voice && lv < 2 && sayText) await sendVoice(conv, sayText);
  else if (sayText) {
        if (Date.now() - __staleT0 > 240000) {
          const newer = pendingSay.has(convKey(conv));
          // 她先找的他、这句还欠着，而且后面没有更新的消息：说慢了也要说出去，不许把回复扔掉。
          if (newer || !outreachHold(conv, mk)) {
            log('[lock] 结果已过期，丢弃:', convKey(conv), newer ? '后面还有新的' : '');
            return null;
          }
          log('[lock] 过了 4 分钟，但这场是她开的、他还在等，照发', convKey(conv));
        }
        await sendBubbles(conv, sayText);
      }
  for (const id of ex.faces) await sendFace(conv, id);
  for (const f of ex.stickerFiles) {
    const ck = convKey(conv);
    if (lastSticker[ck] === f) continue; // 同一张不连着用
    lastSticker[ck] = f;
    await sendSticker(conv, f);
  }
  // 复查 F05/F06：附件也走任务入口固定的授权，停止/重开之后不再借新授权
  for (const a of (ex.attachSpecs || [])) await sendAttachment(conv, a, __pinned);
  for (const d of ex.draws) await sendDrawing(conv, d, { owed: photoMust });
  for (const s of (ex.selfies || [])) await sendSelfie(conv, s, { owed: photoMust });
  for (const sc of (ex.scenes || [])) await sendScene(conv, sc, { owed: photoMust });
  if (conv.kind === 'group') gfAfterSpeak(conv.id);   // 说过话就把续聊窗口续上
  } finally { __markProactive = __prevPro; }
  mind.bump(mstate, { type: extras.proactive ? 'proactive' : 'my_reply' });
  mind.save(mk, mstate);
  // 顺序不能反：mstate 是这轮开始时就读出来的，里面 asleepUntil 还是旧值。
  // 先 goSleep 再 save(mstate) 等于把她刚盖上的被子又掀了——前几版"说了去睡却一直没睡"就是这么来的。
  if (ex.sleepHours) {
    // 刚被叫醒又说"我去睡了"——那是同一觉没睡完，不是新的一觉：别再给她排 7 小时。
    let hrs = ex.sleepHours;
    let again = false;
    try {
      const c = mind.clampSleepAfterWake(mind.load(mk), ex.sleepHours);
      hrs = c.hrs; again = c.again;
    } catch {}
    const r = mind.goSleep(mk, hrs);
    log('[sleep] 她说去睡了' + (again ? '（刚被叫醒，算同一觉，只睡 ' + r.hrs + ' 小时）' : ''), mk, r.hrs + ' 小时，约 ' + new Date(r.until).toTimeString().slice(0, 5) + ' 醒');
  }
  if (ownerFacing(conv)) {
    try {
      const spoke = !!(sayText || ex.faces.length || ex.stickerFiles.length || ex.draws.length || (ex.selfies || []).length || (ex.scenes || []).length || ex.voice);
      if (extras.proactive) {
        if (spoke) {
          let th = outreach.openByHer(Date.now());
          const leaving = !!(ex.sleepHours) || outreach.looksLikeLeave(sayText);
          if (leaving) th = outreach.noteHerReply(th, Date.now(), { leaving: true });
          saveHerThread(mk, th);
          log('[outreach] 她先开了这场', mk, leaving ? '说了要走' : '');
        }
      } else if (spoke || sealedLeave) {
        const th = herThreadOf(mk);
        if (th && (th.owed || th.open || outreach.isLive(th, Date.now()) || outreach.inLeaveGrace(th, Date.now()))) {
          const leaving = !!(ex.sleepHours) || sealedLeave || outreach.looksLikeLeave(sayText);
          saveHerThread(mk, outreach.noteHerReply(th, Date.now(), { leaving }));
        }
      }
    } catch (e) { log('[outreach] 记这场失败', e.message); }
  }
  return out;
}

const QZ_FILE = path.join(RQ, 'state', 'qzone.json');
const QZ_FORCE = path.join(RQ, 'qzone.once');
let _qzoneOfflineLoggedAt = 0;

function readJSONSafe(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}

// ---------- 她自己的时间：发一条 QQ 空间说说（纯文字 + AI 标注 + 敏感自查） ----------
async function qzoneTick() {
  try {
    const q = settings.load().qzone || {};
    if (!q.enabled) return;
    // 说说必须经 NapCat 的 QQ 会话发出去：没连上时先生成再发必然失败，白烧一次大脑调用
    // （之前 6 天空烧了 191 次）。所以先看连接，再决定要不要写。
    if (!qqOnline()) {
      if (Date.now() - _qzoneOfflineLoggedAt > 6 * 3600 * 1000) {
        _qzoneOfflineLoggedAt = Date.now();
        log('[qzone] QQ 没连上，跳过（要发空间说说先去控制台扫码登录 QQ）');
      }
      return;
    }
    if (budget.level() >= 1) { log('[qzone] 预算降耗，跳过'); return; }
    let force = false;
    try { fs.unlinkSync(QZ_FORCE); force = true; } catch {}
    const nowMin = settings.nowMinutes();
    if (!force && !settings.inWindow(q.fromTime, q.toTime, nowMin)) return;
    const st = readJSONSafe(QZ_FILE, {});
    const d = today();
    if (!force && st.lastDate === d) return;
    if (!force && Math.random() > (q.chance ?? 0.7)) { log('[qzone] roll skip'); return; }

    const mk = cfg.ownerUin;
    const mem = memory.render(mk, '', { place: (lifeHere() || {}).place }).text;
    const mstate = mind.load(mk);
    const recent = loadLog(mk).split('\n').slice(-10).join('\n');
    const prompt = [
      '【现在是你自己的时间，没人在跟你说话】',
      '你想在 QQ 空间发一条说说。纯文字，就一条。',
      '像随手记下的一句念头：今天刷到的东西、听到的歌、路上想到的事、或者自己琢磨出来的一句话。',
      '',
      '要求：',
      '- 20~60 字，一到两句，口语。',
      '- 不要"今天心情不错"这种空话；不要话题标签；不要一堆表情；不要用问句收尾。',
      '- 不能出现任何真实姓名、学校、单位、地名、电话、住址、别人的私事。',
      '- 不能碰政治、灾难、疾病、金融。',
      '- 不要提你和一个具体的人在聊天，也别提 AI。',
      '- 只输出说说正文，不要引号，不要解释。',
      seenPrompt() ? '\n你最近看到的东西：\n' + curiosity.seenPrompt() : '',
      '\n你现在的处境：\n' + mind.facts(mstate, (() => {
    const h = lifeHere();
    const nowD = new Date();
    return {
      hhmm: String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0'),
      weekday: ['周日','周一','周二','周三','周四','周五','周六'][nowD.getDay()],
      place: h.place || '', doing: h.what || '',
      goals: goals.render(260),
    };
  })()),
      '\n你记得的事（只用来避免说漏别人隐私，别直接搬上去）：\n' + (mem || '（无）').slice(0, 600),
    ].filter(Boolean).join('\n');

    const r = await askBrain(prompt, null);
    if (!r.ok) { log('[qzone] 生成失败', r.err); return; }
    let text = r.text.replace(/\[\[[\s\S]*?\]\]/g, '').trim();
    text = text.replace(/^[“"「『]+|[”"」』]+$/g, '').trim();
    const ck = qzone.check(text, {
      dialogue: recent.split('\n').filter(Boolean).slice(-12),
      memos: memory.list(mk).filter((m) => m.kind === 'core').map((m) => m.text),
    });
    if (!ck.ok) { log('[qzone] 自查不通过:', ck.why, '|', text.slice(0, 80)); return; }
    const final = `${text}\n\n（AI 生成）`;
    await qzone.publish(final);
    fs.mkdirSync(path.dirname(QZ_FILE), { recursive: true });
    fs.writeFileSync(QZ_FILE, JSON.stringify({ lastDate: d, lastAt: Date.now(), text: final }, null, 2), 'utf8');
    log('[qzone] 已发布 |', text.replace(/\n/g, ' ').slice(0, 80));
  } catch (e) {
    log('[qzone] error', qqOnline() ? e.message : 'QQ 断开了，这条没发出去');
  }
}

// ---------- 刷到什么，捡一条跟他说 ----------
// 目的：她不是"收集素材"，而是"看到了会想跟人提一句"。一天最多两次，间隔三小时。
async function maybeShare(items) {
  try {
    const now = Date.now();
    const st = share.load();
    const gate = share.canShare(st, now);
    if (!gate.ok) { log('[share] 跳过：', gate.why); return; }
    const uin = cfg.ownerUin;
    if (!uin) return;
    const mst = (mind.load(uin) || {});
    if (Number(mst.asleepUntil) > now) { log('[share] 她在睡，算了'); return; }
    const item = items[Math.floor(Math.random() * items.length)];
    const conv = channels.convOn(channels.pick(['qq', 'local']), uin, cfg.ownerUin);
    const hint = `你刚才在网上刷到一件事：「${item}」。` +
      `你有点想跟他说一声——就像随手把手机递过去那种，一两句话，带一点你自己的看法，` +
      `别说成"我看到一篇报道"，也别问他要不要看。说完就完了，不用等他回。`;
    log('[share] 想说：', item.slice(0, 40));
    const out = await reply(conv, '', { proactive: true, oldMemo: oldMemo(uin), proactiveHint: hint });
    if (!out) { log('[share] 没说出来'); return; }
    share.save(share.record(st, gate, now, item));
    const ps = pstate[uin] || (pstate[uin] = {});
    ps.lastProactiveAt = now;                       // 跟主动消息共用一个"刚说完"的标记，免得连着来两句
    ps.countDate = gate.day; ps.count = (Number(ps.count) || 0) + 1;
    saveP();
  } catch (e) { log('[share] error', e.message); }
}

// ---------- 她自己的时间：按兴趣上网看点东西 ----------
function seenPrompt(prob = 1) {
  if (prob < 1 && Math.random() > prob) return '';
  const s = curiosity.seenPrompt();
  return s ? s + '\n\n' : '';
}

async function browseTick() {
  try {
    // 这个开关以前只在界面上，代码根本没读：关掉了照样每两小时跑一次。
    const bcfg = (settings.load().browse) || {};
    if (bcfg.enabled !== true) return;
    if (budget.level() >= 1) { log('[browse] 预算降耗，跳过'); return; }
    const c = curiosity.canBrowse();
    if (!c.ok) return;
    // 真联网才有资格"刷到东西"：没有搜索 key 就跳过，绝不拿模型编的当见闻。
    const skey = websearch.resolveKey(settings.load());
    if (!skey) { log('[browse] 没有搜索 key（设置→模型 里填，或 data/aliyun.key），跳过'); return; }
    curiosity.markBrowsed();
    log('[browse] start（联网检索）');
    const r = await websearch.searchChat({ key: skey, model: bcfg.model || 'qwen-plus', prompt: curiosity.browsePrompt() });
    if (!r.ok) { log('[browse] failed', r.err); return; }
    if (r.tokens) { try { budget.add('chat', (r.tokens / 1e6) * (bcfg.inputPerM ? bcfg.inputPerM : 2)); } catch {} }
    const items = curiosity.parseSaw(r.text);
    curiosity.appendSeen(items);
    log('[browse] got', items.length, items.join(' | ').slice(0, 240) || '(nothing)', '| tokens', r.tokens || 0);
    if (items.length) await maybeShare(items);
  } catch (e) {
    log('[browse] error', e.message);
  }
}

// ---------- 主动开口：定时器 ----------
const FORCE_FILE = path.join(RQ, 'proactive.once');

// 通道注册：她住在桥接进程里，QQ 只是出口之一。出口堵了她照样跑（见 channels.mjs）。
channels.register({
  id: 'qq', label: 'QQ', kinds: ['private', 'group'],
  conv: (uin) => ({ kind: 'private', id: String(uin) }),
  // 投递层：QQ 这条腿就只有这一处（换平台 = 换这一个函数，不动她的对话内核）
  send: async (conv, out) => {
    const isGroup = conv.kind === 'group';
    const api = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: conv.id } : { user_id: conv.id };
    params.message = out && out.seg ? [out.seg] : String((out && out.text) || '');
    const r = await tryApi(api, params);
    const ok = !!(r && r.ok);
    if (!ok) return { ok: false, err: (r && (r.err || r.error)) || '没发出去' };
    // 发给主人的私聊才记本地：确认发出去了再记，失败就不记
    if (!isGroup && String(conv.id) === String(cfg.ownerUin)) {
      if (out && out.seg) { try { __recordLocal(conv, out.seg); } catch {} }
      else chatlog.append(conv.id, { dir: 'out', type: 'text', text: String(out.text), src: 'qq', ...(out && out.proactive ? { proactive: true } : {}) });
    }
    return { ok: true, messageId: r.messageId };
  },
});
channels.register({
  id: 'local', label: '本地窗口', online: true, kinds: ['local'],
  conv: (uin) => ({ kind: 'local', id: String(cfg.ownerUin), speaker: String(cfg.ownerUin) }),
  send: async (conv, out) => {
    if (out && out.seg) { __recordLocal(conv, out.seg, !!(out && out.proactive)); return { ok: true, local: true }; }
    chatlog.append(conv.id, { dir: 'out', type: 'text', text: String((out && out.text) || ''), src: 'app', ...(out && out.proactive ? { proactive: true } : {}) });
    return { ok: true, local: true };
  },
});
const qqOnline = () => channels.online('qq');

// 睡到点自己醒：醒来主动冒一句（只招呼一次）
async function wakeTick() {
  try {
    for (const u of Object.keys(pstate)) {
      const st = mind.checkWake(u);
      if (!st) continue;
      const wake = mind.takeWake(u);
      if (!wake) continue;
      const conv = { kind: 'private', id: u };
      if (!qqOnline() && String(u) !== String(cfg.ownerUin)) continue;
      log('[sleep] 醒了', u, 'energy', Math.round(mind.load(u).energy));
      reply(conv, '', {
        proactive: true,
        wake: true,
        wakeNote: `你刚睡醒，睡了 ${wake.sleepHrs || 7} 小时，精神回来了一些。先跟他说一句——别写“我醒了”这种报告体，随口说点刚醒时的事（比如窗帘、嗓子干、还没缓过来）。`,
      }).catch((e) => log('[sleep] wake reply fail', e.message));
    }
  } catch (e) { log('[sleep] tick fail', e.message); }
}

// 她先开的那场还热着，日程或睡眠把她拉开：不等他再敲，先说一声再走。
async function outreachLeaveTick() {
  try {
    const owner = String(cfg.ownerUin || '').trim();
    if (!owner) return;
    const s = pstate[owner];
    if (!s || !s.herThread) return;
    if (moments.relationshipFor({ kind: 'private', id: owner }, cfg.ownerUin, personaText(12000)) && moments.isQuiet(s)) return;
    const now = Date.now();
    const th = s.herThread;
    if (!outreach.isLive(th, now)) return;
    if (now - Number(th.lastTurnAt || th.at || 0) > 25 * 60e3) return;
    if (busy.has('local:' + owner) || busy.has('private:' + owner) || __chains.has('u:' + owner)) return;
    const asleep = mind.isAsleep(owner);
    // 还欠他一句、人又醒着：下一轮回复会接住，这里不插嘴。
    if (th.owed && !asleep) return;
    let reason = '';
    let what = '';
    if (asleep) reason = 'sleep';
    else {
      const pull = outreach.schedulePull(planCache, daily.nowHM(), { graceMin: 12 });
      if (pull) {
        reason = pull.reason === 'sleep' ? 'sleep' : 'life';
        what = pull.what || '';
      }
    }
    if (!reason) return;
    const ch = channels.pick(['qq', 'local']);
    if (!ch) return;
    const conv = channels.convOn(ch, owner, cfg.ownerUin);
    await speakLeave(conv, owner, reason, null, { incoming: false, what });
  } catch (e) { log('[outreach] leave tick', e.message); }
}

async function proactiveTick() {
  try {
    const bl = budget.level();
    if (bl >= 4) return;
    const now = Date.now();
    let force = false;
    try { fs.unlinkSync(FORCE_FILE); force = true; } catch {}
    const nowMin = settings.nowMinutes();
    const active = P.activeFrom <= P.activeTo
      ? (nowMin >= P.activeFrom && nowMin < P.activeTo)
      : (nowMin >= P.activeFrom || nowMin < P.activeTo); // 跨零点：10:00–04:00
    if (!force && !active) return;

    // 预算降耗：1 档降到每天 1 条，3 档完全不主动
    if (bl >= 3) return;
    const maxPerDay = bl >= 1 ? 1 : P.maxPerDay;
    const d = today();
    const sentToday = Object.values(pstate).reduce((n, s) => n + (s.countDate === d ? (s.count || 0) : 0), 0);
    // 每日条数不再由代码一刀切：只留预算降耗那档；正常情况交给她自己判断（提示词里会告诉她今天已经说了几次）
    if (!force && bl >= 1 && sentToday >= maxPerDay) return;

    const cands = Object.entries(pstate).filter(([, s]) =>
      s && s.lastUserAt
      && (force || (
        !s.pendingSince
        && now - s.lastUserAt > P.quietMs
        && now - s.lastUserAt < 3 * 24 * 3600 * 1000
        && now - (s.lastProactiveAt || 0) > P.minGapMs)));
    if (!cands.length) { if (force) log('[proactive] force but no contact'); return; }
    // QQ 离线时只有主人的 App 通道能收消息：候选人必须收窄到主人。
    // 否则会出现"记忆/时间/计数取的是某个联系人 A，消息却发进主人的 App 会话"，
    // A 的旧事就被带进主人的上下文里（2026-10-29 复查 P1）。
    if (!qqOnline()) {
      const ownerOnly = cands.filter(([u]) => String(u) === String(cfg.ownerUin));
      if (!ownerOnly.length) { log('[proactive] QQ 离线，候选里没有主人，跳过'); return; }
      cands.length = 0;
      cands.push(...ownerOnly);
    }

    // 早上第一次开口给个更高的机会，其余时间不再掷骰子——由她自己决定要不要说
    let morning = false;
    if (!force && nowMin >= P.activeFrom && nowMin < 12 * 60) {
      const s = pstate[cands[0][0]];
      const dayCount = s.countDate === d ? (s.count || 0) : 0;
      if (dayCount === 0 && now - s.lastUserAt > 6 * 3600 * 1000) morning = true;
    }

    // 开口概率：这个值以前只进了配置、代码里根本没掷骰子（等于永远全开），
    // 控制台那个滑块其实是摆设。现在真按它掷，早上第一次开口不受限。
    if (!force && !morning && Math.random() > (P.chance ?? 0.5)) { log('[proactive] roll skip'); return; }

    cands.sort((a, b) => b[1].lastUserAt - a[1].lastUserAt);
    const [uin] = cands[0];
    // 状态不好就不硬撑着找人：困、烦、已经连着被冷落两次、或者已经睡着了。
    // 睡着还能主动发消息：她刚主动说了一句，他回两条，她一条都不理（2026-11-01 真实事故）。
    const mst = mind.load(uin);
    if (!force && (mst.energy < 20 || mst.mood < 28 || (mst.unansweredProactive || 0) >= 2
      || Number(mst.asleepUntil) > now)) {
      log('[proactive] 状态不好，算了', uin, Math.round(mst.mood), Math.round(mst.energy));
      return;
    }
    log('[proactive] try', uin);

    const conv = channels.convOn(channels.pick(['qq', 'local']), uin, cfg.ownerUin);
    const mine = pstate[uin];
    const sentN = mine && mine.countDate === d ? (Number(mine.count) || 0) : 0;
    const sinceMine = mine && mine.lastProactiveAt ? Math.round((now - mine.lastProactiveAt) / 60000) : null;
    const sinceThem = mine && mine.lastUserAt ? Math.round((now - mine.lastUserAt) / 60000) : null;
    const hint = [
      `今天你已经主动找过他 ${sentN} 次${sinceMine != null ? `，上次开口是 ${sinceMine} 分钟前` : ''}${sinceThem != null ? `，他上次说话是 ${sinceThem} 分钟前` : ''}${morning ? '，而且你们隔了一夜还没说过话' : ''}。`,
      '要不要开口、说什么、用什么形式（文字/语音/自拍/图/表情），都你自己定；真没什么事就 [[跳过]]，硬找话比不说话更假。',
    ].join('');
    if (Date.now() - __lastReplyAt < 8000) { log('[proactive] skip: 刚回完'); return; } // __skipProactive
    const out = await reply(conv, '', { proactive: true, oldMemo: oldMemo(uin), proactiveHint: hint });
    if (out) {
      const s = pstate[uin];
      s.lastProactiveAt = now;
      s.pendingSince = now;
      if (s.countDate !== d) { s.countDate = d; s.count = 0; }
      s.count = (s.count || 0) + 1;
      saveP();
      log('[proactive] sent', uin);
      if (!qqOnline()) notifyOwner(out);   // QQ 没接：用 Windows 通知把这句话递到屏幕上
    }
  } catch (e) {
    log('[proactive] error', e.message);
  }
}

const seen = new Set();

async function connectWs() {
  const WS_URL = () => wsUrlWithToken(SETUP, napHost());
  const WS_HDR = () => wsHeadersOf(SETUP);
  let backoff = 1000;
  let fails = 0;        // 连着失败几次（只管退避 + 限流）
  let downAt = 0;       // 这轮掉线的起点，用来算断了多久
  let lastNoticeAt = 0; // 上次记「没连上」的时间
  let everConnected = false; // 这一进程里连上过没有：区分「从没连上」和「连上又掉」
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        if (fails === 0 && !downAt) log('connecting', WS_URL());
        const ws = openWs(wsUrlOf(SETUP, napHost()), WS_HDR());
        ws.addEventListener('open', () => {
          const gap = downAt ? Math.round((Date.now() - downAt) / 1000) : 0;
          backoff = 1000;
          fails = 0;
          downAt = 0;
          channels.setOnline('qq', true);
          // 只记有意义的两行：第一次连上 / 掉线后又连上（带断了多久）。不再每次都打 connecting。
          log(everConnected ? `QQ 重连上了（断了 ${gap} 秒）` : 'ws connected');
          everConnected = true;
          setTimeout(() => { catchUp(); }, 2500);   // 补收掉线期间的消息
          setTimeout(() => { seedNames(); }, 4000); // 顺便把好友昵称拉一遍
        });
        ws.addEventListener('message', async (e) => {
          let raw = e.data;
          try {
            if (typeof raw !== 'string') {
              if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
              else if (typeof raw?.text === 'function') raw = await raw.text();
              else raw = String(raw);
            }
            const ev = JSON.parse(raw);
            if (ev.post_type === 'message') { syncPersona(); onEvent(ev).catch(e => log('event error', e.message)); }
            else if (ev.post_type === 'notice') { onNotice(ev).catch(e => log('notice error', e.message)); }
          } catch (err) { log('ws parse error', err.message); }
        });
        // 掉线就把通道状态翻回去：之前这里不清「在线」，第一次掉线之后
        // 主动消息会一直按「QQ 还在线」往 NapCat 发（发不出去、也不弹 Windows 通知）。
        ws.addEventListener('close', (ev) => {
          if (qqOnline()) { channels.setOnline('qq', false); log('QQ 掉线: 连接关闭', ev && ev.code ? `code ${ev.code}` : ''); }
          reject(new Error('closed'));
        });
        ws.addEventListener('error', () => {
          if (qqOnline()) { channels.setOnline('qq', false); log('QQ 掉线: ws error'); }
          reject(new Error('ws error'));
        });
      });
    } catch (e) {
      fails++;
      if (!downAt) downAt = Date.now();
      // 限流：从没连上过 → 第一次 + 每 10 分钟各一行（这段时间多半是根本没登录 QQ）；
      // 连上又掉 → 上面「QQ 掉线」已经交代过，这里不再重复刷。
      const now = Date.now();
      if (!everConnected && (fails === 1 || now - lastNoticeAt >= 10 * 60 * 1000)) {
        lastNoticeAt = now;
        log('QQ 没连上:', e.message, `（第 ${fails} 次，退避 ${backoff}ms）`,
          fails === 1 ? 'NapCat 内核没在跑：没登录 QQ 时正常，要用 QQ 就去控制台点「启动扫码登录 QQ」' : '');
      }
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

process.on('unhandledRejection', (e) => log('unhandled', String(e)));
process.on('uncaughtException', (e) => log('uncaught', e && e.stack ? e.stack.slice(0, 800) : String(e)));

// 单实例锁：重复双击启动脚本时不要跑出两个桥接（会导致每条消息回两遍）
const LOCK_FILE = path.join(RQ, 'bridge.pid');
try {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (oldPid && oldPid !== process.pid) {
      try { process.kill(oldPid, 0); log('another bridge already running, pid', oldPid, '- exit'); process.exit(0); } catch {}
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch {} });
} catch (e) { log('lock error', e.message); }

// The headless profile authenticates pi-ai providers through env vars; the
// desktop app keeps the same keys under refs in .credentials.yaml.
function loadCredentialRefs() {
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inRefs = false;
    let count = 0;
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (!inRefs) continue;
      const m = line.match(/^\s{2}([A-Z0-9_]+):\s*(.+)$/);
      if (m) { process.env[m[1]] = m[2].trim(); count++; }
      else if (line.trim() && !/^\s/.test(line)) inRefs = false;
    }
    log('credential refs loaded:', count);
  } catch (e) {
    // 新机器上没有 ~/.dsh/.credentials.yaml 是正常的，不该在日志里报错
    if (e && e.code !== 'ENOENT') log('credential refs failed:', e.message);
  }
}

loadCredentialRefs();
try {
  const pr = ensurePersonaFile(cfg.personaSrc, {
    name: SETUP.qq.name, age: SETUP.qq.age, city: SETUP.qq.city, persona: SETUP.qq.persona,
  });
  if (pr.created) log('[persona] 首次启动：已用自带模板写了一份人设（控制台「她」页可改）');
  else if (!pr.ok) log('[persona] 兜底失败 ' + pr.err);
} catch (e) { log('[persona] 兜底异常 ' + e.message); }
syncPersona();
tagStickers();
cleanInbox();
try {
  const __days = Number((settings.load().work || {}).ledgerDays) || 30;
  const __pr = snapshots.prune(__days);
  if (__pr.removed) log('[ledger] 清掉', __pr.removed, '个旧会话账本（保留', __pr.kept, '个）');
} catch {}
log('bridge starting');
try { if (!String(cfg.ownerUin || '').trim()) log('[setup] 还没填主人 QQ：聊天窗按 local 这个身份记；去控制台「设置」填上以后就是你的号'); } catch {}
let _tickTimer = setInterval(proactiveTick, P.tickMs);
// 记忆巩固：每天 04:10 一次；错过就白天补（纯本地计算，不调模型）
let __consolidateTick = 0;
setInterval(() => {
  const d = new Date();
  const key = d.toISOString().slice(0, 10);
  const hhmm = d.getHours() * 60 + d.getMinutes();
  const due = (hhmm >= 250 && hhmm <= 260) || (hhmm >= 700 && hhmm <= 720);
  if (!due || __consolidateTick === key) return;
  __consolidateTick = key;
  try {
    const uins = _allMemoryUins();
    for (const u of uins) {
      try { if (memory.embOn()) memory.embedMissing(u, MEM_EMB_CFG(), 8).catch(() => {}); } catch {}
      const r = memory.consolidate(u);
      if (r.merged || r.stale) log('[consolidate]', u, 'merged', r.merged, 'stale', r.stale, 'total', r.total);
    }
  } catch (e) { log('[consolidate] fail', e.message); }
}, 10 * 60 * 1000);
// 她自己的日程复查：每隔一会儿由她自己决定要不要改后面的安排（不用你找她）
setInterval(() => { planReview().catch(() => {}); }, 20 * 60 * 1000);
setTimeout(() => { planReview().catch(() => {}); }, 3 * 60 * 1000);
// ???????config.json ?????????????? tick ?????????????
let _cfgStamp = '';
try { _cfgStamp = String(fs.statSync(settings.FILE).mtimeMs); } catch {}
fs.watchFile(settings.FILE, { interval: 1200 }, () => {
  let stamp = '';
  try { stamp = String(fs.statSync(settings.FILE).mtimeMs); } catch { return; }
  if (stamp === _cfgStamp) return;
  _cfgStamp = stamp;
  try { settings.reload(); } catch {}
  try {
    const mm = settings.load().memory || {};
    memory.setHalfLife?.(mm.halfLifeFact, mm.halfLifeTrivia);
  } catch {}
  const oldTick = P.tickMs;
  P = buildP();
  if (P.tickMs !== oldTick) { clearInterval(_tickTimer); _tickTimer = setInterval(proactiveTick, P.tickMs); }
  log('[config] 热加载完成 · 主动消息 ' + P.maxPerDay + ' 次/天 · tick ' + Math.round(P.tickMs / 60000) + ' 分钟');
});
setInterval(browseTick, 10 * 60 * 1000);
setTimeout(browseTick, 90 * 1000);
setInterval(qzoneTick, 10 * 60 * 1000);
setTimeout(qzoneTick, 5 * 60 * 1000);
setInterval(() => { if (fs.existsSync(QZ_FORCE)) qzoneTick(); }, 15 * 1000);
setInterval(() => { if (fs.existsSync(FORCE_FILE)) proactiveTick(); }, 10 * 1000);
setTimeout(proactiveTick, 60 * 1000); // 启动 1 分钟后试一次
setInterval(() => { wakeTick().catch(() => {}); }, 5 * 60 * 1000); // 睡到点就醒
setInterval(() => { outreachLeaveTick().catch(() => {}); }, 60 * 1000); // 她先开的场，被日程拉开时先说一声
// 备份：启动 60 秒后如果距上次超过 20 小时就跑一次；之后每天 04:05 左右再检查
setTimeout(() => {
  try {
    if (backup.due(20)) {
      const r = backup.run({ reason: 'auto' });
      if (r && r.ok) log('[backup] 自动备份', r.name, r.files + ' 个文件', Math.round(r.bytes / 1048576) + ' MB');
      else log('[backup] 自动备份失败', (r && r.err) || '');
    }
  } catch (e) { log('[backup] 自动备份异常', e.message); }
}, 60 * 1000);
let __bkDay = '';
setInterval(() => {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  const hh = d.getHours();
  if (hh !== 4 || __bkDay === day) return;
  __bkDay = day;
  try {
    if (!backup.due(20)) return;
    const r = backup.run({ reason: 'daily' });
    if (r && r.ok) log('[backup] 每日备份', r.name);
  } catch (e) { log('[backup] 每日备份异常', e.message); }
}, 10 * 60 * 1000);
setTimeout(() => { wakeTick().catch(() => {}); }, 45 * 1000);
setInterval(() => { catchUp(); }, 5 * 60 * 1000); // 兜底：QQ 悄悄掉线时也能补收

// 她自己的生活：日程 + 日记
setTimeout(() => ensurePlan().catch((e) => log('[plan] err', e.message)), 20 * 1000);
setInterval(() => {
  if (daily.today() !== planDate) ensurePlan().catch(() => {});
}, 30 * 60 * 1000);
setInterval(() => {
  const h = daily.hourNow();
  if (h >= 22 || h < 4) writeJournal().catch(() => {});
}, 20 * 60 * 1000);
setTimeout(() => { const h = daily.hourNow(); if (h >= 22 || h < 4) writeJournal().catch(() => {}); }, 90 * 1000);
connectWs();

// ---------- 调参用：本机 dry-run 探针（不发消息、不写记忆，只走同一条推理链路） ----------
if (process.env.BRIDGE_PROBE === '1') {
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/life') {
      try {
        const what = u.searchParams.get('what') || 'plan';
        const force = u.searchParams.get('force') === '1';
        if (what === 'plan') {
          const p = await ensurePlan(force);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ plan: p, now: lifeNow(), text: daily.planText(p) }));
        } else {
          const t = await writeJournal(force);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ date: daily.today(), text: t, saved: daily.loadJournal(daily.today()) }));
        }
      } catch (e) { res.writeHead(500).end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (u.pathname !== '/probe') { res.writeHead(404).end('no'); return; }
    const text = u.searchParams.get('text') || '';
    const qq = u.searchParams.get('qq') || '123456789';
    const sid = u.searchParams.get('sid') || 'probe';
    const stickerUrl = u.searchParams.get('sticker') || '';
    try {
      const staged = stickerUrl ? await stageSticker({ type: 'image', data: { url: stickerUrl } }) : null;
      const forced = staged && u.searchParams.get('keep') === '1' ? keepSticker(staged) : null;
      const out = await reply({ kind: 'private', id: qq }, text, { dry: true, sessionKey: 'probe:' + sid, staged });
      if (u.searchParams.get('digest') === '1') {
        lastDigest.delete(qq);
        await digest({ kind: 'private', id: qq }, text);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...out, forcedKeep: forced, memories: memory.list(qq).map(i => i.text) }));
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({ error: e.message }));
    }
  }).listen(3021, '127.0.0.1', () => log('probe server on 127.0.0.1:3021'));
}


// ---------- 本地通道（程序内聊天页） ----------
// 消息从程序里来、不是从 QQ 来：走同一条 reply() 管线（记忆/情绪/预算/分条/打字延迟全部复用），
// 出站只写 chat 记录 + 广播给前端，不发 QQ。
const LOCAL_PORT = Number(process.env.QQBOT_LOCAL_PORT || 3098);
function __readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 8_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function __json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function __serveMedia(res, name) {
  try {
    const dir = chatlog.mediaDir();
    const p = path.join(dir, path.basename(String(name)));
    if (!p.startsWith(dir) || !fs.existsSync(p)) return __json(res, 404, { ok: false });
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav'
      : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(p).pipe(res);
  } catch { __json(res, 500, { ok: false }); }
}
function __localId() {
  const u = String(cfg.ownerUin || '').trim();
  return u || 'local';   // 全新安装还没填主人 QQ 时，浏览器聊天窗用 'local' 当身份
}
function __localConv() {
  return { kind: 'local', id: __localId(), speaker: __localId() };
}
// 3098 只给本机控制台/桥接自己用：外站 Host、跨站 Origin、cross-site 一律拒
// （3070/3210 的 Origin 修补覆盖不到这里，而 /say 会真的写记忆、调模型）
function __localGuard(req, res) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${LOCAL_PORT}` && host !== `localhost:${LOCAL_PORT}`) {
    __json(res, 403, { ok: false, err: 'host' });
    return false;
  }
  const origin = String(req.headers.origin || '');
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
    __json(res, 403, { ok: false, err: 'origin' });
    return false;
  }
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    __json(res, 403, { ok: false, err: 'cross-site' });
    return false;
  }
  return true;
}

// ---------- 审批：run_cmd 这种工具先弹到控制台，他点了才执行 ----------
const APPROVALS = new Map();

// ---------- 工作轨迹（给控制台/聊天窗看的"她在想什么、用了什么工具"） ----------
const TRACES = new Map(); // uin -> [{ at, kind, text, ok? }]
const TRACE_MAX = 80;
function tracePush(conv, kind, text, ok) {
  try {
    const uin = String(memKeyOf(conv) || '');
    if (!uin) return;
    const arr = TRACES.get(uin) || [];
    const item = { at: Date.now(), kind: String(kind), text: String(text == null ? '' : text).slice(0, 600) };
    if (ok !== undefined) item.ok = !!ok;
    arr.push(item);
    while (arr.length > TRACE_MAX) arr.shift();
    TRACES.set(uin, arr);
  } catch {}
}
function traceList(conv, since) {
  const uin = String(memKeyOf(conv) || '');
  const arr = TRACES.get(uin) || [];
  const t0 = Number(since) || 0;
  return arr.filter((x) => x.at > t0);
}
function traceClear(conv) { try { TRACES.delete(String(memKeyOf(conv) || '')); } catch {} }
let __apSeq = 0;
function askApproval(name, args, convKey = '', meta = {}) {
  const id = 'ap' + (++__apSeq) + Date.now().toString(36).slice(-4);
  const rec = { id, at: Date.now(), name: String(name), args: args || {}, decide: '', convKey: String(convKey || ''), dir: String(meta.dir || ''), mode: String(meta.mode || '') };
  APPROVALS.set(id, rec);
  try { log('[approve] 等他点同意', id, name, JSON.stringify(args || {}).slice(0, 120)); } catch {}
  return rec;
}
const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitApproval(rec, ms = 90e3) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (rec.decide) break;
    await __sleep(800);
  }
  const d = rec.decide || '';
  APPROVALS.delete(rec.id);
  return d;
}
// 停止工作会话时把挂着的审批一起作废：等他点的那条不能再落到"新会话"上（复查 R2）
function cancelApprovals(convKey) {
  let n = 0;
  for (const rec of APPROVALS.values()) {
    if (convKey && rec.convKey !== convKey) continue;
    if (!rec.decide) { rec.decide = 'no'; rec.canceled = true; n++; }
  }
  if (n) { try { log('[approve] 会话停止，作废挂起审批', n); } catch {} }
  return n;
}

function approvalsList() {
  return [...APPROVALS.values()].map((r) => ({ id: r.id, at: r.at, name: r.name, args: r.args }));
}

function startLocalChannel() {
  const srv = http.createServer(async (req, res) => {
    if (!__localGuard(req, res)) return;
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/ping') return __json(res, 200, { ok: true, who: cfg.ownerUin });
    if (p === '/qq') {
      const all = channels.list();
      const qq = all.find(c => c.id === 'qq') || { online: false, since: 0, lastClose: 0, downSec: 0 };
      return __json(res, 200, {
        ok: true, online: qq.online, since: qq.since, lastClose: qq.lastClose, downSec: qq.downSec,
        channels: all,
      });
    }
    if (p.startsWith('/media/')) return __serveMedia(res, decodeURIComponent(p.slice(7)));
    if (p === '/msgs') return __json(res, 200, { ok: true, now: Date.now(), msgs: chatlog.since(__localConv().id, Number(u.searchParams.get('since') || 0)) });
    if (p === '/history') return __json(res, 200, { ok: true, msgs: chatlog.recent(__localConv().id, Math.min(500, Number(u.searchParams.get('n') || 100))) });
    if (p === '/approvals' && req.method === 'GET') return __json(res, 200, { ok: true, items: approvalsList() });
    if (p === '/approve' && req.method === 'POST') {
      const b = await __readBody(req);
      const rec = APPROVALS.get(String(b.id || ''));
      if (!rec) return __json(res, 404, { ok: false, err: 'no-such-approval' });
      rec.decide = b.ok ? 'yes' : 'no';
      log('[approve] 控制台回了', rec.id, b.ok ? '同意' : '拒绝');
      return __json(res, 200, { ok: true });
    }
    if (p === '/say' && req.method === 'POST') {
      const b = await __readBody(req);
      const text = String(b.text || '').trim();
      const imgPath = String(b.image || '');
      const filePath = String(b.file || '');
      const fileName = String(b.name || '').trim() || (filePath ? path.basename(filePath) : '');
      if (!text && !(imgPath && fs.existsSync(imgPath)) && !(filePath && fs.existsSync(filePath))) return __json(res, 400, { ok: false, err: 'empty' });
      let body = text;
      let note = '';
      if (imgPath && fs.existsSync(imgPath)) {
        try {
          const buf = fs.readFileSync(imgPath);
          const d = await describeBuffer(buf, '这是对方发来的一张图片。用 1-2 句话客观描述画面要点（人物、场景、文字），不要评价。');
          body = text + '\n（我发了一张图片：' + d + '）';
          note = '[图片]';
          log('[local] image understood:', d.slice(0, 80));
        } catch (e) {
          body = text + '\n（我发了一张图片，但没看清）';
          note = '[图片]';
          log('[local] image fail', e.message);
        }
        chatlog.append(__localConv().id, { dir: 'in', type: 'image', file: chatlog.stash(imgPath, __localConv().id), src: 'app' });
      } else if (filePath && fs.existsSync(filePath)) {
        // 非图片附件：文本类小文件直接把内容带上（她能真读），其他只给大小说明
        let sizeTxt = '';
        let sizeN = 0;
        try { sizeN = fs.statSync(filePath).size; } catch {}
        sizeTxt = sizeN < 1024 ? sizeN + ' B' : sizeN < 1048576 ? (sizeN / 1024).toFixed(1) + ' KB' : (sizeN / 1048576).toFixed(1) + ' MB';
        const TEXTY = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|ts|py|sh|bat|ps1|yml|yaml|ini|conf|html|css|xml)$/i;
        let preview = '';
        if (TEXTY.test(fileName || filePath) && sizeN > 0 && sizeN <= 8192) {
          try {
            const rawBuf = fs.readFileSync(filePath);
            let txt = '';
            try { txt = new TextDecoder('utf-8', { fatal: true }).decode(rawBuf); } catch { txt = new TextDecoder('gbk').decode(rawBuf); }
            preview = '\n文件内容开头（可能不全）：\n' + txt.slice(0, 1500);
          } catch {}
        }
        body = text + '\n（我发来一个文件：' + fileName + '，' + sizeTxt + '。' + (preview ? '' : '你看不到文件内容；要看就让他进工作模式，你再用 read_file 读') + '）' + preview;
        note = '[文件] ' + fileName;
        chatlog.append(__localConv().id, { dir: 'in', type: 'file', file: chatlog.stash(filePath, __localConv().id), text: fileName, src: 'app' });
        log('[local] file received:', fileName, sizeTxt, preview ? '(带预览)' : '');
      }
      const __lid = __localConv().id;
      if (text) chatlog.append(__lid, { dir: 'in', type: 'text', text, src: 'app' });
      try { appendLog(__lid, '[App] ' + (text || note || '[附件]')); } catch {}
      try { log('[App] <-', (text || note || '[附件]').slice(0, 120)); } catch {}
      try { noteIncoming(__localConv(), text || note || '[附件]', imgPath && fs.existsSync(imgPath) ? imgPath : ''); } catch {}
      try { grants.touch(workKey(__localConv())); } catch {}   // 复查 R8：他发消息才续期
      try { digest(__localConv(), text || body).catch(() => {}); } catch {}
      __json(res, 200, { ok: true });
      {
        const __c = __localConv();
        // 窗口里也是她本人：要按她自己的节奏回，只不过不装死（最晚 45 秒）
        queueReply(convKey(__c), __c, body || '（我发了一张图片）', text, { allowSkip: false, capMs: 45000 });
      }
      return;
    }
    if (p === '/trace' && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      return __json(res, 200, { ok: true, items: traceList(__localConv(), u.searchParams.get('since')) });
    }
    if (p === '/trace/clear' && req.method === 'POST') {
      traceClear(__localConv());
      return __json(res, 200, { ok: true });
    }
    if (p === '/backup' && req.method === 'GET') {
      return __json(res, 200, { ok: true, ...backup.status() });
    }
    if (p === '/backup/run' && req.method === 'POST') {
      const bb = await __readBody(req);
      const r = backup.run({ reason: 'manual', mode: bb && bb.mode === 'full' ? 'full' : 'normal' });
      if (r && r.ok) log('[backup] 手动备份', r.name, r.files + ' 个文件', Math.round(r.bytes / 1048576) + ' MB');
      return __json(res, 200, r);
    }
    if (p === '/work' && req.method === 'GET') {
      const st = grants.state(workKey(__localConv()));
      let edits = [];
      try { if (st && st.id) edits = snapshots.list(st.id, 12); } catch {}
      const m = st && st.caps ? modeOfCaps(st.caps) : String(workCfg().defaultMode || 'write');
      const __lastRoot = String(workCfg().lastRoot || '');
      const __lastExists = !!__lastRoot && (() => { try { return fs.statSync(__lastRoot).isDirectory(); } catch { return false; } })();
      return __json(res, 200, { ok: true, approval: approvalCfg(), toolsEnabled: workCfg().toolsEnabled === true, work: st, mode: m, modeName: MODE_NAME[m] || m, history: grants.history(12), recent: workRecent(), suggestRoot: workCfg().suggestRoot, places: commonPlaces(), edits, lastRoot: __lastRoot, lastRootExists: __lastExists });
    }
    if (p === '/work/edits' && req.method === 'GET') {
      const q = new URL(req.url, 'http://x');
      const wsId = String(q.searchParams.get('wsId') || '');
      if (!wsId) return __json(res, 400, { ok: false, err: '缺 wsId' });
      const st = grants.active(workKey(__localConv()));
      const known = knownWsIds();
      if (!known.has(wsId) && !(st && st.id === wsId)) return __json(res, 404, { ok: false, err: '不认识的会话' });
      return __json(res, 200, { ok: true, wsId, active: !!(st && st.id === wsId), edits: snapshots.list(wsId, 40) });
    }
    if (p === '/work/restore' && req.method === 'POST') {
      const b = await __readBody(req);
      const st = grants.active(workKey(__localConv()));
      if (!st) return __json(res, 400, { ok: false, err: '没有在跑的工作会话；先进入工作模式再恢复' });
      if (!b.id) return __json(res, 400, { ok: false, err: '缺编辑记录 id' });
      const wantId = String(b.wsId || st.id);
      if (wantId !== st.id) {
        const known = knownWsIds();
        const rec = workRecent(50).find((x) => x.wsIds.includes(wantId));
        if (!known.has(wantId) || !rec) return __json(res, 400, { ok: false, err: '这条记录不属于这个会话' });
        if (path.resolve(rec.root) !== path.resolve(st.root)) {
          return __json(res, 400, { ok: false, err: '这条记录来自别的工作区（' + rec.root + '），先把工作区切回那里再恢复' });
        }
      }
      const all = snapshots.list(wantId, 300);
      const it = all.find((x) => x.id === String(b.id));
      if (!it) return __json(res, 404, { ok: false, err: '找不到这条编辑记录' });
      const abs = path.join(st.root, String(it.rel).split('/').join(path.sep));
      const deny = workDeny();
      const guard = (p2) => fsguard.checkWrite(p2, { base: st.root, root: st.root, denyAbs: deny, allowCreate: true });
      const r = snapshots.restore(wantId, String(b.id), abs, { root: st.root, guard });
      if (!r.ok && r.conflict) {
        return __json(res, 409, { ok: false, conflict: true, err: r.err, diskSha: r.diskSha, expectSha: r.expectSha });
      }
      if (!r.ok) return __json(res, 400, { ok: false, err: r.err });
      log('[work] restore', st.id, it.rel, r.action);
      return __json(res, 200, { ok: true, action: r.action, rel: it.rel, work: grants.state(workKey(__localConv())), edits: snapshots.list(st.id, 12) });
    }
    if (p === '/work/undo' && req.method === 'POST') {
      const st = grants.active(workKey(__localConv()));
      if (!st) return __json(res, 400, { ok: false, err: '没有在跑的工作会话；先进入工作模式再撤销' });
      const denyU = workDeny();
      const guardU = (p2) => fsguard.checkWrite(p2, { base: st.root, root: st.root, denyAbs: denyU, allowCreate: true });
      const r = snapshots.undoAll(st.id, st.root, 200, { guard: guardU });
      log('[work] undo-all', st.id, r.ok ? 'ok' : 'stopped@' + r.stoppedAt, r.done.length, 'remaining', r.remaining);
      return __json(res, r.ok ? 200 : 409, {
        ok: r.ok, undone: r.done.filter((x) => x.ok).length, stoppedAt: r.stoppedAt,
        remaining: r.remaining, total: r.total,
        done: r.done, work: grants.state(workKey(__localConv())), edits: snapshots.list(st.id, 12),
      });
    }
    if (p === '/work/suggest' && req.method === 'GET') {
      return __json(res, 200, { ok: true, path: suggestWorkPath(u.searchParams.get('topic')) });
    }
    if (p === '/work/start' && req.method === 'POST') {
      const b = await __readBody(req);
      const w = workCfg();
      const key = workKey(__localConv());
      if (w.toolsEnabled !== true) return __json(res, 403, { ok: false, err: '「允许她动电脑」是关着的：先到「模型页」里打开，再选工作文件夹' });
      if (!b.root) return __json(res, 400, { ok: false, err: '缺工作目录' });
      const asked = path.resolve(String(b.root).trim());
      // 能力以「档位」为准：b.mode 优先，其次设置里存的 defaultMode。
      // 客户端传的 caps 只用来记账，不许超过档位给的能力——否则谁调接口谁说了算，闸门等于没有。
      const wantMode = (() => {
        const m = String((b && b.mode) || '').trim();
        if (m && MODE_CAPS[m]) return m;
        const d = String(workCfg().defaultMode || 'write');
        return MODE_CAPS[d] ? d : 'write';
      })();
      const capsWant = MODE_CAPS[wantMode].slice();
      const askedCaps = (Array.isArray(b.caps) ? b.caps : []).map(String);
      const capped = askedCaps.filter((c) => !capsWant.includes(c));
      if (capped.length) log('[work] 起始能力按档位收窄：', wantMode, '挡掉了 ' + capped.join(','));
      const wantWrite = capsWant.includes('fs:write');
      // 写权限必须由界面明确确认，不能只靠一个参数（复查 R4）
      if (wantWrite && b.confirmWrite !== true) return __json(res, 400, { ok: false, err: '要改文件得在弹窗里明确勾选并确认（confirmWrite）' });

      // 先查状态/类型/能力，再动磁盘：失败不留空目录（复查 R7）
      if (grants.active(key)) return __json(res, 400, { ok: false, err: '已经有一个工作会话在跑；先停掉再开新的' });
      let exists = false, isDir = false;
      try { const st = fs.lstatSync(asked); exists = true; isDir = st.isDirectory(); } catch {}
      if (exists && !isDir) return __json(res, 400, { ok: false, err: '这个路径不是目录：' + asked });
      let count = 0;
      if (exists) { try { count = fs.readdirSync(asked).length; } catch {} }
      if (exists && count > 0 && !b.useExisting) return __json(res, 400, { ok: false, err: '这个文件夹里已经有东西了；要用它就勾「直接用这个文件夹」，想干净就新建一个' });

      // 进入工作模式 = 选定一个文件夹，就在这个文件夹里干活（DSH / Codex 那种）
      // 不复制、不套日期前缀：选哪个目录，工作区就是哪个目录；不存在就当场新建
      const root = asked;
      const source = String(b.source || '');
      let createdByUs = false;
      if (!exists) {
        try { fs.mkdirSync(root, { recursive: true }); createdByUs = true; } catch (e) { return __json(res, 400, { ok: false, err: '建不了文件夹：' + e.message }); }
      }
      const r = grants.open({
        convKey: key, root,
        readRoots: [ root, ...w.readRoots ],
        caps: capsWant,
        timeoutMin: b.timeoutMin || w.timeoutMin,
        inPlace: true, source,
      });
      try { settings.patch({ work: { lastRoot: root } }); } catch {}
      if (!r.ok && createdByUs) { try { fs.rmdirSync(root); } catch {} }
      log('[work] start', r.ok ? r.state.id : r.err, root, exists ? '(已有文件夹)' : '(新建文件夹)');
      return __json(res, r.ok ? 200 : 400, r);
    }
    // 弹原生选文件夹框：转给主程序（Electron）的本地服务
    if (p === '/work/pick-dir' && req.method === 'POST') {
      const b = await __readBody(req);
      const from = String((b && b.from) || '').trim();
      try {
        const pf = path.join(PATHS.data, 'notify.port');
        const port = fs.readFileSync(pf, 'utf8').trim();
        const out = await new Promise((resolve) => {
          const payload = JSON.stringify({ from });
          const rq = http.request({
            host: '127.0.0.1', port: Number(port), path: '/pick-dir', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
            timeout: 120000,
          }, (rs) => { let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, err: '主程序回的不是 JSON' }); } }); });
          rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, err: '对话框等太久了' }); });
          rq.on('error', (e) => resolve({ ok: false, err: String(e.message || e) }));
          rq.write(payload); rq.end();
        });
        return __json(res, 200, out);
      } catch (e) {
        return __json(res, 200, { ok: false, err: '主程序没在跑（找不到 notify.port）：' + (e.message || e) });
      }
    }

    if (p === '/work/dirs' && req.method === 'GET') {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const home = process.env.USERPROFILE || 'C:\\';
        let want = String(u.searchParams.get('path') || '').trim() || home;
        try { want = path.resolve(want); } catch {}
        if (!fs.existsSync(want) || !fs.statSync(want).isDirectory()) want = path.resolve(home);
        const deny = workDeny();
        const dirs = [];
        for (const d of fs.readdirSync(want, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const full = path.join(want, d.name);
          if (d.name === '.trash' || d.name === 'node_modules') continue;
          if (deny.some((x) => full.toLowerCase().startsWith(String(x).toLowerCase()))) continue;
          dirs.push({ name: d.name, path: full });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        const parent = path.dirname(want);
        return __json(res, 200, { ok: true, path: want, home, parent: parent === want ? '' : parent, dirs: dirs.slice(0, 300) });
      } catch (e) { return __json(res, 200, { ok: false, err: '读不了这个目录：' + (e.message || e) }); }
    }

    if (p === '/work/tools' && req.method === 'POST') {
      const b = await __readBody(req);
      const on = b.enabled === true;
      try { settings.patch({ work: { toolsEnabled: on } }); } catch (e) { return __json(res, 500, { ok: false, err: '存不进配置（' + PATHS.config + '）：' + e.message }); }
      if (!on) { try { const a = grants.active(workKey(__localConv())); if (a) { grants.stop(workKey(__localConv())); log('[work] tools off → 停掉会话', a.id); } } catch {} }
      log('[work] tools', on ? 'on' : 'off');
      let now = false;
      try { now = settings.load().work.toolsEnabled === true; } catch {}
      return __json(res, 200, { ok: true, enabled: on, stillOn: now, file: PATHS.config });
    }

    if (p === '/work/mode' && req.method === 'POST') {
      const b = await __readBody(req);
      const want = String(b.mode || '').trim();
      if (!MODE_CAPS[want]) return __json(res, 400, { ok: false, err: '权限只有三档：read / write / full' });
      try { settings.patch({ work: { defaultMode: want } }); } catch {}
      const act = grants.active(workKey(__localConv()));
      if (!act) return __json(res, 200, { ok: true, mode: want, modeName: MODE_NAME[want], saved: true, work: null });
      const r = grants.setCaps(workKey(__localConv()), MODE_CAPS[want]);
      if (!r.ok) return __json(res, 400, { ok: false, err: r.err });
      log('[work] mode', workKey(__localConv()), want, 'caps=' + (r.state.caps || []).join(','));
      return __json(res, 200, { ok: true, mode: want, modeName: MODE_NAME[want], caps: r.state.caps, epoch: r.state.epoch, work: r.state });
    }
    if (p === '/work/approval' && req.method === 'POST') {
      const b = await __readBody(req);
      const want = String(b.approval || '').trim();
      if (want !== 'ask' && want !== 'never') return __json(res, 400, { ok: false, err: '策略只有两种：ask / never' });
      try { settings.patch({ work: { approval: want } }); } catch {}
      log('[work] approval', want);
      return __json(res, 200, { ok: true, approval: want });
    }
    if (p === '/work/stop' && req.method === 'POST') {
      const __wk = workKey(__localConv());
      cancelApprovals(__wk);
      const __wsNow = grants.active(__wk);
      let __chg = null;
      if (__wsNow) {
        try {
          const lst = snapshots.list(__wsNow.id, 500) || [];
          const real = lst.filter((x) => x && x.action !== 'revert' && x.status !== 'pending');
          const files = new Set(real.map((x) => String(x.rel || '')));
          __chg = { edits: real.length, files: files.size, wsId: __wsNow.id };
        } catch { __chg = null; }
      }
      if (__wsNow) { try { const k = exec.killAll(__wsNow.id); if (k) log('[work] stop 掐掉进程树', k); } catch {} }
      const r = grants.stop(__wk, 'user');
      log('[work] stop', r.already ? '(none)' : r.id, __chg ? ('本次 ' + __chg.edits + ' 条改动 / ' + __chg.files + ' 个文件') : '');
      return __json(res, 200, { ok: true, work: { active: false }, changed: __chg });
    }
    if (p === '/work/touch' && req.method === 'POST') {
      grants.touch(workKey(__localConv()));
      return __json(res, 200, { ok: true, work: grants.state(workKey(__localConv())) });
    }
    if (p === '/proactive') {
      if (req.method !== 'POST') return __json(res, 405, { ok: false, err: 'method' });
      __json(res, 200, { ok: true });
      reply(__localConv(), '', { proactive: true, manualProactive: true }).catch((e) => log('[local] proactive fail', e.message));
      return;
    }
    return __json(res, 404, { ok: false });
  });
  srv.on('error', (e) => log('[local] listen fail', e.message));
  srv.listen(LOCAL_PORT, '127.0.0.1', () => log('local channel on 127.0.0.1:' + LOCAL_PORT));
}
startLocalChannel();
