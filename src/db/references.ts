/**
 * 引用保护：没有引用的记录可以直接删除，被引用的记录拒绝删除。
 *
 * 没有归档这个中间态。一条「已归档」的记录既不出现在候选列表里、又不能删，
 * 留着只是让人每次打开设置页都要重新判断一遍它还有没有用。建错了就删掉，
 * 还在用的就是在用——这两种状态之间不需要第三种。
 *
 * 为什么不靠数据库外键报错：外键只会抛一句 `FOREIGN KEY constraint failed`，
 * 既不说是谁在引用、也不说有几条。用户看到这句话无从下手。这里在删除前
 * 先查清引用来源，把「谁在用它」直接告诉用户。
 *
 * 四处保护用同一套声明驱动的机制，而不是四段各写一遍的 if：
 *
 *   PackageType ← Build.package_type_id
 *   Credential  ← Target.credential_id
 *   Target      ← Release.target_id
 *   Game        ← Build.game_id / Target.game_id
 *
 * 新增一种受保护的实体 = 往 PROTECTED 里加一条，不改删除逻辑。
 *
 * 游戏是唯一的例外：它底下挂着构建、目标与发布历史，所以删游戏走
 * `deleteGameCascade`（catalog/games.ts），而不是这里的「有引用就拒绝」。
 * 它仍登记在 PROTECTED 里，因为「谁在引用这个游戏」要能查出来给用户看。
 */
import type { Db } from './connection.js';

export interface ReferenceSource {
  /** 引用方表名，用于拼人类可读的说明。 */
  readonly table: string;
  /** 引用方的显示名（有的话），让用户知道是哪一条。 */
  readonly label: string;
}

export interface ReferenceCheck {
  readonly referenced: boolean;
  readonly count: number;
  /** 前若干条引用来源，用于错误信息。不全列，几十条没人看。 */
  readonly samples: readonly ReferenceSource[];
}

interface ProtectedEntity {
  /** 被保护的表。 */
  readonly table: string;
  /** 人类可读的实体名。 */
  readonly displayName: string;
  /** 引用它的位置。 */
  readonly referencedBy: readonly {
    readonly table: string;
    readonly column: string;
    /** 取一个能辨认引用方的标签的 SQL 片段。 */
    readonly labelExpr: string;
  }[];
}

const PROTECTED: readonly ProtectedEntity[] = [
  {
    table: 'package_types',
    displayName: '包类型',
    referencedBy: [
      {
        table: 'builds',
        column: 'package_type_id',
        labelExpr: "build_id || ' (' || COALESCE(commit_sha, '无 commit') || ')'",
      },
    ],
  },
  {
    table: 'credentials',
    displayName: '凭据',
    referencedBy: [{ table: 'targets', column: 'credential_id', labelExpr: 'name' }],
  },
  {
    table: 'targets',
    displayName: '发布目标',
    referencedBy: [{ table: 'releases', column: 'target_id', labelExpr: "'发布于 ' || created_at" }],
  },
  {
    // 游戏走级联删除，不靠「有引用就拒绝」。登记在这里是为了能把
    // 「删它会连带删掉什么」查出来展示给用户。
    table: 'games',
    displayName: '游戏',
    referencedBy: [
      {
        table: 'builds',
        column: 'game_id',
        labelExpr: "'构建 ' || build_id",
      },
      { table: 'targets', column: 'game_id', labelExpr: "'目标 ' || name" },
    ],
  },
];

const BY_TABLE = new Map<string, ProtectedEntity>(PROTECTED.map((e) => [e.table, e]));

const SAMPLE_LIMIT = 5;

/**
 * 取受保护实体的声明。
 *
 * 下面的 SQL 需要把表名与列名拼进语句（SQLite 不支持把标识符参数化）。
 * 这些值全部来自本模块的 PROTECTED 常量、不来自请求，但仍然只接受清单内
 * 的表名：这样即便将来有人把外部字符串传进来，也只会得到一个明确的报错，
 * 而不是一条拼出来的 SQL。
 */
function requireProtected(table: string): ProtectedEntity {
  const entity = BY_TABLE.get(table);
  if (entity === undefined) {
    throw new Error(`表 ${table} 不在引用保护清单里`);
  }
  return entity;
}

/** 查某条记录是否被引用，以及被谁引用。 */
export function findReferences(db: Db, table: string, id: string): ReferenceCheck {
  const entity = requireProtected(table);

  let count = 0;
  const samples: ReferenceSource[] = [];

  for (const ref of entity.referencedBy) {
    const row = db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`,
      )
      .get(id);
    const n = row?.n ?? 0;
    if (n === 0) continue;
    count += n;

    if (samples.length < SAMPLE_LIMIT) {
      const rows = db
        .prepare<[string, number], { label: string }>(
          `SELECT ${ref.labelExpr} AS label FROM ${ref.table} WHERE ${ref.column} = ? LIMIT ?`,
        )
        .all(id, SAMPLE_LIMIT - samples.length);
      for (const r of rows) {
        samples.push({ table: ref.table, label: r.label });
      }
    }
  }

  return { referenced: count > 0, count, samples };
}

/** 被引用时抛出，错误信息里带上引用来源。 */
export class ReferencedError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
    readonly check: ReferenceCheck,
  ) {
    const entity = BY_TABLE.get(table);
    const what = entity?.displayName ?? table;
    const sampleText = check.samples.map((s) => `${s.table}: ${s.label}`).join('；');
    const more = check.count > check.samples.length ? ` 等 ${check.count} 条` : '';
    super(`该${what}正被引用，不能删除。请先处理这些引用：${sampleText}${more}`);
    this.name = 'ReferencedError';
  }
}

/**
 * 物理删除，被引用时拒绝。
 *
 * 这是唯一的删除入口：没有「软删除」的版本可选，所以不存在「本想归档却
 * 删掉了」或者反过来的误用。
 */
export function deleteIfUnreferenced(db: Db, table: string, id: string): void {
  const entity = requireProtected(table);
  const check = findReferences(db, table, id);
  if (check.referenced) {
    throw new ReferencedError(table, id, check);
  }
  const result = db.prepare(`DELETE FROM ${entity.table} WHERE id = ?`).run(id);
  if (result.changes === 0) {
    throw new Error(`${table} 中没有 id 为 ${id} 的记录`);
  }
}

/** 受保护的表名清单，供测试与自检使用。 */
export function protectedTables(): readonly string[] {
  return PROTECTED.map((e) => e.table);
}
