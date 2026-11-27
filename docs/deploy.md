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

默认用 CI 构建好的镜像（见「镜像从哪来」一节）：

```bash
git clone https://github.com/lyzz0612/deploy-center.git
cd deploy-center
docker compose pull
docker compose up -d
docker compose logs -f app
```

`docker compose pull` 失败说明镜像还没发布过。这时可以从源码构建，行为相同、只是慢：

```bash
docker compose up -d --build
```

用 1Panel 部署（Compose 编排 + OpenResty 反向代理 + HTTPS）的完整步骤见 [deploy-1panel.md](deploy-1panel.md)。

首次启动会做两件事：

1. 建表（`CREATE TABLE IF NOT EXISTS`，幂等）
2. 登记插件声明的包类型（当前是 `h5` 与 `wechat`）

平台 CLI **不会**自动安装：两个加起来约 280 MB，只发 H5 的部署根本用不到。到「设置 → 平台 CLI」按需安装，装、探测、升级都在后台可见。安装本身走任务队列（分钟级），同步装会让容器迟迟不就绪、健康检查判它失败然后反复重启。

### 3. 设置管理员口令

浏览器打开 `http://<主机>:3000`。没有口令时任何页面都导向首次设置页。

**部署后立刻设置。** 系统刚起来时谁都没有口令，这是必然的初始窗口。

### 4. 登记基础数据

按这个顺序，每一步都依赖前一步：

1. **CI key**（设置 → CI key）— 值加密保存在本机，随时可复制；填进 CI 的 secret
2. **凭据**（设置 → 凭据）— 微信需要 `file` 型（代码上传密钥的文件内容）；H5 发 R2 需要 `s3Keys` 型
3. **游戏**（游戏）— slug 创建后不可改，它会出现在 CI 上报里
4. **发布目标**（游戏详情 → 添加发布目标）— 选类型、选凭据、填位置字段

### 4b. H5 发 R2 要准备什么

后台**不承担 H5 流量入口**：它只把产物写进桶，对外访问由 Cloudflare 提供。所以要先在 Cloudflare 侧准备好三样东西：

| 准备 | 在哪拿 | 填到哪 |
| --- | --- | --- |
| 桶 | R2 → Create bucket（**后台不会自动建桶**） | 目标实例的 `bucket` |
| API token（含该桶的读写） | R2 → Manage API tokens | 凭据的 `accessKeyId` / `secretAccessKey` |
| S3 endpoint | R2 概览页，形如 `https://<accountid>.r2.cloudflarestorage.com` | 凭据的 `endpoint` |
| 公开域名 | 桶 → Settings → Custom domain（或 Workers 路由） | 目标实例的 `baseUrl` |

`endpoint` 留空会让 SDK 去连 AWS，所以插件直接拒绝而不是让它跑到几层之外才失败。`baseUrl` 是发布后回读指针用的——**它验证的是"外部真的能取到"**，不只是"写进去了"。

发布后桶里（`<前缀>` 下）只有三样东西，缓存策略各不相同：

| 对象 | 内容 | 缓存 |
| --- | --- | --- |
| `index.html` | **入口壳**：读 `config.json` 拿到当前版本，再跳到那个版本目录。内容不随发布变化，首次切流时自动创建 | 5 分钟、可回源 |
| `config.json` | 2 KB 的指针（`active` / `prev` / `base`），切流与回滚只改它 | 不缓存 |
| `v/<构建标识>/…` | 这一版的产物，一个版本一个目录，**写入后永不修改** | 一年、immutable |

所以对外地址就是站点地址本身（`<baseUrl>`，以 `/` 结尾），产物自己的 `index.html` 在 `v/<构建标识>/index.html`，由壳跳过去。**别把它手工拷到根目录**：那会覆盖壳，切流与回滚就失效了。入口壳已经存在时发布不会覆盖它（想换回内置壳就把对象删掉再发布一次），于是你可以在那个位置放自己的 loading 页。

发布后的验证会同时回读指针与入口壳：根路径打不开（壳被删、前缀写错、自定义域没绑）会直接写在失败原因里，而不是只报一句「验证失败」。

桶、token、endpoint 配好后，目标详情页的实例级检查（凭据层 + 可达层）能在发布之前就把问题说清楚：桶名写错、token 没有这个桶的权限、endpoint 指向另一个账号，三者给的是不同的结论。

### 4c. 删除规则

**没有归档，删除就是真删除。** 规则统一是「没有引用就能删，有引用就拒绝并告诉你是谁在引用」：

| 删什么 | 没有引用时 | 有引用时 |
| --- | --- | --- |
| 凭据 | 直接删 | 拒绝，列出引用它的目标 |
| 包类型 | 直接删 | 拒绝，列出引用它的构建 |
| 发布目标 | 直接删 | 拒绝；页面上给「先清除已结束的发布记录」按钮 |
| 发布记录 | 已结束的直接删 | — |
| **游戏** | **级联删除**，连带其构建、目标、发布记录 | 同左 |

