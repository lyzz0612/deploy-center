/**
 * 任务队列的读写（design.md D7：SQLite 队列 + 进程内单循环）。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { NotFoundError } from '../shared/errors.js';
import { assertTransition, type JobKind, type JobStatus } from './types.js';

function now(): string {
  return new Date().toISOString();
}

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly ref_id: string;
  readonly status: string;
  readonly attempts: number;
  readonly log: string;
  readonly error: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly refId: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly log: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    refId: row.ref_id,
    status: row.status as JobStatus,
    attempts: row.attempts,
    log: row.log,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function enqueue(db: Db, kind: JobKind, refId: string): Job {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, kind, ref_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)`,
  ).run(id, kind, refId, now());
  return getJob(db, id);
}

export function getJob(db: Db, id: string): Job {
  const row = db.prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?').get(id);
  if (row === undefined) {
    throw new NotFoundError(`任务 ${id} 不存在`);
  }
  return toJob(row);
}

export interface ListJobsOptions {
  readonly status?: JobStatus;
  readonly kind?: JobKind;
  readonly refId?: string;
  readonly limit?: number;
}

export function listJobs(db: Db, options: ListJobsOptions = {}): Job[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.status !== undefined) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options.kind !== undefined) {
    conditions.push('kind = ?');
    params.push(options.kind);
  }
  if (options.refId !== undefined) {
    conditions.push('ref_id = ?');
    params.push(options.refId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit ?? 100);

  return db
    .prepare<Array<string | number>, JobRow>(
      `SELECT * FROM jobs ${where} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...params)
    .map(toJob);
}

/**
 * 取下一个待执行任务并原子地标为 running。
 *
 * 用一条带条件的 UPDATE 而不是「先 SELECT 再 UPDATE」：后者在两个循环
 * 同时跑时会把同一个任务领两次。当前只有单循环，但这个写法的成本是零，
 * 而将来真要加并发时，漏掉它会表现为「同一次发布执行了两遍」。
 */
export function claimNext(db: Db): Job | undefined {
  const row = db
    .prepare<[string], JobRow>(
      `UPDATE jobs
          SET status = 'running', started_at = ?, attempts = attempts + 1
        WHERE seq = (
          SELECT seq FROM jobs WHERE status = 'queued' ORDER BY seq LIMIT 1
        )
        RETURNING *`,
    )
    .get(now());
  return row === undefined ? undefined : toJob(row);
}

/** 追加日志。任务执行中持续调用，所以用追加而不是整体替换。 */
export function appendLog(db: Db, id: string, line: string): void {
  db.prepare('UPDATE jobs SET log = log || ? WHERE id = ?').run(`${line}\n`, id);
}

/**
 * 结束任务。状态转移非法时抛错。
 *
 * 错误信息单独存一列而不是只塞进日志：界面要在列表里显示失败原因，
 * 从几千行日志里捞最后一段不可靠。
 */
export function finish(db: Db, id: string, status: JobStatus, error?: string): Job {
  const current = getJob(db, id);
  assertTransition(current.status, status);
  db.prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(
    status,
    error ?? null,
    now(),
    id,
  );
  return getJob(db, id);
}

/** 取消一个还没开始的任务。 */
export function cancel(db: Db, id: string): Job {
  return finish(db, id, 'cancelled', '被用户取消');
}

/**
 * 启动时的中断恢复。
 *
 * 进程被杀时留下的 running 任务没有任何人在推进它，必须标记为失败而不是
 * 留在原地——否则它会永远显示「执行中」，而且会挡住用户重试。
 *
 * 刻意**不自动重跑**：中断点未知，重跑可能产生重复的平台上传。要不要重试
 * 由人决定（release-execution spec：重试只重试失败阶段）。
 */
export function recoverInterrupted(db: Db): Job[] {
  const stale = db.prepare<[], JobRow>("SELECT * FROM jobs WHERE status = 'running'").all();
  const stamp = now();
  for (const row of stale) {
    db.prepare(
      `UPDATE jobs
          SET status = 'failed', error = ?, finished_at = ?,
              log = log || ?
        WHERE id = ?`,
    ).run(
      '进程中断，任务未完成',
      stamp,
      '[恢复] 进程在该任务执行中退出，已标记为失败。请确认平台侧状态后再决定是否重试。\n',
      row.id,
    );
  }
  // 返回被恢复的任务而不只是个数：任务之外的记录（发布记录与它的阶段）
  // 也停在 running，调用方要据此一并收拾，否则界面上那条发布会永远
  // 显示「执行中」，连重试入口都不出现。
  return stale.map(toJob);
}
