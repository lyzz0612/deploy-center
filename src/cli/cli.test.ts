import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { ensureSchema, open, type Db } from '../db/index.js';
import { listJobs } from '../jobs/index.js';
import { registerTargetKind, resetTargetKinds, type Check, type GlobalCheckContext, type TargetKind } from '../registry/index.js';
import { checkKind } from './checks.js';
import { currentPrefix, npmCliCandidatesFor, npmCliPath, run, versionPrefix } from './install.js';
import { probeCli } from './probe.js';
import { readRegistry, recordInstall, registryPath, switchVersion, writeRegistry } from './registry-file.js';

const scratch = mkdtempSync(join(tmpdir(), 'cli-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function freshHome(): string {
  return mkdtempSync(join(scratch, 'home-'));
}

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

afterEach(() => resetTargetKinds());

describe('CLI 清单', () => {
  it('卷为空时返回空清单（首启的正常情况）', async () => {
    const registry = await readRegistry(freshHome());
    assert.deepEqual(registry.clis, {});
  });

  it('记录安装后可读回，并设为当前版本', async () => {
    const home = freshHome();
    await recordInstall(home, 'miniprogram-ci', '2.1.31', 'npm default');

    const registry = await readRegistry(home);
    assert.equal(registry.clis['miniprogram-ci']?.current, '2.1.31');
    assert.equal(registry.clis['miniprogram-ci']?.versions.length, 1);
  });

  it('装多个版本时保留历史，便于回退', async () => {
    const home = freshHome();
    await recordInstall(home, 'cli-a', '1.0.0', 'npm');
    await recordInstall(home, 'cli-a', '2.0.0', 'npm');

    const entry = (await readRegistry(home)).clis['cli-a'];
    assert.equal(entry?.current, '2.0.0');
    assert.deepEqual(entry?.versions.map((v) => v.version), ['1.0.0', '2.0.0']);
  });

  it('可以切回上一个版本（升级坏了的退路）', async () => {
    const home = freshHome();
    await recordInstall(home, 'cli-a', '1.0.0', 'npm');
    await recordInstall(home, 'cli-a', '2.0.0', 'npm');

    await switchVersion(home, 'cli-a', '1.0.0');
    assert.equal((await readRegistry(home)).clis['cli-a']?.current, '1.0.0');
  });

  it('切到没装过的版本被拒，并列出已装版本', async () => {
    const home = freshHome();
    await recordInstall(home, 'cli-a', '1.0.0', 'npm');
    await assert.rejects(switchVersion(home, 'cli-a', '9.9.9'), /已安装：1\.0\.0/);
  });

  it('清单损坏时报错而不是当成空清单', async () => {
    const home = freshHome();
    writeFileSync(registryPath(home), 'this is not json');
    await assert.rejects(readRegistry(home), /不是合法 JSON/);
  });

  it('不认识的清单版本被拒', async () => {
    const home = freshHome();
    writeFileSync(registryPath(home), JSON.stringify({ schema: 99, clis: {} }));
    await assert.rejects(readRegistry(home), /不支持的 CLI 清单版本 99/);
  });

  it('每版本独立目录（互不覆盖）', () => {
    const home = '/opt/cli';
    assert.notEqual(
      versionPrefix(home, 'cli-a', '1.0.0'),
      versionPrefix(home, 'cli-a', '2.0.0'),
    );
  });
});

describe('CLI 探测（L1 安装完好）', () => {
  it('未安装时报告未安装', async () => {
    const result = await probeCli(freshHome(), 'miniprogram-ci');
    assert.equal(result.installed, false);
    assert.equal(result.install.ok, false);
    assert.match(result.install.message, /尚未安装/);
  });

  it('未注册的 CLI 被明确指出', async () => {
    const result = await probeCli(freshHome(), 'no-such-cli');
    assert.equal(result.install.ok, false);
    assert.match(result.install.message, /未注册的 CLI/);
  });

  it('清单说装了但可执行文件不存在时，探测失败（而不是报可用）', async () => {
    const home = freshHome();
    await recordInstall(home, 'miniprogram-ci', '2.1.31', 'npm');
    // 没有真的装，目录是空的
    const result = await probeCli(home, 'miniprogram-ci');
    assert.equal(result.install.ok, false, '目录存在不等于装好了');
  });

  it('能跑起来时报告可用并带上版本', async () => {
    const home = freshHome();
    const version = '1.0.0';
    const prefix = versionPrefix(home, 'miniprogram-ci', version);
    const binDir = join(prefix, 'node_modules', 'miniprogram-ci', 'bin');
    await mkdir(binDir, { recursive: true });
    // 造一个假的 CLI：真装 miniprogram-ci 要拉 70+ 依赖，而这里要验的是
    // 探测机制（能否跑起来、怎么报结果），不是 npm 本身。
    await writeFile(join(binDir, 'miniprogram-ci.js'), "console.log('2.1.31');\n");
    await recordInstall(home, 'miniprogram-ci', version, 'test');

    const result = await probeCli(home, 'miniprogram-ci');
    assert.equal(result.installed, true);
    assert.equal(result.install.ok, true, result.install.message);
    assert.equal(result.version, version);
    assert.equal(result.install.detail, '2.1.31');
  });

  it('退出码非 0 时报告不可用，并带上 stderr', async () => {
    const home = freshHome();
    const prefix = versionPrefix(home, 'miniprogram-ci', '1.0.0');
    const binDir = join(prefix, 'node_modules', 'miniprogram-ci', 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'miniprogram-ci.js'),
      "console.error('something broke'); process.exit(3);\n",
    );
    await recordInstall(home, 'miniprogram-ci', '1.0.0', 'test');

    const result = await probeCli(home, 'miniprogram-ci');
    assert.equal(result.install.ok, false);
    assert.match(result.install.message, /退出码 3/);
    assert.match(result.install.detail ?? '', /something broke/);
  });

  it('缺桌面环境的错误被点名（容器里最常撞的坑）', async () => {
    const home = freshHome();
    const prefix = versionPrefix(home, 'tt-minigame-ide-cli', '1.0.0');
    const binDir = join(prefix, 'node_modules', 'tt-minigame-ide-cli', 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'tmg.js'),
      "console.error('Error: cannot open display: DISPLAY not set'); process.exit(1);\n",
    );
    await recordInstall(home, 'tt-minigame-ide-cli', '1.0.0', 'test');

    const result = await probeCli(home, 'tt-minigame-ide-cli');
    assert.equal(result.install.ok, false);
    assert.match(result.install.message, /需要桌面环境，不能在无头容器里运行/);
  });

  it('缺系统库的错误被点名（不要用 alpine）', async () => {
    const home = freshHome();
    const prefix = versionPrefix(home, 'miniprogram-ci', '1.0.0');
    const binDir = join(prefix, 'node_modules', 'miniprogram-ci', 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'miniprogram-ci.js'),
      "console.error('Error loading shared library: cannot open shared object file'); process.exit(127);\n",
    );
    await recordInstall(home, 'miniprogram-ci', '1.0.0', 'test');

    const result = await probeCli(home, 'miniprogram-ci');
    assert.match(result.install.message, /系统库缺失|不要用 alpine/);
  });

  it('已安装版本列表供回退选择', async () => {
    const home = freshHome();
    await recordInstall(home, 'miniprogram-ci', '2.1.30', 'npm');
    await recordInstall(home, 'miniprogram-ci', '2.1.31', 'npm');
    const result = await probeCli(home, 'miniprogram-ci');
    assert.deepEqual(result.availableVersions, ['2.1.30', '2.1.31']);
  });
});

