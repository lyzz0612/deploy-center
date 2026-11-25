/**
 * H5 静态目录的写入、切流与验证。
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { PublishContext, StageResult, VerifyResult } from '../../registry/index.js';
import { makePointer, normalizePrefix, parsePointer, POINTER_FILE, VERSIONS_DIR } from './pointer.js';

interface Location {
  readonly rootDir: string;
  readonly prefix: string;
  readonly baseUrl: string;
  readonly keepVersions: number;
}

function readLocation(ctx: PublishContext): Location {
  const rootDir = ctx.target['rootDir'];
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) {
    throw new Error('站点根目录必须是绝对路径');
  }
  const prefix = ctx.target['prefix'];
  if (typeof prefix !== 'string') {
    throw new Error('缺少路径前缀');
  }
  const baseUrl = ctx.target['baseUrl'];
  if (typeof baseUrl !== 'string') {
    throw new Error('缺少对外地址');
  }
  const keep = ctx.target['keepVersions'];
  return {
    rootDir,
    prefix: normalizePrefix(prefix),
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    keepVersions: typeof keep === 'number' && keep > 0 ? Math.floor(keep) : 5,
  };
}

/**
 * 本次发布的版本标识。
 *
 * 用构建标识而不是时间戳：同一个构建重发时应落在同一个版本目录，
 * 否则每次重试都堆一份完全相同的产物。
 */
function versionId(ctx: PublishContext): string {
  // 用 CI 上报的构建标识做版本目录名，不自己生成时间戳：同一个构建重发时
  // 应落在同一个目录，否则每次重试都堆一份完全相同的产物。
  const buildId = ctx.build.buildId;
  // 目录名不能含路径分隔符或 ..，否则会写到站点目录之外
  if (!/^[A-Za-z0-9._-]+$/.test(buildId) || buildId.startsWith('.')) {
    throw new Error(
      `构建标识 ${JSON.stringify(buildId)} 不能作为目录名。` +
        '只允许字母、数字、点、下划线与连字符，且不能以点开头',
    );
  }
  return buildId;
}

function siteDir(location: Location): string {
  return join(location.rootDir, ...location.prefix.split('/').filter((s) => s !== ''));
}

function pointerPath(location: Location): string {
  return join(siteDir(location), POINTER_FILE);
}

