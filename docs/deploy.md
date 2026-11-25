# 部署

单个容器、两个持久卷。没有独立的数据库服务（SQLite 是进程内嵌库），也没有独立的迁移任务（启动时建表）。

> **本文档的部署步骤尚未在真实 Docker 主机上执行过。** 下面标注了哪些部分经过实测、哪些只是按设计写出。见文末「验证状态」。

## 前置条件

| 项 | 要求 | 为什么 |
| --- | --- | --- |
| Docker + Compose | v2 | — |
| 公网 IP | **固定** | 微信代码上传密钥要配 IP 白名单，动态 IP 每次都得改 |
| 磁盘 | ≥ 2 GB 给 CLI 卷 | `miniprogram-ci` 实测 228 MB、抖音 CLI 55 MB，每保留一个旧版本再加一份 |
| 出网 | 能访问 npm 与各平台 API | CLI 安装与发布都要 |

## 步骤

### 1. 准备主密钥

```bash
openssl rand -base64 32
```

存进 `.env`（与 `compose.yaml` 同目录）：

```
MASTER_KEY=<上面生成的值>
WEB_PORT=3000
```

**缺失或短于 16 字符时进程拒绝启动**，不会退化成明文存储，也不会生成临时密钥——临时密钥会让已有凭据在下次重启后全部解不开，而失败会发生在你真正要发布的时候。

### 2. 启动

```bash
git clone https://github.com/lyzz0612/minigames.git
cd minigames
docker compose up -d
docker compose logs -f app
```

首次启动会做三件事：

1. 建表（`CREATE TABLE IF NOT EXISTS`，幂等）
2. 登记插件声明的包类型（当前是 `h5` 与 `wechat`）
3. 投递平台 CLI 的安装任务（**异步**，不阻塞启动）

CLI 安装是分钟级的。同步装会让容器迟迟不就绪、健康检查判它失败然后反复重启，所以它走任务队列。到设置页看进度。

### 3. 设置管理员口令

浏览器打开 `http://<主机>:3000`。没有口令时任何页面都导向首次设置页。

**部署后立刻设置。** 系统刚起来时谁都没有口令，这是必然的初始窗口。

### 4. 登记基础数据

按这个顺序，每一步都依赖前一步：

1. **CI key**（设置页）— 明文只显示一次，立刻存进 CI 的 secret
2. **凭据**（设置页）— 微信需要 `file` 型（代码上传密钥的文件内容）
3. **游戏**（首页）— slug 创建后不可改，它会出现在 CI 上报里
4. **发布目标**（游戏详情页）— 选类型、选凭据、填位置字段

### 5. 接上 CI

见 [ci-report.md](ci-report.md)。CI 只需要在构建后多调一次上报接口。

### 6. 微信侧：把主机出口 IP 加白名单

微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传。

查出口 IP：

