/**
 * 发布目标实例（publish-targets spec）。
 *
 * 实例是**数据**：kind + 凭据引用 + 位置字段。怎么发布由 kind（代码侧插件）
 * 决定，发到哪由实例决定（design.md D2）。
 *
 * 实例表单里不允许出现任何密钥字段——那些在凭据里，实例只持一个引用
 * （design.md D5）。启动自检会对 targetFields 里的疑似密钥字段报错。
 */
import { randomUUID } from 'node:crypto';

import { getCredential } from '../credentials/index.js';
import {
  deleteIfUnreferenced,
  findReferences,
  locationKey,
  type Db,
} from '../db/index.js';
import {
  getTargetKind,
  identityValues,
  validateFields,
  type TargetKind,
} from '../registry/index.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

function now(): string {
  return new Date().toISOString();
}

interface TargetRow {
  readonly id: string;
  readonly game_id: string;
  readonly kind: string;
  readonly name: string;
  readonly credential_id: string | null;
  readonly location: string;
  readonly location_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Target {
  readonly id: string;
  readonly gameId: string;
  readonly kind: string;
  readonly kindDisplayName: string;
  readonly name: string;
  readonly credentialId: string | null;
  /** 位置字段（明文配置，不含密钥）。 */
  readonly location: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 该 kind 接受哪些包类型，供发布入口过滤。 */
  readonly accepts: readonly string[];
  /**
   * 有多少发布记录引用它。
   *
   * 界面用它决定删除按钮能不能点：0 可删，非 0 要先清掉那些发布记录。
   */
  readonly releaseCount: number;
}

function toTarget(db: Db, row: TargetRow): Target {
  // kind 可能已被删除（插件下线），这种情况由启动自检报告为警告，
  // 这里不能直接抛——否则列表页会因为一条坏数据整页打不开。
  let kindDisplayName = row.kind;
  let accepts: readonly string[] = [];
  try {
    const kind = getTargetKind(row.kind);
    kindDisplayName = kind.manifest.displayName;
    accepts = kind.manifest.accepts;
  } catch {
    kindDisplayName = `${row.kind}（类型未注册）`;
  }

  return {
    id: row.id,
    gameId: row.game_id,
    kind: row.kind,
    kindDisplayName,
    name: row.name,
    credentialId: row.credential_id,
    location: JSON.parse(row.location) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accepts,
    releaseCount: findReferences(db, 'targets', row.id).count,
  };
}

/**
 * 校验凭据引用：类型必须与 kind 声明的 requiresCredential 一致。
 *
 * 不一致时直接拒绝，而不是等到发布时让插件拿到一个字段名完全不同的凭据。
 */
function validateCredential(db: Db, kind: TargetKind, credentialId: string | null, masterKey: string): void {
  const required = kind.manifest.requiresCredential;

  if (required === null) {
    if (credentialId !== null) {
      throw new Error(`${kind.manifest.displayName} 不需要凭据，请不要选择`);
    }
    return;
  }

  if (credentialId === null) {
    throw new Error(`${kind.manifest.displayName} 需要一个「${required}」类型的凭据`);
  }

  const credential = getCredential(db, credentialId, masterKey);
  if (credential.type !== required) {
    throw new Error(
      `凭据「${credential.name}」的类型是 ${credential.type}，` +
        `而 ${kind.manifest.displayName} 需要 ${required}`,
    );
  }
}

function validateLocation(kind: TargetKind, location: Record<string, unknown>): void {
  const errors = validateFields(kind.manifest.targetFields, location);
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join('；'));
  }
}

export interface CreateTargetInput {
  readonly gameId: string;
  readonly kind: string;
  readonly name: string;
  readonly credentialId?: string | null;
  readonly location: Record<string, unknown>;
}

export function createTarget(db: Db, input: CreateTargetInput, masterKey: string): Target {
  if (input.name.trim().length === 0) {
    throw new Error('目标名称不能为空');
  }

  const kind = getTargetKind(input.kind);
  const credentialId = input.credentialId ?? null;
  validateCredential(db, kind, credentialId, masterKey);
  validateLocation(kind, input.location);

  // 去重只看决定「发到哪」的字段：否则改个备注就能绕过去重，造出两个
  // 指向同一位置的实例（publish-targets spec：目标实例去重）。
  const key = locationKey(identityValues(kind.manifest.targetFields, input.location));

  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO targets (id, game_id, kind, name, credential_id, location, location_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.gameId,
      input.kind,
      input.name,
      credentialId,
      JSON.stringify(input.location),
      key,
      now(),
      now(),
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      const conflict = findConflicting(db, input.gameId, input.kind, credentialId, key);
      throw new ConflictError(
        `与已有目标「${conflict?.name ?? '未知'}」的类型、凭据与位置完全相同，` +
          '两者会互相覆盖',
      );
    }
    if (error instanceof Error && /FOREIGN KEY/.test(error.message)) {
      throw new Error('游戏或凭据不存在');
    }
    throw error;
  }

  return getTarget(db, id);
}

