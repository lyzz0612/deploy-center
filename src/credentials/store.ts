/**
 * 凭据的读写。
 *
 * 两条不能破的规则（credentials spec）：
 *
 * 1. **任何列表/详情接口都不返回明文**，只回名称、类型与各字段是否已设置。
 * 2. **明文只在执行发布时取用**，由 `readSecrets` 这一个入口提供，调用方
 *    只有任务执行器。
 */
import { randomUUID } from 'node:crypto';

import { deleteIfUnreferenced, findReferences, type Db } from '../db/index.js';
import { getCredentialType, validateFields, type CredentialTypeId } from '../registry/index.js';
import { decryptSecrets, encryptSecrets } from '../shared/crypto.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

function now(): string {
  return new Date().toISOString();
}

interface CredentialRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly secrets: Buffer;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 对外可见的凭据信息。刻意没有 secrets 字段——类型层面就不给机会。 */
export interface CredentialSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly typeDisplayName: string;
  /** 各字段是否已设置。值永不出现在这里。 */
  readonly fieldsSet: Record<string, boolean>;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * 有多少发布目标在引用它。
   *
   * 界面用它决定删除按钮能不能点：0 可删，非 0 要先改掉那些目标。
   */
  readonly referenceCount: number;
}

export interface CreateCredentialInput {
  readonly name: string;
  readonly type: CredentialTypeId;
  readonly secrets: Record<string, string>;
}

function fieldsSetOf(type: string, secrets: Record<string, string>): Record<string, boolean> {
  const declared = getCredentialType(type).fields;
  const result: Record<string, boolean> = {};
  for (const field of declared) {
    const value = secrets[field.key];
    result[field.key] = typeof value === 'string' && value.length > 0;
  }
  return result;
}

function toSummary(db: Db, row: CredentialRow, masterKey: string): CredentialSummary {
  const type = getCredentialType(row.type);
  // 为了算「哪些字段已设置」必须解一次密。这是刻意的：另存一份
  // 「已设置」清单会产生两个事实来源，轮换时必然有一天忘记同步。
  const secrets = decryptSecrets(row.secrets, masterKey);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    typeDisplayName: type.displayName,
    fieldsSet: fieldsSetOf(row.type, secrets),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    referenceCount: findReferences(db, 'credentials', row.id).count,
  };
}

/** 校验字段并丢掉空值，空值等于「没设置」。 */
function normalizeSecrets(
  type: CredentialTypeId,
  secrets: Record<string, string>,
): Record<string, string> {
  const declared = getCredentialType(type).fields;
  const errors = validateFields(declared, secrets);
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join('；'));
  }

  const result: Record<string, string> = {};
  for (const field of declared) {
    const value = secrets[field.key];
    if (typeof value === 'string' && value.length > 0) {
      result[field.key] = value;
    }
  }
  return result;
}

export function createCredential(
  db: Db,
  input: CreateCredentialInput,
  masterKey: string,
): CredentialSummary {
  if (input.name.trim().length === 0) {
    throw new Error('凭据名称不能为空');
  }

  const secrets = normalizeSecrets(input.type, input.secrets);
  const id = randomUUID();
  const stamp = now();

  try {
    db.prepare(
      `INSERT INTO credentials (id, name, type, secrets, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name, input.type, encryptSecrets(secrets, masterKey), stamp, stamp);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new ConflictError(`已存在名为「${input.name}」的凭据`);
    }
    throw error;
  }

  return getCredential(db, id, masterKey);
}

function readRow(db: Db, id: string): CredentialRow {
  const row = db
    .prepare<[string], CredentialRow>('SELECT * FROM credentials WHERE id = ?')
    .get(id);
  if (row === undefined) {
    throw new NotFoundError(`凭据 ${id} 不存在`);
  }
  return row;
}

export function getCredential(db: Db, id: string, masterKey: string): CredentialSummary {
  return toSummary(db, readRow(db, id), masterKey);
}

export interface ListCredentialsOptions {
  /** 只列某个类型的，用于「选择凭据」下拉框。 */
  readonly type?: string;
}

export function listCredentials(
  db: Db,
  masterKey: string,
  options: ListCredentialsOptions = {},
): CredentialSummary[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (options.type !== undefined) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare<string[], CredentialRow>(`SELECT * FROM credentials ${where} ORDER BY name`)
    .all(...params);
  return rows.map((row) => toSummary(db, row, masterKey));
}

/**
 * 更新凭据。
 *
 * 只传部分字段时与已有值合并，而不是整组替换：想单独换一个 secretAccessKey
 * 的人，不该被迫把 accessKeyId 也重新填一遍（credentials spec：就地轮换）。
 * 要清掉某个字段，显式传空串。
 */
export function updateCredential(
  db: Db,
  id: string,
  changes: { name?: string; secrets?: Record<string, string> },
  masterKey: string,
): CredentialSummary {
  const row = readRow(db, id);
  const type = row.type as CredentialTypeId;

  let payload = row.secrets;
  if (changes.secrets !== undefined) {
    const existing = decryptSecrets(row.secrets, masterKey);
    const merged = { ...existing };
    for (const [field, value] of Object.entries(changes.secrets)) {
      if (value === '') {
        delete merged[field];
      } else {
        merged[field] = value;
      }
    }
    payload = encryptSecrets(normalizeSecrets(type, merged), masterKey);
  }

  const name = changes.name ?? row.name;
  if (name.trim().length === 0) {
    throw new Error('凭据名称不能为空');
  }

  try {
    db.prepare(
      'UPDATE credentials SET name = ?, secrets = ?, updated_at = ? WHERE id = ?',
    ).run(name, payload, now(), id);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new ConflictError(`已存在名为「${name}」的凭据`);
    }
    throw error;
  }

  return getCredential(db, id, masterKey);
}

/**
 * 取凭据明文。**只应由任务执行器调用。**
 *
 * 不做成 CredentialSummary 的一个字段，是为了让「取明文」在代码里始终是
 * 一次显式的、搜得到的调用，而不是某个序列化顺手带出去的东西。
 */
export function readSecrets(db: Db, id: string, masterKey: string): Record<string, string> {
  return decryptSecrets(readRow(db, id).secrets, masterKey);
}

/**
 * 删除凭据。被任何发布目标引用时抛 ReferencedError。
 *
 * 没有归档的选项：轮换密钥走 `updateCredential`（就地改，所有引用它的目标
 * 同时生效），不再用的就删掉。
 */
export function deleteCredential(db: Db, id: string): void {
  deleteIfUnreferenced(db, 'credentials', id);
}
