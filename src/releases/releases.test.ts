import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { createGame, createPackageType } from '../catalog/index.js';
import { createCredential } from '../credentials/index.js';
import { ensureSchema, open, ReferencedError, type Db } from '../db/index.js';
import { enqueue, startRunner, type JobContext, type JobHandler } from '../jobs/index.js';
import { createEchoPlugin, freshObservation, type EchoObservation, type EchoOptions } from '../plugins/echo/index.js';
import { registerTargetKind, resetTargetKinds } from '../registry/index.js';
import { createTarget, deleteTarget } from '../targets/index.js';
import { createContext } from './context.js';
import { executeRelease } from './execute.js';
import {
  createRelease,
  deleteRelease,
  deleteReleasesByTarget,
  getRelease,
  listReleases,
  listStageAttempts,
  prepareRetry,
  setReleaseStatus,
} from './store.js';
import { buildZip, sha256 } from '../artifacts/zip-fixture.test-helper.js';

const KEY = 'test-master-key-of-enough-length';
const scratch = mkdtempSync(join(tmpdir(), 'release-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/* ------------------------------ 产物 HTTP 源 ------------------------------ */

let server: Server;
let base: string;
const zipBody = buildZip([
  { name: 'game.js', content: Buffer.from('main()') },
  { name: 'config.json', content: Buffer.from('{}') },
]);

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(zipBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => resetTargetKinds());

/* --------------------------------- 搭场景 --------------------------------- */

interface Scenario {
  readonly db: Db;
  readonly releaseId: string;
  readonly observation: EchoObservation;
  run(): Promise<void>;
}

function setupScenario(options: EchoOptions = {}): Scenario {
  const observation = freshObservation();
  registerTargetKind(createEchoPlugin(observation, options));

  const db = open({ file: ':memory:' });
  ensureSchema(db);

  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  createPackageType(db, { id: 'echo-pkg', displayName: 'Echo 包' });

  const credentialId =
    options.useSecrets === true
      ? createCredential(db, { name: 'c', type: 'secretText', secrets: { secret: 'SECRET-VALUE' } }, KEY).id
      : null;

  const target = createTarget(
    db,
    { gameId: game.id, kind: 'echo', name: 'Echo 目标', credentialId, location: { slot: 'a' } },
    KEY,
  );

  const buildPk = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
     VALUES (?, ?, 'echo-pkg', 'b1', ?, ?, ?, ?)`,
  ).run(buildPk, game.id, `${base}/pkg.zip`, zipBody.length, sha256(zipBody), new Date().toISOString());

  const release = createRelease(db, {
    buildId: buildPk,
    targetId: target.id,
    params: { version: '1.0.0' },
    stageIds: ['upload', 'submit'],
  });

  const handler: JobHandler = (job: JobContext) =>
    executeRelease({ db, masterKey: KEY, cliHome: '/opt/cli', workParentDir: scratch }, job);

  return {
    db,
    releaseId: release.id,
    observation,
    async run(): Promise<void> {
      const runner = startRunner({ db, handlers: { publish: handler }, timeoutMs: 20_000 });
      try {
        enqueue(db, 'publish', release.id);
        await runner.tick();
      } finally {
        runner.stop();
      }
    },
  };
}

/* ---------------------------------- 测试 ---------------------------------- */

describe('插件契约：ctx 把六样东西都准备好', () => {
  it('产物已解压、目标配置、发布参数、CLI 目录都可用', async () => {
    const s = setupScenario();
    try {
      await s.run();

      assert.deepEqual(
        s.observation.artifactEntries.slice().sort(),
        ['config.json', 'game.js'],
        'artifactDir 应是解压后的目录',
      );
      assert.deepEqual(s.observation.target, { slot: 'a' }, '应拿到目标的位置字段');
      assert.deepEqual(s.observation.params, { version: '1.0.0' }, '应拿到发布参数');
      assert.equal(s.observation.cliHome, '/opt/cli');
    } finally {
      s.db.close();
    }
  });

  it('凭据明文可取，插件不接触主密钥', async () => {
    const s = setupScenario({ useSecrets: true });
    try {
      await s.run();
      assert.equal(s.observation.secretValue, 'SECRET-VALUE');
    } finally {
      s.db.close();
    }
  });

  it('发布成功，平台回执写进日志', async () => {
    const s = setupScenario();
    try {
      await s.run();
      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'success');
      assert.deepEqual(s.observation.stagesRun, ['upload', 'submit']);
    } finally {
      s.db.close();
    }
  });
});

describe('密钥物化与清理', () => {
  it('任务结束后工作目录内不存在任何凭据文件', async () => {
    const s = setupScenario({ useSecrets: true });
    try {
      await s.run();

      const path = s.observation.secretFilePath;
      assert.ok(path, '插件应拿到过一个凭据文件路径');
      assert.throws(() => readFileSync(path), /ENOENT/, '凭据文件必须被删除');
    } finally {
      s.db.close();
    }
  });

  it('失败时凭据文件同样被清理', async () => {
    const s = setupScenario({ useSecrets: true, failStage: 'upload' });
    try {
      await s.run();
      const path = s.observation.secretFilePath;
      assert.ok(path);
      assert.throws(() => readFileSync(path), /ENOENT/);
    } finally {
      s.db.close();
    }
  });

  it('取不存在的凭据字段时报错，而不是返回空串', async () => {
    const managed = await createContext({
      artifactDir: scratch,
      workdir: scratch,
      build: {
        buildId: 'test-build',
        commitSha: null,
        packageTypeId: 'echo-pkg',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
      },
      target: {},
      params: {},
      cliHome: '/opt/cli',
      secrets: { secret: 'v' },
      log: () => {},
      progress: () => {},
      signal: new AbortController().signal,
    });
    try {
      assert.equal(managed.ctx.secret('secret'), 'v');
      assert.throws(() => managed.ctx.secret('no-such-field'), /凭据里没有字段 no-such-field/);
      assert.throws(() => managed.ctx.secret('no-such-field'), /可用字段：secret/);
    } finally {
      await managed.cleanupSecrets();
    }
  });

  it('物化的凭据文件权限是 600', async () => {
    const dir = mkdtempSync(join(scratch, 'perm-'));
    const managed = await createContext({
      artifactDir: dir,
      workdir: dir,
      build: {
        buildId: 'test-build',
        commitSha: null,
        packageTypeId: 'echo-pkg',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
      },
      target: {},
      params: {},
      cliHome: '/opt/cli',
      secrets: { key: 'private-key-bytes' },
      log: () => {},
      progress: () => {},
      signal: new AbortController().signal,
    });
    try {
      const path = await managed.ctx.secretFile('key');
      assert.equal(readFileSync(path, 'utf8'), 'private-key-bytes');
      // Windows 不实现 POSIX 权限位，只在类 Unix 上断言
      if (process.platform !== 'win32') {
        const mode = statSync(path).mode & 0o777;
        assert.equal(mode, 0o600, `权限应为 600，实际 ${mode.toString(8)}`);
      }
    } finally {
      await managed.cleanupSecrets();
    }
  });
});

describe('多阶段执行', () => {
  it('前一阶段失败时后续阶段不执行，标记为 skipped', async () => {
    const s = setupScenario({ failStage: 'upload' });
    try {
      await s.run();

      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'failed');
      assert.deepEqual(
        release.stages.map((st) => [st.stageId, st.status]),
        [
          ['upload', 'failed'],
          ['submit', 'skipped'],
        ],
      );
      assert.deepEqual(s.observation.stagesRun, ['upload'], 'submit 不应被执行');
    } finally {
      s.db.close();
    }
  });

  it('第二阶段失败时第一阶段仍是成功', async () => {
    const s = setupScenario({ failStage: 'submit' });
    try {
      await s.run();
      const release = getRelease(s.db, s.releaseId);
      assert.deepEqual(
        release.stages.map((st) => [st.stageId, st.status]),
        [
          ['upload', 'success'],
          ['submit', 'failed'],
        ],
      );
    } finally {
      s.db.close();
    }
  });

  it('阶段日志分别记录', async () => {
    const s = setupScenario();
    try {
      await s.run();
      const release = getRelease(s.db, s.releaseId);
      for (const stage of release.stages) {
        assert.match(stage.log, new RegExp(`echo 执行阶段 ${stage.stageId}`));
      }
    } finally {
      s.db.close();
    }
  });
});

describe('失败只重试失败阶段', () => {
  it('重试只重新执行未成功的阶段，并保留新的尝试记录', async () => {
    const s = setupScenario({ failStage: 'submit' });
    try {
      await s.run();
      assert.deepEqual(s.observation.stagesRun, ['upload', 'submit']);

      // 换成不再失败的插件，模拟修好问题后重试
      resetTargetKinds();
      const retryObs = freshObservation();
      registerTargetKind(createEchoPlugin(retryObs));

      const { fromStageId } = prepareRetry(s.db, s.releaseId);
      assert.equal(fromStageId, 'submit', '应从第一个未成功的阶段继续');

      const runner = startRunner({
        db: s.db,
        handlers: {
          publish: (job) =>
            executeRelease(
              { db: s.db, masterKey: KEY, cliHome: '/opt/cli', workParentDir: scratch },
              job,
            ),
        },
      });
      try {
        enqueue(s.db, 'publish', s.releaseId);
        await runner.tick();
      } finally {
        runner.stop();
      }

      assert.deepEqual(retryObs.stagesRun, ['submit'], 'upload 不应重跑');

      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'success');

      // 旧的尝试记录仍在
      const attempts = listStageAttempts(s.db, s.releaseId, 'submit');
      assert.equal(attempts.length, 2, '两次尝试都应留痕');
      assert.equal(attempts[0]!.status, 'failed');
      assert.equal(attempts[1]!.status, 'success');

      // upload 只有一次尝试
      assert.equal(listStageAttempts(s.db, s.releaseId, 'upload').length, 1);
    } finally {
      s.db.close();
    }
  });

  it('全部成功后重试被拒', async () => {
    const s = setupScenario();
    try {
      await s.run();
      assert.throws(() => prepareRetry(s.db, s.releaseId), /无需重试/);
    } finally {
      s.db.close();
    }
  });
});

describe('结果验证', () => {
  it('声明支持验证时会被调用', async () => {
    const s = setupScenario({ verifyOk: true });
    try {
      await s.run();
      assert.equal(s.observation.verifyCalled, true);
      assert.equal(getRelease(s.db, s.releaseId).status, 'success');
    } finally {
      s.db.close();
    }
  });

  it('验证不通过时记录不进入成功状态', async () => {
    const s = setupScenario({ verifyOk: false });
    try {
      await s.run();
      assert.equal(s.observation.verifyCalled, true);

      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'failed', '验证失败不应算成功');
      // 但各阶段本身是成功的——区分「发布动作做完了」与「结果没达到预期」
      assert.deepEqual(
        release.stages.map((st) => st.status),
        ['success', 'success'],
      );
    } finally {
      s.db.close();
    }
  });

  it('未声明验证时不调用', async () => {
    const s = setupScenario();
    try {
      await s.run();
      assert.equal(s.observation.verifyCalled, false);
    } finally {
      s.db.close();
    }
  });
});

describe('阶段超时', () => {
  it('卡住的阶段按自己声明的超时中断，整条记录标为 timeout', async () => {
    const observation = freshObservation();
    // 把 upload 的超时压到很短
    const plugin = createEchoPlugin(observation, { hangStage: 'upload' });
    registerTargetKind({
      ...plugin,
      manifest: {
        ...plugin.manifest,
        stages: [
          { id: 'upload', name: '上传', timeoutMs: 80 },
          { id: 'submit', name: '提审', timeoutMs: 5_000 },
        ],
      },
    });

    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'echo-pkg', displayName: 'Echo 包' });
      const target = createTarget(
        db,
        { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
        KEY,
      );
      const buildPk = randomUUID();
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'echo-pkg', 'b1', ?, ?, ?, ?)`,
      ).run(buildPk, game.id, `${base}/pkg.zip`, zipBody.length, sha256(zipBody), new Date().toISOString());

      const release = createRelease(db, {
        buildId: buildPk,
        targetId: target.id,
        params: { version: '1.0.0' },
        stageIds: ['upload', 'submit'],
      });

      const runner = startRunner({
        db,
        handlers: {
          publish: (job) =>
            executeRelease({ db, masterKey: KEY, cliHome: '/opt/cli', workParentDir: scratch }, job),
        },
        timeoutMs: 20_000,
      });
      try {
        enqueue(db, 'publish', release.id);
        await runner.tick();
      } finally {
        runner.stop();
      }

      const finished = getRelease(db, release.id);
      assert.equal(finished.status, 'timeout', '阶段超时应让整条记录也是 timeout');
      assert.equal(finished.stages[0]!.status, 'timeout');
      assert.equal(finished.stages[1]!.status, 'skipped');
    } finally {
      db.close();
    }
  });
});

