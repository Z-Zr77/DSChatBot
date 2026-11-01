// 她的"样子"：一份参考图 + 一段形象描述。
// 描述会注入人格（让她知道自己长啥样），并在画图/自拍时拼进提示词。
// 数据放 data\self\ 下，跟其它数据一样可整包搬走。
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import * as settings from './settings.mjs';

const DIR = path.join(paths.PATHS.data, 'self');
const DESC = path.join(DIR, 'desc.txt');
const META = path.join(DIR, 'ref.json');

function ensure() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

export function desc() {
  ensure();
  try { return String(fs.readFileSync(DESC, 'utf8')).trim(); } catch { return ''; }
}

export function setDesc(text) {
  ensure();
  const t = String(text || '').slice(0, 1200).trim();
  fs.writeFileSync(DESC, t, 'utf8');
  return t;
}

export function refFile() {
  ensure();
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch {}
  if (meta && meta.file) {
    const p = path.join(DIR, meta.file);
    if (fs.existsSync(p)) return p;
  }
  for (const n of ['ref.png', 'ref.jpg', 'ref.jpeg', 'ref.webp']) {
    const p = path.join(DIR, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

export function setRef(buf, ext = 'png') {
  ensure();
  const e = String(ext || 'png').toLowerCase().replace(/[^a-z]/g, '') || 'png';
  // 先清掉旧图，避免多个 ref.* 并存
  for (const n of ['ref.png', 'ref.jpg', 'ref.jpeg', 'ref.webp']) {
    try { fs.unlinkSync(path.join(DIR, n)); } catch {}
  }
  const name = `ref.${e}`;
  fs.writeFileSync(path.join(DIR, name), buf);
  fs.writeFileSync(META, JSON.stringify({ file: name, at: Date.now(), bytes: buf.length }), 'utf8');
  return name;
}

export function mtime() {
  ensure();
  try { return String(fs.statSync(DESC).mtimeMs); } catch { return '0'; }
}

export function info() {
  const f = refFile();
  let bytes = 0; let at = 0;
  if (f) { try { const st = fs.statSync(f); bytes = st.size; at = st.mtimeMs; } catch {} }
  return { desc: desc(), hasRef: !!f, refBytes: bytes, refAt: at, refUrl: f ? '/api/self/ref' : '' };
}

// 形象卡单独拿出来：只有"画面里确实有她"的时候才拼进去，
// 画店面/街景/物件时拼这个会把她也画进去（20:47 那张面馆图就是这么来的）
export function characterCard() {
  const d = desc();
  return d ? `角色固定设定（每次都要一致）：${d.replace(/[。；;，,\s]+$/, '')}。` : '';
}

// 画图时拼在提示词前面：让生成的画面尽量保持同一张脸/同一套衣裙
export function stylePrefix(extra = '') {
  const d = desc();
  if (!d) return String(extra || '');
  const base = `角色固定设定（每次都要一致）：${d}`;
  return extra ? `${base}。画面内容：${extra}` : base;
}

function prompts() {
  const d = {
    style: '二次元动漫插画风格，线条干净、上色柔和。',
    selfie: '手机前置摄像头自拍：单人，近景，脸占画面主导，只拍上半身或肩部以上；不要出现手机本身、不要手机屏幕边框、不要对着镜子拍、不要画中画；手最多露一点手指边缘，没有手也行。',
    // 她两只手都要拿东西（水瓶、零食袋、伞…）时不能再说"举着手机自拍"——模型会多画一只举手机的手
    selfieBusy: '手机放在货架/桌面/支架上定时拍的近景（画面里没有手机、也没有举手机的手臂）：她两只手都在拿东西，一只手拿一样；画面里只出现她的两只手、两条胳膊，绝不能出现第三只手、第四条胳膊或多余的手指。',
    selfieFull: '全身照（不是自拍）：像有人在旁边拿手机替她拍下这一刻，从头到脚整个人都在画面里——头顶、手、脚和脚下地面都别裁掉，人物占画面高度八成左右，能看见身后的环境。只拍到腰、只到膝盖、半身，都算画错。',
    selfieBan: '禁止：文字、边框、多格拼图、贴纸、设定稿或立绘、手机或屏幕出现在画面里、镜子与画中画、夸张大特写的手、多条胳膊或畸形手指。',
    ref: '参考图只是设定稿：只参考这个人的长相、发型、耳鳍、服装和配色，绝不要复制参考图的白色背景、正面/侧面/背面三视图排版、全身立绘或线稿风格。',
    scene: '环境细节要有生活痕迹（家具、杂物、光源），构图自然，像随手拍的。',
    sceneBan: '禁止：人物、人脸、文字、水印、边框、多格拼图、画中画、手机与屏幕。',
  };
  try {
    const p = settings.load().prompts || {};
    return {
      style: String(p.style || d.style),
      selfie: String(p.selfie || d.selfie),
      selfieFull: String(p.selfieFull || d.selfieFull),
      selfieBusy: String(p.selfieBusy || d.selfieBusy),
      selfieBan: String(p.selfieBan || d.selfieBan),
      ref: String(p.ref || d.ref),
      scene: String(p.scene || d.scene),
      sceneBan: String(p.sceneBan || d.sceneBan),
    };
  } catch { return d; }
}

const SELFTAG = /\[\[\s*(?:自拍|拍照)\s*[:：]\s*([\s\S]*?)\]\]/g;

// 上一张自拍：谁、什么场景、哪张图。用来做"接着上一张拍"的连贯性。
const LAST = path.join(DIR, 'selfie-last.json');

export function last() {
  ensure();
  try {
    const j = JSON.parse(fs.readFileSync(LAST, 'utf8'));
    if (j && j.file && fs.existsSync(j.file)) return j;
  } catch {}
  return null;
}

export function setLast(file, scene, place = '', outfit = '', look = '') {
  ensure();
  try {
    fs.writeFileSync(LAST, JSON.stringify({ file, scene: String(scene || '').slice(0, 120), place: String(place || '').slice(0, 20), outfit: String(outfit || '').slice(0, 80), look: String(look || '').slice(0, 200), at: Date.now() }), 'utf8');
  } catch {}
}

// 「她现在穿着什么」是独立状态，跟上一张照片分开存：
// 照片超时/被清理/换了地点，都不该让衣服跟着变（2026-10-30 那几次衣服乱跳就是这么来的）。
const WEAR = path.join(DIR, 'outfit.json');

export function getOutfit() {
  ensure();
  try {
    const j = JSON.parse(fs.readFileSync(WEAR, 'utf8'));
    if (j && j.text) return { text: String(j.text).slice(0, 120), at: Number(j.at) || 0, src: String(j.src || ''), pending: String(j.pending || '').slice(0, 120) };
  } catch {}
  return null;
}

// src: 'her'(她这轮说的) | 'his'(他指定的) | 'init'(初始化默认)
export function setOutfit(text, src = 'her') {
  ensure();
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const old = getOutfit();
  const rec = { text: t, at: Date.now(), src, pending: old && old.pending ? old.pending : '' };
  try { fs.writeFileSync(WEAR, JSON.stringify(rec), 'utf8'); } catch {}
  return rec;
}

// 他明确要求换、但还没换（她可能下一句才换）：记一个"待完成的目标"
export function setPendingOutfit(text) {
  ensure();
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const old = getOutfit() || { text: '', at: 0, src: '' };
  const rec = { text: old.text, at: old.at, src: old.src, pending: t };
  try { fs.writeFileSync(WEAR, JSON.stringify(rec), 'utf8'); } catch {}
  return rec;
}

// 「换好了/再拍一张」：把待完成的目标落实成当前穿着，没有目标就返回 null（保持原样）
export function takePendingOutfit() {
  const old = getOutfit();
  if (!old || !old.pending) return null;
  const rec = setOutfit(old.pending, 'his');
  if (rec) {
    // 目标已经落实，清掉 pending，避免下次"换好了"又应用一遍
    try { fs.writeFileSync(WEAR, JSON.stringify({ ...rec, pending: '' }), 'utf8'); } catch {}
    return { ...rec, pending: '' };
  }
  return rec;
}

export function extractSelfies(text) {
  const out = [];
  const cleaned = String(text || '').replace(SELFTAG, (m, p1) => {
    out.push(String(p1 || '').trim());
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { cleaned, selfies: out.slice(0, 1) };
}

// 他这句话要的是全身还是半身。他明说了就按他说的，别让她自己的描述把人拍成半截。
const FULL_ASK = /(全身|整身|从头到脚|站起来|站全身|全身照|露腿|露脚|鞋子|脚下)/;
const HALF_ASK = /(半身|上半身|只拍上|脸就行|特写|近一点|近景)/;

export function frameFromText(text) {
  const t = String(text || '');
  if (HALF_ASK.test(t)) return 'half';   // 先判半身："上半身"里也含"身"
  if (FULL_ASK.test(t)) return 'full';
  return '';
}

// 他要的机位记在磁盘上，下一张自拍用掉就清掉（换进程、重启都还在）
const FRAME = path.join(DIR, 'frame.json');

export function setFrame(kind) {
  ensure();
  const k = kind === 'half' ? 'half' : 'full';
  try { fs.writeFileSync(FRAME, JSON.stringify({ kind: k, at: Date.now() }), 'utf8'); } catch {}
  return k;
}

export function frameWant(maxAgeMs = 30 * 60e3) {
  ensure();
  try {
    const j = JSON.parse(fs.readFileSync(FRAME, 'utf8'));
    if (j && j.kind && Date.now() - (Number(j.at) || 0) < maxAgeMs) return j.kind;
  } catch {}
  return '';
}

export function clearFrame() {
  try { fs.unlinkSync(FRAME); } catch {}
}

// 自拍提示词：强调"手机自拍/她本人在画面里"
// opts.keepIn：上一张自拍的场景（有就要求沿用同一地点，只改姿势/镜头）
const FULL_RE = /(全身|整身|从头到脚|站起来|站全身|拍个全身|拍一张全身|穿搭| outfit|outfit|露腿|鞋子|脚下)/i;
// 地点/室内外判定：嘴上一句"还在小区门口"，图就不能画成房间（2026-10-29 22:18 那次）
const OUTDOOR_RE = /(小区|门口|楼下|天上|街上|街道|马路|路边|路上|公园|夜市|广场|路灯|地铁|公交|车站|河边|海边|山上|天桥|操场|校门|停车场|巷子|街角|店门外)/;
const INDOOR_RE = /(家里|在家|房间|屋里|客厅|卧室|厨房|浴室|卫生间|阳台|宿舍|教室|办公室|店里|馆里|大厅|床上|被窝|室内)/;

export function selfiePrompt(scene, opts = {}) {
  const d = desc();
  const s = String(scene || '').trim() || '随手一张';
  const base = d ? `角色固定设定（每次都要一致）：${d.replace(/[。；;，,\s]+$/, '')}。` : '';
  const keep = String(opts.keepIn || '').trim();
  const changed = opts.changed === true;   // 他明确让换一身：地点可以延续，衣服必须换
  const same = keep
    ? (changed
      ? `延续上一张自拍：上一张是「${keep}」，地点、光线、背景可以延续，但衣服**必须换成下面这身**，别沿用上一张那套。`
      : `延续上一张自拍：上一张是「${keep}」，环境、光线、背景东西都别变，只改姿势和镜头。`)
    : '地点只取上面描述里提到的；没提到就按普通日常环境画，别自己编一个跟最近聊天对不上的新地点（也别加河流、海边这类没提过的地方）。';
  // 她这会儿在哪儿：由调用方把"现在的地点"传进来，优先于描述里的模糊说法
  const place = String(opts.place || '').trim();
  const where = `${place} ${s}`;
  // "卧室门口"这种既有室内词又有"门口"的，按室内算，别因为一个"门口"画到街上
  const outdoor = OUTDOOR_RE.test(where) && !INDOOR_RE.test(where);
  const indoor = !outdoor && INDOOR_RE.test(where);
  const placeRule = place
    ? (outdoor
      ? `她现在人在「${place}」，这是室外：画面里必须是室外的环境——${place}该有的街景、夜色、路灯或店面，别改成室内房间、客厅，也别用纯色/白底背景。`
      : `她现在人在「${place}」，画面环境就按这个地点来，别换成别的地方。`)
    : (outdoor ? '这是室外场景：画面里要有室外环境（街景、夜空、路灯、店门），别改成室内房间。' : '');
  // 白天/夜里要分开：中午在公园还说"路灯、夜色"就不像话了
  const hour = Number(new Date(Date.now() + 8 * 3600e3).getUTCHours());
  const night = hour < 6 || hour >= 18;
  const light = outdoor
    ? (night ? '真实夜景光：路灯、店面漏出来的暖光，脸别打成一团死白' : '真实白天的自然光，别把天画成黑的')
    : (indoor ? '真实室内光' : '真实光线');
  // 参考图是三视图设定稿，模型很容易照抄排版/白底/全身立绘 —— 必须明说只要人
  const P = prompts();
  const refRule = P.ref;
  // 机位：要全身就给全身机位，否则给半身/特写
  const wantFull = opts.full === true || opts.full === false ? opts.full : FULL_RE.test(s);
  const busy = opts.handsBusy === true;
  const cam = busy ? (P.selfieBusy || '') : (wantFull ? (P.selfieFull || '') : P.selfie);
  // 全身时不能再叠「前置自拍、脸占主导」，两个要求打架，模型就只给半身
  const extra = wantFull
    ? '构图必须包含头顶到脚，不要只拍半身，不要腰部以上截断。'
    : '';
  const wear = String(opts.outfit || '').trim();
  const wearRule = wear
    ? (changed
      ? `她这身换成了：${wear}。这是他明确要求换的，画面里必须穿这一身，别沿用上一张的旧衣服，也别把上一张的衣服画进来；参考图只用来对脸、发型和耳鳍。`
      : `她这身穿的是：${wear}。和同一场戏里保持一致，别自己换成别的衣服；参考图只用来对脸、发型和耳鳍，衣服一律按这句穿。`)
    : '';
  // 他发来的参考图（衣服/物件）：只抄东西，不抄人、不抄背景
  const refNote = String(opts.refNote || '').trim();
  const refNoteRule = refNote ? `多图参考：${refNote}` : '';
  return `${P.style}${base}画面内容：${cam}${s}。${extra}${placeRule}${refRule}${wearRule}${same}${refNoteRule}生活照质感，${light}。${P.selfieBan}`;
}

// 画面里有她，但不是自拍：像朋友拿手机替她抓拍。
// 机位不写死（按她自己的描述走），只把"这不是前置自拍"这件事说清楚。
export function photoPrompt(descText, opts = {}) {
  const s = String(descText || '').trim() || '一张她的生活照';
  const P = prompts();
  const wear = String(opts.outfit || '').trim();
  const wearRule = wear
    ? `她这身穿的是：${wear}。参考图只用来对脸、发型和耳鳍，衣服一律按这句穿。`
    : '';
  return [
    P.style,
    characterCard(),
    `画面内容：${s}。`,
    '第三人称视角：像有人拿手机替她拍下来，不是前置自拍——别把脸怼满画面，远近和机位按上面的描述来；描述没写机位就自然地拍全身或三四分之三身。',
    P.ref,
    wearRule,
    String(opts.refNote || '').trim() ? `多图参考：${String(opts.refNote).trim()}` : '',
    '生活照质感，人物和周围环境都要交代清楚，构图自然。',
    P.selfieBan,
  ].filter(Boolean).join('');
}
