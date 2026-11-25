import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { issueCiKey } from '../auth/store.js';
import { createGame, createPackageType } from '../catalog/index.js';
import { ensureSchema, locationKey, open, type Db } from '../db/index.js';
import { parseBuildReport, resolveReport } from './ingest.js';
import { getBuild, upsertBuild } from './store.js';
import { listBuilds } from './views.js';

const MASTER_KEY = 'test-master-key-0123456789';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

interface Setup {
  readonly db: Db;
  readonly gameId: string;
}

function setup(packageTypes: string[] = ['wechat']): Setup {
  const db = freshDb();
  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  for (const type of packageTypes) {
    createPackageType(db, { id: type, displayName: type });
  }
  return { db, gameId: game.id };
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    game: 'demo',
    packageType: 'wechat',
    buildId: 'b20261124',
    artifactUrl: 'https://example.com/a.zip',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

function ingest(db: Db, overrides: Record<string, unknown> = {}, ciKeyId: string | null = null) {
  return upsertBuild(db, resolveReport(db, parseBuildReport(report(overrides))), ciKeyId);
}

/** 建一个发布目标，返回 id。 */
function seedTarget(db: Db, gameId: string, name: string, kind = 'wechat'): string {
  const location = { appid: `wx-${name}` };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO targets (id, game_id, kind, name, location, location_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, gameId, kind, name, JSON.stringify(location), locationKey(location), now(), now());
  return id;
}

/** 建一条发布记录。createdAt 可指定，用于测「取最新一条」。 */
function seedRelease(
  db: Db,
  buildPk: string,
  targetId: string,
  status: string,
  createdAt = now(),
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run(id, buildPk, targetId, status, createdAt);
  return id;
}

describe('上报 upsert', () => {
  it('首次上报新建记录', () => {
    const { db } = setup();
    try {
      const result = ingest(db);
      assert.equal(result.created, true);
      assert.equal(result.build.buildId, 'b20261124');
      assert.equal(result.build.sizeBytes, 1000);
    } finally {
      db.close();
    }
  });

  it('同一载荷连发两次后构建数不变', () => {
    const { db } = setup();
    try {
      ingest(db);
      const second = ingest(db);
      assert.equal(second.created, false);

      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
      assert.equal(count?.n, 1);
    } finally {
      db.close();
    }
  });

  it('重跑时覆盖产物信息（URL、大小、摘要都可能变）', () => {
    const { db } = setup();
    try {
      const first = ingest(db);
      const second = ingest(db, {
        artifactUrl: 'https://example.com/rebuilt.zip',
        sizeBytes: 2000,
        sha256: 'b'.repeat(64),
        description: '重跑',
      });

      assert.equal(second.created, false);
      assert.equal(second.build.id, first.build.id, '应是同一条记录');
      assert.equal(second.build.artifactUrl, 'https://example.com/rebuilt.zip');
      assert.equal(second.build.sizeBytes, 2000);
      assert.equal(second.build.sha256, 'b'.repeat(64));
      assert.equal(second.build.description, '重跑');
    } finally {
      db.close();
    }
  });

  it('不同包类型的同一 buildId 各自独立（一次构建三个包）', () => {
    const { db } = setup(['wechat', 'douyin', 'h5']);
    try {
      for (const type of ['wechat', 'douyin', 'h5']) {
        const result = ingest(db, { packageType: type });
        assert.equal(result.created, true);
      }
      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
      assert.equal(count?.n, 3);
    } finally {
      db.close();
    }
  });

  it('记录上报用的 CI key，便于追溯来源', () => {
    const { db } = setup();
    try {
      const issued = issueCiKey(db, 'github-actions', MASTER_KEY);
      const result = ingest(db, {}, issued.id);
      const row = db
        .prepare<[string], { ci_key_id: string | null }>('SELECT ci_key_id FROM builds WHERE id = ?')
        .get(result.build.id);
      assert.equal(row?.ci_key_id, issued.id);
    } finally {
      db.close();
    }
  });

  it('不存在的 CI key id 被外键拒绝，而不是悄悄写入', () => {
    const { db } = setup();
    try {
      assert.throws(() => ingest(db, {}, 'no-such-key-id'), /FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it('不存在的构建 id 报错', () => {
    const { db } = setup();
    try {
      assert.throws(() => getBuild(db, 'no-such-id'), /不存在/);
    } finally {
      db.close();
    }
  });
});

describe('构建列表：按 commit 聚合', () => {
  it('同一 commit 的三个包聚合为一行', () => {
    const { db } = setup(['wechat', 'douyin', 'h5']);
    try {
      for (const type of ['wechat', 'douyin', 'h5']) {
        ingest(db, { packageType: type, commitSha: 'a1b2c3d', description: 'feat: 新手引导' });
      }

      const groups = listBuilds(db);
      assert.equal(groups.length, 1, '应聚合为一组');
      assert.equal(groups[0]!.commitSha, 'a1b2c3d');
      assert.equal(groups[0]!.builds.length, 3);
      assert.equal(groups[0]!.description, 'feat: 新手引导');

      // 组内按包类型排序，便于稳定展示
      assert.deepEqual(
        groups[0]!.builds.map((b) => b.packageTypeId),
        ['douyin', 'h5', 'wechat'],
      );
    } finally {
      db.close();
    }
  });

  it('不同 commit 分成不同组', () => {
    const { db } = setup(['wechat']);
    try {
      ingest(db, { buildId: 'b1', commitSha: 'aaa' });
      ingest(db, { buildId: 'b2', commitSha: 'bbb' });
      assert.equal(listBuilds(db).length, 2);
    } finally {
      db.close();
    }
  });

  it('没有 commit 的包各自独立成组，不被凑在一起', () => {
    const { db } = setup(['wechat', 'douyin']);
    try {
      ingest(db, { packageType: 'wechat', buildId: 'b1' });
      ingest(db, { packageType: 'douyin', buildId: 'b2' });

      const groups = listBuilds(db);
      assert.equal(groups.length, 2, 'null commit 不代表同一次构建');
      for (const group of groups) {
        assert.equal(group.commitSha, null);
        assert.equal(group.builds.length, 1);
      }
    } finally {
      db.close();
    }
  });

  it('按上报时间降序排列', () => {
    const { db } = setup(['wechat']);
    try {
      ingest(db, { buildId: 'old', commitSha: 'aaa' });
      db.prepare("UPDATE builds SET reported_at = '2020-01-01T00:00:00.000Z' WHERE build_id = 'old'").run();
      ingest(db, { buildId: 'new', commitSha: 'bbb' });

      const groups = listBuilds(db);
      assert.equal(groups[0]!.builds[0]!.buildId, 'new');
      assert.equal(groups[1]!.builds[0]!.buildId, 'old');
    } finally {
      db.close();
    }
  });

  it('limit 限制返回的组数', () => {
    const { db } = setup(['wechat']);
    try {
      for (let i = 0; i < 5; i += 1) {
        ingest(db, { buildId: `b${i}`, commitSha: `c${i}` });
      }
      assert.equal(listBuilds(db, { limit: 2 }).length, 2);
    } finally {
      db.close();
    }
  });
});

describe('构建列表：筛选', () => {
  it('按游戏筛选', () => {
    const { db } = setup(['wechat']);
    try {
      createGame(db, { slug: 'other', displayName: '另一个' });
      ingest(db, { buildId: 'b1', commitSha: 'aaa' });
      ingest(db, { game: 'other', buildId: 'b2', commitSha: 'bbb' });

      const demoId = db
        .prepare<[string], { id: string }>('SELECT id FROM games WHERE slug = ?')
        .get('demo')!.id;
      const groups = listBuilds(db, { gameId: demoId });
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.commitSha, 'aaa');
    } finally {
      db.close();
    }
  });

  it('按包类型筛选', () => {
    const { db } = setup(['wechat', 'h5']);
    try {
      ingest(db, { packageType: 'wechat', commitSha: 'aaa' });
      ingest(db, { packageType: 'h5', commitSha: 'aaa' });

      const groups = listBuilds(db, { packageTypeId: 'h5' });
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.builds.length, 1);
      assert.equal(groups[0]!.builds[0]!.packageTypeId, 'h5');
    } finally {
      db.close();
    }
  });
});

describe('构建列表：各目标最新发布状态', () => {
  it('从未发布的包 targets 为空', () => {
    const { db } = setup();
    try {
      ingest(db);
      assert.deepEqual(listBuilds(db)[0]!.builds[0]!.targets, []);
    } finally {
      db.close();
    }
  });

  it('一个包发到两个目标，各自显示状态', () => {
    const { db, gameId } = setup();
    try {
      const build = ingest(db).build;
      const prod = seedTarget(db, gameId, '微信正式号');
      const test = seedTarget(db, gameId, '微信测试号');
      seedRelease(db, build.id, prod, 'success');
      seedRelease(db, build.id, test, 'failed');

      const targets = listBuilds(db)[0]!.builds[0]!.targets;
      assert.equal(targets.length, 2);
      const byName = new Map(targets.map((t) => [t.targetName, t.status]));
      assert.equal(byName.get('微信正式号'), 'success');
      assert.equal(byName.get('微信测试号'), 'failed');
    } finally {
      db.close();
    }
  });

  it('同一目标发过多次时只显示最新一条', () => {
    const { db, gameId } = setup();
    try {
      const build = ingest(db).build;
      const target = seedTarget(db, gameId, '微信正式号');
      seedRelease(db, build.id, target, 'failed', '2020-01-01T00:00:00.000Z');
      seedRelease(db, build.id, target, 'success', '2026-01-01T00:00:00.000Z');

      const targets = listBuilds(db)[0]!.builds[0]!.targets;
      assert.equal(targets.length, 1, '同一目标只应有一条');
      assert.equal(targets[0]!.status, 'success', '应取最新一条');
    } finally {
      db.close();
    }
  });

  it('聚合行里三个包各自带自己的目标状态', () => {
    const { db, gameId } = setup(['wechat', 'h5']);
    try {
      const wechat = ingest(db, { packageType: 'wechat', commitSha: 'a1b2c3d' }).build;
      const h5 = ingest(db, { packageType: 'h5', commitSha: 'a1b2c3d' }).build;

      const wxTarget = seedTarget(db, gameId, '微信正式号', 'wechat');
      const h5Target = seedTarget(db, gameId, 'H5 生产', 'h5-r2');
      seedRelease(db, wechat.id, wxTarget, 'success');
      seedRelease(db, h5.id, h5Target, 'running');

      const group = listBuilds(db)[0]!;
      assert.equal(group.builds.length, 2);
      const byType = new Map(group.builds.map((b) => [b.packageTypeId, b.targets]));
      assert.equal(byType.get('wechat')![0]!.status, 'success');
      assert.equal(byType.get('h5')![0]!.status, 'running');
    } finally {
      db.close();
    }
  });
});
