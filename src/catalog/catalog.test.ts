import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ensureSchema, open, ReferencedError, type Db } from '../db/index.js';
import { registerTargetKind, resetTargetKinds } from '../registry/index.js';
import type { TargetKind } from '../registry/index.js';
import {
  countGameDependents,
  createGame,
  deleteGameCascade,
  findGameBySlug,
  getGame,
  listGames,
  renameGame,
  requireActiveGame,
} from './games.js';
import {
  createPackageType,
  deletePackageType,
  getPackageType,
  listPackageTypes,
  renamePackageType,
  requireActivePackageType,
} from './package-types.js';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

function kindAccepting(id: string, accepts: string[]): TargetKind {
  return {
    manifest: {
      id,
      displayName: id,
      description: '',
      accepts,
      requiresCredential: null,
      requiresCli: [],
      targetFields: [{ key: 'where', label: '位置', type: 'string', required: true, identity: true }],
      publishFields: [],
      stages: [{ id: 'upload', name: '上传', timeoutMs: 1000 }],
      capabilities: { rollback: 'none', verify: false, activateLatencySeconds: 0 },
    },
    globalChecks: [],
    targetChecks: [],
    execute: async () => ({}),
  };
}

/** 建一条引用指定包类型的构建记录。 */
function seedBuild(db: Db, gameId: string, packageTypeId: string): void {
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
     VALUES (?, ?, ?, ?, 'https://x/a.zip', 1, 'h', ?)`,
  ).run(randomUUID(), gameId, packageTypeId, `b-${randomUUID().slice(0, 8)}`, new Date().toISOString());
}

afterEach(() => resetTargetKinds());

describe('游戏：创建', () => {
  it('创建后可按 slug 找到，用于构建上报', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: '示例游戏' });
      assert.equal(game.slug, 'demo');
      assert.equal(game.displayName, '示例游戏');
      assert.equal(findGameBySlug(db, 'demo')?.id, game.id);
    } finally {
      db.close();
    }
  });

  it('slug 重复时明确指出被占用', () => {
    const db = freshDb();
    try {
      createGame(db, { slug: 'demo', displayName: 'A' });
      assert.throws(
        () => createGame(db, { slug: 'demo', displayName: 'B' }),
        /slug「demo」已被占用/,
      );
    } finally {
      db.close();
    }
  });

  it('非法 slug 被拒', () => {
    const db = freshDb();
    try {
      for (const slug of ['Demo', 'my game', 'has_underscore', '-leading', '', 'a'.repeat(64)]) {
        assert.throws(
          () => createGame(db, { slug, displayName: 'X' }),
          /slug 只能是/,
          `slug ${JSON.stringify(slug)} 应被拒`,
        );
      }
    } finally {
      db.close();
    }
  });

  it('空显示名被拒', () => {
    const db = freshDb();
    try {
      assert.throws(() => createGame(db, { slug: 'ok', displayName: '  ' }), /显示名不能为空/);
    } finally {
      db.close();
    }
  });
});

describe('游戏：slug 只读', () => {
  it('只能改显示名，没有改 slug 的入口', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: '旧名' });
      const renamed = renameGame(db, game.id, '新名');
      assert.equal(renamed.displayName, '新名');
      assert.equal(renamed.slug, 'demo', 'slug 不应变化');
    } finally {
      db.close();
    }
  });

  it('改名到空字符串被拒', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      assert.throws(() => renameGame(db, game.id, ''), /显示名不能为空/);
    } finally {
      db.close();
    }
  });
});

describe('游戏：删除（级联）', () => {
  /** 建一套完整数据：游戏 + 包类型 + 构建 + 目标 + 发布记录（含阶段）。 */
  function seedFullGame(db: Db, slug = 'demo'): { gameId: string; releaseId: string } {
    const game = createGame(db, { slug, displayName: slug });
    createPackageType(db, { id: 'wechat', displayName: '微信' });

    const buildId = randomUUID();
    db.prepare(
      `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
       VALUES (?, ?, 'wechat', 'b1', 'https://x/a.zip', 1, 'h', ?)`,
    ).run(buildId, game.id, new Date().toISOString());

    const targetId = randomUUID();
    db.prepare(
      `INSERT INTO targets (id, game_id, kind, name, location, location_key, created_at, updated_at)
       VALUES (?, ?, 'wechat', '正式号', '{}', '{}', ?, ?)`,
    ).run(targetId, game.id, new Date().toISOString(), new Date().toISOString());

    const releaseId = randomUUID();
    db.prepare(
      `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
       VALUES (?, ?, ?, '{}', 'success', ?)`,
    ).run(releaseId, buildId, targetId, new Date().toISOString());
    db.prepare(
      `INSERT INTO release_stages (id, release_id, stage_id, seq, attempt, status)
       VALUES (?, ?, 'upload', 0, 1, 'success')`,
    ).run(randomUUID(), releaseId);

    return { gameId: game.id, releaseId };
  }

  it('删除前能数清会连带删掉什么', () => {
    const db = freshDb();
    try {
      const { gameId } = seedFullGame(db);
      const impact = countGameDependents(db, gameId);
      assert.deepEqual(impact, { builds: 1, targets: 1, releases: 1 });
    } finally {
      db.close();
    }
  });

  it('级联删除：构建、目标、发布记录与阶段一起消失', () => {
    const db = freshDb();
    try {
      const { gameId } = seedFullGame(db);
      const impact = deleteGameCascade(db, gameId);
      assert.deepEqual(impact, { builds: 1, targets: 1, releases: 1 });

      const count = (table: string): number =>
        db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

      assert.equal(count('games'), 0);
      assert.equal(count('builds'), 0);
      assert.equal(count('targets'), 0);
      assert.equal(count('releases'), 0);
      assert.equal(count('release_stages'), 0, '阶段日志不能留成孤儿');
      // 包类型是全局数据，不该被某个游戏的删除带走
      assert.equal(count('package_types'), 1);
    } finally {
      db.close();
    }
  });

  it('只删目标游戏，不碰别的游戏的数据', () => {
    const db = freshDb();
    try {
      const keep = seedFullGame(db, 'keep');
      const doomed = createGame(db, { slug: 'doomed', displayName: 'doomed' });
      seedBuild(db, doomed.id, 'wechat');

      deleteGameCascade(db, doomed.id);

      assert.deepEqual(
        listGames(db).map((g) => g.slug),
        ['keep'],
      );
      const builds = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
      assert.equal(builds?.n, 1, '只该留下 keep 的那条构建');
      assert.equal(getGame(db, keep.gameId).slug, 'keep');
    } finally {
      db.close();
    }
  });

  it('删一个干净的游戏也能用（没有从属数据）', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'empty', displayName: '空的' });
      const impact = deleteGameCascade(db, game.id);
      assert.deepEqual(impact, { builds: 0, targets: 0, releases: 0 });
      assert.equal(listGames(db).length, 0);
    } finally {
      db.close();
    }
  });

  it('删不存在的游戏报错而不是静默成功', () => {
    const db = freshDb();
    try {
      assert.throws(() => deleteGameCascade(db, 'no-such-id'), /不存在/);
    } finally {
      db.close();
    }
  });

  it('游戏没有停用态：只有「未登记」一种上报失败', () => {
    const db = freshDb();
    try {
      createGame(db, { slug: 'demo', displayName: '示例' });
      assert.doesNotThrow(() => requireActiveGame(db, 'demo'));
      assert.throws(() => requireActiveGame(db, 'never-existed'), /未登记/);
    } finally {
      db.close();
    }
  });
});

describe('包类型：作为纯数据管理', () => {
  it('新增后立即可被上报引用，无需改代码', () => {
    const db = freshDb();
    try {
      const type = createPackageType(db, { id: 'qq', displayName: 'QQ 小游戏' });
      assert.equal(type.id, 'qq');
      assert.deepEqual(
        listPackageTypes(db).map((t) => t.id),
        ['qq'],
      );
      assert.doesNotThrow(() => requireActivePackageType(db, 'qq'));
    } finally {
      db.close();
    }
  });

  it('可改显示名', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'qq', displayName: '旧名' });
      assert.equal(renamePackageType(db, 'qq', '新名').displayName, '新名');
    } finally {
      db.close();
    }
  });

  it('重复 id 被拒', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'qq', displayName: 'A' });
      assert.throws(() => createPackageType(db, { id: 'qq', displayName: 'B' }), /已存在/);
    } finally {
      db.close();
    }
  });

  it('非法 id 被拒', () => {
    const db = freshDb();
    try {
      for (const id of ['WeChat', 'has space', 'has_underscore', '']) {
        assert.throws(() => createPackageType(db, { id, displayName: 'X' }), /包类型标识只能是/);
      }
    } finally {
      db.close();
    }
  });
});

describe('包类型：supportedBy', () => {
  it('没有任何目标类型接受时 supportedBy 为空（界面应提示无法发布）', () => {
    const db = freshDb();
    try {
      registerTargetKind(kindAccepting('wechat', ['wechat']));
      const orphan = createPackageType(db, { id: 'kuaishou', displayName: '快手' });
      assert.deepEqual(orphan.supportedBy, []);

      assert.deepEqual(listPackageTypes(db)[0]?.supportedBy, []);
    } finally {
      db.close();
    }
  });

  it('有目标类型接受时列出它们', () => {
    const db = freshDb();
    try {
      registerTargetKind(kindAccepting('h5-r2', ['h5']));
      registerTargetKind(kindAccepting('h5-nginx', ['h5']));
      registerTargetKind(kindAccepting('wechat', ['wechat']));

      const h5 = createPackageType(db, { id: 'h5', displayName: 'H5' });
      assert.deepEqual(h5.supportedBy.slice().sort(), ['h5-nginx', 'h5-r2']);

      const wechat = createPackageType(db, { id: 'wechat', displayName: '微信' });
      assert.deepEqual(wechat.supportedBy, ['wechat']);
    } finally {
      db.close();
    }
  });
});

describe('包类型：引用保护', () => {
  it('被构建引用时删除被拒，并说明存在引用的构建记录', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      seedBuild(db, game.id, 'wechat');

      assert.equal(getPackageType(db, 'wechat').buildCount, 1);
      assert.throws(
        () => deletePackageType(db, 'wechat'),
        (error: unknown) => {
          assert.ok(error instanceof ReferencedError);
          assert.match(error.message, /该包类型正被引用/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('未被引用时可以删除，且真的从库里消失', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'unused', displayName: '没人用' });
      deletePackageType(db, 'unused');
      assert.equal(listPackageTypes(db).length, 0);
      const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM package_types').get();
      assert.equal(row?.n, 0, '不是软删除，库里不该还留着');
    } finally {
      db.close();
    }
  });

  it('包类型没有停用态：登记了就能接受上报', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      assert.doesNotThrow(() => requireActivePackageType(db, 'wechat'));
      assert.throws(() => requireActivePackageType(db, 'never-existed'), /未登记/);
    } finally {
      db.close();
    }
  });

  it('未登记的包类型上报时被拒', () => {
    const db = freshDb();
    try {
      assert.throws(() => requireActivePackageType(db, 'never-registered'), /未登记/);
    } finally {
      db.close();
    }
  });
});
