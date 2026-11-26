/**
 * H5 R2 目标的环境检查。
 *
 * 没有 install 层：这个 kind 不依赖任何外部 CLI，SDK 随镜像一起装好。
 * 实例级分两层：credential 验凭据字段是否齐全可用，reachability 真的对桶
 * 发一次只读请求。
 *
 * reachability 这一层是唯一能暴露「密钥格式没问题但权限不含这个桶」或
 * 「endpoint 写的是另一个账号」的地方。
 */
import type { Check, CheckResult, PublishContext } from '../../registry/index.js';
import { createClient, headBucket, isNotFound } from './client.js';

function readBucket(ctx: PublishContext): string {
  const bucket = ctx.target['bucket'];
  if (typeof bucket !== 'string' || bucket.trim() === '') {
    throw new Error('目标配置缺少 bucket');
  }
  return bucket.trim();
}

/**
 * L2：凭据字段齐不齐、形状对不对。
 *
 * 只验形状不验有效性：有效性要真的调一次存储，那是 L3 的事。分开的意义
 * 在于「endpoint 忘填了」和「endpoint 填了但密钥没这个桶的权限」需要
 * 完全不同的处置。
 */
const credentialCheck: Check<PublishContext> = {
  id: 'r2-credential',
  name: '密钥与 endpoint',
  level: 'credential',
  async run(ctx): Promise<CheckResult> {
    // 必填字段：没有值时 secret() 会抛，这里逐个兜住，一次把缺的都列出来
    const missing: string[] = [];
    for (const field of ['accessKeyId', 'secretAccessKey'] as const) {
      try {
        if (ctx.secret(field).trim() === '') missing.push(field);
      } catch {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      return { ok: false, message: `凭据缺少必填字段：${missing.join('、')}` };
    }

    // endpoint 在凭据里是可选字段，但 R2 必须有它，所以在这一层拦住。
    // 用 secretOptional 读：用 secret() 会在没填时抛「凭据里没有字段」，
    // 那条信息指不到「该去填 endpoint」。
    const endpoint = ctx.secretOptional('endpoint').trim();
    if (endpoint === '') {
      return {
        ok: false,
        message:
          'R2 必须在凭据里填 endpoint，形如 https://<accountid>.r2.cloudflarestorage.com。' +
          '留空会让 SDK 去连 AWS',
      };
    }
    if (!/^https?:\/\//.test(endpoint)) {
      return { ok: false, message: `endpoint 必须以 http(s):// 开头，当前是 ${endpoint}` };
    }

    // region 不检查：R2 忽略它，留空时按 'auto' 处理
    return { ok: true, message: '密钥与 endpoint 已配置' };
  },
};

/**
 * L3：桶能不能通。
 *
 * **直接发一次真请求，不做任何预校验。** 这一层的全部价值就在于「真的试
 * 一下」：密钥失效、权限不含该桶、endpoint 指错账号、容器不能出网，这些
 * 都只有发出去才知道。在这里重复检查字段只会让失败停在本地，报出来的是
 * 「凭据里没有字段 region」这种与可达性无关的话——那正是 L2 的职责。
 *
 * 用 HeadBucket：只读、无副作用。
 */
const reachabilityCheck: Check<PublishContext> = {
  id: 'r2-reachable',
  name: '存储桶可达性',
  level: 'reachability',
  async run(ctx): Promise<CheckResult> {
    let bucket: string;
    let client: ReturnType<typeof createClient>;
    try {
      bucket = readBucket(ctx);
      client = createClient(ctx);
    } catch (error) {
      // 连请求都发不出去（目标没填 bucket、凭据缺 endpoint）。这类问题
      // L2 已经报过，这里如实说明「没能发出请求」，不要伪装成可达性结论。
      return {
        ok: false,
        message: `没能发起请求：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      await headBucket({ client, bucket, ctx });
      return { ok: true, message: `桶 ${bucket} 可访问` };
    } catch (error) {
      return classifyStorageError(error, bucket);
    } finally {
      client.destroy();
    }
  },
};

/**
 * 把存储错误翻译成可行动的结论。
 *
 * 笼统的「上传失败」对用户没用：桶名写错、密钥无权、endpoint 指错账号、
 * 容器不能出网这四种的下一步完全不同，而它们在协议层是可区分的。
 */
export function classifyStorageError(error: unknown, bucket: string): CheckResult {
  const message = error instanceof Error ? error.message : String(error);
  const name = typeof error === 'object' && error !== null ? String((error as { name?: unknown }).name ?? '') : '';
  const status =
    typeof error === 'object' && error !== null
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;

  if (isNotFound(error) || name === 'NoSuchBucket') {
    return {
      ok: false,
      message: `桶 ${bucket} 不存在，或凭据里的 endpoint 指向另一个账号。后台不会自动建桶`,
      detail: message,
    };
  }
  if (status === 403 || name === 'AccessDenied' || /access denied/i.test(message)) {
    return {
      ok: false,
      message: `密钥能用但没有桶 ${bucket} 的权限。到 Cloudflare 控制台确认这个 API token 的桶范围与读写权限`,
      detail: message,
    };
  }
  if (status === 401 || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return {
      ok: false,
      message: 'Access Key ID 或 Secret Access Key 不正确（或已在 Cloudflare 侧吊销）',
      detail: message,
    };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|getaddrinfo/i.test(message)) {
    return {
      ok: false,
      message: '连不上 R2，检查容器的出网能力与 endpoint 域名是否写对',
      detail: message,
    };
  }
  return {
    ok: false,
    message: `存储调用失败${status === undefined ? '' : `（HTTP ${status}）`}`,
    detail: message,
  };
}

export const h5R2TargetChecks: readonly Check<PublishContext>[] = [
  credentialCheck,
  reachabilityCheck,
];
