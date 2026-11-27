/**
 * 一次发布的阶段序列。
 *
 * 插件只声明「发布动作」有哪些阶段；结果验证由核心补在最后一步。放在
 * 这里而不是散在调用处，是为了让「新建发布」只有一个入口去想这件事：
 * 忘了补这一步，声明了 verify 的类型就会悄悄不验证。
 */
import type { TargetKind } from '../registry/index.js';
import { VERIFY_STAGE_ID } from './store.js';

export function releaseStages(kind: TargetKind): string[] {
  const declared = kind.manifest.stages.map((stage) => stage.id);
  // 回滚不走这里：那是另一条只含 __rollback__ 一个阶段的记录
  return kind.manifest.capabilities.verify ? [...declared, VERIFY_STAGE_ID] : declared;
}