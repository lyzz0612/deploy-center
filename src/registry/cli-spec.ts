/**
 * CLI 规格（代码侧注册表）。
 *
 * 后台不是「任意命令执行器」：UI 只能从这份清单里选一个 + 选版本 + 点安装。
 * 这既避免给自己开后门，也让抖音那种「可能装不了」的不确定性被一个字段
 * 吸收掉，而不是让用户点一个注定失败的按钮。
 */

/**
 * 安装方式。
 *
 * - `npm`：后台可自动安装到 CLI 卷
 * - `manual`：只能人工安装（例如只提供桌面安装包），界面只做检测 + 给指引
 */
export type CliInstallKind = 'npm' | 'manual';

export interface CliSpec {
  readonly id: string;
  readonly displayName: string;
  readonly kind: CliInstallKind;

  /** `kind: 'npm'` 时的包名。 */
  readonly packageName?: string;
  /**
   * 推荐版本。安装时可覆盖。
   * 不写 `latest`：那会让两次安装装出不同的东西，且无从复现。
   */
  readonly defaultVersion?: string;
  /** 可选的 npm registry，国内直连官方源装大包很慢。 */
  readonly registry?: string;

  /** 相对安装前缀的可执行文件路径，用于探测与调用。 */
  readonly binPath?: string;
  /** 探测用参数，退出码 0 即视为安装完好。 */
  readonly probeArgs?: readonly string[];

  /** `kind: 'manual'` 时的安装指引。 */
  readonly manualInstructions?: string;
}

const SPECS: readonly CliSpec[] = [
  {
    id: 'miniprogram-ci',
    displayName: '微信小程序 CI',
    kind: 'npm',
    packageName: 'miniprogram-ci',
    defaultVersion: '2.1.31',
    binPath: 'node_modules/miniprogram-ci/bin/miniprogram-ci.js',
    probeArgs: ['--version'],
  },
  {
    // 结论来自 docs/spike-douyin-cli.md：纯 Node 包，无 electron 与原生模块，
    // 所以可以自动安装。但它的认证是会过期的 cookie 而非静态密钥，
    // 续期策略留到抖音插件实现时解决。
    id: 'tt-minigame-ide-cli',
    displayName: '抖音小游戏 CLI',
    kind: 'npm',
    packageName: 'tt-minigame-ide-cli',
    defaultVersion: '2.1.2',
    binPath: 'node_modules/tt-minigame-ide-cli/bin/tmg.js',
    probeArgs: ['--help'],
  },
];

const BY_ID = new Map<string, CliSpec>(SPECS.map((s) => [s.id, s]));

export function listCliSpecs(): readonly CliSpec[] {
  return SPECS;
}

export function findCliSpec(id: string): CliSpec | undefined {
  return BY_ID.get(id);
}

export function getCliSpec(id: string): CliSpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) {
    throw new Error(`未注册的 CLI：${id}`);
  }
  return spec;
}
