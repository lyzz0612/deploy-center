/**
 * H5 产物在 R2 上的上传、切流与验证。
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { S3Client } from '@aws-sdk/client-s3';

import type { PublishContext, StageResult, VerifyResult } from '../../registry/index.js';
import {
  createClient,
  deleteKeys,
  getPointerBody,
  listKeys,
  objectExists,
  putPointer,
  putShell,
  uploadTree,
} from './client.js';
import { makePointer, normalizePrefix, parsePointer, POINTER_FILE, VERSIONS_DIR } from './pointer.js';
import { SHELL_FILE, SHELL_HTML } from './shell.js';

interface Location {
  readonly bucket: string;
  readonly prefix: string;
  readonly baseUrl: string;
  readonly keepVersions: number;
}

function readLocation(ctx: PublishContext): Location {
  const bucket = ctx.target['bucket'];
  if (typeof bucket !== 'string' || bucket.trim() === '') {
    throw new Error('缺少 bucket');
  }
  const prefix = ctx.target['prefix'];
  if (typeof prefix !== 'string') {
    throw new Error('缺少路径前缀');
  }
  const baseUrl = ctx.target['baseUrl'];
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('缺少对外地址');
  }
  const keep = ctx.target['keepVersions'];
  return {
    bucket: bucket.trim(),
    prefix: normalizePrefix(prefix),
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    keepVersions: typeof keep === 'number' && keep > 0 ? Math.floor(keep) : 5,
  };
}

/**
 * 本次发布的版本标识。
 *
 * 用 CI 上报的构建标识而不是时间戳：同一个构建重发时应落在同一个版本
 * 前缀，否则每次重试都在桶里堆一份完全相同的产物。
 */
function versionId(ctx: PublishContext): string {
  const buildId = ctx.build.buildId;
  // 对象键里出现 / 或 .. 会让产物落到版本前缀之外
  if (!/^[A-Za-z0-9._-]+$/.test(buildId) || buildId.startsWith('.')) {
    throw new Error(
      `构建标识 ${JSON.stringify(buildId)} 不能作为版本前缀。` +
        '只允许字母、数字、点、下划线与连字符，且不能以点开头',
    );
  }
  return buildId;
}

/** 指针对象的键。 */
function pointerKey(location: Location): string {
  return `${location.prefix}${POINTER_FILE}`;
}

/** 入口壳的键。 */
function shellKey(location: Location): string {
  return `${location.prefix}${SHELL_FILE}`;
}

/** 某个版本的资源前缀（以 / 结尾）。 */
function versionPrefix(location: Location, version: string): string {
  return `${location.prefix}${VERSIONS_DIR}/${version}/`;
}

async function readCurrentPointer(
  client: S3Client,
  location: Location,
  ctx: PublishContext,
): Promise<ReturnType<typeof parsePointer> | null> {
  const body = await getPointerBody({
    client,
    bucket: location.bucket,
    key: pointerKey(location),
    ctx,
  });
  if (body === null) return null;

  try {
    return parsePointer(body);
  } catch (error) {
    // 指针损坏时报错而不是当成「没有指针」：当成没有会让下一次发布把
    // prev 写成 null，于是回滚的退路悄悄消失了。
    throw new Error(
      `解析现有指针失败：${error instanceof Error ? error.message : String(error)}。` +
        '修好或删掉它再发布',
    );
  }
}

