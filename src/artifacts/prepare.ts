/**
 * 把一个构建的产物准备成「插件可以直接用的目录」。
 *
 * 顺序是刻意的：下载 → 校验 → 解压。先校验再解压，这样一个摘要不符的包
 * 根本不会被展开到磁盘上。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchArtifact } from './fetch.js';
import { unzip } from './unzip.js';

export interface PrepareArtifactOptions {
  readonly url: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  /** 工作目录的父目录。缺省系统临时目录。 */
  readonly parentDir?: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

export interface PreparedArtifact {
  /** 本次任务的工作目录，包含下载的 zip 与解压结果。 */
  readonly workdir: string;
  /** 解压后的产物目录，交给插件的就是这个。 */
  readonly artifactDir: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  /** 清理整个工作目录。任务结束后必须调用。 */
  cleanup(): Promise<void>;
}

/**
 * 下载、校验并解压产物。
 *
 * 工作目录每次独立（mkdtemp）：并发两个任务时必须互不干扰，而且清理时
 * 可以整个删掉而不用担心删到别人的东西。
 */
export async function prepareArtifact(
  options: PrepareArtifactOptions,
): Promise<PreparedArtifact> {
  const parent = options.parentDir ?? tmpdir();
  const workdir = await mkdtemp(join(parent, 'mgc-artifact-'));
  const zipPath = join(workdir, 'artifact.zip');
  const artifactDir = join(workdir, 'extracted');

  const cleanup = async (): Promise<void> => {
    await rm(workdir, { recursive: true, force: true });
  };

  try {
    await fetchArtifact({
      url: options.url,
      destination: zipPath,
      expectedSize: options.expectedSize,
      expectedSha256: options.expectedSha256,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.log !== undefined && { log: options.log }),
    });

    const result = await unzip({
      zipPath,
      destination: artifactDir,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.log !== undefined && { log: options.log }),
    });

    return {
      workdir,
      artifactDir,
      entryCount: result.entryCount,
      totalBytes: result.totalBytes,
      cleanup,
    };
  } catch (error) {
    // 准备失败时立刻清理，不留半截目录占磁盘
    await cleanup();
    throw error;
  }
}
