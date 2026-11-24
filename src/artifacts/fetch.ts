/**
 * 产物获取与校验（build-ingestion spec：发布前校验产物可用性）。
 *
 * 后台不持有任何读取存储的凭据，只会用 CI 给的 URL 去下载。所以这一步
 * 的失败是常态，错误信息必须能让人知道下一步做什么。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 取回失败的原因。
 *
 * 分类而不是一句「下载失败」：这三种对用户的下一步动作完全不同
 * （build-ingestion spec 明确要求区分）。
 *
 * - `unreachable`：404 或 DNS 失败。链接已失效，重试同一个 URL 没有意义
 * - `forbidden`：401/403。签名 URL 过期或权限没开
 * - `timeout`：超时。可能是网络抖动，重试有意义
 * - `integrity`：下载成功但大小或摘要不符。产物被换过或传输损坏
 * - `server_error`：5xx。对方的问题，重试有意义
 */
export type FetchFailureKind =
  | 'unreachable'
  | 'forbidden'
  | 'timeout'
  | 'integrity'
  | 'server_error';

export class ArtifactFetchError extends Error {
  constructor(
    readonly kind: FetchFailureKind,
    /** 当时实际使用的 URL，写进发布日志供排查。 */
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactFetchError';
  }
}

export interface FetchArtifactOptions {
  readonly url: string;
  /** 落盘路径。 */
  readonly destination: string;
  /** 上报的字节数，必须一致。 */
  readonly expectedSize: number;
  /** 上报的 sha256，必须一致。 */
  readonly expectedSha256: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function classifyStatus(status: number): FetchFailureKind {
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 500) return 'server_error';
  return 'unreachable';
}

/**
 * 下载产物并校验完整性。
 *
 * 边下边算摘要，而不是下完再读一遍文件：几百兆的包读两次是无谓的 I/O。
 */
export async function fetchArtifact(options: FetchArtifactOptions): Promise<void> {
  const { url, destination, expectedSize, expectedSha256 } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? ((): void => {});

  await mkdir(dirname(destination), { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs);
  // 外层的取消（任务超时、用户取消）要能传导进来。
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    log(`下载产物：${url}`);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ArtifactFetchError('timeout', url, `下载超时或被取消：${url}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ArtifactFetchError('unreachable', url, `无法连接产物地址：${message}（${url}）`);
    }

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      const hint =
        kind === 'forbidden'
          ? '可能是签名 URL 已过期或存储未开放公开读'
          : kind === 'unreachable'
            ? '产物可能已被清理，重试同一地址不会成功'
            : '对方服务异常，稍后重试可能成功';
      throw new ArtifactFetchError(
        kind,
        url,
        `产物地址返回 HTTP ${response.status}：${hint}（${url}）`,
      );
    }

    if (response.body === null) {
      throw new ArtifactFetchError('unreachable', url, `产物响应没有内容（${url}）`);
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });

    try {
      await pipeline(source, createWriteStream(destination));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ArtifactFetchError('timeout', url, `下载中断：超时或被取消（${url}）`);
      }
      throw error;
    }

    if (bytes !== expectedSize) {
      throw new ArtifactFetchError(
        'integrity',
        url,
        `产物大小不符：上报 ${expectedSize} 字节，实际下载 ${bytes} 字节`,
      );
    }

    const actualSha = hash.digest('hex');
    if (actualSha !== expectedSha256.toLowerCase()) {
      throw new ArtifactFetchError(
        'integrity',
        url,
        `产物 sha256 不符：上报 ${expectedSha256}，实际 ${actualSha}。` +
          '不会把它交给平台 CLI',
      );
    }

    log(`校验通过：${bytes} 字节，sha256 ${actualSha}`);
  } catch (error) {
    // 校验失败或下载中断时删掉半截文件，避免下次误用
    await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** 文件是否存在且非空。 */
export async function isUsableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
