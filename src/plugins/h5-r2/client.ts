/**
 * R2（S3 兼容）访问层。
 *
 * 这个文件只管「怎么把字节放上去、取回来、删掉」，不含任何发布语义——
 * 版本目录布局与指针规则在 publish.ts 与 pointer.ts 里。分开是因为换一个
 * S3 兼容存储时该改的只有这里。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { PublishContext } from '../../registry/index.js';

/** 同时上传的对象数。 */
const UPLOAD_CONCURRENCY = 8;

/** DeleteObjects 单次请求的上限（S3 协议规定 1000）。 */
const DELETE_BATCH = 1000;

/**
 * 静态资源的缓存策略。
 *
 * 版本目录里的文件**永不改变**（改了就是新版本、新目录），所以可以放心
 * 长缓存；而指针对象必须每次回源，否则切流不生效。两者策略相反，必须
 * 分别设置，不能图省事统一。
 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const POINTER_CACHE = 'no-store, max-age=0';

/**
 * 入口壳的缓存策略。
 *
 * 壳的内容不随发布变化，但要为「以后改壳」留一条传播路径：短缓存 + 允许
 * 回源，新壳最多 5 分钟被取到。用 immutable 会让一次壳的 bug 永久钉在
 * 已访问过的客户端上。
 */
const SHELL_CACHE = 'public, max-age=300, must-revalidate';

/** 按扩展名给 Content-Type。 */
const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.atlas', 'text/plain; charset=utf-8'],
  ['.bin', 'application/octet-stream'],
]);

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES.get(key.slice(dot).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * 从凭据建一个 S3 客户端。
 *
 * R2 必须带 endpoint（它不在 AWS 的区域体系里），所以缺 endpoint 时直接
 * 报错而不是让 SDK 去连 AWS——那个错误会以「域名解析失败」的形式出现在
 * 几层调用之外，看不出根因。
 */
export function createClient(ctx: PublishContext): S3Client {
  // endpoint 与 region 在凭据里声明为可选，所以必须用 secretOptional 读：
  // 用 secret() 会在「用户没填」时抛「凭据里没有字段」，把可选变成必填。
  const endpoint = ctx.secretOptional('endpoint').trim();
  if (endpoint === '') {
    throw new Error(
      '凭据里的 endpoint 为空。R2 必须填账号专属的 S3 endpoint，' +
        '形如 https://<accountid>.r2.cloudflarestorage.com',
    );
  }

  return new S3Client({
    endpoint,
    // R2 忽略 region，但 SDK 要求有值，用 S3 的兼容写法。
    region: ctx.secretOptional('region').trim() || 'auto',
    credentials: {
      accessKeyId: ctx.secret('accessKeyId'),
      secretAccessKey: ctx.secret('secretAccessKey'),
    },
    // 路径风格寻址：R2 的自定义 endpoint 不支持把桶名放进域名。
    forcePathStyle: true,
  });
}

/** 列出目录下的全部文件，返回相对路径（已转成 / 分隔）。 */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // 符号链接不跟随：产物包里不该有，有也不该把宿主文件传上去
      if (!entry.isFile()) continue;
      found.push(relative(root, full).split(sep).join(posix.sep));
    }
  }

  await walk(root);
  return found;
}

export interface UploadTreeResult {
  readonly fileCount: number;
  readonly totalBytes: number;
}

/**
 * 把一个本地目录上传到 `keyPrefix` 下。
 *
 * 并发有上限：一个几千文件的 H5 包如果全量并发，会同时打开几千个文件
 * 句柄并把内存撑爆。
 */
