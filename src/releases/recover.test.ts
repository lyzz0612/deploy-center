/**
 * 中断恢复的回归测试。
 *
 * 这个 bug 是在 12.3 故障演练里发现的：任务被正确标为失败，但发布记录
 * 仍停在 running——界面上那条发布永远显示「执行中」，而重试入口因为
 * 状态是 running 根本不出现，用户卡在死局里。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { createGame, createPackageType } from '../catalog/index.js';
import { ensureSchema, open, type Db } from '../db/index.js';
import { claimNext, enqueue, recoverInterrupted } from '../jobs/index.js';
import { createEchoPlugin, freshObservation } from '../plugins/echo/index.js';
import { registerTargetKind, resetTargetKinds } from '../registry/index.js';
import { createTarget } from '../targets/index.js';
import { recoverRelease } from './recover.js';
import { createRelease, getRelease, prepareRetry, setReleaseStatus, startStage } from './store.js';

const KEY = 'test-master-key-of-enough-length';

afterEach(() => resetTargetKinds());

function setup(): { db: Db; releaseId: string } {
  registerTargetKind(createEchoPlugin(freshObservation()));
  const db = open({ file: ':memory:' });
  ensureSchema(db);

  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  createPackageType(db, { id: 'echo-pkg', displayName: 'Echo' });
  const target = createTarget(
    db,
    { gameId: game.id, kind: 'echo', name: 'T', location: { slot: 'a' } },
    KEY,
  );

  const buildPk = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
     VALUES (?, ?, 'echo-pkg', 'b1', 'https://x/a.zip', 1, 'h', ?)`,
  ).run(buildPk, game.id, new Date().toISOString());

  const release = createRelease(db, {
    buildId: buildPk,
    targetId: target.id,
    params: {},
    stageIds: ['upload', 'submit'],
  });
  return { db, releaseId: release.id };
}

describe('发布记录的中断恢复', () => {
  it('执行中被中断时，记录与阶段都不再停在 running', () => {
    const { db, releaseId } = setup();
    try {
      // 模拟「第一阶段正在跑时进程被杀」
      setReleaseStatus(db, releaseId, 'running');
      startStage(db, releaseId, 'upload', 1);
      assert.equal(getRelease(db, releaseId).stages[0]!.status, 'running');

      const recovered = recoverRelease(db, releaseId);
      assert.ok(recovered);
      assert.equal(recovered.interruptedStage, 'upload');

      const release = getRelease(db, releaseId);
      assert.equal(release.status, 'failed', '记录不能停在 running，否则界面永远显示执行中');
      assert.equal(release.stages[0]!.status, 'failed', '执行中的阶段确实没做完');
      assert.equal(release.stages[1]!.status, 'skipped', '还没开始的阶段标为跳过');
      assert.match(
        release.stages[0]!.log,
        /进程在这次发布执行中退出/,
        '阶段日志里要有原因，否则用户看到一条失败发布却没有任何说明',
      );
    } finally {
      db.close();
    }
  });

  it('恢复后重试入口可用，且只重试未成功的阶段', () => {
    const { db, releaseId } = setup();
    try {
      setReleaseStatus(db, releaseId, 'running');
      startStage(db, releaseId, 'upload', 1);
      recoverRelease(db, releaseId);

      // 这是原 bug 的核心后果：状态卡在 running 时 prepareRetry 之后
      // 界面也不显示重试入口。恢复后应当可以重试。
      const { fromStageId } = prepareRetry(db, releaseId);
      assert.equal(fromStageId, 'upload');

      const release = getRelease(db, releaseId);
      assert.equal(release.status, 'queued');
      assert.equal(release.stages[0]!.attempt, 2, '失败的阶段进入第 2 次尝试');
    } finally {
      db.close();
    }
  });

  it('排队中被中断同样能收拾（queued → failed 必须合法）', () => {
    const { db, releaseId } = setup();
    try {
      // 进程在任务排队期间被杀：既没开始，也不该自动开始
      const recovered = recoverRelease(db, releaseId);
      assert.ok(recovered);
      assert.equal(recovered.interruptedStage, null, '没有阶段在执行中');
      const release = getRelease(db, releaseId);
      assert.equal(release.status, 'failed');
      assert.match(
        release.stages[0]!.log,
        /进程在这次发布执行中退出/,
        '一个阶段都没跑起来时，也要在第一个阶段上留下原因',
      );
    } finally {
      db.close();
    }
  });

  it('已终止的记录不被改动', () => {
    const { db, releaseId } = setup();
    try {
      setReleaseStatus(db, releaseId, 'running');
      setReleaseStatus(db, releaseId, 'success');
      assert.equal(recoverRelease(db, releaseId), null, '成功的记录不该被恢复逻辑碰');
      assert.equal(getRelease(db, releaseId).status, 'success');
    } finally {
      db.close();
    }
  });

  it('引用了不存在的发布记录时安静跳过', () => {
    const { db } = setup();
    try {
      assert.equal(recoverRelease(db, randomUUID()), null);
    } finally {
      db.close();
    }
  });
});

describe('任务与记录一并恢复', () => {
  it('recoverInterrupted 返回被中断的任务，供调用方收拾关联记录', () => {
    const { db, releaseId } = setup();
    try {
      setReleaseStatus(db, releaseId, 'running');
      startStage(db, releaseId, 'upload', 1);
      enqueue(db, 'publish', releaseId);
      claimNext(db);

      const jobs = recoverInterrupted(db);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.refId, releaseId);
      assert.equal(jobs[0]!.status, 'running', '返回的是中断前的快照');

      // 调用方据此收拾发布记录
      for (const job of jobs) {
        if (job.kind === 'publish') recoverRelease(db, job.refId);
      }
      assert.equal(getRelease(db, releaseId).status, 'failed');
    } finally {
      db.close();
    }
  });
});
