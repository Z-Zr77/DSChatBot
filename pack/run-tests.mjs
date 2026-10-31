// 统一测试入口：串行跑完全部回归套件（测试会各自写临时目录，不碰开发目录）
// 跑法：npm test        或   node run-tests.mjs [套件名…]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACK = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.join(PACK, 'test');   // 套件在 pack/test/
const REPO = path.resolve(HERE, '..', '..');   // 测试脚本里的 path.resolve('pack') 以仓库根为基准
const LOCK = path.join(os.tmpdir(), 'qq-bot-tests.lock');

const ALL = [
  ['poc-polish2-test', '停止报改动数 / 读宽改严 / 记忆来源与更替链'],

  ['poc-p1-test', '第一轮复查（路径/配置/回复定稿）'],
  ['poc-facts-test', '记忆与氛围字段'],
  ['poc-backup-test', '备份（排除项/清单/保留份数/自动）'],
  ['poc-history-test', '工作区历史/一键重开/旧改动恢复'],
  ['poc-review2-test', '第二轮复查（F14–F21 + 记忆迁移）'],
  ['poc-selfie-place-test', '自拍地点/室内外'],
  ['poc-sleep-test', '睡眠状态'],
  ['poc-face-outfit-test', '表情表与换装'],
  ['poc-multiref-test', '多参考图生图'],
  ['poc-image-intent-test', '生图主体/参考图/穿着判定（第一轮）'],
  ['poc-tools-test', '工具层边界（28 条）'],
  ['poc-approve-test', '审批链路端到端'],
  ['poc-growth-test', '成长三步（经验库/长期事实/技能）'],
  ['poc-work-test', '工作模式第一步（单元）'],
  ['poc-write-test', '工作模式第二步：写/快照/恢复'],
  ['poc-dir-test', '工作模式第三步：目录/移动/删除/检索'],
  ['poc-undo-test', '整会话撤销 + search 编码回退'],
  ['poc-boundary-test', '边界复审 F01–F12（禁读/恢复/授权/编码/附件）'],
  ['poc-exec-test', '受限命令执行（白名单/路径/cwd/超时/杀树/审计）'],
  ['poc-net-test', '联网：域名策略/私网拦截/重定向/超时/审计/工具'],
  ['poc-net-e2e', '联网端到端（真起桥接 + 桩网页）'],
  ['poc-trace-test', '工作轨迹与常用位置（0.3.28）'],
  ['poc-attach-test', '受控图片附件（只发真图/只发工作区内）'],
  ['poc-work-r1-r8-test', '工作模式 R1–R8（集成，真起桥接）'],
  ['poc-tools-e2e', '工具轮端到端（假大脑）'],
  ['poc-noqq-test', '全新安装没填主人 QQ 也能聊（0.6.3 回归）'],
  ['poc-ui-settings-test', '控制台设置：保存密钥生效 / 无重名函数 / NapCat 引导'],
  ['poc-ui-smoke-test', '界面体检：注入完整 / 按钮都有函数 / id 都真实存在 / 没有裸 undefined'],
];

// 防止两个 runner 同时跑（会抢端口、抢临时目录）
// 锁文件里存 JSON {pid, at}：以前把 PID 当时间戳比，等于没判活（复查指出）
try {
  const rawLock = fs.readFileSync(LOCK, 'utf8');
  let rec = { pid: 0, at: 0 };
  try { rec = JSON.parse(rawLock); } catch { rec = { pid: Number(rawLock) || 0, at: 0 }; }
  const fresh = rec.at && Date.now() - rec.at < 30 * 60e3;
  const alive = (() => { try { process.kill(rec.pid, 0); return true; } catch { return false; } })();
  if (fresh && alive) {
    console.error('[tests] 已经有一个测试在跑（pid ' + rec.pid + '），先等它结束，或删掉 ' + LOCK);
    process.exit(2);
  }
} catch {}
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));

const pick = process.argv.slice(2);
const list = pick.length ? ALL.filter(([n]) => pick.some((p) => n.includes(p))) : ALL;
if (!list.length) {
  console.error('[tests] 没有匹配的套件：' + pick.join(' '));
  fs.rmSync(LOCK, { force: true });
  process.exit(2);
}

// 测试里若忘记设 QQBOT_API_FILE，也不许落到 src/api.json
const env = { ...process.env };
if (!env.QQBOT_API_FILE) env.QQBOT_API_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-api-')), 'api.json');

let pass = 0;
let fail = 0;
const failed = [];
const t0 = Date.now();

for (const [name, desc] of list) {
  const file = path.join(HERE, name + '.mjs');
  if (!fs.existsSync(file)) { console.log(`FAIL ${name}（文件不存在）`); fail++; failed.push(name); continue; }
  process.stdout.write(`\n=== ${name} — ${desc}\n`);
  const r = spawnSync(process.execPath, [file], { cwd: REPO, env, stdio: 'inherit' });
  if (r.status === 0) pass++;
  else { fail++; failed.push(name); }
}

fs.rmSync(LOCK, { force: true });
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n──────────────────────────────');
console.log(`套件：通过 ${pass} / 失败 ${fail}（${sec}s）`);
if (failed.length) console.log('失败：' + failed.join(', '));
process.exit(fail ? 1 : 0);
