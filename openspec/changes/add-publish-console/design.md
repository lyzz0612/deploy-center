# Design

## Context

动机见 `proposal.md`。这里只记录塑造方案的事实与约束：

- 目标仓库 `minigames` 是空仓库，没有既有代码、既有 spec，也没有历史包袱；发布中控台从零建。
- 微信/抖音的官方 CLI 需要 Node、可写文件系统与固定出口 IP，因此运行环境必须是常驻容器，而不是边缘运行时。
- CI 侧不保证使用任何特定存储，只承诺产物 URL 公开可访问；后台因此不持有任何读取产物源的凭据。
- 单人使用，无需多用户、RBAC 与操作审计；发布日志是唯一现场。
- 未来会持续新增小游戏平台与 H5 部署方式，扩展成本必须压在「新增一个插件」的量级。
- 领域里的两类东西必须分开：**携带行为的**（插件、凭据类型、CLI 规格）只能在代码里注册；**只有标签或数据的**（游戏、包类型、凭据、目标实例、构建、发布记录）必须能由后台增删。

## Goals / Non-Goals

**Goals:**

- 用一个进程内的插件注册表承接「怎么发布」，用数据表承接「发到哪、发什么、发过什么」。
- 让新增平台/新增 H5 部署方式的改动量固定为：一个插件目录 + 注册表一行。
- 让密钥只存在一处（凭据表），且任何实例、日志、接口响应都不出现明文。
- 让一次发布有完整可回放的事实：用了哪个产物、发到哪个目标、每个阶段的结果、失败原因。
- 在容器里把 CLI 的「装好 / 凭据对 / 平台通」变成可见状态。

**Non-Goals:**

- H5 站点的具体部署细节（写文件还是走 rclone、指针怎么落、缓存怎么绕过）属于插件内部实现，核心只保证「产物已就绪并交给插件」。
- 不做多用户、角色、审批流、操作审计。
- 不做平台审核状态的自动回调；发布后状态靠用户重开页面刷新。
- 不做后台自留产物副本；产物始终在外部 URL。
- 不做动态插件加载（运行时热插拔模块）。

## Decisions

### D1 单进程 + 两个卷

```
一个 Node 进程
  HTTP 服务      中控台 UI + 管理 API + CI 上报接口
  任务循环        发布 / CLI 安装，spawn 出平台 CLI 子进程
卷 console-data  SQLite 文件
卷 console-cli   /opt/cli，平台 CLI 安装目录
```

**曾考虑把 web 与 publisher 拆成两个容器，已否决。** 当时的理由是「CLI 安装与上传是分钟级子进程，会和请求处理抢资源、卡死整个后台」，但这个理由自相矛盾：它们是 `spawn` 出去的**独立进程**，Node 侧只是等一个异步事件，事件循环并未被占用；而且是网络 I/O 密集，不抢 CPU。

另两条收益同样站不住：

- 「publisher 崩了不影响看数据」——同机、同镜像、同卷，真崩了是 `docker restart` 的事，不需要容器边界。
- 「发布密钥只出现在 publisher 一侧」——主密钥在同一个卷里，web 同样能解密，隔离是装饰性的。

而拆分会制造一个真问题：两个进程抢写同一个 SQLite 文件，需要 `busy_timeout` 与 `SQLITE_BUSY` 重试。为不存在的好处引入真实的并发问题，不划算。

单进程下仍要守住一条：**不要用同步 API 解压产物**（几百 MB 的包用 `unzipSync` 会真的堵住事件循环）。用流式解压或 `spawn unzip`。

`jobs` 表与此决策无关，继续保留——它负责重试、历史与崩溃后恢复，这些需求不因进程数而改变。

### D2 数据与代码的分界线

| 实体 | 性质 | 落点 |
|---|---|---|
| Game / PackageType / Credential / Target / Build / Release | 数据 | 数据库表 |
| TargetKind（插件） / CredentialType / CliSpec | 代码 | 编译期注册表 |

判据：**是否携带影响系统处理产物的行为**。包类型只是一个字符串标签（不改变解压方式、不改变校验规则），所以是数据；一旦有人想给它加「解压策略」这类字段，它就跨线了，应改为代码。

### D3 领域模型与引用保护

```
Game
 ├─ PackageType        (数据, 全局)     唯一标识 + 显示名
 ├─ Credential         (数据, 全局)     类型 + 加密字段
 ├─ Target             (数据, 游戏级)   kind + credentialRef + 位置字段 + 归档位
 ├─ Build              (数据, 游戏级)   packageType + buildId + url + size + sha256 + commit
 └─ Release            (数据, 游戏级)   build × target + params + stages + status + log
```

