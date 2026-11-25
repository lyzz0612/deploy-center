/**
 * 从 CLI 卷里加载 miniprogram-ci。
 *
 * 为什么不作为 npm 依赖 import：它装在持久卷里（design.md D6），版本由
 * 用户在界面上选，而不是跟着镜像走。所以只能在运行时按路径动态加载。
 *
 * 这也是「CLI 版本是运行时可变的、代码插件是编译期固定的」这条分界线的
 * 具体体现。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { currentPrefix } from '../../cli/index.js';

/** miniprogram-ci 暴露的我们用到的那部分。 */
export interface MiniProgramCi {
  Project: new (options: {
    projectPath: string;
    type: 'miniGame';
    appid: string;
    privateKeyPath: string;
    ignores?: string[];
  }) => object;

  upload(options: {
    project: object;
    version: string;
    desc?: string;
    robot?: number;
    setting?: Record<string, unknown>;
    onProgressUpdate?: (task: unknown) => void;
  }): Promise<{
    subPackageInfo?: Array<{ name: string; size: number }>;
    pluginInfo?: Array<{ pluginProviderAppid: string; version: string; size: number }>;
  }>;

  getLatestVersion(options: { project: object }): Promise<{
    latestVersion: string;
    grayReleaseVersion?: string;
  }>;
}

export class CliNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliNotInstalledError';
  }
}

/**
 * 加载当前生效版本的 miniprogram-ci。
 *
 * 未安装时抛一个能说清下一步的错，而不是让 import 抛 MODULE_NOT_FOUND。
 */
export async function loadMiniProgramCi(cliHome: string): Promise<MiniProgramCi> {
  const current = await currentPrefix(cliHome, 'miniprogram-ci');
  if (current === undefined) {
    throw new CliNotInstalledError(
      'miniprogram-ci 尚未安装。到「全局设置 → CLI 管理」安装它后再发布',
    );
  }

  try {
    // 用 createRequire 从安装前缀解析包名，让 Node 自己读 package.json 的
    // main 字段。不要写死 `index.js`：这个包的入口实际是 `dist/index.js`，
    // 而且入口路径属于包的内部约定，会随版本变。
    const requireFrom = createRequire(join(current.prefix, 'node_modules', 'noop.js'));
    const entry = requireFrom.resolve('miniprogram-ci');
    const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    // 这个包是 CJS，动态 import 后实体在 default 上
    return (module.default ?? module) as MiniProgramCi;
  } catch (error) {
    throw new CliNotInstalledError(
      `加载 miniprogram-ci ${current.version} 失败：${
        error instanceof Error ? error.message : String(error)
      }。可能安装不完整，尝试重新安装或回退到上一个版本`,
    );
  }
}
