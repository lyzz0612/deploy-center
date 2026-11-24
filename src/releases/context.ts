/**
 * 发布执行上下文的构造（design.md D4）。
 *
 * 核心把一切准备好再交给插件：产物已下载校验解压、凭据已解密、工作目录
 * 已建好。插件只需要关心「拿到一个已就绪的目录，调一个命令，解析结果」。
 *
 * 密钥物化是核心能力，不是插件责任：私钥文件由核心写、核心删、核心设权限。
 * 让每个插件自己 try/finally 删临时文件，迟早会漏掉一次，把密钥留在磁盘上。
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PublishContext } from '../registry/index.js';

export interface ContextDeps {
  readonly artifactDir: string;
  readonly workdir: string;
  readonly target: Record<string, unknown>;
  readonly params: Record<string, unknown>;
  readonly cliHome: string;
  /** 已解密的凭据字段。核心解密，插件不接触主密钥。 */
  readonly secrets: Record<string, string>;
  readonly log: (line: string) => void;
  readonly progress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export interface ManagedContext {
  readonly ctx: PublishContext;
  /**
   * 删除本次物化出来的所有凭据文件。
   *
   * 即使整个工作目录随后会被删掉，这里仍单独清一次：工作目录的删除可能
   * 因为文件被占用而失败，而密钥文件必须确保消失。
   */
  cleanupSecrets(): Promise<void>;
}

/** 凭据文件的存放子目录，和产物分开，便于单独清理。 */
const SECRETS_DIR = 'secrets';

export async function createContext(deps: ContextDeps): Promise<ManagedContext> {
  const secretsDir = join(deps.workdir, SECRETS_DIR);
  /** 已物化的文件路径，用于清理。 */
  const materialized = new Set<string>();

  const ctx: PublishContext = {
    artifactDir: deps.artifactDir,
    workdir: deps.workdir,
    target: deps.target,
    params: deps.params,
    cliHome: deps.cliHome,

    secret(field: string): string {
      const value = deps.secrets[field];
      if (value === undefined) {
        // 报错而不是返回空串：空密钥会被原样发给平台，错误跑到远处。
        throw new Error(
          `凭据里没有字段 ${field}。可用字段：${Object.keys(deps.secrets).join(', ') || '（无）'}`,
        );
      }
      return value;
    },

    async secretFile(field: string): Promise<string> {
      const value = ctx.secret(field);
      await mkdir(secretsDir, { recursive: true });
      const path = join(secretsDir, field);
      await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
      // writeFile 的 mode 只在新建文件时生效，已存在时不改权限，所以显式设一次。
      await chmod(path, 0o600);
      materialized.add(path);
      return path;
    },

    log: deps.log,
    progress: deps.progress,
    signal: deps.signal,
  };

  return {
    ctx,
    async cleanupSecrets(): Promise<void> {
      for (const path of materialized) {
        await rm(path, { force: true });
      }
      await rm(secretsDir, { recursive: true, force: true });
      materialized.clear();
    },
  };
}
