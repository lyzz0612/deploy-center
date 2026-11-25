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

    let endpoint: string;
    try {
      endpoint = ctx.secret('endpoint').trim();
    } catch {
      endpoint = '';
    }
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

    return { ok: true, message: '密钥与 endpoint 已配置' };
  },
};

/**
 * L3：桶能不能通。
 *
 * 用 HeadBucket 这个只读调用来探：密钥失效、权限不含该桶、endpoint 指错
 * 账号、容器不能出网这四类问题都会在这里暴露，且没有任何副作用。
 */
const reachabilityCheck: Check<PublishContext> = {
  id: 'r2-reachable',
  name: '存储桶可达性',
  level: 'reachability',
  async run(ctx): Promise<CheckResult> {
    let bucket: string;
    try {
      bucket = readBucket(ctx);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    let client: ReturnType<typeof createClient>;
    try {
      client = createClient(ctx);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
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
