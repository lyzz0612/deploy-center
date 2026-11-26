/**
 * 发布目标类型（插件契约）。
 *
 * 新增一个小游戏平台或一种 H5 部署方式 = 新增一个插件目录 + 注册表加一行，
 * 核心发布流程不动（design.md D4）。
 *
 * 四条硬规则：
 *
 * 1. **密钥物化是核心能力**。私钥文件由核心写、核心删、核心保证权限；
 *    插件只拿路径。
 * 2. **发布从第一天就是多阶段**，即使某平台第一版只有一个 upload。
 * 3. **差异只能靠 manifest 与 capability 表达**。核心出现
 *    `if (kind === 'wechat')` 即视为抽象失败。
 * 4. **编译期注册，不做动态加载**。
 */
import type { CredentialTypeId } from './credential-type.js';
import type { Field } from './fields.js';

/* --------------------------------- 能力声明 -------------------------------- */

/**
 * 回滚方式。不同平台的回滚语义完全不同，所以必须由插件声明：
 *
 * - `republish`：平台侧没有「回滚」动作，只能把旧版本重新发一次（微信、抖音）
 * - `pointer`：只改生效指针，不重新写入产物（H5）
 * - `none`：不支持回滚，界面不显示入口
 */
export type RollbackMode = 'republish' | 'pointer' | 'none';

export interface Capabilities {
  readonly rollback: RollbackMode;
  /** 是否实现了 `verify`。声明 true 时核心会在发布完成后调用它。 */
  readonly verify: boolean;
  /**
   * 发布生效的预计延迟（秒）。
   *
   * 核心不承诺「秒级」，只承诺插件声明的值，界面据此提示用户。
   * 直写对象存储接近 0；GitHub Pages 这类前置 CDN 不可控的目标要如实写大。
   */
  readonly activateLatencySeconds: number;
}

/* ---------------------------------- 阶段 ---------------------------------- */

export interface Stage {
  readonly id: string;
  readonly name: string;
  /** 该阶段的超时（毫秒）。超时后记录进入 timeout 状态并保留已有日志。 */
  readonly timeoutMs: number;
}

/* --------------------------------- 环境检测 -------------------------------- */

export type CheckLevel = 'install' | 'credential' | 'reachability';

export interface CheckResult {
  readonly ok: boolean;
  /** 给人看的结论。失败时要具体到可行动，而不是「不可用」。 */
  readonly message: string;
  /** 补充细节，例如 CLI 版本号、平台返回的错误码。 */
  readonly detail?: string;
}

/**
 * 一项检查。
 *
 * `level` 决定它跑在哪一层（publish-targets spec：环境检测分两级）：
 *
 * - `install` 是类型级，同类型的多个实例共享一次结果，不重复执行
 * - `credential` 与 `reachability` 是实例级，每个实例各跑一次
 *
 * `reachability` 是唯一能暴露「密钥有效但来源 IP 未在白名单」这类问题的
 * 一层，它的失败信息必须能区分配置错误与来源限制。
 */
export interface Check<Ctx> {
  readonly id: string;
  readonly name: string;
  readonly level: CheckLevel;
  run(ctx: Ctx): Promise<CheckResult>;
}

/** 类型级检查只需要知道 CLI 装在哪，不涉及任何具体实例。 */
export interface GlobalCheckContext {
  readonly cliHome: string;
}

/* ---------------------------------- 执行 ---------------------------------- */

/**
 * 发布执行上下文。核心把一切准备好再交给插件。
 *
 * 这六类东西就是「扩展成本低」的全部原因：插件作者只需要关心
 * 「拿到一个已就绪的目录，调一个命令，解析一个结果」。
 */
