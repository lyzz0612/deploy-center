/**
 * 微信小游戏的上传执行与结果验证。
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PublishContext, StageResult, VerifyResult } from '../../registry/index.js';
import { classifyPlatformError } from './checks.js';
import { loadMiniProgramCi } from './sdk.js';

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${what}缺少 ${key}`);
  }
  return value;
}

/**
 * 找到项目根目录。
 *
 * 有些打包流程会把内容套一层目录（zip 里是 `dist/game.js` 而不是 `game.js`），
 * 这时直接把解压目录当项目根会让 CLI 找不到 `game.json`。往下探一层比让
 * 用户自己去改打包脚本现实。
 */
async function resolveProjectPath(artifactDir: string, log: (line: string) => void): Promise<string> {
  const marker = 'game.json';
  const entries = await readdir(artifactDir, { withFileTypes: true });

  if (entries.some((e) => e.isFile() && e.name === marker)) {
    return artifactDir;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const nested = join(artifactDir, dirs[0]!.name);
    const nestedEntries = await readdir(nested);
    if (nestedEntries.includes(marker)) {
      log(`产物套了一层目录，使用 ${dirs[0]!.name}/ 作为项目根`);
      return nested;
    }
  }

  // 找不到 game.json 就直接报错，而不是让 CLI 抛一个更难懂的错。
  throw new Error(
    `产物里找不到 ${marker}（已查看根目录与唯一的一层子目录）。` +
      `根目录内容：${entries.map((e) => e.name).slice(0, 10).join(', ')}`,
  );
}

export async function wechatExecute(stageId: string, ctx: PublishContext): Promise<StageResult> {
  if (stageId !== 'upload') {
    throw new Error(`微信插件没有阶段 ${stageId}`);
  }

  const appid = requireString(ctx.target, 'appid', '目标配置');
  const version = requireString(ctx.params, 'version', '发布参数');
  const desc = requireString(ctx.params, 'desc', '发布参数');
  const robotRaw = ctx.params['robot'];
  const robot = typeof robotRaw === 'number' ? robotRaw : 1;
  if (!Number.isInteger(robot) || robot < 1 || robot > 30) {
    throw new Error(`CI 机器人编号必须是 1-30 的整数，实际为 ${String(robotRaw)}`);
  }

  // 先做不需要 CLI 的检查：产物结构不对是用户能自己修的问题，而且探测它
  // 不需要加载 CLI。顺序反了的话，CLI 没装时就看不到产物问题。
  const projectPath = await resolveProjectPath(ctx.artifactDir, ctx.log);
  const info = await stat(projectPath);
  if (!info.isDirectory()) {
    throw new Error(`项目路径 ${projectPath} 不是目录`);
  }

  const ci = await loadMiniProgramCi(ctx.cliHome);

  // 私钥由核心物化成文件并在任务结束后删除（design.md D4 规则 1）
  const privateKeyPath = await ctx.secretFile('content');

  ctx.log(`上传到 appid ${appid}，版本 ${version}，robot ${robot}`);

  const project = new ci.Project({
    projectPath,
    type: 'miniGame',
    appid,
    privateKeyPath,
  });

  try {
    const result = await ci.upload({
      project,
      version,
      desc,
      robot,
      // 显式传编译设置，不依赖默认值：默认值会随 CLI 版本变，而发布结果
      // 的差异（是否压缩、是否转 ES5）不该因为升级 CLI 而悄悄改变。
      setting: {
        es6: true,
        es7: true,
        minify: true,
        codeProtect: false,
        autoPrefixWXSS: true,
        ignoreUploadUnusedFiles: true,
      },
      onProgressUpdate: (task) => {
        if (typeof task === 'string' && task.trim().length > 0) {
          ctx.log(task.trim());
        }
      },
    });

    const outputs: Record<string, string> = { appid, version, robot: String(robot) };
    if (result.subPackageInfo !== undefined) {
      const total = result.subPackageInfo.find((p) => p.name === '__FULL__');
      if (total !== undefined) {
        outputs['totalSizeBytes'] = String(total.size);
        ctx.log(`代码包总大小 ${total.size} 字节`);
      }
    }
    ctx.log('上传完成');
    return { outputs };
  } catch (error) {
    const classified = classifyPlatformError(error, appid);
    throw new Error(`${classified.message}${classified.detail === undefined ? '' : `（${classified.detail}）`}`);
  }
}

/**
 * 验证：平台上能查到刚上传的版本。
 *
 * 注意这里查的是「最新线上版本」，而上传产生的是**开发版**，所以不能用
 * 版本号相等来判定——刚上传的版本还没提审发布，线上版本不会变。
 * 能成功调通就说明上传链路是通的；真正的「这个版本上线了」要等人提审。
 */
export async function wechatVerify(ctx: PublishContext): Promise<VerifyResult> {
  const appid = requireString(ctx.target, 'appid', '目标配置');
  const version = requireString(ctx.params, 'version', '发布参数');

  try {
    const ci = await loadMiniProgramCi(ctx.cliHome);
    const privateKeyPath = await ctx.secretFile('content');
    const project = new ci.Project({
      projectPath: ctx.artifactDir,
      type: 'miniGame',
      appid,
      privateKeyPath,
    });
    const latest = await ci.getLatestVersion({ project });
    return {
      ok: true,
      message:
        `上传的 ${version} 已在平台的开发版列表中（线上版本仍是 ${latest.latestVersion}，` +
        '需要在平台提审并发布才会变）',
    };
  } catch (error) {
    const classified = classifyPlatformError(error, appid);
    return { ok: false, message: `验证失败：${classified.message}` };
  }
}
