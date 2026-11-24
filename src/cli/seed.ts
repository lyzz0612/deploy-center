/**
 * 首次启动预置安装（cli-management spec：首次启动预置）。
 *
 * 镜像不预装 CLI（那样升级要重建镜像），但带一份清单，在 CLI 卷为空时
 * 自动按清单装一遍。这是「预装」与「纯动态安装」之间性价比最高的折中：
 * `docker compose up` 开箱可用，同时保住了界面内升级的能力。
 */
import type { Db } from '../db/index.js';
import { enqueue, listJobs } from '../jobs/index.js';
import { listCliSpecs } from '../registry/index.js';
import { currentPrefix } from './install.js';

export interface SeedResult {
  /** 已投递安装任务的 CLI id。 */
  readonly queued: readonly string[];
  /** 跳过的 CLI 及原因。 */
  readonly skipped: readonly { readonly cliId: string; readonly reason: string }[];
}

/**
 * 检查哪些 CLI 还没装，为它们投递安装任务。
 *
 * 投递任务而不是在启动时同步安装：`npm i` 是分钟级操作，同步装会让容器
 * 迟迟不就绪，健康检查会判它失败然后反复重启。
 *
 * 已投递过且仍在队列/执行中的不重复投递，避免反复重启堆出一串同样的任务。
 */
export async function seedClis(db: Db, cliHome: string): Promise<SeedResult> {
  const queued: string[] = [];
  const skipped: { cliId: string; reason: string }[] = [];

  for (const spec of listCliSpecs()) {
    if (spec.kind === 'manual') {
      skipped.push({ cliId: spec.id, reason: '需要人工安装' });
      continue;
    }
    if (spec.defaultVersion === undefined) {
      skipped.push({ cliId: spec.id, reason: '没有默认版本' });
      continue;
    }

    const installed = await currentPrefix(cliHome, spec.id);
    if (installed !== undefined) {
      skipped.push({ cliId: spec.id, reason: `已安装 ${installed.version}` });
      continue;
    }

    const pending = [
      ...listJobs(db, { kind: 'cli_install', refId: spec.id, status: 'queued' }),
      ...listJobs(db, { kind: 'cli_install', refId: spec.id, status: 'running' }),
    ];
    if (pending.length > 0) {
      skipped.push({ cliId: spec.id, reason: '已有待执行的安装任务' });
      continue;
    }

    enqueue(db, 'cli_install', spec.id);
    queued.push(spec.id);
  }

  return { queued, skipped };
}