`Release` 的维度是 **构建 × 目标**（不是「构建 × 平台」），因为它才对应一次真实的发布动作：同一构建可以发到正式号和测试号，同一 H5 包可以发到生产和灰度。

引用保护统一为「只能归档，不能物理删除」：被 Build 引用的 PackageType、被 Target 引用的 Credential、被 Release 引用的 Target。删除拦截在 API 层做，同时在启动时自检跨表一致性。

### D4 插件契约：声明 + 五个钩子

```
TargetKind
  manifest:  { name, accepts: PackageType[], requiresCredential: CredentialType,
               stages: Stage[], capabilities: { rollback, verify, activateLatency } }
  checks:    { global: Check[],  perTarget: Check[] }
  execute(stageId, ctx): Promise<StageResult>
  verify?(ctx): Promise<VerifyResult>
```

`ctx` 由核心构造，插件只能拿到已经准备好的东西：

```
ctx.artifact    已下载、已校验、已解压的工作目录
ctx.target      目标实例的位置字段（明文配置）
ctx.secrets     已解密的凭据（插件按需取，核心负责物化与清理）
ctx.params      本次发布填写的参数
ctx.log / ctx.progress / ctx.signal / ctx.workdir
```

四条硬规则：

1. **密钥物化是核心能力**。私钥文件由核心写、核心删、核心保证权限；插件只拿路径。
2. **发布从第一天就是多阶段**，即使微信第一版只有一个 `upload` 阶段。提审、发布这类后置阶段是这类平台天然要加的。
3. **差异只能靠 manifest 与 capability 表达**。核心代码里出现 `if (kind === 'wechat')` 即视为抽象失败。
4. **编译期注册，不做动态加载**。加平台是「几个月一次」的改动，一行 import 完全可接受；真正的动态需求在 CLI 版本，而那个已经由 `/opt/cli` 解决。

替代方案：按 `h5-static` 一个 kind 加 `transport` 字段区分对象存储与 SSH。这样做，kind 内部必然长出一串条件分支，且 schema 会出现大量「只有某种 transport 才需要」的字段。放弃。

### D5 凭据是类型化的加密键值袋

```
CredentialType（代码）  secretText | usernamePassword | sshKey | s3Keys | file
Credential（数据）      name + type + 加密字段 + 归档位
Target                 只存 credentialRef
```

字段集由**类型**决定，不由 kind 决定。这样 `h5-r2` 和未来任何对象存储目标共用同一种 `s3Keys` 凭据，轮换只改一处。目标实例的表单里不允许出现任何密钥输入框。

加密采用对称加密 + 主密钥（来自环境变量或挂载文件），密文落库。威胁模型要写明：防的是日志泄漏、接口误回显、备份泄漏，**不防主机被完全攻破**——主密钥与数据同机时，这是不可消除的残余风险。

### D6 CLI 装在持久卷，安装是长任务

```
/opt/cli/                       ← 命名卷
  registry.json                 声明：装了什么、什么版本、从哪来
  <cli>/<version>/              每版本独立 prefix
  <cli>/current -> <version>    可切换的当前指向
```

三个要点：装在卷里（容器层会被 `--force-recreate` 清掉）、每版本一目录（升级坏了把软链指回去）、`registry.json` 可导出（让运行时可变环境至少可复现）。

安装/升级/卸载走与发布同一个任务队列，因为 `npm i` 两分钟是常态，阻塞式 HTTP 必然被反代超时掐断。

无法自动安装的 CLI（如仅提供桌面安装包者）在 `CliSpec` 里标为 `manual`，界面只给检测与指引，不给注定失败的按钮。

### D7 任务执行：SQLite 队列 + 单 worker 串行

任务表 `jobs(id, kind, refId, status, attempts, log, startedAt, finishedAt)`，由进程内的单个任务循环顺序取用。不引入 Redis/队列中间件——单机 + 单人 + 低并发的量级下，引入外部依赖换来的是运维负担而不是吞吐。

串行是刻意的：发布与 CLI 安装互相排队，单人场景完全可接受，而且省掉了「并发度」这个要调的参数。

启动时把遗留的 `running` 任务标记为「中断失败」，避免重启后任务永久悬空。

替代方案：发布请求内同步执行。会被反代超时与页面刷新杀死，且无法重试失败阶段。放弃。

### D7b 建表，而不是迁移框架