/** 本次发布对应的构建事实。插件按需使用，不必自己去查库。 */
export interface BuildInfo {
  /** CI 上报的构建标识。H5 用它当版本目录名，平台型插件用它做日志关联。 */
  readonly buildId: string;
  /** 源码 commit，没有时为 null。 */
  readonly commitSha: string | null;
  readonly packageTypeId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PublishContext {
  /** 已下载、已校验 sha256、已解压的产物目录。 */
  readonly artifactDir: string;
  /** 本次发布的构建信息。 */
  readonly build: BuildInfo;
  /** 本次任务的工作目录。核心创建，任务结束后删除。 */
  readonly workdir: string;
  /** 目标实例的位置字段（明文配置，不含密钥）。 */
  readonly target: Record<string, unknown>;
  /** 本次发布填写的参数。 */
  readonly params: Record<string, unknown>;
  /** CLI 安装根目录。 */
  readonly cliHome: string;

  /**
   * 取**必填**凭据字段的明文值。核心负责解密。
   *
   * 插件不接触加密、不接触主密钥。字段没有值时报错而不是返回空串——
   * 空密钥会被原样发给平台，错误跑到离原因很远的地方。
   */
  secret(field: string): string;

  /**
   * 取**可选**凭据字段，没填时返回空串。
   *
   * 为什么必须有这一个：凭据只存有值的字段（空值等于「没设置」），所以
   * 一个声明为 `required: false` 的字段在用户没填时根本不在凭据里。
   * 那时用 `secret()` 读它会抛错，于是「可选」在实际行为上变成了必填。
   */
  secretOptional(field: string): string;

  /**
   * 把凭据字段物化成临时文件，返回路径。
   *
   * 核心负责创建、设权限、任务结束后删除。插件不要自己写临时文件，
   * 那样迟早会漏掉 finally，把密钥留在磁盘上。
   */
  secretFile(field: string): Promise<string>;

  /** 追加一行日志，会落进发布记录。 */
  log(line: string): void;
  /** 报告进度（0-100），用于界面展示。 */
  progress(percent: number): void;
  /** 取消信号。插件应把它传给 spawn 出的子进程。 */
  readonly signal: AbortSignal;
}

export interface StageResult {
  /**
   * 平台返回的标识，写进发布记录。
   * 微信的上传结果、H5 写入后的指针值都走这里。
   */
  readonly outputs?: Record<string, string>;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly message: string;
}

/* --------------------------------- 插件本体 -------------------------------- */

export interface TargetKindManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;

  /**
   * 可接受的包类型 id。
   *
   * 这是「三种包 × N 种目标」能合法组合的唯一机制：选了一个 wechat 包，
   * 发布目标下拉框只列出 accepts 含 wechat 的实例，错配在 UI 层就不可能
   * 出现，核心不需要写任何平台判断。
   */
  readonly accepts: readonly string[];

  /** 所需的凭据类型。不需要凭据时为 null（例如写本地目录）。 */
  readonly requiresCredential: CredentialTypeId | null;

  /** 所需的 CLI（CliSpec id）。核心负责安装与探测。 */
  readonly requiresCli: readonly string[];

  /** 目标实例的配置字段。不允许出现任何密钥字段——那些在凭据里。 */
  readonly targetFields: readonly Field[];

  /** 每次发布要填的字段。 */
  readonly publishFields: readonly Field[];

  readonly stages: readonly Stage[];
  readonly capabilities: Capabilities;
}

export interface TargetKind {
  readonly manifest: TargetKindManifest;
  /** 类型级检查：同类型实例共享结果。 */
  readonly globalChecks: readonly Check<GlobalCheckContext>[];
  /** 实例级检查：每个实例各跑一次。 */
  readonly targetChecks: readonly Check<PublishContext>[];

  execute(stageId: string, ctx: PublishContext): Promise<StageResult>;
  verify?(ctx: PublishContext): Promise<VerifyResult>;

  /**
   * 原地回滚。只在 `capabilities.rollback === 'pointer'` 时需要实现。
   *
   * `republish` 不走这里——那是「以旧版本构建发起一次新发布」，由核心
   * 建一条新的发布记录完成，插件什么都不用知道。
   */
  rollback?(ctx: PublishContext): Promise<StageResult>;
}
