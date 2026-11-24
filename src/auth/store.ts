/**
 * 鉴权数据的读写：管理员口令与 CI key。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { generateCiKey, hashPassword, hashToken, tokenMatches, verifyPassword } from '../shared/hash.js';

function now(): string {
  return new Date().toISOString();
}

/* ---------------------------------- 口令 ---------------------------------- */

interface SettingsRow {
  readonly password_hash: string | null;
}

function readSettings(db: Db): SettingsRow | undefined {
  return db.prepare<[], SettingsRow>('SELECT password_hash FROM settings WHERE id = 1').get();
}

/** 是否已设置管理员口令。未设置时中控台应引导首次设置。 */
export function isPasswordSet(db: Db): boolean {
  const row = readSettings(db);
  return row?.password_hash != null;
}

/**
 * 设置或更换管理员口令。
 *
 * 已设置口令时必须提供当前口令，否则任何能访问接口的人都能顶替口令。
 */
export function setPassword(db: Db, next: string, current?: string): void {
  if (next.length < 8) {
    throw new Error('口令至少 8 个字符');
  }

  const row = readSettings(db);
  const existing = row?.password_hash ?? null;

  if (existing !== null) {
    if (current === undefined) {
      throw new Error('更换口令必须提供当前口令');
    }
    if (!verifyPassword(current, existing)) {
      throw new Error('当前口令不正确');
    }
  }

  const stamp = now();
  db.prepare(
    `INSERT INTO settings (id, password_hash, created_at, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash,
                                   updated_at    = excluded.updated_at`,
  ).run(hashPassword(next), stamp, stamp);
}

/** 校验管理员口令。未设置口令时一律不通过。 */
export function checkPassword(db: Db, password: string): boolean {
  const stored = readSettings(db)?.password_hash;
  if (stored == null) return false;
  return verifyPassword(password, stored);
}

/* --------------------------------- CI key --------------------------------- */

export interface CiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface IssuedCiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  /** 明文 key，只在签发这一刻返回，之后无法再取回。 */
  readonly key: string;
}

/** 签发一个 CI key。明文只返回一次，库里只留哈希。 */
export function issueCiKey(db: Db, name: string): IssuedCiKey {
  if (name.trim().length === 0) {
    throw new Error('CI key 名称不能为空');
  }
  const { key, prefix } = generateCiKey();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ci_keys (id, name, prefix, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, prefix, hashToken(key), now());
  return { id, name, prefix, key };
}

export function listCiKeys(db: Db): CiKeySummary[] {
  interface Row {
    readonly id: string;
    readonly name: string;
    readonly prefix: string;
    readonly created_at: string;
    readonly last_used_at: string | null;
    readonly revoked_at: string | null;
  }
  const rows = db
    .prepare<[], Row>(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM ci_keys ORDER BY created_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export function revokeCiKey(db: Db, id: string): void {
  const result = db.prepare('UPDATE ci_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
  if (result.changes === 0) {
    throw new Error(`CI key ${id} 不存在或已吊销`);
  }
}

/**
 * 校验 CI key，通过时返回它的 id 并记录使用时间。
 *
 * 逐条比较而不是按哈希索引查：库里只有个位数条目，而定时安全比较
 * 不能用 SQL 的 `=`（它会短路，泄漏前缀匹配长度）。
 */
export function verifyCiKey(db: Db, token: string): string | null {
  interface Row {
    readonly id: string;
    readonly token_hash: string;
  }
  const rows = db
    .prepare<[], Row>('SELECT id, token_hash FROM ci_keys WHERE revoked_at IS NULL')
    .all();

  for (const row of rows) {
    if (tokenMatches(token, row.token_hash)) {
      db.prepare('UPDATE ci_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
      return row.id;
    }
  }
  return null;
}