export async function h5R2Execute(stageId: string, ctx: PublishContext): Promise<StageResult> {
  const location = readLocation(ctx);
  const version = versionId(ctx);
  const client = createClient(ctx);

  try {
    if (stageId === 'upload') {
      const keyPrefix = versionPrefix(location, version);
      ctx.log(`上传到 r2://${location.bucket}/${keyPrefix}`);

      // 重发同一版本时先清掉旧对象：残留的文件会让这个版本变成两次产物的
      // 混合体（上一次有、这一次没有的文件会留在线上）。
      const existing = await listKeys({ client, bucket: location.bucket, keyPrefix, ctx });
      if (existing.length > 0) {
        ctx.log(`该版本已存在 ${existing.length} 个对象，先清理再重传`);
        await deleteKeys({ client, bucket: location.bucket, keys: existing, ctx });
      }

      const result = await uploadTree({
        client,
        bucket: location.bucket,
        keyPrefix,
        sourceDir: ctx.artifactDir,
        ctx,
      });

      ctx.log(`上传完成：${result.fileCount} 个文件、${formatBytes(result.totalBytes)}`);
      return {
        outputs: {
          version,
          fileCount: String(result.fileCount),
          totalBytes: String(result.totalBytes),
        },
      };
    }

    if (stageId === 'activate') {
      if (ctx.params['activate'] === false) {
        ctx.log('按参数要求跳过切流，版本已上传但未生效');
        return { outputs: { activated: 'false', version } };
      }

      const current = await readCurrentPointer(client, location, ctx);
      // prev 记的是「被这次切换替换掉的那个版本」，它是回滚的目标。
      // 当前已经是这个版本时保持原 prev，否则重复发布会把 prev 冲成自己。
      const prev =
        current === null ? null : current.active === version ? current.prev : current.active;

      // 先保证入口在，再让指针指过去：反过来的话，指针生效的那一瞬间
      // 站点根路径是 404，正好撞上有人访问。
      await ensureShell(client, location, ctx);
      warnIfNoEntry(ctx);

      const pointer = makePointer({ active: version, prev, prefix: location.prefix });
      await putPointer({
        client,
        bucket: location.bucket,
        key: pointerKey(location),
        body: `${JSON.stringify(pointer, null, 2)}\n`,
        ctx,
      });

      ctx.log(`指针已切到 ${version}${prev === null ? '' : `（上一版本 ${prev}）`}`);
      ctx.progress(100);
      await pruneVersions(client, location, pointer.active, pointer.prev, ctx);

      return {
        outputs: {
          activated: 'true',
          version,
          ...(prev !== null && { previousVersion: prev }),
        },
      };
    }

    throw new Error(`H5 R2 插件没有阶段 ${stageId}`);
  } finally {
    client.destroy();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 清理超出保留数的旧版本。
 *
 * 当前生效版本与 prev **永不清理**：清掉 prev 等于让回滚失去目标，而那
 * 正是用户最需要它的时候。
 */
async function pruneVersions(
  client: S3Client,
  location: Location,
  active: string,
  prev: string | null,
  ctx: PublishContext,
): Promise<void> {
  const versionsRoot = `${location.prefix}${VERSIONS_DIR}/`;
  const keys = await listKeys({ client, bucket: location.bucket, keyPrefix: versionsRoot, ctx });

  // 对象存储没有目录，版本是从键里推出来的
  const versions = new Set<string>();
  for (const key of keys) {
    const rest = key.slice(versionsRoot.length);
    const slash = rest.indexOf('/');
    if (slash > 0) versions.add(rest.slice(0, slash));
  }

  const protectedVersions = new Set([active, ...(prev === null ? [] : [prev])]);
  const removable = [...versions].filter((v) => !protectedVersions.has(v)).sort();
  const excess = removable.length - Math.max(0, location.keepVersions - protectedVersions.size);
  if (excess <= 0) return;

  for (const version of removable.slice(0, excess)) {
    const prefix = versionPrefix(location, version);
    const doomed = keys.filter((key) => key.startsWith(prefix));
    await deleteKeys({ client, bucket: location.bucket, keys: doomed, ctx });
    ctx.log(`清理旧版本 ${version}（${doomed.length} 个对象）`);
  }
}

/**
 * 保证站点入口壳存在。
 *
 * 只在缺失时写：壳是允许被替换的（自己的 loading 页、埋点、骨架屏），每次
 * 发布都覆盖等于把这个位置从用户手里拿走。想换回内置壳，把对象删掉再发布
 * 一次即可。
 */
async function ensureShell(
  client: S3Client,
  location: Location,
  ctx: PublishContext,
): Promise<void> {
  const key = shellKey(location);
  if (await objectExists({ client, bucket: location.bucket, key, ctx })) {
    ctx.log(`入口 ${SHELL_FILE} 已存在，保持不动`);
    return;
  }
  await putShell({ client, bucket: location.bucket, key, body: SHELL_HTML, ctx });
  ctx.log(`已创建入口 ${SHELL_FILE}：它读 ${POINTER_FILE} 再跳到当前版本`);
}

/**
 * 产物根目录没有入口时说一句。
 *
 * 壳会跳到 `<版本目录>${SHELL_FILE}`，产物里没有这个文件，用户看到的就是
 * 404；而 404 的现象（白屏或一句「加载失败」）离「包结构不对」这个原因很远。
 */
async function warnIfNoEntry(ctx: PublishContext): Promise<void> {
  try {
    await access(join(ctx.artifactDir, SHELL_FILE));
  } catch {
    ctx.log(`注意：产物根目录没有 ${SHELL_FILE}，入口壳会跳到一个不存在的文件`);
  }
}

/**
 * 回读指针与入口，确认切流真的生效。
 *
 * 回读的是**对外地址**而不是存储接口：对象写进去不代表外部能取到，中间
 * 可能有自定义域没绑、Workers 路由不对、缓存没失效。
 *
 * 两样都查：指针对了但入口壳不在，站点根路径照样打不开；而「桶里有什么」
 * 这件事只有在这里用外部视角才看得出来。
 *
 * 带 `?t=<version>` 绕开缓存：用版本号而不是 `Date.now()`，这样同一版本的
 * 所有请求共享一份缓存，而新版本自然得到新 URL。
 */
export async function h5R2Verify(ctx: PublishContext): Promise<VerifyResult> {
  const location = readLocation(ctx);
  const version = versionId(ctx);

  if (ctx.params['activate'] === false) {
    return { ok: true, message: '按参数要求未切流，跳过生效验证' };
  }

  const url = `${location.baseUrl}${POINTER_FILE}?t=${encodeURIComponent(version)}`;
  const shellUrl = `${location.baseUrl}${SHELL_FILE}?t=${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, {
      // Node 的 fetch 不支持 cache 选项，用请求头表达同一意图
      headers: { 'cache-control': 'no-cache' },
      signal: ctx.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `回读指针失败：HTTP ${response.status}（${url}）。检查对外地址与自定义域绑定`,
      };
    }
    const pointer = parsePointer(await response.text());
    if (pointer.active !== version) {
      return {
        ok: false,
        message:
          `对外地址上的生效版本是 ${pointer.active}，不是刚发布的 ${version}。` +
          '可能是 CDN 缓存未失效，稍后重试验证',
      };
    }

    const shell = await fetch(shellUrl, {
      headers: { 'cache-control': 'no-cache' },
      signal: ctx.signal,
    });
    if (!shell.ok) {
      return {
        ok: false,
        message:
          `入口 ${SHELL_FILE} 取不到：HTTP ${shell.status}（${shellUrl}）。` +
          `桶里 ${shellKey(location)} 可能被删了（或在自定义域上被路由排除），` +
          '再发布一次会补上',
      };
    }

    return {
      ok: true,
      message: `外部已可取到新版本（${url} → ${pointer.active}），入口 ${SHELL_FILE} 可打开`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `回读指针出错：${describeFetchError(error)}（${url}）`,
    };
  }
}

/**
 * Node 的 fetch 只抛一句 `fetch failed`，真正的原因（域名解析不了、
 * 证书不匹配、连接被拒）压在里面那层 cause 里。不把它翻出来，用户在
 * 发布记录里看到的是一句没法行动的话。
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail === undefined || detail === '' ? error.message : `${error.message}：${detail}`;
}

/**
 * 回滚：把指针切回 prev，不重新上传任何产物。
 *
 * 这是 `capabilities.rollback === 'pointer'` 的实现。
 */
export async function h5R2Rollback(ctx: PublishContext): Promise<StageResult> {
  const location = readLocation(ctx);
  const client = createClient(ctx);

  try {
    const current = await readCurrentPointer(client, location, ctx);
    if (current === null) {
      throw new Error('桶上还没有指针，无从回滚');
    }
    if (current.prev === null) {
      throw new Error('指针里没有上一版本，无从回滚');
    }

    // 回滚目标的对象必须还在：保留策略可能已经清掉它，那时切过去会得到
    // 一个 404 的线上版本，比不回滚更糟。
    const targetPrefix = versionPrefix(location, current.prev);
    const remaining = await listKeys({
      client,
      bucket: location.bucket,
      keyPrefix: targetPrefix,
      ctx,
    });
    if (remaining.length === 0) {
      throw new Error(
        `上一版本 ${current.prev} 的对象已不存在（可能被保留策略清理了），无法回滚`,
      );
    }

    const pointer = makePointer({
      active: current.prev,
      prev: current.active,
      prefix: location.prefix,
    });
    await putPointer({
      client,
      bucket: location.bucket,
      key: pointerKey(location),
      body: `${JSON.stringify(pointer, null, 2)}\n`,
      ctx,
    });
    ctx.log(`已回滚到 ${current.prev}（原版本 ${current.active} 仍保留，可再切回）`);

    return {
      outputs: { activated: 'true', version: current.prev, previousVersion: current.active },
    };
  } finally {
    client.destroy();
  }
}
