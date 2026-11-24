/**
 * echo 插件：仅用于测试插件契约本身。
 *
 * **不注册进生产 PLUGINS 数组**。它的作用是验证核心侧的 ctx 真的把六样
 * 东西都准备好了，而不需要一个真实平台账号。
 */
import { readdir } from 'node:fs/promises';

import type { PublishContext, StageResult, TargetKind, VerifyResult } from '../../registry/index.js';

export const ECHO_KIND_ID = 'echo';

/** 把 ctx 里拿到的东西记下来，测试据此断言。 */
export interface EchoObservation {
  artifactEntries: string[];
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  cliHome: string;
  secretValue?: string;
  secretFilePath?: string;
  stagesRun: string[];
  verifyCalled: boolean;
}

export interface EchoOptions {
  /** 指定哪个阶段抛错，用于测失败与重试。 */
  readonly failStage?: string;
  /** 指定哪个阶段永不返回，用于测超时。 */
  readonly hangStage?: string;
  /** verify 的返回值。缺省通过。 */
  readonly verifyOk?: boolean;
  /** 是否取用凭据。 */
  readonly useSecrets?: boolean;
}

export function createEchoPlugin(
  observation: EchoObservation,
  options: EchoOptions = {},
): TargetKind {
  const verify = async (ctx: PublishContext): Promise<VerifyResult> => {
    observation.verifyCalled = true;
    void ctx;
    return options.verifyOk === false
      ? { ok: false, message: '验证故意失败' }
      : { ok: true, message: '验证通过' };
  };

  const kind: TargetKind = {
    manifest: {
      id: ECHO_KIND_ID,
      displayName: 'Echo（测试用）',
      description: '只记录拿到了什么，不做任何真实发布',
      accepts: ['echo-pkg'],
      requiresCredential: options.useSecrets === true ? 'secretText' : null,
      requiresCli: [],
      targetFields: [
        { key: 'slot', label: '位置', type: 'string', required: true, identity: true },
      ],
      publishFields: [{ key: 'version', label: '版本号', type: 'string', required: true }],
      stages: [
        { id: 'upload', name: '上传', timeoutMs: 5_000 },
        { id: 'submit', name: '提审', timeoutMs: 5_000 },
      ],
      capabilities: {
        rollback: 'republish',
        verify: options.verifyOk !== undefined,
        activateLatencySeconds: 0,
      },
    },
    globalChecks: [],
    targetChecks: [],

    async execute(stageId: string, ctx: PublishContext): Promise<StageResult> {
      observation.stagesRun.push(stageId);
      observation.artifactEntries = await readdir(ctx.artifactDir);
      observation.target = ctx.target;
      observation.params = ctx.params;
      observation.cliHome = ctx.cliHome;

      if (options.useSecrets === true) {
        observation.secretValue = ctx.secret('secret');
        observation.secretFilePath = await ctx.secretFile('secret');
      }

      ctx.log(`echo 执行阶段 ${stageId}`);

      if (options.hangStage === stageId) {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('被取消')), { once: true });
          setTimeout(resolve, 60_000);
        });
      }

      if (options.failStage === stageId) {
        throw new Error(`阶段 ${stageId} 故意失败`);
      }

      return { outputs: { [`${stageId}_id`]: `echo-${stageId}-1` } };
    },
  };

  if (options.verifyOk !== undefined) {
    return { ...kind, verify };
  }
  return kind;
}

export function freshObservation(): EchoObservation {
  return {
    artifactEntries: [],
    target: {},
    params: {},
    cliHome: '',
    stagesRun: [],
    verifyCalled: false,
  };
}
