/**
 * H5 静态目录发布目标。
 */
import type { TargetKind } from '../../registry/index.js';
import { h5DirManifest } from './manifest.js';
import { h5DirExecute, h5DirRollback, h5DirVerify } from './publish.js';

export const h5DirPlugin: TargetKind = {
  manifest: h5DirManifest,
  globalChecks: [],
  targetChecks: [],
  execute: h5DirExecute,
  verify: h5DirVerify,
  rollback: h5DirRollback,
};

export { H5_DIR_KIND_ID } from './manifest.js';
export { h5DirRollback };
export { makePointer, parsePointer, POINTER_FILE, VERSIONS_DIR, type Pointer } from './pointer.js';
