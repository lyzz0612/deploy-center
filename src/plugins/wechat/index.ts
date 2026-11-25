/**
 * 微信小游戏发布目标。
 */
import type { TargetKind } from '../../registry/index.js';
import { wechatTargetChecks } from './checks.js';
import { wechatManifest } from './manifest.js';
import { wechatExecute, wechatVerify } from './publish.js';

export const wechatPlugin: TargetKind = {
  manifest: wechatManifest,
  // 类型级检查（CLI 装没装）由核心统一探，插件不必重复声明
  globalChecks: [],
  targetChecks: wechatTargetChecks,
  execute: wechatExecute,
  verify: wechatVerify,
};

export { WECHAT_KIND_ID } from './manifest.js';
