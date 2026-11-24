/**
 * 发布执行：按插件声明的阶段顺序执行，逐阶段记录（release-execution spec）。
 */
import { prepareArtifact } from '../artifacts/index.js';
import { getBuild } from '../builds/index.js';
import { readSecrets } from '../credentials/index.js';
import type { Db } from '../db/index.js';
import type { JobContext } from '../jobs/index.js';
import { getTargetKind, type StageResult, type TargetKind } from '../registry/index.js';
import { getTarget } from '../targets/index.js';
import { createContext } from './context.js';
import {
  appendStageLog,
  finishStage,
  getRelease,
  setReleaseStatus,
  startStage,
  type Release,
  type StageStatus,
} from './store.js';

export interface ExecuteDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
  /** 工作目录的父目录。缺省系统临时目录。 */
  readonly workParentDir?: string;
}

/** 本次要执行哪些阶段：attempt 最大且未成功的那些。 */
function pendingStages(release: Release): Release['stages'] {
  return release.stages.filter((s) => s.status !== 'success');
}

/**
 * 执行一次发布。
 *
 * 失败时**不抛出**，而是把状态写进记录后正常返回：任务层的失败与发布层的
 * 失败是两件事，混在一起会让「任务成功但发布失败」这种情况无法表达。
 * 只有基础设施问题（取不到构建、插件没注册）才抛，那属于任务失败。
 */
export async function executeRelease(deps: ExecuteDeps, job: JobContext): Promise<void> {
  const { db, masterKey, cliHome } = deps;
  const releaseId = job.job.refId;

  const release = getRelease(db, releaseId);
  const build = getBuild(db, release.buildId);
  const target = getTarget(db, release.targetId);
  const kind: TargetKind = getTargetKind(target.kind);

  setReleaseStatus(db, releaseId, 'running');
  job.log(`发布 ${build.buildId} → ${target.name}（${kind.manifest.displayName}）`);

  const todo = pendingStages(release);
  if (todo.length === 0) {
    job.log('所有阶段都已成功，无需执行');
    setReleaseStatus(db, releaseId, 'success');
    return;
  }

  const secrets =
    target.credentialId === null ? {} : readSecrets(db, target.credentialId, masterKey);

  let prepared: Awaited<ReturnType<typeof prepareArtifact>> | undefined;
  let managed: Awaited<ReturnType<typeof createContext>> | undefined;

  try {
    prepared = await prepareArtifact({
      url: build.artifactUrl,
      expectedSize: build.sizeBytes,
      expectedSha256: build.sha256,
      ...(deps.workParentDir !== undefined && { parentDir: deps.workParentDir }),
      signal: job.signal,
      log: (line) => job.log(line),
    });

    managed = await createContext({
      artifactDir: prepared.artifactDir,
      workdir: prepared.workdir,
      target: target.location,
      params: release.params,
      cliHome,
      secrets,
      log: (line) => {
        job.log(line);
      },
      progress: () => {},
      signal: job.signal,
    });

    const outputs: Record<string, string> = {};
    let failed = false;

    for (const stage of todo) {
      const declared = kind.manifest.stages.find((s) => s.id === stage.stageId);
      const stageName = declared?.name ?? stage.stageId;

      if (failed) {
        // 前序阶段失败时后续阶段不执行（release-execution spec）
        finishStage(db, releaseId, stage.stageId, stage.attempt, 'skipped');
        appendStageLog(db, releaseId, stage.stageId, stage.attempt, '前序阶段失败，本阶段未执行');
        continue;
      }

      startStage(db, releaseId, stage.stageId, stage.attempt);
      job.log(`[${stageName}] 开始`);

      const stageLog = (line: string): void => {
        appendStageLog(db, releaseId, stage.stageId, stage.attempt, line);
        job.log(`[${stageName}] ${line}`);
      };

      // 把日志重定向到当前阶段，这样界面能逐阶段展开查看
      const stageCtx = { ...managed.ctx, log: stageLog };

      try {
        const timeoutMs = declared?.timeoutMs;
        const result = await runWithTimeout(
          () => kind.execute(stage.stageId, stageCtx),
          timeoutMs,
          job.signal,
        );
        Object.assign(outputs, result.outputs ?? {});
        finishStage(db, releaseId, stage.stageId, stage.attempt, 'success');
        job.log(`[${stageName}] 成功`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status: StageStatus = /超时/.test(message) ? 'timeout' : 'failed';
        stageLog(`失败：${message}`);
        finishStage(db, releaseId, stage.stageId, stage.attempt, status);
        failed = true;
      }
    }

    if (failed) {
      // 阶段超时要让整条记录也是 timeout，而不是笼统的 failed：两者的
      // 下一步不同（超时要先确认平台侧是否已生效）。
      const hasTimeout = getRelease(db, releaseId).stages.some((s) => s.status === 'timeout');
      setReleaseStatus(db, releaseId, hasTimeout ? 'timeout' : 'failed');
      return;
    }

    // 结果验证：声明支持时必须执行，不通过则不进入成功状态
    if (kind.manifest.capabilities.verify && kind.verify !== undefined) {
      job.log('验证发布结果');
      const verified = await kind.verify(managed.ctx);
      job.log(`验证：${verified.message}`);
      if (!verified.ok) {
        setReleaseStatus(db, releaseId, 'failed');
        return;
      }
    }

    if (Object.keys(outputs).length > 0) {
      job.log(`平台回执：${JSON.stringify(outputs)}`);
    }
    setReleaseStatus(db, releaseId, 'success');
  } finally {
    // 凭据文件先单独删一遍：整个工作目录的删除可能因文件被占用而失败，
    // 而密钥文件必须确保消失。
    if (managed !== undefined) {
      await managed.cleanupSecrets();
    }
    if (prepared !== undefined) {
      await prepared.cleanup();
    }
  }
}

/**
 * 给单个阶段加超时。
 *
 * 用竞速而不是只依赖外层任务超时：阶段各自声明了自己的超时时间，
 * 一个卡住的上传不该拖到整个任务超时才被发现。
 */
async function runWithTimeout(
  run: () => Promise<StageResult>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<StageResult> {
  if (timeoutMs === undefined) return run();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`阶段超时（${timeoutMs} 毫秒）`)), timeoutMs);
        signal.addEventListener('abort', () => reject(new Error('阶段被取消')), { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
