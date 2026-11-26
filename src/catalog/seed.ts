/**
 * 包类型的预置登记。
 *
 * 为什么需要它：包类型是**数据**（用户可增删），但已注册的插件声明了自己
 * 接受哪些包类型，那些是插件能工作的前提。如果库里没有它们，启动自检会
 * 判「accepts 指向未登记的包类型」而让进程起不来——一个全新部署就起不来，
 * 显然不对。
 *
 * 所以启动时把插件声明的包类型补齐，只补不覆盖：用户改过显示名、或把某个
 * 类型改过显示名，都不该被启动流程推翻。
 */
import type { Db } from '../db/index.js';
import { listTargetKinds } from '../registry/index.js';
import { createPackageType, findPackageType } from './package-types.js';

export interface SeedPackageTypesResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

export function seedPackageTypes(db: Db): SeedPackageTypesResult {
  const created: string[] = [];
  const existing: string[] = [];

  const declared = new Set<string>();
  for (const kind of listTargetKinds()) {
    for (const packageType of kind.manifest.accepts) {
      declared.add(packageType);
    }
  }

  for (const id of [...declared].sort()) {
    if (findPackageType(db, id) !== undefined) {
      existing.push(id);
      continue;
    }
    // 显示名先用 id，用户可以在界面上改成想要的名字
    createPackageType(db, { id, displayName: id });
    created.push(id);
  }

  return { created, existing };
}
