import { PATHS } from './paths.mjs';
const RQ = PATHS.data;
const RQ_AGENT = PATHS.agent;
// QQ 空间：发布 / 列表 / 删除 / 敏感词自查
// 走的是 QQ 空间 Web 接口，凭证从 NapCat 的登录态里取（get_credentials）。
// 注意：这是非公开接口，QQ 随时可能改；改了就是 500 或 code 非 0，看日志即可。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://user.qzone.qq.com/', Origin: 'https://user.qzone.qq.com' };
const NAPCAT = 'http://127.0.0.1:3000';

async function creds() {
  const r = await fetch(`${NAPCAT}/get_credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'qzone.qq.com' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  const ck = j?.data?.cookies || '';
  const uin = (ck.match(/uin=o(\d+)/) || [])[1];
  if (!uin) throw new Error('拿不到 QQ 登录态（cookies 里没有 uin）');
  return { uin, cookies: ck, gtk: j.data.token };
}

export async function publish(text) {
  const { uin, cookies, gtk } = await creds();
  const body = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    who: '1',
    con: text,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: uin,
    code: '',
    format: 'json',
    qzone_version: '20150630',
  });
  const res = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`, {
    method: 'POST',
    headers: { ...H, Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const t = await res.text();
  const code = (t.match(/"code"\s*:\s*(-?\d+)/) || [])[1];
  if (code !== '0') throw new Error(`发布失败 code=${code ?? '?'} ${t.slice(0, 160)}`);
  return true;
}

export async function list(count = 10) {
  const { uin, cookies, gtk } = await creds();
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=${uin}&ftype=0&sort=0&pos=0&num=${count}&replynum=0&g_tk=${gtk}&format=json`;
  const res = await fetch(url, { headers: { ...H, Cookie: cookies }, signal: AbortSignal.timeout(30000) });
  const t = await res.text();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0) throw new Error('空间列表返回异常');
  const j = JSON.parse(t.slice(s, e + 1));
  return (j.msglist || []).map((m) => ({ tid: m.tid, content: m.content, time: m.created_time }));
}

export async function remove(tid) {
  const { uin, cookies, gtk } = await creds();
  const res = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${gtk}`, {
    method: 'POST',
    headers: { ...H, Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hostuin: uin, tid, t1_source: '1', code: '', format: 'json' }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await res.text();
  const code = (t.match(/"code"\s*:\s*(-?\d+)/) || [])[1];
  if (code !== '0') throw new Error(`删除失败 code=${code}`);
  return true;
}

// ---- 发送前自查（DECISIONS.md 第八节第 4 条的黑名单）----
const HARD = [
  [/\b1[3-9]\d{9}\b/, '手机号'],
  [/\b\d{5,12}\b/, '疑似 QQ/工号等数字 ID'],
  [/(身份证|学号|学籍)/, '身份信息'],
  [/(大学|学院|中学|小学|高中|技校|浙大|北大|清华|复旦|交大|同济|武大|南开|人大附)/, '学校'],
  [/(小区|号楼|单元|门牌|公寓)/, '住址'],
  [/(微信|支付宝|银行卡|收款|转账)/, '联系方式/支付'],
  [/(自杀|跳楼|割腕|去死)/, '自伤'],
  [/(癌症|艾滋病|抑郁症|确诊)/, '疾病'],
  [/(股票|基金|比特币|涨停|收益率)/, '金融'],
  [/(总统|主席|政府|共产党|国民党|选举|游行|示威)/, '政治'],
  [/(地震|洪水|空难|爆炸|疫情)/, '灾难'],
  [/(男朋友|女朋友|对象|老公|老婆|我家那位)/, '指向用户的私人关系'],
  [/(傻逼|操你|妈的|滚蛋|贱人|神经病)/, '脏话'],
];

function overlap(a, b) {
  // 8 字以上的连续重合，用来挡"把聊天原话搬上去"
  if (!a || !b) return false;
  const s = String(a).replace(/\s+/g, '');
  const t = String(b).replace(/\s+/g, '');
  if (t.length < 8) return false;
  for (let i = 0; i + 8 <= t.length; i++) if (s.includes(t.slice(i, i + 8))) return true;
  return false;
}

export function check(text, ctx = {}) {
  const t = String(text || '');
  if (t.length < 10) return { ok: false, why: '太短' };
  if (t.length > 400) return { ok: false, why: '太长' };
  for (const [re, why] of HARD) if (re.test(t)) return { ok: false, why: `命中「${why}」` };
  // 记忆里出现过的名字，一律不许写到空间上
  for (const m of ctx.memos || []) {
    const g = String(m).match(/叫\s*([\u4e00-\u9fa5]{2,3})/);
    if (g && t.includes(g[1])) return { ok: false, why: '出现了对方的名字' };
  }
  for (const line of ctx.dialogue || []) if (overlap(t, line)) return { ok: false, why: '和聊天原话重合' };
  for (const m of ctx.memos || []) if (overlap(t, m)) return { ok: false, why: '翻出了私事' };
  return { ok: true };
}
