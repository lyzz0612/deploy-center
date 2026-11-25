/**
 * H5 对象存储（Cloudflare R2）发布目标。
 */
import type { TargetKind } from '../../registry/index.js';
import { h5R2TargetChecks } from './checks.js';
import { h5R2Manifest } from './manifest.js';
import { h5R2Execute, h5R2Rollback, h5R2Verify } from './publish.js';

export const h5R2Plugin: TargetKind = {
  manifest: h5R2Manifest,
  globalChecks: [],
  targetChecks: h5R2TargetChecks,
  execute: h5R2Execute,
  verify: h5R2Verify,
  rollback: h5R2Rollback,
};

export { H5_R2_KIND_ID } from './manifest.js';
export { h5R2Rollback };
export { makePointer, parsePointer, POINTER_FILE, VERSIONS_DIR, type Pointer } from './pointer.js';