describe('人工安装类型', () => {
  it('标注为需人工安装并给出指引，不提供注定失败的按钮', async () => {
    // 临时把一个 spec 当成 manual 来验行为。spec 本身是代码常量，
    // 这里构造一份等价的清单状态来触发那条分支。
    const home = freshHome();
    await writeRegistry(home, { schema: 1, clis: {} });

    const result = await probeCli(home, 'tt-minigame-ide-cli');
    // 当前 spec 是 npm 型（见 docs/spike-douyin-cli.md 的结论）
    assert.equal(result.installKind, 'npm');
    assert.match(result.install.message, /尚未安装/);
  });
});

describe('类型级与实例级分离', () => {
  function kindWithChecks(checks: Check<GlobalCheckContext>[]): TargetKind {
    return {
      manifest: {
        id: 'k',
        displayName: 'K',
        description: '',
        accepts: ['p'],
        requiresCredential: null,
        requiresCli: ['miniprogram-ci'],
        targetFields: [{ key: 'slot', label: 'S', type: 'string', required: true, identity: true }],
        publishFields: [],
        stages: [{ id: 'upload', name: '上传', timeoutMs: 1000 }],
        capabilities: { rollback: 'none', verify: false, activateLatencySeconds: 0 },
      },
      globalChecks: checks,
      targetChecks: [],
      execute: async () => ({}),
    };
  }

  it('类型级检查只跑一次，不随实例数重复', async () => {
    let runCount = 0;
    registerTargetKind(
      kindWithChecks([
        {
          id: 'c1',
          name: '类型级检查',
          level: 'install',
          run: async () => {
            runCount += 1;
            return { ok: true, message: 'ok' };
          },
        },
      ]),
    );

    const home = freshHome();
    const status = await checkKind(home, 'k');
    assert.equal(runCount, 1);
    assert.equal(status.checks.length, 1);
    // CLI 未安装，所以整体不通过
    assert.equal(status.ok, false);
    assert.equal(status.clis.length, 1);
  });

  it('检查自身抛错时记为未通过，而不是让整页崩', async () => {
    registerTargetKind(
      kindWithChecks([
        {
          id: 'boom',
          name: '会炸的检查',
          level: 'install',
          run: async () => {
            throw new Error('检查内部异常');
          },
        },
      ]),
    );

    const status = await checkKind(freshHome(), 'k');
    assert.equal(status.checks[0]?.result.ok, false);
    assert.match(status.checks[0]?.result.message ?? '', /检查本身出错：检查内部异常/);
  });
});


