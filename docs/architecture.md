# 架构

> 这份文档描述**当前**实现（0.7.x）。仓库根目录的 `ARCH.md` 是 0.2 时代的历史文档，仅作留存。

## 进程模型

| 进程 | 端口 | 职责 | 入口 |
|---|---|---|---|
| Electron 主进程 | — | 启动、托盘、安装计划任务、开/关各子进程 | `pack/electron/main.cjs` |
| 控制台 | 3070 | 设置、状态、人格、记忆、日志（HTTP + SSE 推送） | `pack/src/ui.mjs` |
| 桥接 | 3098（本地通道） | 收消息、调大脑、记忆、预算、主动消息、空间、定时任务 | `pack/src/bridge.mjs` |
| 聊天窗 | 3210 | 只负责对话的前端 + 转发给桥接 | `pack/src/chatserver.mjs` + `chatui.html` |
| NapCat（外部） | 3001（WebSocket） | 要接 QQ 时由它实现协议、维持登录 | 用户自装 |

**两个入口，一份状态。** QQ 和浏览器窗口进来的消息都汇到同一个桥接进程，写同一份 `data/`——所以"在 QQ 里说过的话，浏览器窗口里她知道"。

## 一条消息经过什么

```
QQ / 浏览器
   │
   ▼
bridge.mjs  ──► 归属判定（主人 / 群友 / 陌生人）
   │            └─ 白名单、群聊是否被 @、是否被叫名字
   ▼
记忆召回 ─────► memory.mjs：按权重 + 时间衰减，取回相关条目
   │
   ▼
拼提示词 ─────► persona.md（人格唯一真源）
   │            + 记忆条目 + 时间/作息 + 当前频道（QQ 还是窗口）
   │            + 回复格式 + 工具说明 + 最近 10 轮原文
   ▼
大脑调用 ─────► OpenAI 兼容 /chat/completions（地址和 Key 由用户填）
   │
   ▼
解析输出 ─────► [[VOICE]] 语音标记 / 表情包 / 动作（括号里的表演提示）
   │
   ▼
排队发送 ─────► replyDelay()：2 秒 ~ 2 小时的抖动，可"这次不回"
   │
   ▼
记账 ─────────► budget.mjs：每次调用按 kind 记账（chat/tts/asr/vision/draw）
```

## 关键模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `pack/src/bridge.mjs` | ~4.5k | 调度层：消息入口、提示词拼装、回复节奏、主动消息、空间、定时任务 |
| `pack/src/ui.mjs` | ~3.8k | 控制台页面与服务端（含页面内文件夹浏览器、设置热更新） |
| `pack/src/tools.mjs` | 568 | 「允许她动电脑」的文件工具与授权闸门 |
| `pack/src/memory.mjs` | 515 | 记忆条目、权重衰减、被更正、事实白名单 |
| `pack/src/chatserver.mjs` | 471 | 聊天窗 HTTP/SSE |
| `pack/src/settings.mjs` | 434 | 配置读写、默认值、热加载 |
| `pack/src/voice.mjs` | 361 | TTS（阿里云 CosyVoice）与语音条封装 |
| `pack/src/draw.mjs` | 346 | 文生图 / 参考图换装 / 画完自检 |
| `pack/src/napcat-guard.mjs` | 331 | NapCat 进程守护、扫码引导 |
| `pack/src/self.mjs` | 266 | 角色设定（长相/耳鳍/服装/场景）与自拍提示词 |

## 成本控制

这是"长期运行"和"demo"的分界线：**每一分钱都要有账**。

- `data/config.json` 里的月度预算（默认 20 元，可改）。
- 四级熔断：到额度 → 少说话；1.2 倍 → 停主动；1.4 倍 → 只被动回复；超上限 → 通知并停。
- 画图单独配额（每天几张），因为单张图比几十轮对话还贵。
- 每次调用落 `ledger`，按 `kind` 和 `channel` 分组——所以能回答"这个月钱花在聊天还是画图上"。

## 工程质量

- **42 个测试套件**（`node --test`，由 `pack/run-tests.mjs` 串行调度），跑完约 40 秒。
  覆盖：消息路由、预算熔断、记忆衰减、睡眠状态机、授权边界、打包产物、界面契约。
- **热更新**：改完 `pack/src/*.mjs` 拷到安装目录，`POST /api/restart` 即生效，不用重装。
- **日志轮转**：单文件超 8MB 自动改名，避免长期运行时日志撑爆磁盘。
- **发布**：`node pack/tools/release.cjs patch` 走完 版本号 → 打包 → 发布包 → SHA256。

## 已知的技术债（写在这里，不藏着）

1. `bridge.mjs` 4.5k 行是调度层没拆干净的结果。`brain/ memory/ draw/ voice/ tools/` 都已独立，剩下的"编排"还在一个文件里——下一步是抽 dispatcher + 用事件总线替掉直接互相调用。
2. 24 处空 `catch` 与 19 处 `.catch(() => {})`：早期为了"别崩"写下的，正在逐处改成记日志。
3. CI 已接（`.github/workflows/test.yml`，windows-latest + Node 22），但套件以正则/源码断言为主，跨入口的行为覆盖不到，仍需定向验证。
4. 单机、单用户、Windows only。没做多实例与并发控制（`data/` 用文件锁，够用但不优雅）。

## 目录

```
pack/
  src/        运行时（Node ESM，无构建步骤）
  test/       测试套件
  electron/   主进程与打包配置
  build/      图标、NSIS 脚本、打包后处理
  tools/      发布/推送/打包脚本
  assets/     图标与人格模板
docs/         使用与设计文档
deploy/       Docker / systemd 部署参考（社区贡献向）
```
