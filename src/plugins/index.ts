/**
 * 目标类型（TargetKind）插件的编译期注册入口。
 *
 * 新增一个发布目标类型的全部步骤：
 *
 *   1. plugins/<id>/manifest.ts   声明字段、阶段与能力
 *   2. plugins/<id>/checks.ts     CLI 在不在、凭据对不对、平台通不通
 *   3. plugins/<id>/publish.ts    execute(stage, ctx)
 *   4. 在下面的 import 与 PLUGINS 各加一行
 *   5. 若需要新 CLI，往 registry/cli-spec.ts 加一条
 *
 * 这五步之外还要动核心，就说明抽象错了（design.md D4）。
 */
import { registerTargetKind, type TargetKind } from '../registry/index.js';

/** 已实现的目标类型。微信在 9.1、H5 在 10.1 加入。 */
const PLUGINS: readonly TargetKind[] = [];

/** 把全部插件注册进注册表。进程启动时调用一次。 */
export function registerAllPlugins(): void {
  for (const plugin of PLUGINS) {
    registerTargetKind(plugin);
  }
}