describe('阶段之外的失败也要落地', () => {
  it('产物下载失败时记录标为失败，而不是永久停在执行中', async () => {
    // 这是 12.3 演练里发现的 bug：prepareArtifact 抛异常时直接跳到
    // finally 清理，发布记录停在 running——界面一直显示「执行中」，
    // 重试入口因为状态是 running 根本不出现。
    const observation = freshObservation();
    registerTargetKind(createEchoPlugin(observation));

    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'echo-pkg', displayName: 'Echo' });
      const target = createTarget(
        db,
        { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
        KEY,
      );

      const buildPk = randomUUID();
      // 指向一个连不上的地址
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'echo-pkg', 'dead', 'http://127.0.0.1:1/gone.zip', 1, ?, ?)`,
      ).run(buildPk, game.id, 'a'.repeat(64), new Date().toISOString());

      const release = createRelease(db, {
        buildId: buildPk,
        targetId: target.id,
        params: { version: '1.0.0' },
        stageIds: ['upload', 'submit'],
      });

      const runner = startRunner({
        db,
        handlers: {
          publish: (job) =>
            executeRelease(
              { db, masterKey: KEY, cliHome: '/opt/cli', workParentDir: scratch },
              job,
            ),
        },
      });
      try {
        enqueue(db, 'publish', release.id);
        await runner.tick();
      } finally {
        runner.stop();
      }

      const finished = getRelease(db, release.id);
      assert.equal(finished.status, 'failed', '记录不能停在 running');
      assert.deepEqual(
        finished.stages.map((s) => s.status),
        ['skipped', 'skipped'],
        '一个阶段都没跑起来，都该标为跳过',
      );
      assert.equal(observation.stagesRun.length, 0, '插件不该被调用');
    } finally {
      db.close();
    }
  });

  it('摘要不符时同样标为失败', async () => {
    const observation = freshObservation();
    registerTargetKind(createEchoPlugin(observation));

    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'echo-pkg', displayName: 'Echo' });
      const target = createTarget(
        db,
        { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
        KEY,
      );

      const buildPk = randomUUID();
      // 产物源是好的，但摘要故意写错
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'echo-pkg', 'bad-sha', ?, ?, ?, ?)`,
      ).run(buildPk, game.id, `${base}/pkg.zip`, zipBody.length, 'f'.repeat(64), new Date().toISOString());

      const release = createRelease(db, {
        buildId: buildPk,
        targetId: target.id,
        params: { version: '1.0.0' },
        stageIds: ['upload', 'submit'],
      });

      const runner = startRunner({
        db,
        handlers: {
          publish: (job) =>
            executeRelease(
              { db, masterKey: KEY, cliHome: '/opt/cli', workParentDir: scratch },
              job,
            ),
        },
      });
      try {
        enqueue(db, 'publish', release.id);
        await runner.tick();
      } finally {
        runner.stop();
      }

      assert.equal(getRelease(db, release.id).status, 'failed');
      assert.equal(observation.stagesRun.length, 0, '摘要不符时不该把产物交给插件');
    } finally {
      db.close();
    }
  });
});

