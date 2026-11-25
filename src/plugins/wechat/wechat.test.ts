import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createContext } from '../../releases/index.js';
import { validateFields } from '../../registry/index.js';
import { classifyPlatformError } from './checks.js';
import { wechatPlugin } from './index.js';
import { wechatManifest } from './manifest.js';
import { wechatExecute } from './publish.js';
import { CliNotInstalledError, loadMiniProgramCi } from './sdk.js';

const scratch = mkdtempSync(join(tmpdir(), 'wechat-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';

async function makeCtx(options: {
  artifactDir: string;
  target?: Record<string, unknown>;
  params?: Record<string, unknown>;
  cliHome?: string;
  secrets?: Record<string, string>;
}): Promise<Awaited<ReturnType<typeof createContext>>> {
  const workdir = mkdtempSync(join(scratch, 'work-'));
  return createContext({
    artifactDir: options.artifactDir,
    workdir,
    build: {
      buildId: 'test-build',
      commitSha: null,
      packageTypeId: 'wechat',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
    },
    target: options.target ?? { appid: 'wx0123456789abcdef' },
    params: options.params ?? { version: '1.0.0', desc: '测试' },
    cliHome: options.cliHome ?? join(scratch, 'empty-cli'),
    secrets: options.secrets ?? { content: PEM },
    log: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  });
}

describe('manifest 声明', () => {
  it('只接受微信包，需要 file 型凭据与 miniprogram-ci', () => {
    assert.deepEqual(wechatManifest.accepts, ['wechat']);
    assert.equal(wechatManifest.requiresCredential, 'file');
    assert.deepEqual(wechatManifest.requiresCli, ['miniprogram-ci']);
  });

  it('目标字段里没有任何密钥字段（密钥在凭据里）', () => {
    for (const field of wechatManifest.targetFields) {
      assert.equal(
        /secret|password|privatekey|token/i.test(field.key),
        false,
        `targetFields 不该含密钥字段 ${field.key}`,
      );
    }
  });

  it('appid 参与去重，备注不参与', () => {
    const appid = wechatManifest.targetFields.find((f) => f.key === 'appid');
    const note = wechatManifest.targetFields.find((f) => f.key === 'note');
    assert.equal(appid?.identity, true);
    assert.notEqual(note?.identity, true);
  });

  it('回滚声明为 republish（平台侧没有回滚动作）', () => {
    assert.equal(wechatManifest.capabilities.rollback, 'republish');
  });

  it('声明了 verify 且确实实现了它', () => {
    assert.equal(wechatManifest.capabilities.verify, true);
    assert.equal(typeof wechatPlugin.verify, 'function');
  });

  it('提供了实例级的凭据层与可达层检查', () => {
    const levels = wechatPlugin.targetChecks.map((c) => c.level);
    assert.ok(levels.includes('credential'), '应有凭据层检查');
    assert.ok(levels.includes('reachability'), '应有可达层检查');
  });
});

describe('发布参数校验', () => {
  it('版本号必须形如 1.0.0', () => {
    const fields = wechatManifest.publishFields;
    assert.equal(validateFields(fields, { version: '1.0.0', desc: 'x' }).length, 0);
    for (const bad of ['v1.0.0', '1.0', '1.0.0-beta', 'latest']) {
      const errors = validateFields(fields, { version: bad, desc: 'x' });
      assert.equal(errors.length, 1, `${bad} 应被拒`);
      assert.match(errors[0]!.message, /格式不正确/);
    }
  });

  it('版本号与描述都是必填', () => {
    const errors = validateFields(wechatManifest.publishFields, {});
    assert.deepEqual(errors.map((e) => e.key).sort(), ['desc', 'version']);
  });

  it('robot 是可选的数字', () => {
    assert.equal(validateFields(wechatManifest.publishFields, { version: '1.0.0', desc: 'x' }).length, 0);
    assert.equal(
      validateFields(wechatManifest.publishFields, { version: '1.0.0', desc: 'x', robot: 5 }).length,
      0,
    );
    assert.equal(
      validateFields(wechatManifest.publishFields, { version: '1.0.0', desc: 'x', robot: 'five' })
        .length,
      1,
    );
  });

  it('appid 格式被校验', () => {
    const fields = wechatManifest.targetFields;
    assert.equal(validateFields(fields, { appid: 'wx0123456789abcdef' }).length, 0);
    for (const bad of ['wx123', 'notwx0123456789ab', 'wx0123456789ABCDEF']) {
      assert.equal(validateFields(fields, { appid: bad }).length, 1, `${bad} 应被拒`);
    }
  });
});

describe('执行期参数检查', () => {
  it('robot 超出 1-30 被拒', async () => {
    const dir = mkdtempSync(join(scratch, 'artifact-'));
    await writeFile(join(dir, 'game.json'), '{}');

    for (const robot of [0, 31, 1.5]) {
      const managed = await makeCtx({
        artifactDir: dir,
        params: { version: '1.0.0', desc: 'x', robot },
      });
      try {
        await assert.rejects(
          wechatExecute('upload', managed.ctx),
          /机器人编号必须是 1-30 的整数/,
          `robot=${robot} 应被拒`,
        );
      } finally {
        await managed.cleanupSecrets();
      }
    }
  });

  it('未知阶段被拒', async () => {
    const dir = mkdtempSync(join(scratch, 'artifact-'));
    const managed = await makeCtx({ artifactDir: dir });
    try {
      await assert.rejects(wechatExecute('submit', managed.ctx), /没有阶段 submit/);
    } finally {
      await managed.cleanupSecrets();
    }
  });

  it('缺 appid 被拒', async () => {
    const dir = mkdtempSync(join(scratch, 'artifact-'));
    const managed = await makeCtx({ artifactDir: dir, target: {} });
    try {
      await assert.rejects(wechatExecute('upload', managed.ctx), /缺少 appid/);
    } finally {
      await managed.cleanupSecrets();
    }
  });
});

describe('项目根目录探测', () => {
  it('CLI 未安装时报错说清下一步，而不是抛 MODULE_NOT_FOUND', async () => {
    const dir = mkdtempSync(join(scratch, 'artifact-'));
    await writeFile(join(dir, 'game.json'), '{}');

    const managed = await makeCtx({ artifactDir: dir, cliHome: join(scratch, 'no-cli') });
    try {
      await assert.rejects(
        wechatExecute('upload', managed.ctx),
        (error: unknown) => {
          assert.ok(error instanceof CliNotInstalledError);
          assert.match(error.message, /尚未安装/);
          assert.match(error.message, /CLI 管理/, '应指出去哪里安装');
          return true;
        },
      );
    } finally {
      await managed.cleanupSecrets();
    }
  });

  it('产物里找不到 game.json 时报错并列出实际内容', async () => {
    const dir = mkdtempSync(join(scratch, 'bad-artifact-'));
    await writeFile(join(dir, 'readme.txt'), 'x');
    await writeFile(join(dir, 'index.html'), 'x');

    const managed = await makeCtx({ artifactDir: dir });
    try {
      await assert.rejects(wechatExecute('upload', managed.ctx), (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /找不到 game\.json/);
        assert.match(message, /readme\.txt|index\.html/, '应列出实际内容帮助排查');
        return true;
      });
    } finally {
      await managed.cleanupSecrets();
    }
  });

  it('产物套了一层目录时能找到项目根', async () => {
    // 这是很常见的打包形态：zip 里是 dist/game.json 而不是 game.json
    const dir = mkdtempSync(join(scratch, 'nested-'));
    const inner = join(dir, 'dist');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'game.json'), '{}');

    const logs: string[] = [];
    const managed = await createContext({
      artifactDir: dir,
      workdir: mkdtempSync(join(scratch, 'work-')),
    build: {
      buildId: 'test-build',
      commitSha: null,
      packageTypeId: 'test-pkg',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
    },
      target: { appid: 'wx0123456789abcdef' },
      params: { version: '1.0.0', desc: 'x' },
      cliHome: join(scratch, 'no-cli'),
      secrets: { content: PEM },
      log: (line) => logs.push(line),
      progress: () => {},
      signal: new AbortController().signal,
    });

    try {
      // 会在加载 CLI 时失败，但那发生在项目根探测之后
      await assert.rejects(wechatExecute('upload', managed.ctx), CliNotInstalledError);
      assert.ok(
        logs.some((l) => /套了一层目录/.test(l)),
        `应记录目录探测结果，实际日志：${JSON.stringify(logs)}`,
      );
    } finally {
      await managed.cleanupSecrets();
    }
  });
});

