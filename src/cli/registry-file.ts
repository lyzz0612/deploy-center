/**
 * CLI 安装清单（design.md D6）。
 *
 * `registry.json` 的作用是把「运行时可变环境」变成一个可导出、可进 git、
 * 可复现的声明。没有它，容器里装了什么就只能靠翻目录猜。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface InstalledVersion {
  readonly version: string;
  /** 安装时间 */
  readonly installedAt: string;
  /** 从哪个 registry 装的，便于复现 */
  readonly source: string;
}

export interface CliEntry {
  /** 当前生效版本。升级坏了就把它指回上一个。 */
  current: string | null;
  /** 已安装的版本，保留以便回退。 */
  versions: InstalledVersion[];
}

export interface CliRegistry {
  /** 清单格式版本。 */
  schema: number;
  /** CLI id → 安装状态 */
  clis: Record<string, CliEntry>;
}

const REGISTRY_FILE = 'registry.json';
const SCHEMA = 1;

function emptyRegistry(): CliRegistry {
  return { schema: SCHEMA, clis: {} };
}

export function registryPath(cliHome: string): string {
  return join(cliHome, REGISTRY_FILE);
}

/**
 * 读清单。文件不存在时返回空清单（首次启动的正常情况）。
 *
 * 但格式损坏时**报错**而不是当成空清单：那会让一次误操作静默丢掉所有
 * 安装记录，而磁盘上的目录还在，状态和记录就对不上了。
 */
export async function readRegistry(cliHome: string): Promise<CliRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(cliHome), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `CLI 清单 ${registryPath(cliHome)} 不是合法 JSON。` +
        '修好它或删掉它（删掉会丢失安装记录，但磁盘上的目录仍在）',
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`CLI 清单格式不对：期望对象`);
  }
  const candidate = parsed as Partial<CliRegistry>;
  if (candidate.schema !== SCHEMA) {
    throw new Error(`不支持的 CLI 清单版本 ${String(candidate.schema)}，本程序只认识 ${SCHEMA}`);
  }
  return { schema: SCHEMA, clis: candidate.clis ?? {} };
}

export async function writeRegistry(cliHome: string, registry: CliRegistry): Promise<void> {
  await mkdir(cliHome, { recursive: true });
  await writeFile(registryPath(cliHome), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

/** 记录一次安装完成。 */
export async function recordInstall(
  cliHome: string,
  cliId: string,
  version: string,
  source: string,
): Promise<void> {
  const registry = await readRegistry(cliHome);
  const entry = registry.clis[cliId] ?? { current: null, versions: [] };
  if (!entry.versions.some((v) => v.version === version)) {
    entry.versions.push({ version, installedAt: new Date().toISOString(), source });
  }
  entry.current = version;
  registry.clis[cliId] = entry;
  await writeRegistry(cliHome, registry);
}

/** 切换当前版本（回退用）。 */
export async function switchVersion(
  cliHome: string,
  cliId: string,
  version: string,
): Promise<void> {
  const registry = await readRegistry(cliHome);
  const entry = registry.clis[cliId];
  if (entry === undefined) {
    throw new Error(`${cliId} 还没有任何已安装版本`);
  }
  if (!entry.versions.some((v) => v.version === version)) {
    const available = entry.versions.map((v) => v.version).join(', ') || '（无）';
    throw new Error(`${cliId} 没有已安装的版本 ${version}。已安装：${available}`);
  }
  entry.current = version;
  await writeRegistry(cliHome, registry);
}
