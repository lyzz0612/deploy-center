/**
 * 构建列表视图（build-ingestion spec：构建视图）。
 *
 * 主视角是「按 commit 聚合」而不是「按包类型筛选」：一次构建通常产出三个包，
 * 用户真正想知道的是「这次构建发完了没有」，逐个平台翻列表回答不了这个问题。
 * 筛选仍然保留，只是退为次要动作。
 */
import type { Db } from '../db/index.js';

/** 一个包在某个发布目标上的最新发布状态。 */
export interface TargetStatus {
  readonly targetId: string;
  readonly targetName: string;
  readonly targetKind: string;
  readonly releaseId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** 列表里的一个包。 */
export interface BuildListItem {
  readonly id: string;
  readonly packageTypeId: string;
  readonly packageTypeName: string;
  readonly buildId: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly description: string | null;
  readonly reportedAt: string;
  /** 各发布目标上的最新状态。空数组表示从未发布过。 */
  readonly targets: readonly TargetStatus[];
}

/** 聚合后的一行：同一次构建产出的若干个包。 */
export interface BuildGroup {
  /**
   * 聚合键。有 commit 时是 `commit:<sha>`，没有时是 `build:<id>`。
   *
   * 为什么没有 commit 的包不互相聚合：null 不代表「同一次构建」，把它们
   * 并成一行会把无关的包凑在一起，比不聚合更误导。
   */
  readonly key: string;
  readonly commitSha: string | null;
  /** 组内最近一次上报时间，用于排序。 */
  readonly reportedAt: string;
  /** 组内第一个有描述的包的描述，作为这次构建的说明。 */
  readonly description: string | null;
  readonly builds: readonly BuildListItem[];
}

export interface ListBuildsOptions {
  /** 按游戏 id 筛选。 */
  readonly gameId?: string;
  /** 按包类型筛选（次要动作）。 */
  readonly packageTypeId?: string;
  /** 返回多少组。缺省 50。 */
  readonly limit?: number;
}

interface BuildQueryRow {
  readonly id: string;
  readonly package_type_id: string;
  readonly package_type_name: string;
  readonly build_id: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly commit_sha: string | null;
  readonly description: string | null;
  readonly reported_at: string;
}

interface StatusQueryRow {
  readonly build_id: string;
  readonly target_id: string;
  readonly target_name: string;
  readonly target_kind: string;
  readonly release_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly finished_at: string | null;
}

/**
 * 查每个包在每个目标上的**最新**一条发布记录。
 *
 * 用窗口函数而不是在 JS 里过滤：同一个包在同一个目标上可能发过很多次
 * （重试、回滚），全部取回再筛是把分页的意义抵消掉。
 */
function loadLatestStatuses(db: Db, buildIds: readonly string[]): Map<string, TargetStatus[]> {
  const result = new Map<string, TargetStatus[]>();
  if (buildIds.length === 0) return result;

  const placeholders = buildIds.map(() => '?').join(', ');
  const rows = db
    .prepare<string[], StatusQueryRow>(
      `SELECT build_id, target_id, target_name, target_kind, release_id, status, created_at, finished_at
       FROM (
         SELECT r.build_id        AS build_id,
                r.target_id       AS target_id,
                t.name            AS target_name,
                t.kind            AS target_kind,
                r.id              AS release_id,
                r.status          AS status,
                r.created_at      AS created_at,
                r.finished_at     AS finished_at,
                ROW_NUMBER() OVER (
                  PARTITION BY r.build_id, r.target_id
                  ORDER BY r.created_at DESC, r.id DESC
                ) AS rn
         FROM releases r
         JOIN targets t ON t.id = r.target_id
         WHERE r.build_id IN (${placeholders})
       )
       WHERE rn = 1
       ORDER BY target_name`,
    )
    .all(...buildIds);

  for (const row of rows) {
    const list = result.get(row.build_id) ?? [];
    list.push({
      targetId: row.target_id,
      targetName: row.target_name,
      targetKind: row.target_kind,
      releaseId: row.release_id,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    });
    result.set(row.build_id, list);
  }
  return result;
}

/**
 * 列出构建，按 commit 聚合。
 *
 * 分页按「组」而不是按「包」：按包分页会把同一次构建的三个包切到两页上，
 * 那正好破坏了聚合想解决的问题。
 */
export function listBuilds(db: Db, options: ListBuildsOptions = {}): BuildGroup[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (options.gameId !== undefined) {
    conditions.push('b.game_id = ?');
    params.push(options.gameId);
  }
  if (options.packageTypeId !== undefined) {
    conditions.push('b.package_type_id = ?');
    params.push(options.packageTypeId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare<Array<string | number>, BuildQueryRow>(
      `SELECT b.id, b.package_type_id, p.display_name AS package_type_name, b.build_id,
              b.size_bytes, b.sha256, b.commit_sha, b.description, b.reported_at
       FROM builds b
       JOIN package_types p ON p.id = b.package_type_id
       ${where}
       ORDER BY b.reported_at DESC, b.id DESC`,
    )
    .all(...params);

  const statuses = loadLatestStatuses(
    db,
    rows.map((r) => r.id),
  );

  interface MutableGroup {
    key: string;
    commitSha: string | null;
    reportedAt: string;
    description: string | null;
    builds: BuildListItem[];
  }

  const groups = new Map<string, MutableGroup>();
  for (const row of rows) {
    const key = row.commit_sha === null ? `build:${row.id}` : `commit:${row.commit_sha}`;
    const item: BuildListItem = {
      id: row.id,
      packageTypeId: row.package_type_id,
      packageTypeName: row.package_type_name,
      buildId: row.build_id,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      description: row.description,
      reportedAt: row.reported_at,
      targets: statuses.get(row.id) ?? [],
    };

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        commitSha: row.commit_sha,
        reportedAt: row.reported_at,
        description: row.description,
        builds: [item],
      });
    } else {
      existing.builds.push(item);
      // rows 已按 reported_at 降序，组的时间取第一条即最新；描述取第一个非空。
      existing.description ??= row.description;
    }
  }

  const limit = options.limit ?? 50;
  return [...groups.values()].slice(0, limit).map((group) => ({
    key: group.key,
    commitSha: group.commitSha,
    reportedAt: group.reportedAt,
    description: group.description,
    builds: [...group.builds].sort((a, b) => a.packageTypeId.localeCompare(b.packageTypeId)),
  }));
}
