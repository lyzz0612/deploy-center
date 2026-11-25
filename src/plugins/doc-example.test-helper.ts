/**
 * 照 docs/add-a-target-kind.md 从零写出来的一个最小插件。
 *
 * 它的存在是为了验证那份文档：一个只读过文档的人，能不能在不碰核心代码的
 * 前提下让新目标类型跑起来。所以这里**只用文档里出现过的东西**，不引入
 * 任何文档没提到的内部细节。
 *
 * 是 test-helper 而不是真插件：它不做任何实际发布，不该进生产 bundle。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  Check,
  PublishContext,
  StageResult,
  TargetKind,
  TargetKindManifest,
  VerifyResult,
} from '../registry/index.js';

/* ------------------------------ 步骤 1：manifest ------------------------------ */

const manifest: TargetKindManifest = {
  id: 'doc-example',
  displayName: '文档示例目标',
  description: '照 add-a-target-kind.md 写出来的最小插件，用于验证那份文档。',

  accepts: ['h5'],
  requiresCredential: 'secretText',
  requiresCli: [],

  targetFields: [
    { key: 'slot', label: '位置', type: 'string', required: true, identity: true },
    { key: 'note', label: '备注', type: 'string', required: false },
  ],

  publishFields: [{ key: 'tag', label: '标签', type: 'string', required: true }],

  stages: [{ id: 'deploy', name: '部署', timeoutMs: 30_000 }],

  capabilities: { rollback: 'pointer', verify: true, activateLatencySeconds: 0 },
};

/* ------------------------------ 步骤 2：检查 ------------------------------ */

const checks: readonly Check<PublishContext>[] = [
  {
    id: 'doc-example-credential',
    name: '密钥非空',
    level: 'credential',
    async run(ctx) {
      const secret = ctx.secret('secret');
      return secret.length > 0
        ? { ok: true, message: '密钥已配置' }
        : { ok: false, message: '密钥为空' };
    },
  },
];

/* ------------------------------ 步骤 3：执行体 ------------------------------ */

/** 记下插件实际拿到了什么，供测试断言。 */
export interface DocExampleTrace {
  stages: string[];
  buildId: string;
  slot: unknown;
  tag: unknown;
  secretFilePath: string;
  verified: boolean;
  rolledBack: boolean;
}

export function freshTrace(): DocExampleTrace {
  return {
    stages: [],
    buildId: '',
    slot: undefined,
    tag: undefined,
    secretFilePath: '',
    verified: false,
    rolledBack: false,
  };
}

/* ------------------------------ 步骤 4：组装 ------------------------------ */

export function createDocExamplePlugin(trace: DocExampleTrace): TargetKind {
  const execute = async (stageId: string, ctx: PublishContext): Promise<StageResult> => {
    if (stageId !== 'deploy') {
      throw new Error(`没有阶段 ${stageId}`);
    }

    trace.stages.push(stageId);
    // 文档里承诺 ctx 提供这些东西
    trace.buildId = ctx.build.buildId;
    trace.slot = ctx.target['slot'];
    trace.tag = ctx.params['tag'];
    // 文档明确要求用 secretFile() 而不是自己写临时文件
    trace.secretFilePath = await ctx.secretFile('secret');

    ctx.log(`部署 ${ctx.build.buildId} 到 ${String(ctx.target['slot'])}`);
    await writeFile(join(ctx.workdir, 'deployed.txt'), ctx.build.buildId, 'utf8');

    return { outputs: { deployedVersion: ctx.build.buildId } };
  };

  const verify = async (ctx: PublishContext): Promise<VerifyResult> => {
    trace.verified = true;
    return { ok: true, message: `已确认 ${ctx.build.buildId} 生效` };
  };

  const rollback = async (ctx: PublishContext): Promise<StageResult> => {
    trace.rolledBack = true;
    ctx.log('指针已回退');
    return { outputs: { activated: 'true' } };
  };

  return { manifest, globalChecks: [], targetChecks: checks, execute, verify, rollback };
}

export const DOC_EXAMPLE_KIND_ID = manifest.id;