async function readCurrentPointer(location: Location): Promise<ReturnType<typeof parsePointer> | null> {
  try {
    return parsePointer(await readFile(pointerPath(location), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 指针损坏时报错而不是当成「没有指针」：当成没有会让下一次发布把
    // prev 写成 null，于是回滚的退路悄悄消失了。
    throw new Error(
      `读取现有指针失败：${error instanceof Error ? error.message : String(error)}。` +
        '修好或删掉它再发布',
    );
  }
}

export async function h5DirExecute(stageId: string, ctx: PublishContext): Promise<StageResult> {
  const location = readLocation(ctx);
  const version = versionId(ctx);

  if (stageId === 'upload') {
    const versionDir = join(siteDir(location), VERSIONS_DIR, version);
    ctx.log(`写入版本目录 ${versionDir}`);

    // 先删再写：重发同一版本时要保证目录内容与产物完全一致，残留的旧文件
    // 会让这个版本变成两次产物的混合体。
    await rm(versionDir, { recursive: true, force: true });
    await mkdir(versionDir, { recursive: true });
    await cp(ctx.artifactDir, versionDir, { recursive: true });

    const entries = await readdir(versionDir);
    ctx.log(`写入 ${entries.length} 个顶层条目`);
    return { outputs: { version, versionDir } };
  }

  if (stageId === 'activate') {
    const activate = ctx.params['activate'];
    if (activate === false) {
      ctx.log('按参数要求跳过切流，版本目录已就绪但未生效');
      return { outputs: { activated: 'false', version } };
    }

    const current = await readCurrentPointer(location);
    // prev 记的是「被这次切换替换掉的那个版本」，它是回滚的目标。
    // 当前已经是这个版本时保持原 prev，否则重复发布会把 prev 冲成自己。
    const prev = current === null ? null : current.active === version ? current.prev : current.active;

    const pointer = makePointer({ active: version, prev, prefix: location.prefix });
    await mkdir(siteDir(location), { recursive: true });
    await writeFile(pointerPath(location), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');

    ctx.log(`指针已切到 ${version}${prev === null ? '' : `（上一版本 ${prev}）`}`);
    await pruneVersions(location, pointer.active, pointer.prev, ctx.log);

    return {
      outputs: {
        activated: 'true',
        version,
        ...(prev !== null && { previousVersion: prev }),
      },
    };
  }

  throw new Error(`H5 目录插件没有阶段 ${stageId}`);
}

/**
 * 清理超出保留数的旧版本目录。
 *
 * 当前生效版本与 prev **永不清理**：清掉 prev 等于让回滚失去目标，而那
 * 正是用户最需要它的时候。
 */
async function pruneVersions(
  location: Location,
  active: string,
  prev: string | null,
  log: (line: string) => void,
): Promise<void> {
  const versionsRoot = join(siteDir(location), VERSIONS_DIR);
  let entries: string[];
  try {
    entries = await readdir(versionsRoot);
  } catch {
    return;
  }

  const protectedVersions = new Set([active, ...(prev === null ? [] : [prev])]);
  const removable = entries.filter((name) => !protectedVersions.has(name)).sort();
  const excess = removable.length - Math.max(0, location.keepVersions - protectedVersions.size);
  if (excess <= 0) return;

  for (const name of removable.slice(0, excess)) {
    await rm(join(versionsRoot, name), { recursive: true, force: true });
    log(`清理旧版本目录 ${name}`);
  }
}

/**
 * 回读指针确认切流真的生效。
 *
 * 带 `?t=<version>` 绕开缓存：用版本号而不是 `Date.now()`，这样同一版本的
 * 所有请求共享一份缓存，而新版本自然得到新 URL。
 *
 * 回读的是**对外地址**而不是本地文件：本地文件写成功不代表外部能取到，
 * 中间可能有反代配置错、路径映射不对、权限不足。
 */
export async function h5DirVerify(ctx: PublishContext): Promise<VerifyResult> {
  const location = readLocation(ctx);
  const version = versionId(ctx);

  if (ctx.params['activate'] === false) {
    return { ok: true, message: '按参数要求未切流，跳过生效验证' };
  }

  const url = `${location.baseUrl}${POINTER_FILE}?t=${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, {
      // Node 的 fetch 不支持 cache 选项，用请求头表达同一意图
      headers: { 'cache-control': 'no-cache' },
      signal: ctx.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `回读指针失败：HTTP ${response.status}（${url}）。检查对外地址与静态服务器配置`,
      };
    }
    const pointer = parsePointer(await response.text());
    if (pointer.active !== version) {
      return {
        ok: false,
        message: `对外地址上的生效版本是 ${pointer.active}，不是刚发布的 ${version}。可能有缓存未失效`,
      };
    }
    return { ok: true, message: `外部已可取到新版本（${url} → ${pointer.active}）` };
  } catch (error) {
    return {
      ok: false,
      message: `回读指针出错：${error instanceof Error ? error.message : String(error)}（${url}）`,
    };
  }
}

/**
 * 回滚：把指针切回 prev，不重新写入任何产物。
 *
 * 这是 `capabilities.rollback === 'pointer'` 的实现。
 */
export async function h5DirRollback(ctx: PublishContext): Promise<StageResult> {
  const location = readLocation(ctx);
  const current = await readCurrentPointer(location);
  if (current === null) {
    throw new Error('站点上还没有指针，无从回滚');
  }
  if (current.prev === null) {
    throw new Error('指针里没有上一版本，无从回滚');
  }

  const versionDir = join(siteDir(location), VERSIONS_DIR, current.prev);
  try {
    await readdir(versionDir);
  } catch {
    throw new Error(
      `上一版本 ${current.prev} 的目录已不存在（可能被保留策略清理了），无法回滚`,
    );
  }

  const pointer = makePointer({
    active: current.prev,
    prev: current.active,
    prefix: location.prefix,
  });
  await writeFile(pointerPath(location), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  ctx.log(`已回滚到 ${current.prev}（原版本 ${current.active} 仍保留，可再切回）`);

  return { outputs: { activated: 'true', version: current.prev, previousVersion: current.active } };
}
