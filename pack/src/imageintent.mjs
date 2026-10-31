// 生图/自拍的"语言判定"纯函数：画面里是谁、这轮给了什么衣服、必须出现哪些物件。
// 只做文字判断，不碰文件/网络/状态；bridge 与 self 共用这一份，避免两条链各写一套正则后分叉
//（2026-10-30 那次「书桌命中书」「站好不算在场」就是分叉 + 子串匹配造成的）。
//
// 判断顺序（按修改指导）：① 明确排除她 → 无人；② 明确要求她 → 她在；③ 其余当无人场景并标 unclear。

const NEG_HER = new RegExp(
  [
    '(?:不要|别|不用|不想|不必)(?:让|叫)?(?:我|俺|自己|她|本人)?(?:入镜|出镜|上镜|出现|进画面|在画面|站在|站着)',
    '(?:不要|别|不用|不必)(?:有|出现|画|放)?人',
    '无人|没人|空镜|纯场景|空房间',
    '只拍(?!我|俺|自己|她)|光拍(?!我|俺|自己|她)|只画(?!我|俺|自己|她)',
    '镜前不要站人|不要站人',
  ].join('|'),
);

const REQ_HER = new RegExp(
  [
    '(?:我|俺|自己|本人)[^，。；]{0,10}(?:站在|站着|站好|站到|坐着|坐好|坐在|躺在|躺着|趴着|靠在|靠着|蹲着|蹲在|穿[着上了]|拿着|端着|举着|捧着|拎着|背着|抱着|戴着|看镜头|入镜|出镜|比耶)',
    '(?:拍|画|给我拍|拍一张|拍个|来一张)(?:我|俺|自己|本人)',
    '自拍|镜头里|对镜自拍|合影',
  ].join('|'),
);

const SELF_SHOT = /自拍|拍我|给我拍|镜头里|对镜自拍/;

// 明确"不是人物照"的说法：商品图/平铺/挂拍这类，就算句子里有"我"也不该画人
const PRODUCT = /商品图|细节图|平铺|挂拍|无人|空镜|只拍(?:衣服|裙子|那件|这件)/;

export function subjectOf(text) {
  const s = String(text || '');
  if (NEG_HER.test(s)) return { role: 'none', shot: 'other', why: '明确排除人物' };
  if (SELF_SHOT.test(s)) return { role: 'her', shot: 'selfie', why: '自拍/拍我' };
  if (REQ_HER.test(s)) return { role: 'her', shot: 'photo', why: '她点明自己在画面里' };
  if (PRODUCT.test(s)) return { role: 'none', shot: 'other', why: '商品图/平铺' };
  return { role: 'none', shot: 'other', why: '不明确，按无人场景' };
}

// 服装词表（判定"这轮有没有给新衣服"用）
export const OUT_KW = /(女仆装|女仆裙|睡衣|家居服|短袖|T恤|吊带裙|吊带|衬衫|毛衣|卫衣|连衣裙|半身裙|围裙|制服|校服|西装|外套|风衣|运动裤|短裤|长裤|裙子|短裙|长裙|裙|短上衣|上衣|牛仔裤|连裤袜|黑丝|白丝|丝袜|打底裤|马甲|背心)/;

const NOT_CHANGE = /(?:不|别|不用|不要)(?:换|穿)|(?:这次|今天|今晚)不换|别换/;
const PLAN_NOW = /(?:明天|后天|以后再|下次|下周|回头|等会|一会儿|准备|打算|计划)/;
const STRIP_PREFIX = /^(?:我)?(?:换上了|换成了|换上了|换成了|换上|换成|换|穿上了|穿上|穿了|穿着|穿|打扮成|改成了|改穿)\s*/;

// 这轮消息里有没有"新的、明确要穿的那身"。不按顿号切整套搭配（裙子 + 连裤袜 + 鞋），
// 但要能把"我在书桌前站好，穿深蓝女仆装，全身照"这种整句里只摘出"深蓝女仆装"。
const TAIL_JUNK = /(全身照|半身照|照片|特写|一张|一张照片|的样子|看看|拍个|拍一张|镜头|光线|屋里|外面|背景)$/;

