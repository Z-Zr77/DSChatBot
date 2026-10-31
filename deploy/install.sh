#!/usr/bin/env bash
# QQ 聊天机器人 —— Linux 一键部署脚本
# 适用：Ubuntu 20.04+ / Debian 11+，2 核 2G 起（建议 4G），装好 Docker
set -euo pipefail

cd "$(dirname "$0")"

say()  { printf '\033[36m[部署]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 环境检查 ----------
command -v docker >/dev/null 2>&1 || die "没装 Docker。Ubuntu/Debian：curl -fsSL https://get.docker.com | sh"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "没有 docker compose 插件。装一下：apt install -y docker-compose-plugin"
fi
say "Docker 就绪（$DC）"

# ---------- 2. 换行/权限 ----------
grep -q '^UI_PASS=.\+' .env 2>/dev/null || {
  cp -n .env.example .env 2>/dev/null || true
  PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  UID_N=$(id -u); GID_N=$(id -g)
  cat > .env <<EOF
# 控制台密码（手机/公网访问必填）
UI_PASS=$PASS
UI_PORT=3070
WEBUI_TOKEN=$TOKEN
NAPCAT_UID=$UID_N
NAPCAT_GID=$GID_N
EOF
  chmod 600 .env
  say "已生成 .env（控制台密码：$PASS）"
}

set -a; . ./.env; set +a

# ---------- 3. 目录 ----------
mkdir -p napcat/config napcat/qq napcat/cache napcat/logs data
chown -R "${NAPCAT_UID:-1000}:${NAPCAT_GID:-1000}" napcat 2>/dev/null || warn "napcat 目录 chown 失败（非 root？可忽略）"

# ---------- 4. 内存检查（NapCat + Node 大约要 1.2G） ----------
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 2600 ]; then
  SWAP=$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$SWAP" -lt 1024 ]; then
    warn "内存 ${MEM_MB}MB、swap ${SWAP}MB，可能不够。加 2G swap："
    warn "  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
    warn "  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
  fi
fi

# ---------- 5. 构建并启动 ----------
say "构建镜像（第一次几分钟）…"
$DC build app
say "启动容器…"
$DC up -d

sleep 6
$DC ps

IP=$(curl -s --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<EOF

=====================================================
  装好了。接下来三件事：

  1) 打开控制台
     http://${IP:-服务器IP}:${UI_PORT:-3070}
     密码：${UI_PASS}

  2) 填大脑 API（DeepSeek 等）和你的主人 QQ
     控制台 → 设置 → 大脑（API）
     控制台 → 设置 → 主人 QQ → 保存主人
     填完点「重启桥接」

  3) 让 QQ 上线
     看二维码：$DC logs -f napcat | grep -A20 qrcode
     或打开 NapCat WebUI：http://${IP:-服务器IP}:6099
         token：${WEBUI_TOKEN}
     手机 QQ 切到小号 → 扫一扫 → 确认登录

  常看日志： $DC logs -f app
  重启：     $DC restart app
  停止：     $DC down
=====================================================
EOF
