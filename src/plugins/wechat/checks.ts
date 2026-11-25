/**
 * 微信目标的环境检查（cli-management spec：三层可用性探测）。
 *
 * 类型级（install）由核心统一探 CLI，这里只补插件自己需要的；
 * 实例级分两层：credential 验凭据格式，reachability 真的调一次平台只读 API。
 *
 * reachability 这一层是唯一能暴露「密钥有效但出口 IP 未在白名单」的地方。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Check, CheckResult, PublishContext } from '../../registry/index.js';
import { loadMiniProgramCi } from './sdk.js';

/** 微信私钥的 PEM 头。 */
const PRIVATE_KEY_HEADER = /-----BEGIN (RSA )?PRIVATE KEY-----/;

function readAppid(ctx: PublishContext): string {
  const appid = ctx.target['appid'];
  if (typeof appid !== 'string' || appid.length === 0) {
    throw new Error('目标配置缺少 appid');
  }
  return appid;
}

/**
 * L2：凭据格式能不能用。
 *
 * 只验格式不验有效性：有效性要调平台，那是 L3 的事。分开的意义在于
 * 「私钥贴错了」和「私钥对但 IP 没加白」需要完全不同的处置。
 */
const credentialCheck: Check<PublishContext> = {
  id: 'wechat-private-key',
  name: '上传私钥格式',
  level: 'credential',
  async run(ctx): Promise<CheckResult> {
    let key: string;
    try {
      key = ctx.secret('content');
    } catch (error) {
      return {
        ok: false,
        message: `取不到私钥：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!PRIVATE_KEY_HEADER.test(key)) {
      return {
        ok: false,
        message: '私钥内容不是 PEM 格式。应从微信公众平台下载「代码上传密钥」文件，整个贴进来',
      };
    }
    return { ok: true, message: '私钥格式正确' };
  },
};

/**
 * L3：平台能不能通。
 *
 * 用 `getLatestVersion` 这个只读调用来探：它会真的带着私钥访问平台，
 * 所以密钥失效、网络不通、出口 IP 未加白这三类问题都会在这里暴露，
 * 而且不产生任何副作用。
 */
const reachabilityCheck: Check<PublishContext> = {
  id: 'wechat-platform-reachable',
  name: '平台可达性',
  level: 'reachability',
  async run(ctx): Promise<CheckResult> {
    let appid: string;
    try {
      appid = readAppid(ctx);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    let ci: Awaited<ReturnType<typeof loadMiniProgramCi>>;
    try {
      ci = await loadMiniProgramCi(ctx.cliHome);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    // 检查阶段没有工作目录（checkTarget 传的是空串），所以自己开一个临时的。
    // 项目目录可以是空的：getLatestVersion 只用 appid 与私钥，不读代码。
    const dir = await mkdtemp(join(tmpdir(), 'wechat-probe-'));
    const keyPath = join(dir, 'private.key');
    try {
      await writeFile(keyPath, ctx.secret('content'), { encoding: 'utf8', mode: 0o600 });
      const project = new ci.Project({
        projectPath: dir,
        type: 'miniGame',
        appid,
        privateKeyPath: keyPath,
      });
      const result = await ci.getLatestVersion({ project });
      return {
        ok: true,
        message: `平台可达，当前线上版本 ${result.latestVersion}`,
        ...(result.grayReleaseVersion !== undefined && {
          detail: `灰度版本 ${result.grayReleaseVersion}`,
        }),
      };
    } catch (error) {
      return classifyPlatformError(error, appid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/**
 * 把平台错误翻译成可行动的结论。
 *
 * 笼统的「调用失败」对用户没用：IP 白名单、私钥不匹配、appid 写错这三种
 * 的下一步完全不同，而它们的 errcode 是确定的。
 */
export function classifyPlatformError(error: unknown, appid: string): CheckResult {
  const message = error instanceof Error ? error.message : String(error);

  // 微信把错误塞在 message 里，形如 "errcode: 40013, errmsg: invalid appid"
  const codeMatch = /errcode[":\s]*(-?\d+)/i.exec(message);
  const code = codeMatch === null ? null : Number(codeMatch[1]);

  if (/ip|whitelist|白名单/i.test(message) || code === 40164) {
    return {
      ok: false,
      message:
        '私钥有效，但本机出口 IP 不在白名单内。到微信公众平台的「开发管理 → 开发设置 → 小程序代码上传」把本机公网 IP 加进去',
      detail: message,
    };
  }
  if (code === 40013) {
    return { ok: false, message: `appid ${appid} 不存在或格式不对`, detail: message };
  }
  if (code === 40001 || /invalid credential|私钥/i.test(message)) {
    return {
      ok: false,
      message: '私钥与该 appid 不匹配，或已在平台上被重置',
      detail: message,
    };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(message)) {
    return { ok: false, message: '连不上微信平台，检查容器的出网能力', detail: message };
  }
  return {
    ok: false,
    message: `平台调用失败${code === null ? '' : `（errcode ${code}）`}`,
    detail: message,
  };
}

export const wechatTargetChecks: readonly Check<PublishContext>[] = [
  credentialCheck,
  reachabilityCheck,
];
