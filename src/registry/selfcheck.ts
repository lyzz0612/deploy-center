/**
 * 启动自检：校验注册表之间的引用完整性。
 *
 * 为什么要在启动时做：这些都是**纯配置错误**（插件声明了一个不存在的凭据
 * 类型、引用了一个没登记的 CLI）。它们不会让任何查询报错，只会在用户真正
 * 点发布时炸在半路上，那时现场最难看。启动时炸掉，代价是重启失败，
 * 收益是问题离原因最近。
 */
import type { Db } from '../db/index.js';
import { findCliSpec } from './cli-spec.js';
import { findCredentialType } from './credential-type.js';
import { protectedTables } from '../db/references.js';
import { validateFields, type Field } from './fields.js';
import { findTargetKind, listTargetKinds } from './target-kind-registry.js';

export interface SelfCheckProblem {
  /** 出问题的位置，例如 `targetKind:wechat`。 */
  readonly where: string;
  readonly message: string;
}

export interface SelfCheckOptions {
  /**
   * 已登记的包类型 id。
   *
   * 传入时会校验每个 kind 的 `accepts` 是否都指向已登记的包类型；不传则
   * 跳过这一项——包类型是数据，可能还没来得及登记，那不算配置错误。
   */
  readonly knownPackageTypes?: readonly string[];
}

/**
 * 检查注册表自身的一致性。返回全部问题而不是抛第一个：一次把问题看全，
 * 比修一个重启一次快得多。
 */
export function checkRegistries(options: SelfCheckOptions = {}): SelfCheckProblem[] {
  const problems: SelfCheckProblem[] = [];
  const kinds = listTargetKinds();

  for (const kind of kinds) {
    const m = kind.manifest;
    const where = `targetKind:${m.id}`;

    if (m.accepts.length === 0) {
      problems.push({ where, message: '没有声明任何可接受的包类型，它永远无法被用来发布' });
    }

    if (options.knownPackageTypes !== undefined) {
      const known = new Set(options.knownPackageTypes);
      for (const accepted of m.accepts) {
        if (!known.has(accepted)) {
          problems.push({ where, message: `accepts 指向未登记的包类型 ${accepted}` });
        }
      }
    }

    if (m.requiresCredential !== null && findCredentialType(m.requiresCredential) === undefined) {
      problems.push({
        where,
        message: `requiresCredential 指向未注册的凭据类型 ${m.requiresCredential}`,
      });
    }

    for (const cliId of m.requiresCli) {
      if (findCliSpec(cliId) === undefined) {
        problems.push({ where, message: `requiresCli 指向未注册的 CLI ${cliId}` });
      }
    }

    if (m.stages.length === 0) {
      problems.push({ where, message: '没有声明任何阶段，发布无从执行' });
    }

    const stageIds = new Set<string>();
    for (const stage of m.stages) {
      if (stageIds.has(stage.id)) {
        problems.push({ where, message: `阶段 id 重复：${stage.id}` });
      }
      stageIds.add(stage.id);
      if (stage.timeoutMs <= 0) {
        problems.push({ where, message: `阶段 ${stage.id} 的超时必须为正数` });
      }
    }

    // 声明了 verify 却没实现，发布会在最后一步撞上 undefined。
    if (m.capabilities.verify && kind.verify === undefined) {
      problems.push({ where, message: 'capabilities.verify 为 true 但没有实现 verify()' });
    }
    if (!m.capabilities.verify && kind.verify !== undefined) {
      problems.push({
        where,
        message: '实现了 verify() 但 capabilities.verify 为 false，它永远不会被调用',
      });
    }

    // 目标实例的表单里不允许出现密钥字段——那些在凭据里（design.md D5）。
    for (const field of m.targetFields) {
      if (/secret|password|privatekey|token|accesskey/i.test(field.key)) {
        problems.push({
          where,
          message: `targetFields 含疑似密钥字段 ${field.key}，密钥必须放在凭据里`,
        });
      }
    }

    // 位置标识为空意味着去重索引退化成「同类型同凭据只能有一个实例」，
    // 与「同一存储不同路径可共存」矛盾。
    if (m.targetFields.length > 0 && !m.targetFields.some((f) => f.identity === true)) {
      problems.push({
        where,
        message: 'targetFields 没有任何 identity 字段，同类型的多个实例将无法区分',
      });
    }

    problems.push(...checkFieldDeclarations(m.targetFields, `${where}.targetFields`));
    problems.push(...checkFieldDeclarations(m.publishFields, `${where}.publishFields`));
  }

  return problems;
}