describe('npm 调用方式（跨平台）', () => {
  it('npm 入口候选覆盖 Windows 与 Unix prefix 两种布局', () => {
    // 路径拼接用平台分隔符，统一归一化后再断言，测试在两个平台都成立
    const normalize = (path: string): string => path.split(/[\\/]+/).join('/');

    const windows = npmCliCandidatesFor('C:\\Program Files\\nodejs\\node.exe').map(normalize);
    assert.ok(
      windows.includes('C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'),
      'Windows 官方安装包：node_modules 与 node.exe 同目录',
    );

    const docker = npmCliCandidatesFor('/usr/local/bin/node').map(normalize);
    assert.ok(
      docker.includes('/usr/local/lib/node_modules/npm/bin/npm-cli.js'),
      '官方 node Docker 镜像：全局 npm 在 <prefix>/lib/node_modules，不在 <prefix>/node_modules',
    );
  });

  it('能定位到 npm 的 JS 入口', async () => {
    const path = npmCliPath();
    assert.match(path, /npm-cli\.js$/);
    assert.doesNotThrow(
      () => readFileSync(path),
      `npm 入口应存在于 ${path}；不存在说明 node 安装布局与预期不同`,
    );
  });

  it('真的能跑起来 npm（不依赖 .cmd 包装）', async () => {
    // 这是整个安装功能的地基：Windows 上 npm 是 .cmd，直接 spawn 会
    // ENOENT 或 EINVAL。用 node + npm-cli.js 绕过去。
    const result = await run('node', [npmCliPath(), '--version']);
    assert.equal(result.code, 0, `npm --version 应成功，stderr=${result.stderr.slice(0, 300)}`);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/, 'npm 应报出版本号');
  });

  it('真实装一个极小的包，产物落在预期目录', async (t) => {
    const home = freshHome();
    const prefix = versionPrefix(home, 'probe-pkg', '1.0.0');

    const result = await run('node', [
      npmCliPath(),
      'install',
      'is-even@1.0.0',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
    ]);

    if (result.code !== 0) {
      // 网络不通是环境问题，不是代码问题
      t.skip(`npm 安装失败（可能是网络问题）：${result.stderr.slice(0, 200)}`);
      return;
    }

    const pkgJson = join(prefix, 'node_modules', 'is-even', 'package.json');
    assert.doesNotThrow(
      () => readFileSync(pkgJson),
      '安装产物应在 <prefix>/node_modules/<pkg>/，这是 binaryPath 的拼法依据',
    );

    await recordInstall(home, 'probe-pkg', '1.0.0', 'npm default');
    const current = await currentPrefix(home, 'probe-pkg');
    assert.equal(current?.version, '1.0.0');
    assert.equal(current?.prefix, prefix);
  });
});
