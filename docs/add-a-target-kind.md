#  新增一个发布目标类型

发布目标类型（`TargetKind`）就是这套系统里的"插件"。新增一个的全部改动是**一个目录加一行 import**，核心发布流程不动。

如果你发现还得改核心，那说明抽象漏了东西——该补的是 manifest 字段或 capability，不是加分支。

## 五步

### 1. 建目录与 manifest

`src/plugins/<your-kind>/manifest.ts`：

```ts
import type { TargetKindManifest } from '../../registry/index.js';

export const myManifest: TargetKindManifest = {
  id: 'h5-r2',
  displayName: 'H5 对象存储（R2）',
  description: '把产物写进 S3 兼容存储，通过覆盖指针切流。',

  // 能吃哪些包类型。这是「错配不可能出现」的唯一机制：
  // 发布目标下拉框只列出 accepts 含该包类型的实例。
  accepts: ['h5'],

  // 需要哪种凭据。类型决定字段集（见 registry/credential-type.ts），
  // 所以所有对象存储目标共用 s3Keys，轮换密钥只改一处。
  requiresCredential: 's3Keys',

  // 需要哪些 CLI。核心负责安装与探测，插件不管。
  requiresCli: [],

  // 目标实例的配置字段。**不允许出现任何密钥字段**——那些在凭据里，
  // 启动自检会对 secret/password/privateKey/token 这类 key 报错。
  targetFields: [
    { key: 'bucket', label: 'Bucket', type: 'string', required: true, identity: true },
    { key: 'prefix', label: '路径前缀', type: 'string', required: true, identity: true },
    { key: 'baseUrl', label: '对外地址', type: 'string', required: true },
  ],

  // 每次发布要填的参数。
  publishFields: [
    { key: 'activate', label: '立即切为线上版本', type: 'boolean', required: false },
  ],

  stages: [
    { id: 'upload', name: '上传版本目录', timeoutMs: 10 * 60 * 1000 },
    { id: 'activate', name: '切换生效指针', timeoutMs: 60 * 1000 },
  ],

  capabilities: {
    rollback: 'pointer',
    verify: true,
    activateLatencySeconds: 60, // 前面有 CDN 就如实写大
  },
};
```

#### `identity` 决定什么算"重复实例"

只有真正决定**发到哪**的字段该标 `identity: true`。

反例：如果把"备注"也算进去，改一下备注就能绕过去重，造出两个指向同一位置的实例——它们会互相覆盖。正例是 `h5-dir` 的 `baseUrl` 不参与去重：它是"怎么访问"，不是"发到哪"。

### 2. 写环境检查

`src/plugins/<your-kind>/checks.ts`。分三层，各自失败时的下一步完全不同：

| level | 查什么 | 跑在哪 |
| --- | --- | --- |
| `install` | CLI/工具装没装 | 类型级（同类型实例共享一次） |
| `credential` | 凭据格式对不对 | 实例级 |
| `reachability` | 平台/存储能不能通 | 实例级 |

```ts
export const myTargetChecks: readonly Check<PublishContext>[] = [
  {
    id: 'r2-credential',
    name: '密钥格式',
    level: 'credential',
    async run(ctx) {
      const keyId = ctx.secret('accessKeyId');
      return keyId.length > 0
        ? { ok: true, message: '密钥已配置' }
        : { ok: false, message: 'Access Key ID 为空' };
    },
  },
  {
    id: 'r2-reachable',
    name: '存储可达性',
    level: 'reachability',
    async run(ctx) {
      // 用一个只读调用去探，不产生副作用
      try {
        await headBucket(ctx);
        return { ok: true, message: 'bucket 可访问' };
      } catch (error) {
        return { ok: false, message: 分类错误(error) };
      }
    },
  },
];
```

**`reachability` 这一层最值钱**：它是唯一能暴露"密钥有效但出口 IP 未加白名单"这类问题的地方，而那个问题装得再好也看不出来。所以失败信息要具体到可行动，不要只说"不可用"。微信插件的 [classifyPlatformError](../src/plugins/wechat/checks.ts) 是一个参照：它把 errcode 翻译成"到哪里改什么"。

### 3. 写执行体

`src/plugins/<your-kind>/publish.ts`：

```ts
export async function myExecute(stageId: string, ctx: PublishContext): Promise<StageResult> {
  if (stageId === 'upload') {
    // ctx 里一切都已就绪，见下方「ctx 给你什么」
    await uploadDir(ctx.artifactDir, target(ctx));
    return { outputs: { version: ctx.build.buildId } };
  }
  if (stageId === 'activate') { /* ... */ }
  throw new Error(`没有阶段 ${stageId}`);
}
```

#### ctx 给你什么

