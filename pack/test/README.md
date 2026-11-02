# 测试都在测什么

`node pack/run-tests.mjs` 会按文件名字母序跑完这 56 个脚本，每个脚本自己起环境、自己退出。
用 `poc-` 前缀是因为它们大多是「当时修的一个具体 bug」的回归测试，不是完整单元测试——
一条测试背后通常对应 CHANGELOG 里的一行。

| 领域 | 覆盖什么 | 文件（去掉 -test.mjs） |
|---|---|---|
| 对话内核 | 回复边界、授权、上下文注入、禁忌话题 | poc-boundary, poc-trace, poc-polish2, poc-review2, poc-taboo, poc-p1 |
| 记忆 | 入库分类、过期、静音、归档召回、mute/done | poc-memory-classify, poc-memory-expire, poc-memory-archive, poc-memory-mute, poc-loops, poc-facts |
| 人格与关系 | 人设模板、默认外貌、moments 状态、亲密度 | poc-persona-default, poc-blank-version, poc-moments, poc-face-outfit, poc-growth |
| 她的一天 | 作息、日记、主动开口、分享 | poc-her-day, poc-life, poc-outreach, poc-share, poc-daily |
| 出图与语音 | 自拍机位、参考图、多图、画图、看图 | poc-selfie-frame, poc-selfie-place, poc-multiref, poc-image-intent, poc-photo-promise, poc-attach |
| 工作模式 | 权限档位、工作区、run_cmd 审批、撤销 | poc-work, poc-work-r1-r8, poc-exec, poc-tools, poc-tools-e2e, poc-write, poc-undo, poc-dir |
| 通道 | QQ 插件、OneBot、SnowLuma、channels 抽象 | poc-plugins, poc-onebot, poc-snowluma, poc-channels, poc-noqq, poc-net, poc-net-e2e |
| 控制台 | 六页布局、设置项、第一次见面、自检、手机页 | poc-console-layout, poc-ui-settings, poc-ui-smoke, poc-wizard, poc-doctor, poc-fresh-install |
| 睡眠与节奏 | 睡觉、叫醒、回复节奏 | poc-sleep, poc-outreach |
| 工程与发布 | 安装包过滤、备份、审批链路、端到端 | poc-acceptance-fix, poc-approve, poc-backup, poc-history, poc-chatwork-e2e, poc-plugins, poc-brain-retry, poc-browse-gate, poc-websearch |

## 怎么加新测试

1. 建 `pack/test/poc-你要测的东西-test.mjs`，用 `pack/test/_kit.mjs` 里的 `t()` / `assert`；
2. 在 `pack/run-tests.mjs` 的 `ALL` 数组里登记；
3. 让它**不依赖网络和真实 QQ**：端口用 0 或 3999 这类死端口，数据目录用 `QQBOT_DATA` 指到临时目录。