几个需要留意的点：

- **游戏是唯一会连带删数据的**，所以删除前要把 slug 抄一遍，页面上也会先显示会删掉多少条。不可恢复。
- **发布记录只能删已结束的**（成功/失败/超时/已取消）。排队中与执行中的不行——执行器还要往那条记录上写结果。
- **删不掉发布过的目标**是刻意的：发布历史是「线上曾经是什么版本」的唯一记录，不该被删目标的动作顺手带走。真要删，先清历史。
- 插件声明的包类型（`h5`、`wechat`）删掉后，**下次启动会被自动补回**——它们是插件能工作的前提，不是用户数据。
- 凭据不要用「删了重建」来轮换：直接改值即可，所有引用它的目标同时生效。

### 5. 接上 CI

见 [ci-report.md](ci-report.md)。CI 只需要在构建后多调一次上报接口。

### 6. 微信侧：把主机出口 IP 加白名单

微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传。

查出口 IP：

```bash
docker compose exec app node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

不加白名单时，发布会失败并提示"私钥有效，但本机出口 IP 不在白名单内"，带上具体 errcode。这个检查也在目标详情页的实例级检查里，不用等到发布才发现。

## 镜像从哪来（CI）

镜像由 [.github/workflows/docker-publish.yml](../.github/workflows/docker-publish.yml) 构建并推到 GHCR，部署机不需要本地 Docker 构建。

**触发**：

| 方式 | 产生的镜像标签 |
| --- | --- |
| **push 到 `master`** | **自动发版**：版本号末位 +1，发 `X.Y.Z`、`X.Y`、`latest`、`sha-<短哈希>`，并回推 `chore(release)` 提交与 `vX.Y.Z` 标签 |
| 推 `v*` 标签（如 `v1.2.3`） | `1.2.3`、`1.2`、`latest`。预发布标签（如 `v1.2.3-rc.1`）只发它自己，不动 `latest` |
| Actions 页面手动 Run workflow | 分支名、`sha-<短哈希>`、`latest`，可再填一个额外标签；取消勾选 `push_image` 则只构建冒烟、不推送 |

**流程**：算版本号 → 写进 `package.json` → 构建到 runner 本地 → 真起容器查 `/healthz` 与首次设置页 → 登录 GHCR 推送 → **最后**才回推提交与标签。坏镜像不会进仓库，失败的构建也不会白烧掉一个版本号、不会留下没有镜像的标签。

### 自动发版（push 到 master）

推代码到 `master` 就会发一个新的补丁版本，不需要手工改版本号或打标签。

**版本号怎么来**：取 `package.json` 与仓库里最大的 `v*` 标签中**较大的那个**，末位 +1。只看 `package.json` 会在有人手工打过标签却忘了改文件时算出一个已占用的版本号。预发布标签（含 `-`）与格式不对的标签都被忽略。

**哪些 push 不发版**：全部改动都落在下面这些路径时整个工作流不触发——它们进不了镜像（Dockerfile 只 `COPY` `package.json`、锁文件、`tsconfig.json` 与 `src/`）。

```
**.md    docs/**    openspec/**    .gitignore    .github/ISSUE_TEMPLATE/**
```

想跳一个 minor 或发预发布版时，照旧手工打标签：改好 `package.json` 的版本号，提交，再 `git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0`。手工标签那条路径不受上面的路径清单影响（**GitHub 对标签推送不做路径过滤**）。

**为什么发版和构建在同一个工作流里**：用 `GITHUB_TOKEN` 回推的提交与标签**不会**触发工作流——这是 Actions 为防递归的既有行为（[官方文档](https://docs.github.com/en/actions/concepts/security/github_token)）。所以「CI 推标签、让另一个工作流去构建」这条链在自动场景下是断的，必须一次把活干完。好处是顺带不会无限递归：CI 自己推的那次 push 不会再触发一轮。

**并发**：同一分支的发版串行执行（`concurrency` 不取消进行中的任务）。两次 push 挨得很近时，后一次会等前一次跑完再算版本号，否则两者会算出同一个号、后打的标签必然失败。

**已实测**（2026-11-26，run [45825935024](https://github.com/lyzz0612/minigames/actions/runs/45825935024) 与 [45827449030](https://github.com/lyzz0612/minigames/actions/runs/45827449030)）：push 到 `deploy-center` → 算出 `0.1.3` / `0.1.4` → 冒烟过（容器里 `database created at schema version 6`）→ 推 GHCR → 回推提交与标签，且 CI 自己那次回推**没有**触发第二轮。

**手动触发的前提**：GitHub 只在默认分支上列出 `workflow_dispatch` 工作流。本仓库默认分支是 `master`，工作流文件在其上，Actions 页面的 Run workflow 按钮可以直接用；**推 `v*` 标签不受影响**——按 GitHub 文档，`push`（含 tag）会执行被推提交里的工作流，"This includes workflows that are not merged into the default branch"。

另外，工作流只要跑过一次，就可以用 CLI 对任意分支手动触发（UI 按钮仍要求默认分支有该文件）：

```bash
gh workflow run docker-publish.yml --ref master -f push_image=false
```

镜像位于 `ghcr.io/lyzz0612/deploy-center`。**GHCR 的包默认是私有的**，部署机首次拉取要登录（token 带 `read:packages` 即可）；想匿名拉取就到包的设置里把可见性改成 public。

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub 用户名> --password-stdin
docker compose pull
```

`compose.yaml` 里的镜像标签可用 `IMAGE_TAG` 覆盖，钉版本：

```bash
IMAGE_TAG=1.2.3 docker compose pull
```

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

镜像里没有 `sqlite3` 命令行，用应用自带的 `better-sqlite3` 做在线备份（走 SQLite 的 backup API，WAL 下也是安全快照）：

```bash
docker compose exec app node -e "const D=require('better-sqlite3');const db=new D('/data/console.db',{readonly:true});db.backup('/data/backup.db').then(()=>{db.close();console.log('backup ok')}).catch(e=>{console.error(e.message);process.exit(1)})"
docker cp "$(docker compose ps -q app)":/data/backup.db ./console-$(date +%F).db
```

**不要直接复制 `console.db`**：WAL 模式下还有 `-wal` 与 `-shm` 两个旁文件，单独拷主文件可能拿到一个不一致的快照。backup API 会处理这件事。

备份里包含加密后的凭据。**主密钥不在备份里**，所以恢复时必须有同一个 `MASTER_KEY`，否则凭据全部解不开。

## 升级

用 CI 镜像时：

```bash
docker compose pull
docker compose up -d
```

从源码构建时：

```bash
git pull
docker compose up -d --build
```

数据卷与 CLI 卷都不动。CLI 装在卷里就是为了这个——装进容器层的话，`--build` 之后它会无声消失。

### 表结构升级

启动时按 `PRAGMA user_version` 自动补齐结构（见 design.md D7b）。**用新版程序打开更新的库会被拒绝启动**（`user_version` 高于程序支持的版本），以免写坏数据——那种情况要换回对应版本的镜像。

**有两次升级会删数据，升级前务必先按上面「备份」一节做一份：**

| 升级 | 做了什么 |
| --- | --- |
| v4 → v5 | 去掉 CI key 的吊销位，**删除历史上已吊销的 key**。构建记录保留，只是 `ci_key_id` 置空 |
| v5 → v6 | 去掉归档机制。**没有引用的已归档记录（游戏/目标/凭据/包类型）直接删掉**；仍被引用的恢复为正常状态 |

两次都不可逆。v6 那次的取舍是：一条被归档的记录本来就是「不想要了」的意思，而新模型里没有「不可用但删不掉」这个状态，所以无引用的清掉、有引用的留着。被归档却仍挂着构建或目标的游戏会被**恢复**而不是级联删除——悄悄删掉一个游戏名下的全部历史，风险远大于让它重新出现在列表里。

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

现在失败过的也算已尝试，不自动重投，由用户在「设置 → 平台 CLI」手动点重装（那时他能看到失败原因）。

## 验证状态

| 项 | 状态 |
| --- | --- |
| 启动、建表、包类型登记 | 已实测（本机进程） |
| CLI 安装到持久卷、重启后仍可用 | 已实测，两个真实平台 CLI 都装成功并探测可用 |
| CI 上报 → 构建列表 | 已实测，含幂等与 commit 聚合 |
| H5（R2）发布 → 外部 URL 取到新版本 → 回滚 | 已实测，但对的是**进程内的假 S3 服务**（真 SDK、真 HTTP、真签名）；**未对真实 Cloudflare R2 跑过** |
| 重试失败阶段 | 已实测，第一阶段未重跑 |
| 进程中断恢复 | 已实测（见上） |
| **`docker compose up` 全流程** | **未实测**，本机没有 Docker 与 WSL |
| **镜像构建与启动冒烟（CI）** | 工作流已加入，**尚未在 Actions 上跑过**；冒烟断言已用本地进程等价验证（`/healthz` 返回 `{"status":"ok"}`、首页是首次设置页） |
| **微信真实上传** | **未实测**，需要小游戏账号与代码上传密钥。插件与核心的集成用 stub CLI 验过 |
| 反向代理与 TLS | 未实测 |
| 备份与恢复 | 未实测 |

第一次真实部署时，请把踩到的坑补回本文档。
