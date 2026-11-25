# 基底用 debian-slim 而不是 alpine：平台 CLI 与 better-sqlite3 的依赖链里
# 有原生模块与 glibc 假设，musl 上会给出难以定位的失败（design.md 风险一节）。
#
# 两个阶段必须用同一个 node 版本：better-sqlite3 的 .node 二进制绑定 Node ABI。
FROM node:22-bookworm-slim AS build

WORKDIR /app
# corepack 首次用到 packageManager 指定的 pnpm 时会交互式询问是否下载；
# 构建容器里没有 TTY，不关掉这个提示会直接失败。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build


FROM node:22-bookworm-slim AS runtime

# unzip 供产物解压；ca-certificates 供 HTTPS 下载产物与调用平台 API
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# --prod 之后仍要跑 better-sqlite3 的安装脚本（预编译二进制下载或本地编译），
# 这由 pnpm-workspace.yaml 的 onlyBuiltDependencies 允许。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod \
 && node -e "require('better-sqlite3'); console.log('better-sqlite3 loads OK')"

COPY --from=build /app/dist ./dist

# 挂载点：数据库卷与 CLI 安装卷。CLI 必须装在卷里，装在容器层会被
# `docker compose up --force-recreate` 清掉（design.md D6）。
RUN mkdir -p /data /opt/cli && chown -R node:node /data /opt/cli

ENV NODE_ENV=production \
    DATA_DIR=/data \
    CLI_HOME=/opt/cli

# 不以 root 运行：私钥与 cookie 会物化到磁盘
USER node

# 仅作声明，实际端口由 PORT 环境变量决定（缺省 3000）
EXPOSE 3000

CMD ["node", "dist/main.js"]
