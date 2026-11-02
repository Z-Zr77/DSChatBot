# 应用镜像：只装运行时依赖 + 源码（不含 Electron / 不含 NapCat）
FROM node:22-slim

ENV TZ=Asia/Shanghai \
    NODE_ENV=production

WORKDIR /app

# 国内装依赖快一些；海外机器可以删掉这一行
RUN npm config set registry https://registry.npmmirror.com

COPY deploy/app-package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

COPY pack/src ./src
COPY deploy/supervise.mjs ./src/supervise.mjs

EXPOSE 3070

CMD ["node", "src/supervise.mjs"]
