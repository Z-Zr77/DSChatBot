// 给她"像不像活人"打个分。
//
// 起因：改人设改了六遍，全靠感觉，每次都觉得好一点，指标看不出来。
// 这个脚本读聊天记录，量五个能反映"活人感"的硬指标，改前改后各跑一次就有数了。
//
// 用法：
//   node pack/tools/style-score.mjs                 # 最近 200 条她的发言
//   node pack/tools/style-score.mjs --n 100
//   node pack/tools/style-score.mjs --data E:/DSChatBot/data
//   node pack/tools/style-score.mjs --from 2026-11-02 --to 2026-11-03
//   node pack/tools/style-score.mjs --file 某文件.jsonl
//
// 指标（都是"越高越像人"，除了平均长度是越低越好）：
//   问号率   真人有 20–30% 的句子带问号（追问、确认、反问）；她原来只有 8%
//   均长     一行话 8–12 字最像打字；超过 15 字开始像"回答问题"
//   感叹号   0% 是"客服腔"的典型特征
//   开头重复 前三字重复越多，越像模板
//   表情开场 适度有（3–10%）说明她在用表情包，不是纯文字
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DATA = arg('data', process.env.QQBOT_DATA || 'E:/DSChatBot/data');
const N = Number(arg('n', 200));
const FROM = arg('from', '');
const TO = arg('to', '');
const FILE = arg('file', '');

function findChatFile() {
  if (FILE) return FILE;
  const dir = path.join(DATA, 'chat');
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  // 选最大的那个（主人号聊得最多）
  files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size);
  return files.length ? path.join(dir, files[0]) : '';
}

const dayOf = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const HEDGE = /^(行吧|行行|行，|嗯|哦|噢|好吧|可以啊|随便你)/;

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function main() {
  const file = findChatFile();
  if (!file) {
    console.log('找不到聊天记录：' + path.join(DATA, 'chat'));
    process.exit(1);
  }
  const rows = fs.readFileSync(file, 'utf8').split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.type === 'text' && String(r.text || '').trim());
  if (!rows.length) { console.log('记录里没有文本消息'); process.exit(1); }

  const inRange = r => {
    const d = dayOf(r.at);
    if (FROM && d < FROM) return false;
    if (TO && d > TO) return false;
    return true;
  };
  const hers = rows.filter(r => r.dir === 'out' && inRange(r)).slice(-N);
  const his = rows.filter(r => r.dir === 'in' && inRange(r)).slice(-N);
  if (!hers.length) { console.log('这个范围里没有她的发言'); process.exit(1); }

  const stat = (xs) => {
    const n = xs.length;
    const lens = xs.map(r => String(r.text).trim().length);
    const avg = lens.reduce((a, b) => a + b, 0) / n;
    const ask = xs.filter(r => /[?？]/.test(r.text)).length;
    const excl = xs.filter(r => /[!！]/.test(r.text)).length;
    const emo = xs.filter(r => EMOJI.test(String(r.text).trim().slice(0, 2))).length;
    const hedge = xs.filter(r => HEDGE.test(String(r.text).trim())).length;
    // 开头重复：取前两个字（去掉表情）做计数
    const head = new Map();
    for (const r of xs) {
      const t = String(r.text).trim().replace(EMOJI, '').slice(0, 2);
      if (t) head.set(t, (head.get(t) || 0) + 1);
    }
    const top = [...head.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return {
      n, avgLen: +avg.toFixed(1),
      ask: pct(ask, n), excl: pct(excl, n), emoji: pct(emo, n), hedge: pct(hedge, n),
      topHead: top.map(([k, v]) => `${k}×${v}`).join(' '),
      topHeadMax: top.length ? top[0][1] : 0,
    };
  };

  const H = stat(hers);
  const U = stat(his);

  // 打分：五项加权，满分 100。线来自"真人闲聊"的经验值，不是精确科学。
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 相对基准：真人的说话长度、感叹号、问号是**跟着对方走**的。
  // 用绝对阈值会奖励"假激动"（为了凑 3% 感叹号硬加！），所以这里改成跟她对话的人比。
  const askScore = clamp(H.ask / Math.max(15, U.ask * 0.75), 0, 1);
  const lenScore = clamp(1 - Math.abs(H.avgLen - U.avgLen) / Math.max(6, U.avgLen * 0.45), 0, 1);
  const exclScore = clamp(1 - Math.abs(H.excl - U.excl) / Math.max(3, U.excl + 3), 0, 1);
  const repScore = clamp(1 - (H.topHeadMax - 1) / Math.max(1, Math.ceil(H.n * 0.08)), 0, 1);
  const emoScore = clamp(1 - Math.abs(H.emoji - 6) / 10, 0, 1); // 6% 最好
  const total = Math.round(100 * (askScore * 0.35 + lenScore * 0.2 + exclScore * 0.1 + repScore * 0.2 + emoScore * 0.15));

  console.log(`记录：${path.basename(file)}    范围：${FROM || '全部'} → ${TO || '全部'}    取样：她 ${H.n} 条 / 他 ${U.n} 条`);
  console.log('');
  console.log('指标            她      他      参考');
  console.log(`问号率          ${String(H.ask).padStart(3)}%    ${String(U.ask).padStart(3)}%    ≥他的一半`);
  console.log(`平均字数        ${String(H.avgLen).padStart(5)}   ${String(U.avgLen).padStart(5)}   跟他接近`);
  console.log(`感叹号          ${String(H.excl).padStart(3)}%    ${String(U.excl).padStart(3)}%    跟他接近`);
  console.log(`敷衍开头        ${String(H.hedge).padStart(3)}%    ${String(U.hedge).padStart(3)}%    ≤他`);
  console.log(`表情开场        ${String(H.emoji).padStart(3)}%    ${String(U.emoji).padStart(3)}%    3–10%`);
  console.log(`开头 top3       ${H.topHead}`);
  console.log('');
  console.log(`分数：${total}/100   （问号35% 长度20% 重复20% 感叹10% 表情15%）`);
  console.log('');
  // 分数怎么读
  if (total >= 75) console.log('读法：像个人。保持，别再加形容词了。');
  else if (total >= 55) console.log('读法：一半像人一半像客服。看上面最差的那一项，只改那一项。');
  else console.log('读法：机器味重。优先补问号（她得会追问）和去掉敷衍开头。');
}

main();