export async function uploadTree(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly sourceDir: string;
  readonly ctx: PublishContext;
}): Promise<UploadTreeResult> {
  const { client, bucket, keyPrefix, sourceDir, ctx } = options;
  const files = await listFiles(sourceDir);
  if (files.length === 0) {
    throw new Error('产物目录是空的，没有任何文件可上传');
  }

  let totalBytes = 0;
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      ctx.signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      const relativePath = files[index];
      if (relativePath === undefined) return;

      const localPath = join(sourceDir, relativePath.split(posix.sep).join(sep));
      const body = await readFile(localPath);
      totalBytes += body.byteLength;

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${keyPrefix}${relativePath}`,
          Body: body,
          ContentType: contentTypeFor(relativePath),
          CacheControl: IMMUTABLE_CACHE,
        }),
        { abortSignal: ctx.signal },
      );

      done += 1;
      // 进度只报到 90%：activate 阶段还没跑，报 100 会让界面显示「完成」
      // 而其实还没切流。
      ctx.progress(Math.floor((done / files.length) * 90));
      if (done % 50 === 0 || done === files.length) {
        ctx.log(`已上传 ${done}/${files.length} 个文件`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  );

  return { fileCount: files.length, totalBytes };
}

/** 上传指针对象。单独一个函数是因为它的缓存策略与版本资源相反。 */
export async function putPointer(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly body: string;
  readonly ctx: PublishContext;
}): Promise<void> {
  await options.client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ContentType: 'application/json; charset=utf-8',
      // 指针必须每次回源，否则切流与回滚都会被缓存吃掉
      CacheControl: POINTER_CACHE,
    }),
    { abortSignal: options.ctx.signal },
  );
}

/** 写入口壳。缓存策略与版本资源、指针都不同，见 SHELL_CACHE。 */
export async function putShell(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly body: string;
  readonly ctx: PublishContext;
}): Promise<void> {
  await options.client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: SHELL_CACHE,
    }),
    { abortSignal: options.ctx.signal },
  );
}

/** 对象是否存在。用 HEAD 而不是 GET：入口壳可能有几百 KB 的自定义版本。 */
export async function objectExists(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly ctx: PublishContext;
}): Promise<boolean> {
  try {
    await options.client.send(
      new HeadObjectCommand({ Bucket: options.bucket, Key: options.key }),
      { abortSignal: options.ctx.signal },
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** 读指针对象。对象不存在时返回 null（首次发布的正常情况）。 */
export async function getPointerBody(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly ctx: PublishContext;
}): Promise<string | null> {
  try {
    const response = await options.client.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: options.key }),
      { abortSignal: options.ctx.signal },
    );
    return (await response.Body?.transformToString()) ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** 对象或桶不存在。SDK 在不同实现上给的字段不一致，所以几处都看。 */
export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') return true;
  if (candidate.Code === 'NoSuchKey') return true;
  return candidate.$metadata?.httpStatusCode === 404;
}

/** 列出 `keyPrefix` 下的全部对象键（自动翻页）。 */
export async function listKeys(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly ctx: PublishContext;
}): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const response = await options.client.send(
      new ListObjectsV2Command({
        Bucket: options.bucket,
        Prefix: options.keyPrefix,
        ...(token !== undefined && { ContinuationToken: token }),
      }),
      { abortSignal: options.ctx.signal },
    );
    for (const item of response.Contents ?? []) {
      if (item.Key !== undefined) keys.push(item.Key);
    }
    // 翻页必须看 IsTruncated：NextContinuationToken 在最后一页是 undefined，
    // 只靠它判断会在恰好整页时多转一圈。
    token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
  } while (token !== undefined);

  return keys;
}

/** 批量删除对象。空列表时不发请求。 */
export async function deleteKeys(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keys: readonly string[];
  readonly ctx: PublishContext;
}): Promise<number> {
  let deleted = 0;

  for (let start = 0; start < options.keys.length; start += DELETE_BATCH) {
    const batch = options.keys.slice(start, start + DELETE_BATCH);
    const response = await options.client.send(
      new DeleteObjectsCommand({
        Bucket: options.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
      { abortSignal: options.ctx.signal },
    );
    // DeleteObjects 是「部分成功」语义：HTTP 200 里也可能带着一串失败项，
    // 不看 Errors 就会把清理失败当成功。
    const errors = response.Errors ?? [];
    if (errors.length > 0) {
      const sample = errors
        .slice(0, 3)
        .map((e) => `${e.Key ?? '?'}: ${e.Message ?? e.Code ?? '未知错误'}`)
        .join('；');
      throw new Error(`删除对象失败 ${errors.length} 个：${sample}`);
    }
    deleted += batch.length;
  }

  return deleted;
}

/** 桶是否可达。用于实例级可达性检查。 */
export async function headBucket(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly ctx: PublishContext;
}): Promise<void> {
  await options.client.send(new HeadBucketCommand({ Bucket: options.bucket }), {
    abortSignal: options.ctx.signal,
  });
}
