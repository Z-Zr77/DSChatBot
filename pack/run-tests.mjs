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
  ['poc-memory-classify-test', '记忆入库前分类：她的台词丢掉、交代的事转待办、其余才当事实'],
  ['poc-memory-mute-test', '记忆：别再提 / 办完就打标 / 连着两次不回必须开口'],
  ['poc-websearch-test', '联网检索：走百炼 enable_search，没 key 就不出门'],
  ['poc-browse-gate-test', '上网开关真的会拦住她：默认关，关着就不出门'],
  ['poc-share-test', '她刷到东西想跟人说：一天两次、间隔三小时、按东八区算天'],
  ['poc-her-day-test', '概览第一屏：她在干什么：日程、事件、待办都得是真的'],
  ['poc-moments-test', '恋人相处：身份隔离 / 关心触发 / 忙时安静'],
  ['poc-blank-version-test', '空白版：外貌无预设 / 身份保存 / 打包隐私排除'],
  ['poc-fresh-install-test', '全新机器：向导不再重复弹、语音灯按真能不能跑判、没主人号有提示'],
  ['poc-qqlogin-test', 'QQ 登录改成密码：扫码入口下线、三步引导、状态看内核/窗口/连上'],
  ['poc-acceptance-fix-test', '验收六条：exec 越权 / 首条发送 / 档位 / 例子能力 / 原生框超时 / 审批超时'],
  ['poc-chatwork-e2e-test', '端到端：聊天窗发一句话，桥接真的收到、她真的回'],
  ['poc-polish2-test', '停止报改动数 / 读宽改严 / 记忆来源与更替链'],

  ['poc-p1-test', '第一轮复查（路径/配置/回复定稿）'],
  ['poc-facts-test', '记忆与氛围字段'],
  ['poc-backup-test', '备份（排除项/清单/保留份数/自动）'],
  ['poc-history-test', '工作区历史/一键重开/旧改动恢复'],
  ['poc-review2-test', '第二轮复查（F14–F21 + 记忆迁移）'],
  ['poc-selfie-place-test', '自拍地点/室内外'],
  ['poc-sleep-test', '睡眠状态'],
  ['poc-outreach-test', '她先开口的这场：不能装没看见，要走得把话说完'],
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
  ['poc-console-layout-test', '控制台定稿：Electron 渲染 / 图谱 / 主题 / 配置保存 / 看图路由'],
  ['poc-brain-retry-test', '大脑空回复重试（不许她的回复凭空消失）'],
  ['poc-memory-expire-test', '一次性承诺会过期（明早说的那件事，过了就作废）'],
  ['poc-selfie-frame-test', '全身照别拍成半身（机位按他的原话定）'],
  ['poc-photo-promise-test', '答应发照片却没写标签：仍要出图；出不了就当轮说明'],
  ['poc-taboo-test', '口语禁忌：别提/不要再说要记住，可以说了才解开，回复里再提起会被拿掉'],
  ['poc-loops-test', '未了之事：做完或过期，不许一直挂着'],
  ['poc-memory-archive-test', '长期档案：旧事不删、聊到能翻出来，说忘就忘'],
  ['poc-doctor-test', '自检：十项最基础的东西，硬伤和可选项要分得清'],
  ['poc-wizard-test', '第一次见面向导：没配好才出来，配好了不许再弹'],
  ['poc-channels-test', '通道层：她住在桥接里，QQ 只是出口之一'],
  ['poc-onebot-test', 'OneBot 连接参数：地址归一化与 token 头'],
  ['poc-persona-default-test', '第一次启动自动生成人设（新人第一次打开别是空壳）'],
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
// 她会"晚点回"甚至"这次不回"之后，测试不能真等：延迟统一乘 0，也不许装死
if (!env.QQBOT_DELAY_SCALE) env.QQBOT_DELAY_SCALE = '0';

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