function checkFieldDeclarations(fields: readonly Field[], where: string): SelfCheckProblem[] {
  const problems: SelfCheckProblem[] = [];
  const keys = new Set<string>();

  for (const field of fields) {
    if (keys.has(field.key)) {
      problems.push({ where, message: `字段 key 重复：${field.key}` });
    }
    keys.add(field.key);

    if (field.type === 'select' && (field.options === undefined || field.options.length === 0)) {
      problems.push({ where, message: `字段 ${field.key} 是 select 但没有选项` });
    }
    if (field.pattern !== undefined) {
      try {
        new RegExp(field.pattern);
      } catch {
        problems.push({ where, message: `字段 ${field.key} 的 pattern 不是合法正则` });
      }
    }
  }

  return problems;
}

/**
 * 校验库里已有的目标实例仍能被当前代码理解。
 *
 * 典型场景：删掉或改名了一个插件，而库里还有引用它的实例。这不该让进程
 * 起不来（数据不是配置错误，且可能需要先登录后台归档它们），所以只报告。
 */
export function checkStoredTargets(db: Db): SelfCheckProblem[] {
  const problems: SelfCheckProblem[] = [];
  const rows = db
    .prepare<[], { id: string; kind: string; name: string; location: string }>(
      'SELECT id, kind, name, location FROM targets WHERE archived_at IS NULL',
    )
    .all();

  for (const row of rows) {
    const kind = findTargetKind(row.kind);
    if (kind === undefined) {
      problems.push({
        where: `target:${row.id}`,
        message: `实例「${row.name}」的类型 ${row.kind} 未注册，归档它或恢复该插件`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.location);
    } catch {
      problems.push({ where: `target:${row.id}`, message: '位置字段不是合法 JSON' });
      continue;
    }

    const errors = validateFields(kind.manifest.targetFields, parsed as Record<string, unknown>);
    for (const error of errors) {
      problems.push({
        where: `target:${row.id}`,
        message: `实例「${row.name}」的配置与当前 ${row.kind} 声明不符：${error.message}`,
      });
    }
  }

  return problems;
}

/**
 * 执行全部自检。
 *
 * 注册表问题是配置错误，**抛出**（调用方据此以非零码退出）；
 * 存量数据问题只返回，由调用方打印成警告。
 */
export function runSelfCheck(
  db: Db,
  options: SelfCheckOptions = {},
): { warnings: SelfCheckProblem[] } {
  const fatal = [...checkRegistries(options), ...checkProtectedTables(db)];
  if (fatal.length > 0) {
    const lines = fatal.map((p) => `  - [${p.where}] ${p.message}`).join('\n');
    throw new Error(`启动自检未通过（${fatal.length} 项）：\n${lines}`);
  }
  return { warnings: checkStoredTargets(db) };
}

/**
 * 受保护的表必须有 `archived_at` 列。
 *
 * 少了它，「只能归档不能删除」就成了「既不能归档也不能删除」，而这个
 * 失败只会在用户点归档时才暴露。
 */
function checkProtectedTables(db: Db): SelfCheckProblem[] {
  const problems: SelfCheckProblem[] = [];
  const query = db.prepare<[string], { name: string }>(
    'SELECT name FROM pragma_table_info(?)',
  );
  for (const table of protectedTables()) {
    const columns = query.all(table);
    if (!columns.some((c) => c.name === 'archived_at')) {
      problems.push({
        where: `table:${table}`,
        message: '受引用保护的表缺少 archived_at 列，无法归档',
      });
    }
  }
  return problems;
}
