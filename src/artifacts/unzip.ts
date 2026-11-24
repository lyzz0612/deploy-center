/**
 * 产物解压。
 *
 * 产物来自外部 URL，是**不可信输入**，所以这里的路径检查不是防御性编程，
 * 是必需的：一个构造过的 zip 能用 `../../` 条目把文件写到工作目录之外
 * （zip slip）。只要有一次把这种包解到容器里，攻击者就能覆盖任意可写路径。
 *
 * 用纯 JS 的 yauzl 而不是 spawn 系统 unzip：后者在 Windows 上不存在，
 * 而且把路径安全检查交给外部命令就失去了自己把控的能力。
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';

export class UnzipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnzipError';
  }
}

export interface UnzipOptions {
  readonly zipPath: string;
  readonly destination: string;
  /** 条目数上限，防 zip 炸弹。缺省 50000。 */
  readonly maxEntries?: number;
  /** 解压后总字节上限，防 zip 炸弹。缺省 2 GiB。 */
  readonly maxTotalBytes?: number;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

export interface UnzipResult {
  readonly entryCount: number;
  readonly totalBytes: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 把 zip 条目名解析成目标目录内的安全绝对路径。
 *
 * 四种必须拒绝的情况：
 *
 * 1. 绝对路径（`/etc/passwd`、`C:\Windows\...`）
 * 2. 跳出目标目录（`../../x`）
 * 3. Windows 盘符或 UNC 前缀
 * 4. 反斜杠分隔符——zip 规范要求用 `/`，出现 `\` 说明是非常规打包工具，
 *    而在 Windows 上 `a\..\..\b` 同样能跳出去
 */
export function resolveEntryPath(destination: string, entryName: string): string {
  if (entryName.includes('\0')) {
    throw new UnzipError(`压缩包条目名含空字节：${JSON.stringify(entryName)}`);
  }
  if (entryName.includes('\\')) {
    throw new UnzipError(`压缩包条目名含反斜杠（非法 zip 路径）：${entryName}`);
  }
  if (isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) {
    throw new UnzipError(`压缩包含绝对路径条目：${entryName}`);
  }

  const target = join(destination, normalize(entryName));
  const rel = relative(destination, target);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnzipError(`压缩包条目试图写到目标目录之外：${entryName}`);
  }
  return target;
}

export async function unzip(options: UnzipOptions): Promise<UnzipResult> {
  const { zipPath, destination } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const log = options.log ?? ((): void => {});

  await mkdir(destination, { recursive: true });

  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    // lazyEntries 让我们逐条处理，而不是一次把所有条目读进内存。
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) => {
      if (error !== null) {
        reject(new UnzipError(`打开压缩包失败：${error.message}`));
        return;
      }
      resolve(file);
    });
  });

  let entryCount = 0;
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      zip.close();
      reject(error);
    };

    const onAbort = (): void => fail(new UnzipError('解压被取消'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    zip.on('entry', (entry: yauzl.Entry) => {
      void (async (): Promise<void> => {
        try {
          if (options.signal?.aborted === true) {
            fail(new UnzipError('解压被取消'));
            return;
          }

          entryCount += 1;
          if (entryCount > maxEntries) {
            fail(new UnzipError(`压缩包条目数超过上限 ${maxEntries}`));
            return;
          }

          const targetPath = resolveEntryPath(destination, entry.fileName);

          // 以 / 结尾的是目录条目
          if (entry.fileName.endsWith('/')) {
            await mkdir(targetPath, { recursive: true });
            zip.readEntry();
            return;
          }

          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxTotalBytes) {
            fail(new UnzipError(`解压后总大小超过上限 ${maxTotalBytes} 字节`));
            return;
          }

          await mkdir(dirname(targetPath), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => {
            zip.openReadStream(entry, (error, readStream) => {
              if (error !== null) {
                rej(new UnzipError(`读取条目 ${entry.fileName} 失败：${error.message}`));
                return;
              }
              res(readStream);
            });
          });

          await pipeline(stream, createWriteStream(targetPath));
          zip.readEntry();
        } catch (error) {
          fail(error instanceof Error ? error : new UnzipError(String(error)));
        }
      })();
    });

    zip.on('end', () => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    });

    zip.on('error', (error: Error) => {
      options.signal?.removeEventListener('abort', onAbort);
      fail(new UnzipError(`解压失败：${error.message}`));
    });

    zip.readEntry();
  });

  log(`解压完成：${entryCount} 个条目，${totalBytes} 字节`);
  return { entryCount, totalBytes };
}
