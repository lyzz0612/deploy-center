/**
 * 发布记录的读写（release-execution spec）。
 *
 * 阶段记录按 `(release, stage, attempt)` 存，所以重试天然留痕而不是覆盖
 * 上一次——「当前状态」是每个阶段 attempt 最大的那一行。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { assertTransition, type JobStatus } from '../jobs/index.js';
import { NotFoundError } from '../shared/errors.js';

function now(): string {
  return new Date().toISOString();
}

/** 阶段状态。比任务状态多一个 skipped：前序阶段失败时后续阶段不执行。 */
export type StageStatus = JobStatus | 'skipped';

interface ReleaseRow {
  readonly id: string;
  readonly build_id: string;
  readonly target_id: string;
  readonly params: string;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface StageRow {
  readonly id: string;
  readonly release_id: string;
  readonly stage_id: string;
  readonly seq: number;
  readonly attempt: number;
  readonly status: string;
  readonly log: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface StageRecord {
  readonly id: string;
  readonly stageId: string;
  readonly seq: number;
  readonly attempt: number;
  readonly status: StageStatus;
  readonly log: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface Release {
  readonly id: string;
  readonly buildId: string;
  readonly targetId: string;
  readonly params: Record<string, unknown>;
  readonly status: JobStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** 每个阶段的最新一次尝试，按 seq 排序。 */
  readonly stages: readonly StageRecord[];
}

function toStage(row: StageRow): StageRecord {
  return {
    id: row.id,
    stageId: row.stage_id,
    seq: row.seq,
    attempt: row.attempt,
    status: row.status as StageStatus,
    log: row.log,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** 取每个阶段 attempt 最大的那一行，即「当前状态」。 */
function loadCurrentStages(db: Db, releaseId: string): StageRecord[] {
  return db
    .prepare<[string], StageRow>(
      `SELECT * FROM release_stages
        WHERE release_id = ?
          AND attempt = (
            SELECT MAX(attempt) FROM release_stages s2
             WHERE s2.release_id = release_stages.release_id
               AND s2.stage_id = release_stages.stage_id
          )
        ORDER BY seq`,
    )
    .all(releaseId)
    .map(toStage);
}

function toRelease(db: Db, row: ReleaseRow): Release {
  return {
    id: row.id,
    buildId: row.build_id,
    targetId: row.target_id,
    params: JSON.parse(row.params) as Record<string, unknown>,
    status: row.status as JobStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    stages: loadCurrentStages(db, row.id),
  };
}

/**
 * 回滚专用的阶段 id。
 *
 * 回滚不是「再跑一遍发布阶段」：h5 的 activate 阶段会切到**当前**版本，
 * 用它做回滚等于什么都没做。所以回滚是一条独立的发布记录，只有这一个
 * 阶段，由核心调插件的 rollback() 而不是 execute()。
 */
export const ROLLBACK_STAGE_ID = '__rollback__';

export interface CreateReleaseInput {
  readonly buildId: string;
  readonly targetId: string;
  readonly params: Record<string, unknown>;
  /** 声明的阶段，按顺序。回滚时传 `[ROLLBACK_STAGE_ID]`。 */
  readonly stageIds: readonly string[];
  readonly createdBy?: string;
}

/**
 * 建一条发布记录，并为每个阶段建 attempt=1 的 queued 行。
 *
 * 一开始就把所有阶段建出来，而不是执行到哪个建哪个：界面要在任务刚排队时
 * 就显示「将要执行哪几步」，否则用户看到的是一个空壳在转。
 */
export function createRelease(db: Db, input: CreateReleaseInput): Release {
  if (input.stageIds.length === 0) {
    throw new Error('发布至少需要一个阶段');
  }

  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO releases (id, build_id, target_id, params, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      id,
      input.buildId,
      input.targetId,
      JSON.stringify(input.params),
      input.createdBy ?? 'owner',
      now(),
    );

    const insertStage = db.prepare(
      `INSERT INTO release_stages (id, release_id, stage_id, seq, attempt, status)
       VALUES (?, ?, ?, ?, 1, 'queued')`,
    );
    input.stageIds.forEach((stageId, index) => {
      insertStage.run(randomUUID(), id, stageId, index);
    });
  })();

  return getRelease(db, id);
}

export function getRelease(db: Db, id: string): Release {
  const row = db.prepare<[string], ReleaseRow>('SELECT * FROM releases WHERE id = ?').get(id);
  if (row === undefined) {
    throw new NotFoundError(`发布记录 ${id} 不存在`);
  }
  return toRelease(db, row);
}

export interface ListReleasesOptions {
  readonly targetId?: string;
  readonly buildId?: string;
  readonly limit?: number;
}

export function listReleases(db: Db, options: ListReleasesOptions = {}): Release[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.targetId !== undefined) {
    conditions.push('target_id = ?');
    params.push(options.targetId);
  }
  if (options.buildId !== undefined) {
    conditions.push('build_id = ?');
    params.push(options.buildId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit ?? 50);

  return db
    .prepare<Array<string | number>, ReleaseRow>(
      `SELECT * FROM releases ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toRelease(db, row));
}

/* -------------------------------- 阶段状态 -------------------------------- */

export function startStage(db: Db, releaseId: string, stageId: string, attempt: number): void {
  db.prepare(
    `UPDATE release_stages SET status = 'running', started_at = ?
      WHERE release_id = ? AND stage_id = ? AND attempt = ?`,
  ).run(now(), releaseId, stageId, attempt);
}

export function appendStageLog(
  db: Db,
  releaseId: string,
  stageId: string,
  attempt: number,
  line: string,
): void {
  db.prepare(
    `UPDATE release_stages SET log = log || ?
      WHERE release_id = ? AND stage_id = ? AND attempt = ?`,
  ).run(`${line}\n`, releaseId, stageId, attempt);
}

export function finishStage(
  db: Db,
  releaseId: string,
  stageId: string,
  attempt: number,
  status: StageStatus,
): void {
  db.prepare(
    `UPDATE release_stages SET status = ?, finished_at = ?
      WHERE release_id = ? AND stage_id = ? AND attempt = ?`,
  ).run(status, now(), releaseId, stageId, attempt);
}

export function setReleaseStatus(db: Db, id: string, status: JobStatus): Release {
  const current = getRelease(db, id);
  assertTransition(current.status, status);
  const finishedAt = status === 'running' ? null : now();
  db.prepare('UPDATE releases SET status = ?, finished_at = ? WHERE id = ?').run(
    status,
    finishedAt,
    id,
  );
  return getRelease(db, id);
}

/**
 * 为重试准备：给第一个未成功的阶段及其后的所有阶段建新 attempt。
 *
 * 已成功的阶段不重建（release-execution spec：重试 MUST 从第一个未成功的
 * 阶段继续，已成功的阶段 MUST NOT 重新执行）。
 *
 * 后续阶段也要重建，因为前一阶段重跑后它们的输入可能变了，沿用上次的
 * skipped 行会让它们永远不执行。
 */
export function prepareRetry(db: Db, releaseId: string): { fromStageId: string } {
  const release = getRelease(db, releaseId);
  const firstUnfinished = release.stages.find((s) => s.status !== 'success');
  if (firstUnfinished === undefined) {
    throw new Error('所有阶段都已成功，无需重试');
  }

  const toRetry = release.stages.filter((s) => s.seq >= firstUnfinished.seq);
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO release_stages (id, release_id, stage_id, seq, attempt, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
    );
    for (const stage of toRetry) {
      insert.run(randomUUID(), releaseId, stage.stageId, stage.seq, stage.attempt + 1);
    }
    db.prepare("UPDATE releases SET status = 'queued', finished_at = NULL WHERE id = ?").run(
      releaseId,
    );
  })();

  return { fromStageId: firstUnfinished.stageId };
}

/** 已结束的状态。只有这些状态的发布记录可以删。 */
const FINISHED_STATUSES: readonly JobStatus[] = ['success', 'failed', 'timeout', 'cancelled'];

/**
 * 删除一条发布记录及其阶段历史。
 *
 * 只允许删已结束的：`queued` 还在队列里等着被执行器取走，`running` 正在
 * 跑——删掉它们会让执行器写回一条已经不存在的记录，而那个失败会出现在
 * 离原因很远的地方。想删正在跑的，先取消它。
 *
 * 删掉最后一条引用某目标的记录后，那个目标就变成「无引用」、于是可删。
 * 这是刻意的连锁：清掉历史是让目标可删的前置动作。
 */
export function deleteRelease(db: Db, id: string): void {
  const release = getRelease(db, id);
  if (!FINISHED_STATUSES.includes(release.status)) {
    throw new Error(
      `发布记录处于 ${release.status} 状态，不能删除。请先等它结束或取消它`,
    );
  }

  db.transaction(() => {
    // 阶段表有 ON DELETE CASCADE，但显式删一遍不依赖 PRAGMA foreign_keys
    db.prepare('DELETE FROM release_stages WHERE release_id = ?').run(id);
    db.prepare('DELETE FROM releases WHERE id = ?').run(id);
  })();
}

/**
 * 清掉某个目标名下的全部**已结束**发布记录，返回删了几条。
 *
 * 用途是「这个目标不要了」：逐条删几十条历史不现实，而未结束的记录保持
 * 不动——它们还在被执行器用着。所以这个函数清完之后目标仍可能有引用，
 * 调用方不该假设它一定能删掉了。
 */
export function deleteReleasesByTarget(db: Db, targetId: string): number {
  const placeholders = FINISHED_STATUSES.map(() => '?').join(', ');
  let deleted = 0;

  db.transaction(() => {
    const doomed = db
      .prepare<string[], { id: string }>(
        `SELECT id FROM releases WHERE target_id = ? AND status IN (${placeholders})`,
      )
      .all(targetId, ...FINISHED_STATUSES)
      .map((r) => r.id);

    if (doomed.length === 0) return;
    const ids = doomed.map(() => '?').join(', ');
    db.prepare(`DELETE FROM release_stages WHERE release_id IN (${ids})`).run(...doomed);
    db.prepare(`DELETE FROM releases WHERE id IN (${ids})`).run(...doomed);
    deleted = doomed.length;
  })();

  return deleted;
}

/** 取某个阶段的全部尝试历史，用于界面展开查看。 */
export function listStageAttempts(db: Db, releaseId: string, stageId: string): StageRecord[] {
  return db
    .prepare<[string, string], StageRow>(
      `SELECT * FROM release_stages WHERE release_id = ? AND stage_id = ? ORDER BY attempt`,
    )
    .all(releaseId, stageId)
    .map(toStage);
}