export function outfitOf(text) {
  const s = String(text || '');
  const negated = NOT_CHANGE.test(s);
  const planned = PLAN_NOW.test(s);
  if (!OUT_KW.test(s)) return { explicit: false, negated, planned, text: '', why: '没提衣服' };
  // 先按句号/逗号分组：一组里如果有点名衣服，就把"同样点名的顿号片段"拼回整套
  const groups = s.split(/[，。；;！!？?\n]/).map((x) => x.trim()).filter(Boolean);
  let best = '';
  let bestScore = Infinity;
  for (const g of groups) {
    const parts = g.split(/、/).map((x) => x.trim()).filter(Boolean);
    if (!parts.some((p) => OUT_KW.test(p))) continue;
    const keepParts = parts.filter((p) => OUT_KW.test(p));
    const ens = keepParts.join('、');
    // 越短越像"衣服本身"（整句里挑最短的那段，避免把场景、光线一起塞进来）
    const score = ens.length;
    if (score < bestScore) { bestScore = score; best = ens; }
  }
  if (!best) return { explicit: false, negated, planned, text: '', why: '没解析出具体那身' };
  let t = best.replace(STRIP_PREFIX, '').trim();
  for (let i = 0; i < 3; i++) {
    const n = t.replace(/^(?:了|的|一[件条套双]?)\s*/, '').replace(TAIL_JUNK, '').trim();
    if (n === t) break;
    t = n;
  }
  if (!t || !OUT_KW.test(t)) return { explicit: false, negated, planned, text: '', why: '没解析出具体那身' };
  if (negated) return { explicit: false, negated, planned, text: '', why: '这轮说了不换' };
  if (planned) return { explicit: false, negated, planned, text: '', why: '是计划不是说现在这身' };
  return { explicit: true, negated, planned, text: t, why: '明确了新的一身' };
}

// 只认"明确要求出现在画面里"的物件。复合词（书桌/画面/电脑桌/手机支架）与否定句一律不算，
// 否则会像 2026-10-30 那样把「书桌」判成缺书、再白画一张。
const PROPS = ['面', '包子', '饺子', '烤肠', '外卖', '奶茶', '咖啡', '快递', '伞', '手机', '花', '书', '电脑', '饭', '粥', '饮料', '袋子', '行李箱', '猫', '狗', '烟', '冰淇淋'];
const HOLD = /(拿着|端着|举着|捧着|拎着|背着|抱着|戴着|手里|怀里|桌上|面前|旁边|嘴里|吃着|喝着|啃着|叼着|揣着)/;
const NEG_PROP = /(没有|没带|不带|不需要|别放|空着|不放)/;

export function propsOf(text) {
  const out = [];
  const s = String(text || '');
  for (const raw of s.split(/[。；;！!？?\n]/)) {
    if (!HOLD.test(raw)) continue;
    if (NEG_PROP.test(raw)) continue;
    const seg = raw
      .replace(/书桌|书架|书柜|书包/g, '')
      .replace(/电脑桌|电脑屏|电脑上|电脑前|电脑包/g, '')
      .replace(/手机支架|手机壳/g, '')
      .replace(/画面|面条|面馆|泡面馆/g, '');
    for (const p of PROPS) {
      if (out.includes(p)) continue;
      if (seg.includes(p)) out.push(p);
    }
  }
  return out;
}

// 他刚发来的图，是干嘛用的：衣服 / 画稿截图之类的文档 / 不知道
export function refPurposeOf(text) {
  const s = String(text || '');
  if (/(画稿|稿子|截图|屏幕|文件|文档|代码|报表)/.test(s)) return 'doc';
  if (OUT_KW.test(s) || /(换上|穿上|这套|这身|这条|这件)/.test(s)) return 'clothes';
  return 'unknown';
}

// 这句是不是在"明确点名用他发的那张图"（而不是碰巧提到衣服）
export function pointsAtRef(text) {
  return /(这张|那这张|这身|这套|这件|这条|图里|图上的|参考图|照着|按(?:这|那张)|同样?的(?:衣服|外套|裙子|款式)|穿这张|穿那套)/.test(String(text || ''));
}