function findConflicting(
  db: Db,
  gameId: string,
  kind: string,
  credentialId: string | null,
  key: string,
): TargetRow | undefined {
  return db
    .prepare<[string, string, string, string], TargetRow>(
      `SELECT * FROM targets
       WHERE game_id = ? AND kind = ? AND COALESCE(credential_id, '') = ? AND location_key = ?`,
    )
    .get(gameId, kind, credentialId ?? '', key);
}

export function getTarget(db: Db, id: string): Target {
  const row = db.prepare<[string], TargetRow>('SELECT * FROM targets WHERE id = ?').get(id);
  if (row === undefined) {
    throw new NotFoundError(`发布目标 ${id} 不存在`);
  }
  return toTarget(db, row);
}

export interface ListTargetsOptions {
  readonly gameId?: string;
  /**
   * 只列能接受该包类型的目标。
   *
   * 这是「错配不可能出现」的落点：发布入口用它取候选，所以跨类型组合
   * 根本不会出现在下拉框里（publish-targets spec：包类型兼容性校验）。
   */
  readonly acceptsPackageType?: string;
}

export function listTargets(db: Db, options: ListTargetsOptions = {}): Target[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.gameId !== undefined) {
    conditions.push('game_id = ?');
    params.push(options.gameId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const targets = db
    .prepare<string[], TargetRow>(`SELECT * FROM targets ${where} ORDER BY name`)
    .all(...params)
    .map((row) => toTarget(db, row));

  if (options.acceptsPackageType === undefined) return targets;
  const packageType = options.acceptsPackageType;
  return targets.filter((t) => t.accepts.includes(packageType));
}

export interface UpdateTargetInput {
  readonly name?: string;
  readonly credentialId?: string | null;
  readonly location?: Record<string, unknown>;
}

/**
 * 更新目标。
 *
 * kind 不可改：它决定了位置字段的形状与所需凭据类型，改 kind 等于换一个
 * 完全不同的目标，应该新建而不是原地改——否则历史发布记录会指向一个
 * 语义已变的目标。
 */
export function updateTarget(
  db: Db,
  id: string,
  changes: UpdateTargetInput,
  masterKey: string,
): Target {
  const current = getTarget(db, id);
  const kind = getTargetKind(current.kind);

  const name = changes.name ?? current.name;
  if (name.trim().length === 0) {
    throw new Error('目标名称不能为空');
  }

  const credentialId =
    changes.credentialId === undefined ? current.credentialId : changes.credentialId;
  validateCredential(db, kind, credentialId, masterKey);

  const location = changes.location ?? current.location;
  validateLocation(kind, location);
  const key = locationKey(identityValues(kind.manifest.targetFields, location));

  try {
    db.prepare(
      `UPDATE targets SET name = ?, credential_id = ?, location = ?, location_key = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, credentialId, JSON.stringify(location), key, now(), id);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      const conflict = findConflicting(db, current.gameId, current.kind, credentialId, key);
      throw new ConflictError(
        `与已有目标「${conflict?.name ?? '未知'}」的类型、凭据与位置完全相同，两者会互相覆盖`,
      );
    }
    throw error;
  }

  return getTarget(db, id);
}

/**
 * 删除目标。有发布历史时抛 ReferencedError。
 *
 * 想删一个发过版的目标，得先清掉它的发布记录
 * （`deleteReleasesByTarget`）。这一步是刻意留着的：发布历史是「线上曾经
 * 是什么版本」的唯一记录，不该被删目标的动作顺手带走。
 */
export function deleteTarget(db: Db, id: string): void {
  deleteIfUnreferenced(db, 'targets', id);
}

/**
 * 取一个可用于发布的目标，并校验它接受给定的包类型。
 *
 * 这是发布入口的守门人：即使有人绕过 UI 直接调接口，跨类型组合也会被拒
 * （publish-targets spec：不兼容的组合 MUST 无法发起发布）。
 */
export function requirePublishableTarget(db: Db, id: string, packageTypeId: string): Target {
  const target = getTarget(db, id);
  if (!target.accepts.includes(packageTypeId)) {
    // 用 ConflictError 而不是普通 Error：请求本身合法，是与当前状态冲突，
    // 该回 409 而不是 400，让调用方能区分「我填错了」和「这个组合不成立」。
    throw new ConflictError(
      `目标「${target.name}」（${target.kindDisplayName}）不接受 ${packageTypeId} 包，` +
        `它只接受：${target.accepts.length > 0 ? target.accepts.join('、') : '（无）'}`,
    );
  }
  return target;
}
