/**
 * SQLite 连接与启动建表。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { DDL, EXPECTED_INDEXES, EXPECTED_TABLES, MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径。`:memory:` 用于测试。 */
  readonly file: string;
}

/** 从数据目录推导数据库文件路径。 */
export function databaseFile(dataDir: string): string {
  return join(dataDir, 'console.db');
}

/**
 * 打开数据库并应用连接级 PRAGMA。
 *
 * - `journal_mode = WAL`：读不阻塞写（design.md 风险一节）。内存库不支持
 *   WAL，SQLite 会回落到 `memory`，这是预期行为。
 * - `foreign_keys = ON`：SQLite 默认关闭外键约束。引用保护在 API 层做，
 *   但库层也不该允许写出悬空引用。
 * - `busy_timeout`：备份工具或 DB 浏览器短暂持锁时等待而非立即报错。
 */
export function open(options: OpenOptions): Db {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const db = new Database(options.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function readUserVersion(db: Db): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('读取 PRAGMA user_version 失败：没有返回任何行');
  }
  return row.user_version;
}

function listObjects(db: Db, type: 'table' | 'index'): Set<string> {
  const rows = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'",
    )
    .all(type);
  return new Set(rows.map((r) => r.name));
}

export interface EnsureSchemaResult {
  /** 本次调用前库里的结构版本，全新库为 0。 */
  readonly previousVersion: number;
  /** 本次调用后的结构版本。 */
  readonly version: number;
  /** 是否为全新库（调用前 user_version 为 0 且没有业务表）。 */
  readonly created: boolean;
}

/**
 * 按版本顺序执行升级语句。
 *
 * 只跑 fromVersion 之后、当前版本之前的步骤。
 *
 * 每一步声明了它依赖哪些表，缺任何一张就跳过：跨表的清理语句（v6 要按
 * releases 判断哪些 targets 还有引用）在半成品库里会撞上 `no such table`，
 * 而那时正确的行为是跳过——没有那张表就意味着没有要清理的数据，随后的
 * 统一 DDL 会把表按新结构建好。
 */
function applyMigrations(db: Db, fromVersion: number): void {
  const existing = listObjects(db, 'table');

  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion || migration.version > SCHEMA_VERSION) continue;
    for (const step of migration.statements) {
      if (!step.requires.every((table) => existing.has(table))) continue;
      db.exec(step.sql);
    }
  }
}

/**
 * 建表并核对结构。可重复调用，第二次为无变更。
 *
 * 为什么建完还要核对：`CREATE TABLE IF NOT EXISTS` 只保证「表存在就不动」，
 * 不保证表结构与当前代码一致。若 DDL 改过而库是旧的，它会静默跳过，于是
 * 运行时拿到旧结构的表。这里把这种不一致变成启动期的显式报错。
 */
export function ensureSchema(db: Db): EnsureSchemaResult {
  const previousVersion = readUserVersion(db);

  if (previousVersion > SCHEMA_VERSION) {
    throw new Error(
      `数据库结构版本为 ${previousVersion}，高于本程序支持的 ${SCHEMA_VERSION}。` +
        '这通常意味着用旧版程序打开了新版数据库，拒绝继续以免写坏数据。',
    );
  }

  const tablesBefore = listObjects(db, 'table');
  const created = previousVersion === 0 && !EXPECTED_TABLES.some((t) => tablesBefore.has(t));

  db.transaction(() => {
    // 老库先补列/补表，再跑一遍统一 DDL（新库直接走后者）。
    if (previousVersion !== 0) applyMigrations(db, previousVersion);
    for (const statement of DDL) {
      db.exec(statement);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();

  // 建完还要核对：IF NOT EXISTS 只保证「存在就不动」，不保证结构与代码
  // 一致。缺索引尤其危险——查询照样能跑，只是重复数据会悄悄写进去。
  const tablesAfter = listObjects(db, 'table');
  const missingTables = EXPECTED_TABLES.filter((t) => !tablesAfter.has(t));
  const indexesAfter = listObjects(db, 'index');
  const missingIndexes = EXPECTED_INDEXES.filter((i) => !indexesAfter.has(i));

  if (missingTables.length > 0 || missingIndexes.length > 0) {
    const parts: string[] = [];
    if (missingTables.length > 0) parts.push(`表：${missingTables.join(', ')}`);
    if (missingIndexes.length > 0) parts.push(`索引：${missingIndexes.join(', ')}`);
    throw new Error(
      `建表后仍缺少 ${parts.join('；')}。` +
        '若 DDL 改动过而库是旧的，CREATE ... IF NOT EXISTS 会静默跳过，' +
        '请检查 DDL 与 SCHEMA_VERSION 是否同步递增。',
    );
  }

  return { previousVersion, version: SCHEMA_VERSION, created };
}
