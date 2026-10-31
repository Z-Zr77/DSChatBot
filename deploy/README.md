# 部署到 Linux 云服务器

两条路，先看清楚区别：

| 路线 | 服务器 | 部署什么 | 适合谁 |
|---|---|---|---|
| **A. Linux + Docker（推荐）** | Ubuntu 22.04 / Debian 12 | 本目录的 `docker-compose.yml` + 源码 | 长期挂机、便宜、开源分发 |
| B. Windows 服务器 | Windows Server 2核4G | 直接装 `QQChatBot-Setup-x.y.z.exe` | 只想点鼠标、不想碰命令行 |

> exe 是 Windows 版（Electron），**Linux 上跑不了**；Linux 就按本目录走。

---

## 一、最小配置（给别人用也照这个交代）

| 项目 | 最低 | 建议 | 说明 |
|---|---|---|---|
| CPU | 2 核 | 2 核 | QQ 客户端 + Node 都不吃 CPU |
| 内存 | **2 GB**（必须给 2G swap） | 4 GB | NapCat 里的 QQ 约 700MB–1.2G，Node 约 200MB |
| 磁盘 | 20 GB | 40 GB | 系统 + 镜像约 3–4G，其余给聊天记录/图/语音 |
| 带宽 | 2 Mbps | 5 Mbps | 文字聊天几乎不耗流量；图/语音是大头，月均 2–5GB |
| 系统 | Ubuntu 20.04+ / Debian 11+ | Ubuntu 22.04 | 需要 Docker |
| 公网 | 不强制 | 建议有 | 没有公网也能跑，但要靠内网穿透才能扫码/看控制台 |
| QQ | 1 个小号 | 养过几天的号 | **新号直接上云容易触发验证** |

流量说明：云厂商一般只对**出方向**计费（阿里云国内 20GB/月免费额度），入方向不计费。

---

## 二、五步装完

```bash
# 1. 装 Docker（已装跳过）
curl -fsSL https://get.docker.com | sh

# 2. 把项目传上去（git clone 或 scp 整个 qq-bot 目录）
cd qq-bot/deploy

# 3. 一键部署（自动生成控制台密码、建目录、构建、起容器）
chmod +x install.sh && ./install.sh

# 4. 浏览器打开 http://服务器IP:3070 ，用脚本打印的密码登录
#    设置 → 大脑（API）填 key 和模型 → 保存
#    设置 → 主人 QQ 填你自己的号 → 保存主人
#    然后点「重启桥接」

# 5. 扫码让 QQ 上线
docker compose logs -f napcat | grep -A30 qrcode     # 二维码会打印在日志里
# 或用 NapCat 自带 WebUI：http://服务器IP:6099  （token 在 .env 的 WEBUI_TOKEN）
# 手机 QQ 切到小号 → 扫一扫 → 手机上点确认
```

装完检查：

```bash
docker compose ps                    # 两个容器都该是 Up
docker compose logs -f app           # 会看到 credential refs loaded / ws connected
```

---

## 三、数据在哪 / 怎么搬家

| 路径 | 内容 |
|---|---|
| `deploy/data/` | **全部机器人数据**：`config.json`、`setup.json`、`persona.md`、`memory/`、`stickers/`、`life/`、`drawn/`、`bridge.log` |
| `deploy/napcat/config/` | NapCat 的 OneBot 配置（3000/3001 端口） |
| `deploy/napcat/qq/` | QQ 的登录态（`data/` 会被 Docker 挂进容器） |

搬家 = 把 `data/` 整个拷过去；**QQ 登录态换机器要重新扫码**（换 IP 也是）。

从 Windows 版迁过来：

```bash
scp -r "E:\QQChatBot\data" user@server:/opt/qq-bot/deploy/data
# 注意别再拷 napcat-console.log 之类的大文件；data/config.json 里的 draw.key / tts.key 会一起过去
```

---

## 四、安全（一定要看）

1. **控制台必须设密码**：`install.sh` 会随机生成；手动装就在 `.env` 里写 `UI_PASS=至少10位`。
2. **不要裸奔端口**：更稳的做法是安全组只放行 SSH，然后：
   ```bash
   # 手机也能用：把本机 3070 映射到本地
   ssh -L 3070:127.0.0.1:3070 user@server
   ```
   或者挂个反向代理（Caddy/Nginx）加 HTTPS，再在云厂商安全组里限制来源 IP。
3. **NapCat 的 6099 也别对公网开**，那是能扫码登录你 QQ 的地方。
4. `.env`、`data/config.json`、`data/aliyun.key`、`data/ark.key` 里有密钥，**别提交到 Git**。

---

## 五、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 控制台打不开 | 安全组没放行 3070；或 `docker compose logs app` 里 `EADDRINUSE` |
| 登录后一直 `ws connected` 又断 | NapCat 那侧还没扫码；`docker compose logs napcat` 看二维码 |
| 发消息不回 | 控制台 → 状态页看「QQ 未登录」；再看 `data/bridge.log` 有没有 `[selfie]`/`daily` 报错 |
| 内存爆了（OOM） | 加 swap，或换 4G；`docker stats` 看谁在涨 |
| 二维码过期 | 重启 NapCat：`docker compose restart napcat`，会出新码 |
| 换机器后 QQ 要重新验证 | 正常，异地登录风控；先用手机 QQ 正常登录几天再搬 |

---

## 六、更新版本

```bash
cd qq-bot && git pull
cd deploy && docker compose build app && docker compose up -d
```

`data/` 不受影响（它在宿主机上）。
