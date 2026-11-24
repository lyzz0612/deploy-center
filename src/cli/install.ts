/**
 * CLI 安装与路径解析（design.md D6）。
 *
 * 布局：
 *
 *   <cliHome>/
 *     registry.json           装了什么、当前用哪个版本
 *     <cliId>/<version>/      每版本独立 prefix
 *
 * 当前版本记在 registry.json 里而不是用软链：Windows 建软链需要管理员
 * 权限，而「用一个 JSON 字段指路」在所有平台行为一致，升级坏了改一个
 * 字段就回退了。
 */
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getCliSpec, type CliSpec } from '../registry/index.js';
import { readRegistry, recordInstall } from './registry-file.js';

/** 某个版本的安装前缀。 */
export function versionPrefix(cliHome: string, cliId: string, version: string): string {
  return join(cliHome, cliId, version);
}

/** 当前生效版本的安装前缀。没有已安装版本时返回 undefined。 */
export async function currentPrefix(
  cliHome: string,
  cliId: string,
): Promise<{ version: string; prefix: string } | undefined> {
  const registry = await readRegistry(cliHome);
  const entry = registry.clis[cliId];
  if (entry?.current == null) return undefined;
  return { version: entry.current, prefix: versionPrefix(cliHome, cliId, entry.current) };
}

/** 可执行文件的完整路径。 */
export function binaryPath(prefix: string, spec: CliSpec): string | undefined {
  if (spec.binPath === undefined) return undefined;
  return join(prefix, spec.binPath);
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * npm 的 JS 入口路径，和 node 可执行文件放在一起。
 *
 * 为什么不直接 `spawn('npm')`：Windows 上 npm 是 `.cmd` 批处理，不是可执行
 * 文件，于是
 *
 * 1. `spawn('npm')` 不走 shell 时按字面名找 PATH → ENOENT
 * 2. 改成 `spawn('npm.cmd')` 后，Node 20+ 出于安全（CVE-2024-27980）拒绝在
 *    非 shell 模式下执行 `.cmd` → EINVAL
 * 3. 开 `shell: true` 能跑，但参数会被 cmd.exe 再解析一次，Node 自己都对
 *    这个组合发弃用警告；而且给命令名加引号会让 cmd 去找本地 node_modules
 *
 * 用 `node <npm-cli.js>` 绕过整个 `.cmd` 包装，三个问题一起消失，而且
 * Windows 与 Linux 走的是同一条 `shell: false` 路径。
 */
export function npmCliPath(): string {
  return join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/**
 * 确认 npm 入口存在。
 *
 * 显式检查并给出路径，而不是让 `node <不存在的路径>` 抛一个 MODULE_NOT_FOUND
 * 栈——后者对着一串 loader 内部帧，看不出是环境问题还是代码问题。
 */
async function requireNpm(): Promise<string> {
  const path = npmCliPath();
  try {
    await access(path);
  } catch {
    throw new Error(
      `找不到 npm 入口 ${path}。本镜像的 node 安装布局与预期不同，无法自动安装 CLI`,
    );
  }
  return path;
}

/**
 * 跑一个命令并收集输出。一律不走 shell：参数里有用户给的版本号与路径，
 * 走 shell 就得操心引号与转义，而那是注入问题的常见入口。
 */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    let stdout = '';
    let stderr = '';

    const feed = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (into === 'out') stdout += text;
      else stderr += text;
      if (options.onLine !== undefined) {
        for (const line of text.split('\n')) {
          if (line.trim().length > 0) options.onLine(line.trimEnd());
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => feed(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => feed(chunk, 'err'));

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`找不到可执行文件 ${command}`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export interface InstallOptions {
  readonly cliHome: string;
  readonly cliId: string;
  /** 要装的版本。缺省用 spec 的 defaultVersion。 */
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

export interface InstallResult {
  readonly version: string;
  readonly prefix: string;
}

/**
 * 安装一个 CLI 到独立版本前缀。
 *
 * 失败时**不改** registry.json 的 current：这样「升级失败」不会把一个
 * 可用的旧版本也搞没（design.md D6）。
 */
export async function installCli(options: InstallOptions): Promise<InstallResult> {
  const spec = getCliSpec(options.cliId);
  const log = options.log ?? ((): void => {});

  if (spec.kind === 'manual') {
    throw new Error(
      `${spec.displayName} 只能人工安装，后台无法自动完成。${spec.manualInstructions ?? ''}`,
    );
  }
  if (spec.packageName === undefined) {
    throw new Error(`${spec.id} 声明为 npm 安装但没有包名`);
  }

  const version = options.version ?? spec.defaultVersion;
  if (version === undefined) {
    throw new Error(`${spec.id} 没有指定版本，也没有默认版本`);
  }

  const prefix = versionPrefix(options.cliHome, options.cliId, version);
  await mkdir(prefix, { recursive: true });

  const args = [
    'install',
    `${spec.packageName}@${version}`,
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
  ];
  if (spec.registry !== undefined) {
    args.push('--registry', spec.registry);
  }

  log(`安装 ${spec.packageName}@${version} 到 ${prefix}`);
  const npmCli = await requireNpm();
  const result = await run('node', [npmCli, ...args], {
    ...(options.signal !== undefined && { signal: options.signal }),
    onLine: log,
  });

  if (result.code !== 0) {
    throw new Error(
      `安装失败（npm 退出码 ${String(result.code)}）：${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  // 装完先确认可执行文件真的在，再写进清单。否则清单会声称装好了而实际没有。
  const bin = binaryPath(prefix, spec);
  if (bin !== undefined) {
    try {
      await access(bin);
    } catch {
      throw new Error(`安装后找不到可执行文件 ${bin}，清单未更新`);
    }
  }

  await recordInstall(options.cliHome, options.cliId, version, spec.registry ?? 'npm default');
  log(`安装完成：${spec.packageName}@${version}`);
  return { version, prefix };
}