describe('平台错误分类', () => {
  it('IP 白名单问题被点名，并指出去哪里改', () => {
    for (const message of [
      'errcode: 40164, errmsg: invalid ip 1.2.3.4, not in whitelist',
      'Error: ip not in whitelist',
      '当前 IP 不在白名单中',
    ]) {
      const result = classifyPlatformError(new Error(message), 'wx1');
      assert.equal(result.ok, false);
      assert.match(result.message, /出口 IP 不在白名单/, message);
      assert.match(result.message, /开发设置/, '应指出到哪里配置');
    }
  });

  it('appid 错误与私钥错误被区分', () => {
    const appidError = classifyPlatformError(
      new Error('errcode: 40013, errmsg: invalid appid'),
      'wx-bad',
    );
    assert.match(appidError.message, /appid wx-bad 不存在或格式不对/);

    const keyError = classifyPlatformError(
      new Error('errcode: 40001, errmsg: invalid credential'),
      'wx1',
    );
    assert.match(keyError.message, /私钥与该 appid 不匹配/);

    assert.notEqual(appidError.message, keyError.message, '两类错误文案必须不同');
  });

  it('网络问题与平台拒绝被区分', () => {
    const network = classifyPlatformError(new Error('getaddrinfo ENOTFOUND api.weixin.qq.com'), 'wx1');
    assert.match(network.message, /连不上微信平台/);

    const refused = classifyPlatformError(new Error('errcode: 85013, errmsg: something else'), 'wx1');
    assert.match(refused.message, /errcode 85013/);
    assert.notEqual(network.message, refused.message);
  });

  it('原始错误保留在 detail 里，便于排查', () => {
    const raw = 'errcode: 40164, errmsg: invalid ip 203.0.113.5';
    const result = classifyPlatformError(new Error(raw), 'wx1');
    assert.equal(result.detail, raw);
  });
});