系统从未部署过，没有任何存量数据，因此**不需要迁移**：所谓"迁移"要有「从哪一版迁到哪一版」才成立。启动时执行一遍 `CREATE TABLE IF NOT EXISTS` 即可，幂等性是建表语句自带的，不靠框架保证。

只留一个 `PRAGMA user_version`（SQLite 文件头里的整数，零成本），将来需要时知道当前结构在哪一版。不建 `migrations/` 目录、不建版本表、不写 up/down。

第一次需要改动**已上线**的表结构时，再引入真正的迁移机制——那时才有明确的起点版本和真实数据要照顾。

### D8 CI 上报：只存事实，不下结论

上报键为 `(game, packageType, buildId)`，重复上报按 upsert 处理，构建记录本身不可变（除补全字段）。后台不判断产物「好不好」，只记录它存在、多大、摘要是什么、来自哪个 commit。

产物可用性是**发布时**才验证的：下载 → 校验 size 与 sha256 → 解压 → 交给插件。下载失败必须区分 404 / 403 / 超时，因为这三者对用户的下一步动作完全不同。

### D9 技术栈

后端 Node 22 + TypeScript，HTTP 层用轻量框架（Hono/Fastify 量级），数据访问用 better-sqlite3，前端 React + Vite，HTTP 服务与任务循环同处一个进程。选它的理由是这套系统「业务薄、交互重、外部调用多」：业务逻辑量小到不需要分层框架，但发布表单、状态徽标、日志查看这类交互占开发量大头，前后端同语言最省切换成本。

不用 `node:sqlite`：它在 Node 22 上仍是实验性的、需要 `--experimental-sqlite`，而部署约束是 `node >= 22`。

替代方案：Directus/Payload 这类开箱后台。中控台的核心操作是发布、重试、切流这类「动作型」而非「内容型」，在 CMS 里加自定义动作的改造成本高于自写。放弃。

## Risks / Trade-offs

- **抖音 CLI 可能无法在 Linux 容器内运行** → 落地前先做最小验证（容器内装包 + 跑一次帮助命令）；若依赖桌面环境，把 `CliSpec` 标为 `manual`，执行器退化为「另一台常开机器上的发布代理」，插件契约不变。
- **产物 URL 会过期**（如 CI 制品默认保留期）→ 发布时下载失败必须显式报错并记录当时的 URL；不静默重试死链。后台自留副本被列为非目标，若真需要，再加「归档到对象存储」插件。
- **CLI 装在卷里 = 运行时可变环境** → 用 `registry.json` + 预置清单把状态显式化，并保留版本回退。
- **主密钥与数据同机** → 只保到「防误泄漏」级别，明确写进文档，不假装是 KMS 级隔离。
- **任务串行** → 发布与 CLI 安装会互相排队。单人场景可接受；若将来并发变刚需，再给 `jobs` 加按 kind 的并发份额，表结构不用改。
- **H5 切流的生效时间不由核心保证** → 由插件的 capability 声明，界面据此显示预计生效时间；核心不承诺「秒级」，只承诺「插件声明的值」。
- **SQLite 单文件 + 卷** → WAL 模式 + 定期文件级备份；这是可接受的运维成本，不是可忽略的。

## Migration Plan

绿地项目，无数据迁移。部署顺序：

1. 建 Docker 主机（固定公网 IP），创建两个持久卷：数据库卷、`/opt/cli`。
2. `docker compose up -d`；进程启动时自己建表（`CREATE TABLE IF NOT EXISTS`），并按预置清单安装 CLI。
3. 浏览器打开中控台，设置管理员口令 → 登记 CI key → 创建游戏 → 登记包类型（wechat/douyin/h5）→ 创建凭据 → 创建目标实例。
4. 在 CI 侧加入上报调用（不在本变更内实施，接口契约见 `specs/publish-console/build-ingestion/spec.md`）。
5. 用一次真实构建走通「上报 → 发布到单个目标」，再把其余目标接上。

回滚策略：后台自身升级失败时回退镜像 tag，数据卷不动；单次发布失败的回滚按 `Release` 记录上的能力声明执行，与后台版本无关。

## Open Questions

- 抖音的 CLI 安装形态（npm 包 / 桌面安装器 / 独立镜像）尚未确认，只影响 `CliSpec` 的 `kind` 取值，不改变插件契约。
- 微信/抖音的「提审」是否要走开放平台第三方授权，决定了这两个插件是单阶段还是多阶段。该问题可在实现微信插件时再回答，不影响本设计。
