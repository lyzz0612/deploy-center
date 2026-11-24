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
  readonly archived_at: string | null;
}

export interface Game {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
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

export interface ListGamesOptions {
  readonly includeArchived?: boolean;
}

export function listGames(db: Db, options: ListGamesOptions = {}): Game[] {
  const where = options.includeArchived === true ? '' : 'WHERE archived_at IS NULL';
  return db
    .prepare<[], GameRow>(`SELECT * FROM games ${where} ORDER BY display_name`)
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

/**
 * 归档游戏：不再接受新的构建上报与发布，历史记录保持可读。
 *
 * 游戏不走 db/references.ts 的引用保护：那套机制管的是「删除」，而游戏
 * 没有删除入口——它底下挂着构建、目标与发布历史，归档是唯一合理的终态。
 */
export function archiveGame(db: Db, id: string): Game {
  const result = db
    .prepare('UPDATE games SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
    .run(now(), id);
  if (result.changes === 0) {
    throw new Error(`游戏 ${id} 不存在或已归档`);
  }
  return getGame(db, id);
}

export function unarchiveGame(db: Db, id: string): Game {
  const result = db
    .prepare('UPDATE games SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
    .run(id);
  if (result.changes === 0) {
    throw new Error(`游戏 ${id} 不存在或未归档`);
  }
  return getGame(db, id);
}

/**
 * 取一个可接受上报的游戏，否则报错。
 *
 * 上报与发布都要先过这一关：归档的游戏不该再进新数据，而「游戏不存在」
 * 与「游戏已归档」对 CI 来说是两种不同的处置，错误信息要能区分。
 */
export function requireActiveGame(db: Db, slug: string): Game {
  const game = findGameBySlug(db, slug);
  if (game === undefined) {
    throw new Error(`游戏「${slug}」未登记`);
  }
  if (game.archivedAt !== null) {
    throw new Error(`游戏「${slug}」已归档，不再接受新的构建上报`);
  }
  return game;
}