describe('凭据层检查', () => {
  it('非 PEM 内容被拒，并说明该贴什么', async () => {
    const managed = await makeCtx({
      artifactDir: scratch,
      secrets: { content: 'this is not a pem key' },
    });
    try {
      const check = wechatPlugin.targetChecks.find((c) => c.level === 'credential');
      assert.ok(check);
      const result = await check.run(managed.ctx);
      assert.equal(result.ok, false);
      assert.match(result.message, /不是 PEM 格式/);
      assert.match(result.message, /代码上传密钥/, '应说明从哪里拿这个文件');
    } finally {
      await managed.cleanupSecrets();
    }
  });

  it('合法 PEM 通过', async () => {
    const managed = await makeCtx({ artifactDir: scratch, secrets: { content: PEM } });
    try {
      const check = wechatPlugin.targetChecks.find((c) => c.level === 'credential')!;
      const result = await check.run(managed.ctx);
      assert.equal(result.ok, true);
    } finally {
      await managed.cleanupSecrets();
    }
  });
});

describe('SDK 加载', () => {
  it('CLI 未安装时抛 CliNotInstalledError', async () => {
    await assert.rejects(
      loadMiniProgramCi(join(scratch, 'definitely-no-cli')),
      CliNotInstalledError,
    );
  });
});
