/**
 * 构建记录的读写。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { NotFoundError } from '../shared/errors.js';
import type { ResolvedReport } from './ingest.js';

function now(): string {
  return new Date().toISOString();
}

interface BuildRow {
  readonly id: string;
  readonly game_id: string;
  readonly package_type_id: string;
  readonly build_id: string;
  readonly artifact_url: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly commit_sha: string | null;
  readonly description: string | null;
  readonly reported_at: string;
  readonly ci_key_id: string | null;
}

export interface Build {
  readonly id: string;
  readonly gameId: string;
  readonly packageTypeId: string;
  readonly buildId: string;
  readonly artifactUrl: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly commitSha: string | null;
  readonly description: string | null;
  readonly reportedAt: string;
}

function toBuild(row: BuildRow): Build {
  return {
    id: row.id,
    gameId: row.game_id,
    packageTypeId: row.package_type_id,
    buildId: row.build_id,
    artifactUrl: row.artifact_url,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    commitSha: row.commit_sha,
    description: row.description,
    reportedAt: row.reported_at,
  };
}

export interface UpsertResult {
  readonly build: Build;
  /** true 表示新建，false 表示更新了既有记录。 */
  readonly created: boolean;
}

/**
 * 登记一次上报，按 `(game, packageType, buildId)` 幂等。
 *
 * 为什么允许覆盖 URL 与摘要：构建记录的「不可变」指的是它代表哪一次构建
 * 不会变，也就是那三个字段组成的身份；产物本身是可以变的。CI 重跑同一个
 * 标识时产出的是新产物，URL、大小、摘要都可能不同。若拒绝覆盖，用户就只能
 * 换一个 buildId，那会在列表里留下一堆语义重复的条目。
 *
 * 覆盖时重置 `reported_at`：它记录的是「这条产物信息什么时候来的」，
 * 而不是「这个构建标识第一次出现在什么时候」。
 */
export function upsertBuild(db: Db, resolved: ResolvedReport, ciKeyId: string | null): UpsertResult {
  const { report, game, packageType } = resolved;

  const existing = db
    .prepare<[string, string, string], BuildRow>(
      'SELECT * FROM builds WHERE game_id = ? AND package_type_id = ? AND build_id = ?',
    )
    .get(game.id, packageType.id, report.buildId);

  if (existing !== undefined) {
    db.prepare(
      `UPDATE builds
         SET artifact_url = ?, size_bytes = ?, sha256 = ?, commit_sha = ?,
             description = ?, reported_at = ?, ci_key_id = ?
       WHERE id = ?`,
    ).run(
      report.artifactUrl,
      report.sizeBytes,
      report.sha256,
      report.commitSha ?? null,
      report.description ?? null,
      now(),
      ciKeyId,
      existing.id,
    );
    return { build: getBuild(db, existing.id), created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url,
                         size_bytes, sha256, commit_sha, description, reported_at, ci_key_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    game.id,
    packageType.id,
    report.buildId,
    report.artifactUrl,
    report.sizeBytes,
    report.sha256,
    report.commitSha ?? null,
    report.description ?? null,
    now(),
    ciKeyId,
  );
  return { build: getBuild(db, id), created: true };
}

export function getBuild(db: Db, id: string): Build {
  const row = db.prepare<[string], BuildRow>('SELECT * FROM builds WHERE id = ?').get(id);
  if (row === undefined) {
    throw new NotFoundError(`构建 ${id} 不存在`);
  }
  return toBuild(row);
}
