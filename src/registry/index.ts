/**
 * 代码侧注册表（design.md D2：携带行为的是代码，只是标签的是数据）。
 *
 *   TargetKind      怎么发布：检测、配置、阶段、执行、回滚能力
 *   CredentialType  凭据有哪些字段、怎么加密
 *   CliSpec         CLI 怎么装、怎么探
 */
export type { Field, FieldError, FieldOption, FieldType } from './fields.js';
export { identityValues, validateFields } from './fields.js';

export type { CredentialType, CredentialTypeId } from './credential-type.js';
export { findCredentialType, getCredentialType, listCredentialTypes } from './credential-type.js';

export type { CliInstallKind, CliSpec } from './cli-spec.js';
export { findCliSpec, getCliSpec, listCliSpecs } from './cli-spec.js';

export type {
  BuildInfo,
  Capabilities,
  Check,
  CheckLevel,
  CheckResult,
  GlobalCheckContext,
  PublishContext,
  RollbackMode,
  Stage,
  StageResult,
  TargetKind,
  TargetKindManifest,
  VerifyResult,
} from './target-kind.js';

export {
  accepts,
  findTargetKind,
  getTargetKind,
  listTargetKinds,
  registerTargetKind,
  resetTargetKinds,
  targetKindsAccepting,
} from './target-kind-registry.js';

export type { SelfCheckOptions, SelfCheckProblem } from './selfcheck.js';
export { checkRegistries, checkStoredTargets, runSelfCheck } from './selfcheck.js';
