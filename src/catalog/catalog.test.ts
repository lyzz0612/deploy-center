import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ensureSchema, open, ReferencedError, type Db } from '../db/index.js';
import { registerTargetKind, resetTargetKinds } from '../registry/index.js';
import type { TargetKind } from '../registry/index.js';
import {
  archiveGame,
  createGame,
  findGameBySlug,
  getGame,
  listGames,
  renameGame,
  requireActiveGame,
  unarchiveGame,
} from './games.js';
import {
  archivePackageType,
  createPackageType,
  deletePackageType,
  getPackageType,
  listPackageTypes,
  renamePackageType,
  requireActivePackageType,
  unarchivePackageType,
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
      assert.equal(game.archivedAt, null);
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

describe('游戏：归档', () => {
  it('归档后不再接受上报，历史仍可读', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      seedBuild(db, game.id, 'wechat');

      archiveGame(db, game.id);

      // 上报被拒，且错误区分「未登记」与「已归档」
      assert.throws(() => requireActiveGame(db, 'demo'), /已归档，不再接受新的构建上报/);
      assert.throws(() => requireActiveGame(db, 'never-existed'), /未登记/);

      // 历史记录仍可读
      const builds = db
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM builds WHERE game_id = ?')
        .get(game.id);
      assert.equal(builds?.n, 1);
      assert.equal(getGame(db, game.id).displayName, '示例');
    } finally {
      db.close();
    }
  });

  it('缺省列表不含已归档的', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      archiveGame(db, game.id);
      assert.equal(listGames(db).length, 0);
      assert.equal(listGames(db, { includeArchived: true }).length, 1);
    } finally {
      db.close();
    }
  });

  it('重复归档报错而不是静默成功', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      archiveGame(db, game.id);
      assert.throws(() => archiveGame(db, game.id), /不存在或已归档/);
    } finally {
      db.close();
    }
  });

  it('可以取消归档', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      archiveGame(db, game.id);
      assert.equal(unarchiveGame(db, game.id).archivedAt, null);
      assert.doesNotThrow(() => requireActiveGame(db, 'demo'));
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

  it('未被引用时可以删除', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'unused', displayName: '没人用' });
      deletePackageType(db, 'unused');
      assert.equal(listPackageTypes(db, { includeArchived: true }).length, 0);
    } finally {
      db.close();
    }
  });

  it('归档后不再接受上报，但历史构建仍指得到它', () => {
    const db = freshDb();
    try {
      const game = createGame(db, { slug: 'demo', displayName: 'A' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      seedBuild(db, game.id, 'wechat');

      archivePackageType(db, 'wechat');
      assert.throws(() => requireActivePackageType(db, 'wechat'), /已归档/);
      assert.equal(listPackageTypes(db).length, 0);
      assert.equal(getPackageType(db, 'wechat').buildCount, 1);

      unarchivePackageType(db, 'wechat');
      assert.doesNotThrow(() => requireActivePackageType(db, 'wechat'));
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
