# 在 1Panel 上部署（Compose + 反向代理）

适用：1Panel 已装好、域名已解析到这台机器、80/443 可用。镜像由 CI 构建并推到 `ghcr.io/lyzz0612/minigames`，服务器上不需要源码，也不需要本地构建。

## 1. 准备主密钥

1Panel 左侧「终端」或 SSH：

```bash
openssl rand -base64 32
```

记下输出。**缺失或短于 16 字符时容器拒绝启动**，不会退化成明文存储，也不会生成临时密钥。

## 2. 创建 Compose 编排

1Panel → 容器 → 编排 → 创建编排：

- 名称：`minigames-console`（决定目录 `/opt/1panel/docker/compose/minigames-console`，以你面板显示的路径为准）
- 内容：粘贴下面这份。**不要带 `build:`**——1Panel 上直接拉 GHCR 镜像，不构建：

```yaml
name: minigames-console

services:
  app:
    image: ghcr.io/lyzz0612/minigames:${IMAGE_TAG:-latest}
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATA_DIR: /data
      CLI_HOME: /opt/cli
      PORT: "3000"
      MASTER_KEY: ${MASTER_KEY:?MASTER_KEY is required}
    # 只绑回环：公网只经 1Panel 的 OpenResty 进来，3000 不对公网开
    ports:
      - "127.0.0.1:${WEB_PORT:-3000}:3000"
    volumes:
      - console-data:/data
      - console-cli:/opt/cli
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  console-data:
  console-cli:
```

先别启动。

## 3. 写 .env

1Panel → 文件 → 打开 `/opt/1panel/docker/compose/minigames-console/`，新建 `.env`：

```
MASTER_KEY=第 1 步生成的值
WEB_PORT=3000
IMAGE_TAG=0.0.1
```

- `IMAGE_TAG` 填具体版本，别用 `latest`：升级时才不会在重启后意外跟着变。
- 如果你的 1Panel 编排页有「环境变量」表单，填在那里等价，二选一即可。

不想维护 `.env` 也行：把上面 YAML 里的 `${...}` 换成实际值直接写死——`MASTER_KEY` 填生成的值（加引号）、镜像写 `ghcr.io/lyzz0612/minigames:0.0.1`、端口写 `"127.0.0.1:3000:3000"`。base64 密钥不含 `$`，不会被 compose 当变量插值；如果你自己换了含 `$` 的密钥，要写成 `$$`。

## 4. 拉镜像

GHCR 的包默认私有。二选一：

- **最省事：把包改成 public** — GitHub → 头像 → Your profile → Packages → `minigames` → Package settings → Change visibility → Public。镜像里没有密钥，只有已开源的代码。
- **或者登录** — 1Panel → 容器 → 仓库 → 添加仓库：类型 Docker，地址 `ghcr.io`，用户名 `lyzz0612`，密码用带 `read:packages` 的 PAT，保存后点测试连接。之后在编排页「拉取镜像」。

终端手动拉也行：

```bash
docker pull ghcr.io/lyzz0612/minigames:0.0.1
```

## 5. 启动与验收

编排页点「启动」，然后：

```bash
docker ps --filter name=minigames
curl -fsS http://127.0.0.1:3000/healthz     # 期望 {"status":"ok"}
```

浏览器打开 `http://<服务器IP>:3000`（或先做第 6 步用域名），看到「首次设置」→ **立刻设置管理员口令**。系统刚起来时谁都没有口令，这是必然的初始窗口。

首次启动只做两件事：建表、登记包类型（`h5`/`wechat`）。平台 CLI **不会**自动装（两个约 280 MB），用到时到设置页点安装。

## 6. 反向代理

1Panel → 网站 → 创建网站 → **反向代理**：

- 域名：`console.example.com`
- 代理地址：`http://127.0.0.1:3000`

保存后 → 该站点 → HTTPS → 申请 Let's Encrypt 证书 → 开启强制 HTTPS。

几个坑：

- 代理地址用 `127.0.0.1` 依赖 1Panel 的 OpenResty 走 host 网络（1Panel 默认如此）。如果你的 OpenResty 在桥接网络里，`127.0.0.1` 连不上，改成**宿主机内网 IP**，或把两个容器放进同一个 Docker 网络后写容器名。
- 3000 只绑了回环，公网只能走反代，不必在 1Panel 防火墙里开 3000。
- 会话 cookie 没有 `Secure` 属性（纯 HTTP 部署时不至于登录不上）；套 HTTPS 后也能用，只是少了这道保险。

## 7. 微信出口 IP 白名单

微信代码上传要配 IP 白名单，配的是**这台机器的公网出口 IP**，反代不改变出口：

```bash
curl -s https://api.ipify.org; echo
```

填进微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传。换机器或换宽带都要重配。

## 8. 升级

改 `.env` 里的 `IMAGE_TAG` → 编排页「拉取镜像」→「重启」，或者终端：

```bash
cd /opt/1panel/docker/compose/minigames-console
docker compose pull && docker compose up -d
```

数据卷与 CLI 卷不动。CLI 装在卷里就是为了这个——装进容器层的话，换镜像后会无声消失。

## 9. 备份

1Panel → 计划任务 → 创建计划任务 → Shell 脚本，每天执行一次：

```bash
set -e
DIR=/opt/backups/minigames
mkdir -p "$DIR"
docker compose -f /opt/1panel/docker/compose/minigames-console/docker-compose.yml \
  exec -T app node -e "const D=require('better-sqlite3');const db=new D('/data/console.db',{readonly:true});db.backup('/data/backup.db').then(()=>{db.close();console.log('backup ok')})"
docker cp minigames-console-app-1:/data/backup.db "$DIR/console-$(date +%F).db"
find "$DIR" -name 'console-*.db' -mtime +14 -delete
```

容器名默认是 `minigames-console-app-1`（compose 的 `name` + 服务名 + 序号）；改过编排名的话用 `docker ps` 确认。

备份里有加密后的凭据，**主密钥不在备份里**：恢复时必须用同一个 `MASTER_KEY`，否则凭据全部解不开。

## 10. 验收清单

- [ ] `curl -fsS http://127.0.0.1:3000/healthz` 返回 `{"status":"ok"}`
- [ ] 域名 HTTPS 打开中控台，能设置/输入口令并登录
- [ ] 设置页能签发 CI key，构建列表能打开
- [ ] 建一条游戏或包类型，重启容器后还在（数据卷生效）
- [ ] 需要平台 CLI 时能装上，装完探测通过

部署总览与故障演练见 [deploy.md](deploy.md)，镜像规则见其中「镜像从哪来（CI）」，CI 上报接口见 [ci-report.md](ci-report.md)。