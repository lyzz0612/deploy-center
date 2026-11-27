# 平台 CLI 管理

微信和抖音的发布都要调用各自的官方 CLI。这些 CLI 由后台安装、升级与探测，不预装进镜像。

## 为什么装在卷里

```
/opt/cli/                      ← 命名卷（compose 里的 console-cli）
  registry.json                装了什么、当前用哪个版本
  miniprogram-ci/2.1.31/       每版本独立 prefix
  tt-minigame-ide-cli/2.1.2/
```

**装进容器层的 CLI 会在 `docker compose up --force-recreate` 或换镜像时无声消失。** 那时的症状是"CLI 又坏了"，而实际原因是环境被重置了。装在卷里，容器重建后仍在。

每版本一个独立目录，代价极低，但让"升级装坏了"退化成"把 current 指回去"。

### 当前版本记在 JSON 里，不用软链

Windows 上建软链需要管理员权限。用 `registry.json` 的一个字段指路，在所有平台行为一致，回退就是改一个字段。

`registry.json` 还有一个作用：把"运行时可变环境"变成可导出、可进 git、可复现的声明。没有它，容器里装了什么只能靠翻目录猜。

## 安装是长任务

`npm i` 两分钟是常态，反代通常 60 秒就断了。所以安装走与发布同一个任务队列（`jobs` 表，`kind = cli_install`）。

点「安装」后，CLI 卡片里会出现一个任务面板：状态徽标（排队中 / 执行中 / 成功 / 失败 / 超时）、耗时、失败原因与日志（页面渲染最后 80 行，完整日志留在任务记录里）。排队或执行中，设置页每 3 秒自动刷新，npm 的每次 registry 抓取都会实时出现在日志里——安装用 `--loglevel http` 就是为了让无 TTY 的任务日志有真实进展可看。同一个 CLI 已有任务在跑时，再点安装会被提示而不是重复排队；失败后再点一次「安装」即是重试。

**安装失败不会破坏已有版本**：只有在新版本真的装好、可执行文件确认存在之后，才更新 `registry.json` 的 `current`。

## 启动时不自动安装

镜像不预装，也不在首次启动时自动投递安装任务。两个平台 CLI 加起来约 283 MB，而一个只发 H5 的部署根本用不到它们——装不装由用户在设置页手动决定。启动时自动装带来的只是「新部署凭空多几百 MB 下载」。

## 三层探测

CLI 可用性分三层独立报告，而不是一个绿点：

| 层 | 查什么 | 失败意味着 |
| --- | --- | --- |
| **install** | 能不能跑起来、版本是多少 | 装没装好 |
| **credential** | 凭据格式对不对 | 配置填错了 |
| **reachability** | 平台能不能通 | 密钥失效、网络不通、或**出口 IP 未在白名单** |

分层的理由是三者的下一步完全不同。尤其第三层：**它是唯一能暴露 IP 白名单问题的地方**，而那个问题只在真正调用平台时才出现，装得再好也看不出来。

`install` 层是**类型级**的，同类型的多个实例共享一次结果。三个微信号不该在平台 CLI 页显示三份重复的 CLI 状态，而且三份可能因探测时机不同而不一致。`credential` 和 `reachability` 是**实例级**的，每个实例各跑一次。

### 容器里最常撞的两个坑会被点名

探测失败时会看 stderr 的特征，给出具体结论而不是"不可用"：

- 含 `DISPLAY` / `GTK` / `xvfb` → "它似乎需要桌面环境，不能在无头容器里运行"
- 含 `GLIBC` / `musl` / `cannot open shared object` → "它依赖的系统库缺失，可能是镜像基底不对（不要用 alpine）"

这也是 Dockerfile 用 `debian-slim` 而不是 `alpine` 的原因。

## 判据是"能跑起来"，不是"目录存在"

装到一半、依赖缺失的目录同样存在，但一跑就炸。所以探测会真的执行一次 `--version` 或 `--help`，退出码 0 才算可用。

同理，`registry.json` 说装了但可执行文件不存在时，探测报失败而不是报可用——有测试守着这条。

## 无法自动安装的 CLI

`CliSpec` 里标为 `kind: 'manual'` 的 CLI，界面只做探测并给出安装指引，**不提供一个注定失败的按钮**。

目前两个 CLI 都是 `npm` 型（抖音的结论见 [spike-douyin-cli.md](spike-douyin-cli.md)）。

## 一个跨平台实现细节

npm 的调用方式是 `node <npm-cli.js>`，不是 `spawn('npm')`。因为 Windows 上 npm 是 `.cmd` 批处理：

1. `spawn('npm')` 不走 shell 时按字面名找 PATH → `ENOENT`
2. 改成 `spawn('npm.cmd')` 后，Node 20+ 出于安全（CVE-2024-27980）拒绝在非 shell 模式下执行 `.cmd` → `EINVAL`
3. 开 `shell: true` 能跑，但参数会被 cmd.exe 再解析一次（Node 自己对这个组合发弃用警告），而且给命令名加引号会让 cmd 去找本地 `node_modules`

npm-cli.js 的位置按两种布局探测，命中哪个用哪个：

- Windows 官方安装包：`<dir>/node.exe` 与 `<dir>/node_modules/npm/` 同目录
- Unix prefix 安装（**官方 node Docker 镜像**、nvm、homebrew、发行版）：`<prefix>/bin/node` + `<prefix>/lib/node_modules/npm/`

后者必须覆盖：`node:22-bookworm-slim` 里 node 在 `/usr/local/bin`，npm 在 `/usr/local/lib/node_modules`。只认第一种布局时，容器里每次安装都会在第一步报「找不到 npm 入口」，而这条失败若不显示任务日志就完全不可见——症状正是「点了安装，一直没显示成功」。

用 `node <npm-cli.js>` 绕过整个 `.cmd` 包装，三个问题一起消失，而且 Windows 与 Linux 走同一条 `shell: false` 路径——**不走 shell 也意味着参数不会被二次解析，这是注入问题的常见入口**。

## 磁盘占用

实测（2026-11-24，各装一个版本）：

| CLI | 版本 | 占用 |
| --- | --- | --- |
| `miniprogram-ci` | 2.1.31 | 228 MB |
| `tt-minigame-ide-cli` | 2.1.2 | 55 MB |

每保留一个旧版本就多一份。CLI 卷按**每个 CLI 留 2 个版本**估算，预留 1 GB 比较稳妥。

## 版本不写 latest

`CliSpec` 里的 `defaultVersion` 是固定版本号。写 `latest` 会让两次安装装出不同的东西，而且事后无从复现。有一条测试断言所有 npm 型 CLI 都不用 `latest`。
