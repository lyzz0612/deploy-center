/**
 * 目标类型注册表。
 *
 * 编译期注册：新增一个目标类型只需在 src/plugins/index.ts 加一行
 * import 并放进数组。不做运行时动态加载（design.md D4 规则 4）——
 * 加平台是几个月一次的改动，而动态加载会同时带来类型、调试与安全问题。
 */
import type { TargetKind } from './target-kind.js';

const kinds = new Map<string, TargetKind>();

/**
 * 注册一个目标类型。重复 id 直接报错而不是后者覆盖前者：
 * 静默覆盖会让发布打到一个你以为不存在的实现上。
 */
export function registerTargetKind(kind: TargetKind): void {
  const id = kind.manifest.id;
  if (kinds.has(id)) {
    throw new Error(`目标类型 ${id} 已注册，不允许重复注册`);
  }
  kinds.set(id, kind);
}

export function listTargetKinds(): readonly TargetKind[] {
  return [...kinds.values()];
}

export function findTargetKind(id: string): TargetKind | undefined {
  return kinds.get(id);
}

export function getTargetKind(id: string): TargetKind {
  const kind = kinds.get(id);
  if (kind === undefined) {
    throw new Error(`未注册的目标类型：${id}`);
  }
  return kind;
}

/**
 * 列出接受某个包类型的目标类型。
 *
 * 这是「错配不可能出现」的实现点：发布目标下拉框只用它取候选，
 * 核心因此不需要任何按平台的条件分支。
 */
export function targetKindsAccepting(packageTypeId: string): readonly TargetKind[] {
  return [...kinds.values()].filter((k) => k.manifest.accepts.includes(packageTypeId));
}

/** 某个目标类型是否接受某个包类型。 */
export function accepts(kindId: string, packageTypeId: string): boolean {
  return findTargetKind(kindId)?.manifest.accepts.includes(packageTypeId) ?? false;
}

/** 仅供测试：清空注册表。 */
export function resetTargetKinds(): void {
  kinds.clear();
}