| 字段 | 内容 |
| --- | --- |
| `artifactDir` | **已下载、已校验 sha256、已解压**的产物目录 |
| `build` | 构建事实：`buildId`、`commitSha`、`sha256`、`sizeBytes` |
| `target` | 目标实例的位置字段（明文，不含密钥） |
| `params` | 本次发布填的参数 |
| `cliHome` | CLI 安装根目录 |
| `secret(field)` | 凭据明文。核心解密，你不接触主密钥 |
| `secretFile(field)` | 把凭据物化成临时文件，返回路径。**核心负责删除** |
| `log(line)` | 追加日志，会落进发布记录 |
| `signal` | 取消信号。**必须传给你 spawn 的子进程** |

两条规矩：

- **不要自己写临时凭据文件。** 用 `secretFile()`。自己写就要自己 `finally` 删，而那个 finally 迟早会在某条异常路径上被漏掉，密钥就留在磁盘上了。
- **不要用同步 API 解压或读大文件。** 整个系统是单进程，`unzipSync` 一个几百兆的包会真的堵住事件循环。

### 4. 组装并注册

`src/plugins/<your-kind>/index.ts`：

```ts
export const myPlugin: TargetKind = {
  manifest: myManifest,
  globalChecks: [],          // CLI 可用性由核心统一探，不必重复声明
  targetChecks: myTargetChecks,
  execute: myExecute,
  verify: myVerify,          // 声明了 capabilities.verify 就必须实现
  rollback: myRollback,      // 声明了 rollback: 'pointer' 就必须实现
};
```

然后在 `src/plugins/index.ts` 加一行：

```ts
import { myPlugin } from './h5-r2/index.js';

const PLUGINS: readonly TargetKind[] = [wechatPlugin, h5DirPlugin, myPlugin];
```

**到这里就结束了。** 核心会自动：把它列进「添加发布目标」的类型选择和自检页、按 `accepts` 过滤发布候选、渲染两套表单、按 `stages` 编排执行、按 `capabilities` 决定显示哪个回滚入口。

### 5. 需要新 CLI 时加一条 spec

只在你的插件依赖某个命令行工具时需要。往 `src/registry/cli-spec.ts` 加：

```ts
{
  id: 'your-cli',
  displayName: '某平台 CLI',
  kind: 'npm',                  // 装不了就写 'manual'
  packageName: 'their-cli',
  defaultVersion: '1.2.3',      // 不要写 latest
  binPath: 'node_modules/their-cli/bin/cli.js',
  probeArgs: ['--version'],
}
```

装不了的（比如只提供桌面安装包）标 `kind: 'manual'` 并写 `manualInstructions`。界面只做探测和给指引，**不会提供一个注定失败的按钮**。

## 启动自检会替你挡住什么

写完直接启动，这些问题会在启动时就炸（而不是等用户点发布）：

- `accepts` 指向未登记的包类型
- `requiresCredential` 指向未注册的凭据类型
- `requiresCli` 指向未注册的 CLI
- 声明 `capabilities.verify: true` 却没实现 `verify()`（反之也报）
- 声明 `rollback: 'pointer'` 却没实现 `rollback()`（反之也报）
- `targetFields` 里出现疑似密钥字段
- `targetFields` 没有任何 `identity` 字段（同类型实例将无法区分）
- 阶段 id 重复、超时非正数、`select` 没有选项、正则非法

错误信息会一次列全部问题，不是只报第一个。

## 以 h5-dir 为模板改 R2 型

[h5-dir](../src/plugins/h5-dir/) 是一个完整的 H5 目标实现。把它改成对象存储型，要动的只有"怎么把字节放上去"：

| 部分 | h5-dir | h5-r2 |
| --- | --- | --- |
| manifest | `requiresCredential: null` | `requiresCredential: 's3Keys'` |
| targetFields | `rootDir` + `prefix` | `bucket` + `prefix`（+ endpoint 在凭据里） |
| upload 阶段 | `cp -r` 到目录 | `rclone copy` 或 S3 SDK 批量上传 |
| activate 阶段 | `writeFile(config.json)` | 上传单个对象，**单独设 `Cache-Control: no-store`** |
| verify | `fetch(baseUrl + config.json)` | 同左，不变 |
| 回滚 | 覆盖 config.json | 同左，不变 |

**指针机制、版本目录布局、回滚语义三者完全一致**，可以直接复用 [pointer.ts](../src/plugins/h5-dir/pointer.ts)。

一处对象存储特有的坑：版本目录里的资源要 `immutable, max-age=31536000`，而指针要 `no-store`，两者缓存策略相反。`rclone` 的 `--header-upload` 作用于整次 copy，所以**必须拆成两次调用**，不能为了省事合并。

## 不要做的事

- **不要做运行时动态加载插件。** 加平台是几个月一次的改动，一行 import 完全可接受；动态加载会同时带来类型、调试与安全问题。真正需要运行时可变的是 CLI 版本，而那个由 `/opt/cli` 卷解决了。
- **不要在核心里按 kind 写分支。** 核心出现 `if (kind === 'wechat')` 即视为抽象失败。
- **不要让 `execute` 吞掉错误。** 抛出来，核心会记进阶段日志、标记状态、保留现场供重试。自己 catch 后返回成功会让失败变成静默的。