```bash
docker compose exec app node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

不加白名单时，发布会失败并提示"私钥有效，但本机出口 IP 不在白名单内"，带上具体 errcode。这个检查也在游戏详情页的实例级检查里，不用等到发布才发现。

## 反向代理

容器只听 HTTP。生产环境应该在前面放一层 TLS 终止：

```nginx
server {
    listen 443 ssl;
    server_name console.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # CLI 安装与发布走任务队列，HTTP 请求本身很快，
        # 60 秒超时够用
        proxy_read_timeout 90s;
    }
}
```

会话 Cookie 带 `SameSite=Strict` 与 `HttpOnly`，但**没有 `Secure`**——加上它在纯 HTTP 下会导致登录不上。如果你一定走 HTTPS，建议改代码加上。

## 备份

要备份的只有数据卷里的 SQLite 文件。CLI 卷不用备份，重装即可。

```bash
docker compose exec app sh -c "cd /data && sqlite3 console.db '.backup /data/backup.db'"
docker cp "$(docker compose ps -q app)":/data/backup.db ./console-$(date +%F).db
```

**不要直接复制 `console.db`**：WAL 模式下还有 `-wal` 与 `-shm` 两个旁文件，单独拷主文件可能拿到一个不一致的快照。`.backup` 命令会处理这件事。

备份里包含加密后的凭据。**主密钥不在备份里**，所以恢复时必须有同一个 `MASTER_KEY`，否则凭据全部解不开。

## 升级

```bash
git pull
docker compose up -d --build
```

数据卷与 CLI 卷都不动。CLI 装在卷里就是为了这个——装进容器层的话，`--build` 之后它会无声消失。

**改了表结构的版本不能直接升**：启动时会检测到 `user_version` 低于代码需要的版本并拒绝启动（见 design.md D7b）。那种升级需要先实现迁移机制。

## 故障演练结果（已实测）

以下在本机真实执行过（非 Docker，但进程行为相同）。

### 演练：发布执行中强杀进程

**步骤**：发起一个指向慢速产物源的发布，等它进入"执行中"，然后 `kill -9` 掉进程，重启。

**结果**：

```
杀之前：
  job      publish 609e30ba  running
  release  609e30ba          running

重启后：
  job      publish 609e30ba  failed   进程中断，任务未完成
  release  609e30ba          failed
  upload   阶段 skipped，日志里有「[恢复] 进程在这次发布执行中退出，
           已标记为失败。请先确认平台侧状态（可能已经收到包），
           再决定是否重试。」
  queued 任务数 = 0（不自动重跑）
```

界面上：记录标为失败、不再显示"执行中"、重试入口出现、列表里也不是执行中。

**为什么不自动重跑**：中断点未知，重跑可能产生重复的平台上传（微信那边可能已经收到包了）。所以标记为失败并说明情况，由人确认平台侧状态后再决定。

### 这次演练逼出的两个 bug

都已修复并补了回归测试。

**1. 发布记录卡在"执行中"**

任务被正确恢复为 failed，但发布记录仍是 running。界面上那条发布会永远显示"执行中"、页面一直自动刷新，而重试入口因为状态是 running 根本不出现——用户卡在死局里。

根因是中断恢复只管了 jobs 表。现在 `recoverInterrupted` 返回被中断的任务，由调用方一并收拾发布记录与阶段。

顺带发现同一类问题的另一条路径：**产物下载失败时**（链接过期、摘要不符）`executeRelease` 抛异常直接跳到清理，发布记录同样卡在 running。这是比进程中断常见得多的情况。已在异常路径里补上状态落地。

**2. CLI 安装任务反复堆积**

`seedClis` 判断"已投递过"时只看 queued/running，不看 failed。于是每次重启都给失败过的 CLI 再投一条——容器重启几次就堆几条，而失败原因（比如网络不通）通常不会因为重启改变。

现在失败过的也算已尝试，不自动重投，由用户在设置页手动点重装（那时他能看到失败原因）。

## 验证状态

| 项 | 状态 |
| --- | --- |
| 启动、建表、包类型登记 | 已实测（本机进程） |
| CLI 安装到持久卷、重启后仍可用 | 已实测，两个真实平台 CLI 都装成功并探测可用 |
| CI 上报 → 构建列表 | 已实测，含幂等与 commit 聚合 |
| H5 发布 → 外部 URL 取到新版本 → 回滚 | 已实测，走真实 HTTP 访问 |
| 重试失败阶段 | 已实测，第一阶段未重跑 |
| 进程中断恢复 | 已实测（见上） |
| **`docker compose up` 全流程** | **未实测**，本机没有 Docker 与 WSL |
| **微信真实上传** | **未实测**，需要小游戏账号与代码上传密钥。插件与核心的集成用 stub CLI 验过 |
| 反向代理与 TLS | 未实测 |
| 备份与恢复 | 未实测 |

第一次真实部署时，请把踩到的坑补回本文档。
