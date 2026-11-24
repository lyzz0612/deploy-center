# Spike：抖音小游戏 CLI 的容器可用性

> 对应任务 1.1。目的是回答一个问题：`CliSpec.kind` 该取 `npm` 还是 `manual`。

## 结论

**`CliSpec.kind = "npm"`**。`tt-minigame-ide-cli` 是纯 Node 包，可以由后台在容器内自动安装，不需要桌面环境。

但它带来一个设计约束，必须在实现抖音插件时处理：**这个 CLI 用的是「登录态 cookie 文件」，不是「静态密钥」**。详见下方「会话模型」一节。

## 验证环境（与计划的偏差）

任务 1.1 原本要求在 Linux 容器内验证。**本机没有 Docker，也没有 WSL**：

```
docker      命令不存在
wsl --status 报「未安装用于 Linux 的 Windows 子系统」
```

因此实际验证在 **Windows + Node v24.19.0 + npm 11.17.0** 上完成，并辅以对安装结果的静态检查来推断 Linux 可用性。下面逐项说明哪些结论是实测的、哪些是推断的。

## 实测：安装与运行

```
> npm init -y && npm install tt-minigame-ide-cli
added 386 packages in 41s

> node node_modules/tt-minigame-ide-cli/bin/tmg.js --help
Usage: tmg [options] [command]

Commands:
  open [options] <project-path>         Open target project by path
  login [options]                       Login to the developer platform
  login-e [options] [email] [password]  Login to the developer platform by E-mail
  logout                                Logout and clear the session.
  preview [options] [entry]             Preview project by remote
  upload [options] [entry]              Upload project to the developer platform
  build-npm [projectPath]               build npm packages in node_modules
  version [entry]                       Get latest released version of project
  set-config [options]                  Set tt-minigame-ide-cli config
  help [command]                        display help for command

exit=0
```

版本 `2.1.2`，`bin` 为 `bin/tmg.js`，`package.json` 里 **没有** `engines`、`os`、`cpu` 任何限制。

## 实测：没有桌面或原生依赖

安装后扫描 386 个包，只有两个二进制文件，都来自 `clipboardy` 的 Windows 回退程序：

```
clipboardy/fallbacks/windows/clipboard_i686.exe
clipboardy/fallbacks/windows/clipboard_x86_64.exe
```

依赖树里 **没有** `electron`、`puppeteer`、`playwright`、`node-gyp`，没有 `.node` 原生模块。唯一的厂商私有依赖 `@tt-miniprogram/ext-pack@1.0.33` 是单个 `index.js`（52 KB 纯 JS）。

这是「`npm` 而不是 `manual`」的主要依据：不存在需要 GUI 或编译的组件。

## 推断：Linux 下的两个注意点

以下是对安装结果的静态分析，**未在真实 Linux 上执行**，落地时需复验：

1. **`clipboardy` 在 Linux 上要 `xsel`**。`clipboardy/lib/linux.js` 先调系统 `xsel`，失败后回退到自带 `fallbacks/linux/xsel`。只有 `upload -u/--copy`（复制链接到剪贴板）会走到这条路径；后台发布不需要这个选项，**不传 `-u` 即可绕开**。镜像里也无需装 `xsel`。
2. **二维码输出需要终端**。`upload` 的 `-s/--small`、`-o/--output`、`-b/--background-color` 都和二维码有关，`qrcode-terminal` 在无 TTY 环境下的行为未验证。`-o <path>` 把二维码写成图片文件，应当是容器内的安全选项。

## 会话模型：这是真正要处理的问题

这个 CLI **没有** 微信那种「appid + 上传私钥」的静态凭据模型。从打包产物里读出的事实：

```js
// dist/cli.js
getDefaultStoragePath = function () {
  var e = B() ? ".tmg-cli/" : ".tma-cli/";
  return process.env.TMA_CLI_HOME
    ? path.join(process.env.TMA_CLI_HOME, e)
    : path.join(os.homedir(), e);
}

// cookie 文件位置
path.join(config.storagePath, ".cookies")
```

也就是说：

- 认证靠 `tmg login`（手机）或 `tmg login-e <email> <password>`（邮箱）产生的 **cookie 文件**，落在 `<storagePath>/.cookies`。
- `logout` 的说明就是「Logout and clear the session」，证实这是会话而非密钥。
- **`TMA_CLI_HOME` 环境变量可以改写存储根目录**，实测有效：

  ```
  > $env:TMA_CLI_HOME = <dir>; tmg set-config --allow-report-event no
  setConfig {"env":{},"allowReportEvent":false}
  → <TMA_CLI_HOME>/.tmg-cli/config.json
  ```

### 对设计的影响

| 事项 | 微信 | 抖音 |
| --- | --- | --- |
| 凭据性质 | 静态私钥文件，长期有效 | 登录态 cookie，**会过期** |
| 凭据类型 | `file`（私钥）+ appid | 待定：cookie 文件内容，或邮箱+密码 |
| 能否全自动 | 能 | **取决于 cookie 能否无人工续期** |

两个未决点，留给抖音插件实现时解决（不影响插件契约，也不影响本变更的其他任务）：

1. **cookie 怎么进后台**。两条路：把 `.cookies` 文件作为 `file` 类型凭据存起来（简单，但会过期，过期后要人工重新登录并替换）；或者存邮箱+密码为 `usernamePassword` 凭据，让插件在 cookie 失效时自动跑一次 `login-e`（更自动，但要把平台账号密码交给后台，风险更高）。
2. **cookie 的有效期未知**。`login` 的实际存活时间没有在本次 spike 中测量，需要真实账号跑一次才知道。

无论选哪条，`TMA_CLI_HOME` 都要在执行发布任务时指向本次任务的工作目录，这样 cookie 物化与清理仍然由核心负责，和微信私钥走同一套机制（设计里的 D4 规则 1）。

## 待复验清单

落地到真实 Docker 主机时（任务 12.1）必须补做：

- [ ] 在 `node:22-bookworm-slim` 容器内 `npm i tt-minigame-ide-cli` 并跑 `tmg --help`
- [ ] 不装 `xsel` 时跑一次不带 `-u` 的 `upload`，确认不触发剪贴板路径
- [ ] 在无 TTY（`docker run` 不带 `-t`）下跑 `upload -o qr.png`，确认二维码落盘而非要求终端
- [ ] 用真实账号测 cookie 有效期，决定上面两个未决点
