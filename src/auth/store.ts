/**
 * 鉴权数据的读写：管理员口令与 CI key。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { decryptCiKeyValue, encryptCiKeyValue } from '../shared/crypto.js';
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
  /**
   * 明文。设置页要随时复制，所以这里返回解密后的值。
   * 老记录（v3 之前签发）或主密钥变更导致解不开时为 null。
   */
  readonly value: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

interface CiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly token_hash: string;
  readonly token_encrypted: Buffer | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

/** 自定义 key 的下限。低于这个长度连「自用」都谈不上。 */
const MIN_KEY_LENGTH = 8;

function normalizeKeyValue(value: string): string {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) {
    throw new Error('CI key 不能包含空白字符');
  }
  if (trimmed.length < MIN_KEY_LENGTH) {
    throw new Error(`CI key 至少 ${MIN_KEY_LENGTH} 个字符`);
  }
  return trimmed;
}

function toCiKeySummary(row: CiKeyRow, masterKey: string): CiKeySummary {
  let value: string | null = null;
  if (row.token_encrypted !== null) {
    try {
      value = decryptCiKeyValue(row.token_encrypted, masterKey);
    } catch {
      // 主密钥换过时老密文解不开。让列表照常打开，界面提示重新设置，
      // 而不是整个设置页报错。
      value = null;
    }
  }

  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    value,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function readCiKeyRow(db: Db, id: string): CiKeyRow {
  const row = db.prepare<[string], CiKeyRow>('SELECT * FROM ci_keys WHERE id = ?').get(id);
  if (row === undefined) {
    throw new Error(`CI key ${id} 不存在`);
  }
  return row;
}

function getCiKey(db: Db, id: string, masterKey: string): CiKeySummary {
  return toCiKeySummary(readCiKeyRow(db, id), masterKey);
}

/**
 * 新建一个 CI key。
 *
 * `value` 留空时生成 256 位随机值；也可以直接指定——自用后台没必要强制
 * 「只显示一次」，值随时可在设置页查看和替换。
 */
export function issueCiKey(
  db: Db,
  name: string,
  masterKey: string,
  value?: string,
): CiKeySummary {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new Error('CI key 名称不能为空');
  }

  const generated = value === undefined || value.trim() === '' ? generateCiKey() : null;
  const key = generated === null ? normalizeKeyValue(value ?? '') : generated.key;
  const prefix = generated === null ? key.slice(0, 8) : generated.prefix;

  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO ci_keys (id, name, prefix, token_hash, token_encrypted, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, trimmedName, prefix, hashToken(key), encryptCiKeyValue(key, masterKey), now());
  } catch (error) {
    // 唯一约束的原始报错是 "UNIQUE constraint failed: ci_keys.token_hash"，
    // 对着界面念 SQL 没有意义：用户要知道的是「这个值已经在用了」。
    // updateCiKey 早就这么翻译了，新建这条路径漏了。
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new Error('这个 CI key 值已被另一条记录使用，请换一个');
    }
    throw error;
  }
  return getCiKey(db, id, masterKey);
}

export interface UpdateCiKeyInput {
  readonly name?: string;
  /** 新的 key 原文。给出时旧值立即失效。 */
  readonly value?: string;
}

/** 改名或更换值。更换值后旧值立即失效（哈希与密文一起换）。 */
export function updateCiKey(
  db: Db,
  id: string,
  changes: UpdateCiKeyInput,
  masterKey: string,
): CiKeySummary {
  const current = readCiKeyRow(db, id);
  const name = changes.name === undefined ? current.name : changes.name.trim();
  if (name.length === 0) {
    throw new Error('CI key 名称不能为空');
  }

  let tokenHash = current.token_hash;
  let prefix = current.prefix;
  let encrypted = current.token_encrypted;

  if (changes.value !== undefined) {
    const value = normalizeKeyValue(changes.value);
    tokenHash = hashToken(value);
    prefix = value.slice(0, 8);
    encrypted = encryptCiKeyValue(value, masterKey);
  }

  try {
    db.prepare(
      'UPDATE ci_keys SET name = ?, prefix = ?, token_hash = ?, token_encrypted = ? WHERE id = ?',
    ).run(name, prefix, tokenHash, encrypted, id);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new Error('这个 CI key 值已被另一条记录使用，请换一个');
    }
    throw error;
  }

  return getCiKey(db, id, masterKey);
}

export function listCiKeys(db: Db, masterKey: string): CiKeySummary[] {
  const rows = db
    .prepare<[], CiKeyRow>('SELECT * FROM ci_keys ORDER BY created_at DESC')
    .all();
  return rows.map((row) => toCiKeySummary(row, masterKey));
}

/**
 * 删除一个 CI key。删掉即失效，列表里不留痕。
 *
 * 不做软删除：一条既不能用也不能改的记录留在设置页里只是噪音，而「它曾经
 * 存在过」对自用后台没有价值。要换值就直接改值（旧值当场失效）。
 *
 * 构建记录**不删**：那是 CI 上报的事实，不该因为换了把钥匙就消失。所以先
 * 把引用置空再删 key，否则外键会拦住整个操作。代价是那些历史构建不再知道
 * 当初是谁上报的，而这正是删除的含义。
 */
export function deleteCiKey(db: Db, id: string): void {
  db.transaction(() => {
    const cleared = db
      .prepare('UPDATE builds SET ci_key_id = NULL WHERE ci_key_id = ?')
      .run(id);

    const result = db.prepare('DELETE FROM ci_keys WHERE id = ?').run(id);
    if (result.changes === 0) {
      // 抛出会让整个事务回滚，连带撤销上面的置空
      throw new Error(`CI key ${id} 不存在`);
    }
    if (cleared.changes > 0) {
      // 这不是错误，但属于「删除产生了附带影响」，值得留在日志里
      console.info(
        `[ci-key] 删除 ${id} 时清空了 ${cleared.changes} 条构建记录的上报来源`,
      );
    }
  })();
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
  const rows = db.prepare<[], Row>('SELECT id, token_hash FROM ci_keys').all();

  for (const row of rows) {
    if (tokenMatches(token, row.token_hash)) {
      db.prepare('UPDATE ci_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
      return row.id;
    }
  }
  return null;
}
