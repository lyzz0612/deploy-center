/**
 * 包类型登记簿（game-catalog spec）。
 *
 * 包类型是**纯数据**：除 id 与显示名外不携带任何影响产物处理的字段
 * （design.md D2）。所以新增一个包类型只要在后台点一下，不用改代码。
 *
 * 一旦有人想给它加「解压策略」这类字段，它就跨过了数据/代码的分界线，
 * 该搬到 src/registry/ 里去。
 */
import type { Db } from '../db/index.js';
import { deleteIfUnreferenced, findReferences } from '../db/index.js';
import { targetKindsAccepting } from '../registry/index.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

function now(): string {
  return new Date().toISOString();
}

/** id 会出现在 CI 上报载荷与产物路径里，限制同 slug。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface PackageTypeRow {
  readonly id: string;
  readonly display_name: string;
  readonly created_at: string;
}

export interface PackageType {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  /**
   * 声明接受该包类型的目标类型 id。
   *
   * 为空意味着这个包类型**永远发不出去**：建了类型、传了包，然后在发布页
   * 面对一个空下拉框。界面必须显式提示，而不是让人自己发现。
   */
  readonly supportedBy: readonly string[];
  /** 有多少构建记录在引用它。 */
  readonly buildCount: number;
}

function toPackageType(db: Db, row: PackageTypeRow): PackageType {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    supportedBy: targetKindsAccepting(row.id).map((k) => k.manifest.id),
    buildCount: findReferences(db, 'package_types', row.id).count,
  };
}

export interface CreatePackageTypeInput {
  readonly id: string;
  readonly displayName: string;
}

export function createPackageType(db: Db, input: CreatePackageTypeInput): PackageType {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error('包类型标识只能是小写字母、数字与连字符，以字母或数字开头，最长 32 个字符');
  }
  if (input.displayName.trim().length === 0) {
    throw new Error('显示名不能为空');
  }

  try {
    db.prepare('INSERT INTO package_types (id, display_name, created_at) VALUES (?, ?, ?)').run(
      input.id,
      input.displayName,
      now(),
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE|PRIMARY KEY/.test(error.message)) {
      throw new ConflictError(`包类型「${input.id}」已存在`);
    }
    throw error;
  }
  return getPackageType(db, input.id);
}

export function getPackageType(db: Db, id: string): PackageType {
  const row = db
    .prepare<[string], PackageTypeRow>('SELECT * FROM package_types WHERE id = ?')
    .get(id);
  if (row === undefined) {
    throw new NotFoundError(`包类型「${id}」不存在`);
  }
  return toPackageType(db, row);
}

export function findPackageType(db: Db, id: string): PackageType | undefined {
  const row = db
    .prepare<[string], PackageTypeRow>('SELECT * FROM package_types WHERE id = ?')
    .get(id);
  return row === undefined ? undefined : toPackageType(db, row);
}

export function listPackageTypes(db: Db): PackageType[] {
  return db
    .prepare<[], PackageTypeRow>('SELECT * FROM package_types ORDER BY id')
    .all()
    .map((row) => toPackageType(db, row));
}

export function renamePackageType(db: Db, id: string, displayName: string): PackageType {
  if (displayName.trim().length === 0) {
    throw new Error('显示名不能为空');
  }
  const result = db
    .prepare('UPDATE package_types SET display_name = ? WHERE id = ?')
    .run(displayName, id);
  if (result.changes === 0) {
    throw new NotFoundError(`包类型「${id}」不存在`);
  }
  return getPackageType(db, id);
}

/**
 * 删除包类型。被任何构建记录引用时抛 ReferencedError。
 *
 * 注意插件声明的包类型（当前是 h5 与 wechat）删掉后，下次启动会被
 * `seedPackageTypes` 补回来——它们是插件能工作的前提，不是用户数据。
 */
export function deletePackageType(db: Db, id: string): void {
  deleteIfUnreferenced(db, 'package_types', id);
}

/**
 * 取一个可接受上报的包类型，否则报错。
 *
 * 这是「未登记包类型拒绝写入」的实现点：上报指向未登记类型时直接拒绝，
 * 不先存下来再说（game-catalog spec）。
 */
export function requireActivePackageType(db: Db, id: string): PackageType {
  const type = findPackageType(db, id);
  if (type === undefined) {
    throw new Error(`包类型「${id}」未登记`);
  }
  return type;
}
