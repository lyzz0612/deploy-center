/**
 * 游戏登记册（game-catalog spec）。
 *
 * slug 创建后不可改：它出现在构建上报、发布目标与产物路径里，改了之后
 * CI 那边会突然报「游戏不存在」，而且已有产物路径无从对应。显示名可以随便改。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

function now(): string {
  return new Date().toISOString();
}

/** slug 只允许小写字母、数字与连字符：它会进 URL 与文件路径。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface GameRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly created_at: string;
}

export interface Game {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAt: string;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export interface CreateGameInput {
  readonly slug: string;
  readonly displayName: string;
}

export function createGame(db: Db, input: CreateGameInput): Game {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      'slug 只能是小写字母、数字与连字符，以字母或数字开头，最长 63 个字符',
    );
  }
  if (input.displayName.trim().length === 0) {
    throw new Error('显示名不能为空');
  }

  const id = randomUUID();
  try {
    db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      input.slug,
      input.displayName,
      now(),
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new ConflictError(`slug「${input.slug}」已被占用`);
    }
    throw error;
  }
  return getGame(db, id);
}

export function getGame(db: Db, id: string): Game {
  const row = db.prepare<[string], GameRow>('SELECT * FROM games WHERE id = ?').get(id);
  if (row === undefined) {
    throw new NotFoundError(`游戏 ${id} 不存在`);
  }
  return toGame(row);
}

/** 按 slug 查。CI 上报用 slug 而不是 id，因为 CI 侧不该知道内部 id。 */
export function findGameBySlug(db: Db, slug: string): Game | undefined {
  const row = db.prepare<[string], GameRow>('SELECT * FROM games WHERE slug = ?').get(slug);
  return row === undefined ? undefined : toGame(row);
}

export function listGames(db: Db): Game[] {
  return db
    .prepare<[], GameRow>('SELECT * FROM games ORDER BY display_name')
    .all()
    .map(toGame);
}

/** 改显示名。slug 不在可改范围内——它不是笔误能改的东西。 */
export function renameGame(db: Db, id: string, displayName: string): Game {
  if (displayName.trim().length === 0) {
    throw new Error('显示名不能为空');
  }
  const result = db.prepare('UPDATE games SET display_name = ? WHERE id = ?').run(displayName, id);
  if (result.changes === 0) {
    throw new NotFoundError(`游戏 ${id} 不存在`);
  }
  return getGame(db, id);
}

/** 删游戏会连带删掉什么。界面在确认前要把这些数字摆给用户看。 */
export interface GameDeletionImpact {
  readonly builds: number;
  readonly targets: number;
  readonly releases: number;
}

/** 数一遍这个游戏名下的从属数据。只读，不改任何东西。 */
export function countGameDependents(db: Db, id: string): GameDeletionImpact {
  const one = (sql: string): number =>
    db.prepare<[string], { n: number }>(sql).get(id)?.n ?? 0;

  const releases =
    db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM releases
          WHERE target_id IN (SELECT id FROM targets WHERE game_id = ?)
             OR build_id  IN (SELECT id FROM builds  WHERE game_id = ?)`,
      )
      .get(id, id)?.n ?? 0;

  return {
    builds: one('SELECT COUNT(*) AS n FROM builds WHERE game_id = ?'),
    targets: one('SELECT COUNT(*) AS n FROM targets WHERE game_id = ?'),
    releases,
  };
}

/**
 * 删除游戏，连带删掉它名下的全部数据。
 *
 * 游戏是唯一走级联的实体：它底下挂着构建、目标与发布历史，而「有引用就
 * 拒绝」会让任何用过一次的游戏永远删不掉。所以这里是真的连带删除，
 * **不可恢复**——调用方必须先用 `countGameDependents` 让用户看清代价。
 *
 * 删除顺序是依赖倒序：发布阶段 → 发布记录 → 目标 → 构建 → 游戏。顺序错了
 * 会撞上外键。整体在一个事务里，中途失败什么都不会变。
 */
export function deleteGameCascade(db: Db, id: string): GameDeletionImpact {
  // 先确认存在，顺手拿到 slug 用于报错信息
  getGame(db, id);
  const impact = countGameDependents(db, id);

  db.transaction(() => {
    // 发布阶段靠 ON DELETE CASCADE 跟着发布记录走，但显式删一遍更稳：
    // 那条级联依赖 PRAGMA foreign_keys 开着。
    db.prepare(
      `DELETE FROM release_stages WHERE release_id IN (
         SELECT id FROM releases
          WHERE target_id IN (SELECT id FROM targets WHERE game_id = ?)
             OR build_id  IN (SELECT id FROM builds  WHERE game_id = ?)
       )`,
    ).run(id, id);

    db.prepare(
      `DELETE FROM releases
        WHERE target_id IN (SELECT id FROM targets WHERE game_id = ?)
           OR build_id  IN (SELECT id FROM builds  WHERE game_id = ?)`,
    ).run(id, id);

    db.prepare('DELETE FROM targets WHERE game_id = ?').run(id);
    db.prepare('DELETE FROM builds WHERE game_id = ?').run(id);
    db.prepare('DELETE FROM games WHERE id = ?').run(id);
  })();

  return impact;
}

/**
 * 取一个可接受上报的游戏，否则报错。
 *
 * 上报与发布都要先过这一关。现在只有「不存在」一种失败：游戏没有停用态，
 * 不想要了就删掉。
 */
export function requireActiveGame(db: Db, slug: string): Game {
  const game = findGameBySlug(db, slug);
  if (game === undefined) {
    throw new Error(`游戏「${slug}」未登记`);
  }
  return game;
}