describe('发布记录', () => {
  it('创建时就建出所有阶段，界面能显示将要执行哪几步', () => {
    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'p', displayName: 'P' });
      registerTargetKind(createEchoPlugin(freshObservation()));
      const target = createTarget(
        db,
        { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
        KEY,
      );
      const buildPk = randomUUID();
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'p', 'b1', 'https://x/a.zip', 1, 'h', ?)`,
      ).run(buildPk, game.id, new Date().toISOString());

      const release = createRelease(db, {
        buildId: buildPk,
        targetId: target.id,
        params: {},
        stageIds: ['upload', 'submit'],
      });

      assert.equal(release.status, 'queued');
      assert.deepEqual(
        release.stages.map((s) => [s.stageId, s.status, s.attempt]),
        [
          ['upload', 'queued', 1],
          ['submit', 'queued', 1],
        ],
      );
    } finally {
      db.close();
    }
  });

  it('没有阶段的发布被拒', () => {
    const db = open({ file: ':memory:' });
    try {
      ensureSchema(db);
      assert.throws(
        () => createRelease(db, { buildId: 'b', targetId: 't', params: {}, stageIds: [] }),
        /至少需要一个阶段/,
      );
    } finally {
      db.close();
    }
  });
});

describe('发布记录：删除', () => {
  interface Scene {
    readonly db: Db;
    readonly targetId: string;
    readonly buildPk: string;
  }

  function setup(): Scene {
    const db = open({ file: ':memory:' });
    ensureSchema(db);
    const game = createGame(db, { slug: 'demo', displayName: '示例' });
    createPackageType(db, { id: 'p', displayName: 'P' });
    registerTargetKind(createEchoPlugin(freshObservation()));
    const target = createTarget(
      db,
      { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
      KEY,
    );
    const buildPk = randomUUID();
    db.prepare(
      `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
       VALUES (?, ?, 'p', 'b1', 'https://x/a.zip', 1, 'h', ?)`,
    ).run(buildPk, game.id, new Date().toISOString());
    return { db, targetId: target.id, buildPk };
  }

  /** 建一条发布记录并推到指定状态。 */
  function makeRelease(s: Scene, status: 'queued' | 'running' | 'success' | 'failed'): string {
    const release = createRelease(s.db, {
      buildId: s.buildPk,
      targetId: s.targetId,
      params: {},
      stageIds: ['upload'],
    });
    if (status === 'queued') return release.id;
    setReleaseStatus(s.db, release.id, 'running');
    if (status === 'running') return release.id;
    setReleaseStatus(s.db, release.id, status);
    return release.id;
  }

  function stageCount(db: Db, releaseId: string): number {
    return (
      db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM release_stages WHERE release_id = ?',
        )
        .get(releaseId)?.n ?? 0
    );
  }

  it('删除已结束的记录，阶段日志一并消失', () => {
    const s = setup();
    try {
      const id = makeRelease(s, 'success');
      assert.equal(stageCount(s.db, id), 1);

      deleteRelease(s.db, id);

      assert.equal(listReleases(s.db).length, 0);
      assert.equal(stageCount(s.db, id), 0, '阶段不能留成孤儿');
    } finally {
      s.db.close();
    }
  });

  it('正在执行或排队中的不能删——执行器还会写回它', () => {
    const s = setup();
    try {
      const running = makeRelease(s, 'running');
      assert.throws(() => deleteRelease(s.db, running), /不能删除/);

      const queued = makeRelease(s, 'queued');
      assert.throws(() => deleteRelease(s.db, queued), /不能删除/);

      assert.equal(listReleases(s.db).length, 2, '拒绝删除时不该动数据');
    } finally {
      s.db.close();
    }
  });

  it('删掉最后一条引用后，目标就变成可删', () => {
    const s = setup();
    try {
      const id = makeRelease(s, 'failed');
      assert.equal(getTargetReleaseCount(s.db, s.targetId), 1);

      deleteRelease(s.db, id);

      assert.equal(getTargetReleaseCount(s.db, s.targetId), 0);
      assert.doesNotThrow(() => deleteTarget(s.db, s.targetId));
    } finally {
      s.db.close();
    }
  });

  it('按目标批量清理只删已结束的，正在跑的留下', () => {
    const s = setup();
    try {
      makeRelease(s, 'success');
      makeRelease(s, 'failed');
      const running = makeRelease(s, 'running');

      const removed = deleteReleasesByTarget(s.db, s.targetId);
      assert.equal(removed, 2);

      const left = listReleases(s.db);
      assert.deepEqual(
        left.map((r) => r.id),
        [running],
      );
      // 还有一条在跑，所以目标仍然删不掉
      assert.throws(() => deleteTarget(s.db, s.targetId), ReferencedError);
    } finally {
      s.db.close();
    }
  });

  it('没有可清的记录时返回 0，不报错', () => {
    const s = setup();
    try {
      assert.equal(deleteReleasesByTarget(s.db, s.targetId), 0);
    } finally {
      s.db.close();
    }
  });

  it('删不存在的记录报错而不是静默成功', () => {
    const s = setup();
    try {
      assert.throws(() => deleteRelease(s.db, randomUUID()), /不存在/);
    } finally {
      s.db.close();
    }
  });
});

function getTargetReleaseCount(db: Db, targetId: string): number {
  return (
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM releases WHERE target_id = ?')
      .get(targetId)?.n ?? 0
  );
}
