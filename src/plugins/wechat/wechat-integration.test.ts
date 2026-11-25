/**
 * 微信插件与核心的集成：阶段编排、输出写入记录、凭据物化与清理。
 *
 * 用一个装在 CLI 卷里的 stub 替代真实 miniprogram-ci（见
 * stub-cli.test-helper.ts）。**这不等于一次真实上传**：它验证的是插件
 * 传给 CLI 的参数正确、返回值被正确记录、失败被正确分类，而不是微信
 * 平台的实际行为。真实上传需要一个小游戏账号与代码上传密钥。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { buildZip, sha256 } from '../../artifacts/zip-fixture.test-helper.js';
import { createGame, createPackageType } from '../../catalog/index.js';
import { createCredential } from '../../credentials/index.js';
import { ensureSchema, open, type Db } from '../../db/index.js';
import { enqueue, startRunner } from '../../jobs/index.js';
import { createRelease, executeRelease, getRelease } from '../../releases/index.js';
import { registerTargetKind, resetTargetKinds } from '../../registry/index.js';
import { createTarget } from '../../targets/index.js';
import { wechatPlugin } from './index.js';
import { installStubCli, type StubBehavior } from './stub-cli.test-helper.js';

const KEY = 'test-master-key-of-enough-length';
const APPID = 'wx0123456789abcdef';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nSTUBKEY\n-----END RSA PRIVATE KEY-----';

const scratch = mkdtempSync(join(tmpdir(), 'wechat-int-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// 产物：一个最小的小游戏包（必须有 game.json）
const zipBody = buildZip([
  { name: 'game.json', content: Buffer.from('{"deviceOrientation":"portrait"}') },
  { name: 'game.js', content: Buffer.from('console.log("hi")') },
]);

let server: Server;
let base: string;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(zipBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => resetTargetKinds());

interface Scenario {
  readonly db: Db;
  readonly releaseId: string;
  readonly cliHome: string;
  readonly callsFile: string;
}

async function setup(
  behavior: StubBehavior = {},
  params: Record<string, unknown> = { version: '1.4.0', desc: 'feat: 新手引导', robot: 2 },
): Promise<Scenario> {
  registerTargetKind(wechatPlugin);

  const cliHome = mkdtempSync(join(scratch, 'cli-'));
  const { callsFile } = await installStubCli(cliHome, behavior);

  const db = open({ file: ':memory:' });
  ensureSchema(db);

  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  createPackageType(db, { id: 'wechat', displayName: '微信小游戏' });
  const credential = createCredential(
    db,
    { name: 'wx-upload-key', type: 'file', secrets: { content: PEM } },
    KEY,
  );
  const target = createTarget(
    db,
    {
      gameId: game.id,
      kind: 'wechat',
      name: '微信正式号',
      credentialId: credential.id,
      location: { appid: APPID },
    },
    KEY,
  );

  const buildPk = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, commit_sha, reported_at)
     VALUES (?, ?, 'wechat', 'b20261125', ?, ?, ?, 'a1b2c3d', ?)`,
  ).run(buildPk, game.id, `${base}/pkg.zip`, zipBody.length, sha256(zipBody), new Date().toISOString());

  const release = createRelease(db, {
    buildId: buildPk,
    targetId: target.id,
    params,
    stageIds: ['upload'],
  });

  return { db, releaseId: release.id, cliHome, callsFile };
}

async function run(s: Scenario): Promise<void> {
  const runner = startRunner({
    db: s.db,
    handlers: {
      publish: (job) =>
        executeRelease(
          { db: s.db, masterKey: KEY, cliHome: s.cliHome, workParentDir: scratch },
          job,
        ),
    },
    timeoutMs: 30_000,
  });
  try {
    enqueue(s.db, 'publish', s.releaseId);
    await runner.tick();
  } finally {
    runner.stop();
  }
}

interface Call {
  readonly call: string;
  readonly options?: Record<string, unknown>;
  readonly version?: string;
  readonly desc?: string;
  readonly robot?: number;
  readonly setting?: Record<string, unknown>;
}

function readCalls(s: Scenario): Call[] {
  return JSON.parse(readFileSync(s.callsFile, 'utf8')) as Call[];
}

describe('上传阶段：传给 CLI 的参数', () => {
  it('发布成功，记录里出现平台返回的标识', async () => {
    const s = await setup({ totalSize: 7_654_321 });
    try {
      await run(s);

      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'success', `实际日志：${release.stages[0]?.log}`);

      // 平台回执写进了日志
      const log = release.stages[0]!.log;
      assert.match(log, /上传完成/);
      assert.match(log, /7654321 字节/, '代码包大小应记进日志');
    } finally {
      s.db.close();
    }
  });

  it('用 miniGame 类型与正确的 appid 建 Project', async () => {
    const s = await setup();
    try {
      await run(s);
      const project = readCalls(s).find((c) => c.call === 'Project');
      assert.ok(project, '应调用过 Project 构造');
      assert.equal(project.options?.['type'], 'miniGame', '小游戏必须用 miniGame 而不是 miniProgram');
      assert.equal(project.options?.['appid'], APPID);
    } finally {
      s.db.close();
    }
  });

  it('私钥被物化成文件交给 CLI，内容正确', async () => {
    const s = await setup();
    try {
      await run(s);
      const project = readCalls(s).find((c) => c.call === 'Project')!;
      assert.equal(project.options?.['privateKeyExists'], true, 'CLI 调用时私钥文件必须存在');
      assert.equal(project.options?.['privateKeyContent'], PEM, '私钥内容应与凭据一致');
    } finally {
      s.db.close();
    }
  });

  it('任务结束后私钥文件被删除', async () => {
    const s = await setup();
    try {
      await run(s);
      const project = readCalls(s).find((c) => c.call === 'Project')!;
      const keyPath = project.options?.['privateKeyPath'] as string;
      assert.throws(() => readFileSync(keyPath), /ENOENT/, '私钥文件必须在任务结束后消失');
    } finally {
      s.db.close();
    }
  });

  it('发布参数原样传给 upload', async () => {
    const s = await setup();
    try {
      await run(s);
      const upload = readCalls(s).find((c) => c.call === 'upload');
      assert.ok(upload);
      assert.equal(upload.version, '1.4.0');
      assert.equal(upload.desc, 'feat: 新手引导');
      assert.equal(upload.robot, 2);
    } finally {
      s.db.close();
    }
  });

  it('显式传编译设置，不依赖 CLI 默认值', async () => {
    const s = await setup();
    try {
      await run(s);
      const upload = readCalls(s).find((c) => c.call === 'upload')!;
      // 默认值会随 CLI 版本变，而发布结果的差异不该因为升级 CLI 悄悄改变
      assert.equal(upload.setting?.['es6'], true);
      assert.equal(upload.setting?.['minify'], true);
      assert.equal(upload.setting?.['ignoreUploadUnusedFiles'], true);
    } finally {
      s.db.close();
    }
  });

  it('robot 缺省为 1', async () => {
    const s = await setup({}, { version: '1.0.0', desc: 'x' });
    try {
      await run(s);
      const upload = readCalls(s).find((c) => c.call === 'upload')!;
      assert.equal(upload.robot, 1);
    } finally {
      s.db.close();
    }
  });

  it('CLI 的进度输出被转进阶段日志', async () => {
    const s = await setup();
    try {
      await run(s);
      assert.match(getRelease(s.db, s.releaseId).stages[0]!.log, /stub 上传进度 50%/);
    } finally {
      s.db.close();
    }
  });
});

describe('结果验证', () => {
  it('验证会被调用并说明开发版与线上版本的区别', async () => {
    const s = await setup({ latestVersion: '1.3.0' });
    try {
      await run(s);
      const calls = readCalls(s);
      assert.ok(
        calls.some((c) => c.call === 'getLatestVersion'),
        'capabilities.verify 为 true，应调用 getLatestVersion',
      );
      assert.equal(getRelease(s.db, s.releaseId).status, 'success');
    } finally {
      s.db.close();
    }
  });

  it('验证失败时记录不进入成功状态', async () => {
    const s = await setup({ latestVersionError: 'errcode: 40164, errmsg: invalid ip' });
    try {
      await run(s);
      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'failed', '验证不通过不该算成功');
      // 但上传阶段本身是成功的——区分「动作做完了」与「结果没达到预期」
      assert.equal(release.stages[0]!.status, 'success');
    } finally {
      s.db.close();
    }
  });
});

describe('失败分类写进记录', () => {
  it('IP 白名单问题被点名，并指出去哪里改', async () => {
    const s = await setup({ uploadError: 'errcode: 40164, errmsg: invalid ip 203.0.113.5' });
    try {
      await run(s);
      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'failed');
      const log = release.stages[0]!.log;
      assert.match(log, /出口 IP 不在白名单/);
      assert.match(log, /开发设置/, '应指出到哪里配置');
      assert.match(log, /203\.0\.113\.5/, '原始错误应保留在日志里供排查');
    } finally {
      s.db.close();
    }
  });

  it('私钥不匹配与 appid 错误的文案不同', async () => {
    const keyCase = await setup({ uploadError: 'errcode: 40001, errmsg: invalid credential' });
    let keyLog: string;
    try {
      await run(keyCase);
      keyLog = getRelease(keyCase.db, keyCase.releaseId).stages[0]!.log;
    } finally {
      keyCase.db.close();
    }
    resetTargetKinds();

    const appidCase = await setup({ uploadError: 'errcode: 40013, errmsg: invalid appid' });
    let appidLog: string;
    try {
      await run(appidCase);
      appidLog = getRelease(appidCase.db, appidCase.releaseId).stages[0]!.log;
    } finally {
      appidCase.db.close();
    }

    assert.match(keyLog, /私钥与该 appid 不匹配/);
    assert.match(appidLog, /不存在或格式不对/);
  });

  it('上传失败时私钥文件同样被清理', async () => {
    const s = await setup({ uploadError: 'something went wrong' });
    try {
      await run(s);
      const project = readCalls(s).find((c) => c.call === 'Project')!;
      const keyPath = project.options?.['privateKeyPath'] as string;
      assert.throws(() => readFileSync(keyPath), /ENOENT/);
    } finally {
      s.db.close();
    }
  });
});

describe('产物结构', () => {
  it('产物里没有 game.json 时在加载 CLI 之前就报错', async () => {
    registerTargetKind(wechatPlugin);
    const cliHome = mkdtempSync(join(scratch, 'cli-'));
    await installStubCli(cliHome);

    // 换一个没有 game.json 的产物
    const badZip = buildZip([{ name: 'readme.txt', content: Buffer.from('x') }]);
    const badServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end(badZip);
    });
    await new Promise<void>((resolve) => badServer.listen(0, '127.0.0.1', resolve));
    const badBase = `http://127.0.0.1:${(badServer.address() as AddressInfo).port}`;

    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      const credential = createCredential(
        db,
        { name: 'k', type: 'file', secrets: { content: PEM } },
        KEY,
      );
      const target = createTarget(
        db,
        {
          gameId: game.id,
          kind: 'wechat',
          name: 'T',
          credentialId: credential.id,
          location: { appid: APPID },
        },
        KEY,
      );
      const buildPk = randomUUID();
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'wechat', 'bad1', ?, ?, ?, ?)`,
      ).run(buildPk, game.id, `${badBase}/pkg.zip`, badZip.length, sha256(badZip), new Date().toISOString());

      const release = createRelease(db, {
        buildId: buildPk,
        targetId: target.id,
        params: { version: '1.0.0', desc: 'x' },
        stageIds: ['upload'],
      });

      const runner = startRunner({
        db,
        handlers: {
          publish: (job) =>
            executeRelease({ db, masterKey: KEY, cliHome, workParentDir: scratch }, job),
        },
      });
      try {
        enqueue(db, 'publish', release.id);
        await runner.tick();
      } finally {
        runner.stop();
      }

      const finished = getRelease(db, release.id);
      assert.equal(finished.status, 'failed');
      assert.match(finished.stages[0]!.log, /找不到 game\.json/);
      assert.match(finished.stages[0]!.log, /readme\.txt/, '应列出实际内容帮助排查');
    } finally {
      db.close();
      await new Promise<void>((resolve) => badServer.close(() => resolve()));
    }
  });
});
