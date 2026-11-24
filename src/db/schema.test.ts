import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { ensureSchema, open, type Db } from './connection.js';
import { locationKey } from './location-key.js';
import { EXPECTED_INDEXES, EXPECTED_TABLES } from './schema.js';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

/** 建一个游戏，返回 id。 */
function seedGame(db: Db, slug = 'demo'): string {
  const id = randomUUID();
  db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    slug,
    slug,
    now(),
  );
  return id;
}

function seedPackageType(db: Db, id = 'wechat'): string {
  db.prepare('INSERT INTO package_types (id, display_name, created_at) VALUES (?, ?, ?)').run(
    id,
    id,
    now(),
  );
  return id;
}

function insertTarget(
  db: Db,
  gameId: string,
  kind: string,
  location: Record<string, unknown>,
  credentialId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO targets (id, game_id, kind, name, credential_id, location, location_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    gameId,
    kind,
    'target',
    credentialId,
    JSON.stringify(location),
    locationKey(location),
    now(),
    now(),
  );
}

/** 建一条完整的发布记录（含所需的游戏、包类型、构建、目标），返回 release id。 */
function seedRelease(db: Db): string {
  const gameId = seedGame(db, `g-${randomUUID().slice(0, 8)}`);
  const typeId = seedPackageType(db, `t-${randomUUID().slice(0, 8)}`);
  const buildId = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
     VALUES (?, ?, ?, 'b1', 'https://x/a.zip', 1, 'h', ?)`,
  ).run(buildId, gameId, typeId, now());

  insertTarget(db, gameId, 'wechat', { appid: 'wx' });
  const target = db.prepare<[], { id: string }>('SELECT id FROM targets LIMIT 1').get();

  const releaseId = randomUUID();
  db.prepare(
    `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
     VALUES (?, ?, ?, '{}', 'queued', ?)`,
  ).run(releaseId, buildId, target!.id, now());
  return releaseId;
}

describe('结构完整性', () => {
  it('所有期望的表都存在', () => {
    const db = freshDb();
    try {
      const names = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((r) => r.name),
      );
      for (const table of EXPECTED_TABLES) {
        assert.ok(names.has(table), `缺少表 ${table}`);
      }
    } finally {
      db.close();
    }
  });

  it('所有期望的索引都存在', () => {
    const db = freshDb();
    try {
      const names = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((r) => r.name),
      );
      for (const index of EXPECTED_INDEXES) {
        assert.ok(names.has(index), `缺少索引 ${index}`);
      }
    } finally {
      db.close();
    }
  });
});

describe('构建上报幂等键 (game, packageType, buildId)', () => {
  it('同一组合重复插入被拒', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      const typeId = seedPackageType(db);
      const insert = db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(randomUUID(), gameId, typeId, 'b1', 'https://x/a.zip', 1, 'h', now());
      assert.throws(
        () => insert.run(randomUUID(), gameId, typeId, 'b1', 'https://x/a.zip', 1, 'h', now()),
        /UNIQUE/,
      );
    } finally {
      db.close();
    }
  });

  it('不同包类型的同一 buildId 可共存（一次构建产出三个包）', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      const insert = db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const type of ['wechat', 'douyin', 'h5']) {
        seedPackageType(db, type);
        insert.run(randomUUID(), gameId, type, 'b1', 'https://x/a.zip', 1, 'h', now());
      }
      const count = db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds')
        .get();
      assert.equal(count?.n, 3);
    } finally {
      db.close();
    }
  });

  it('未登记的包类型写不进去', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(randomUUID(), gameId, 'kuaishou', 'b1', 'https://x/a.zip', 1, 'h', now()),
        /FOREIGN KEY/,
      );
    } finally {
      db.close();
    }
  });
});

describe('目标实例去重 (game, kind, credential, location)', () => {
  it('同类型同位置重复插入被拒', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      insertTarget(db, gameId, 'wechat', { appid: 'wx123' });
      assert.throws(() => insertTarget(db, gameId, 'wechat', { appid: 'wx123' }), /UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('键序不同但语义相同的位置也被判为重复', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      insertTarget(db, gameId, 'h5-r2', { bucket: 'b', prefix: 'p' });
      assert.throws(
        () => insertTarget(db, gameId, 'h5-r2', { prefix: 'p', bucket: 'b' }),
        /UNIQUE/,
      );
    } finally {
      db.close();
    }
  });

  it('同类型不同 appid 可共存（正式号 + 测试号）', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      insertTarget(db, gameId, 'wechat', { appid: 'wx-prod' });
      insertTarget(db, gameId, 'wechat', { appid: 'wx-test' });
      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM targets').get();
      assert.equal(count?.n, 2);
    } finally {
      db.close();
    }
  });

  it('同凭据不同路径可共存（生产 + 灰度）', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      const credId = randomUUID();
      db.prepare(
        'INSERT INTO credentials (id, name, type, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(credId, 'r2-prod', 's3Keys', Buffer.from('cipher'), now(), now());

      insertTarget(db, gameId, 'h5-r2', { bucket: 'b', prefix: 'demo/' }, credId);
      insertTarget(db, gameId, 'h5-r2', { bucket: 'b', prefix: 'demo-staging/' }, credId);
      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM targets').get();
      assert.equal(count?.n, 2);
    } finally {
      db.close();
    }
  });

  it('无凭据的重复实例同样被拒（NULL 不应绕过唯一约束）', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      insertTarget(db, gameId, 'h5-nginx', { path: '/srv/a' }, null);
      assert.throws(() => insertTarget(db, gameId, 'h5-nginx', { path: '/srv/a' }, null), /UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('不同游戏可以有完全相同的目标配置', () => {
    const db = freshDb();
    try {
      const a = seedGame(db, 'game-a');
      const b = seedGame(db, 'game-b');
      insertTarget(db, a, 'wechat', { appid: 'wx123' });
      insertTarget(db, b, 'wechat', { appid: 'wx123' });
      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM targets').get();
      assert.equal(count?.n, 2);
    } finally {
      db.close();
    }
  });
});

describe('发布记录', () => {
  it('同一构建可发到两个目标，各自独立', () => {
    const db = freshDb();
    try {
      const gameId = seedGame(db);
      const typeId = seedPackageType(db);
      const buildId = randomUUID();
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(buildId, gameId, typeId, 'b1', 'https://x/a.zip', 1, 'h', now());

      insertTarget(db, gameId, 'wechat', { appid: 'wx-prod' });
      insertTarget(db, gameId, 'wechat', { appid: 'wx-test' });
      const targets = db.prepare<[], { id: string }>('SELECT id FROM targets').all();

      const insertRelease = db.prepare(
        `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      );
      for (const t of targets) {
        insertRelease.run(randomUUID(), buildId, t.id, '{}', now());
      }

      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM releases').get();
      assert.equal(count?.n, 2);
    } finally {
      db.close();
    }
  });

  it('非法状态被 CHECK 拒绝', () => {
    const db = freshDb();
    try {
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
               VALUES (?, 'b', 't', '{}', 'bogus', ?)`,
            )
            .run(randomUUID(), now()),
        /CHECK constraint failed|FOREIGN KEY/,
      );
    } finally {
      db.close();
    }
  });

  it('同一阶段的多次尝试各自留痕', () => {
    const db = freshDb();
    try {
      const releaseId = seedRelease(db);
      const insert = db.prepare(
        `INSERT INTO release_stages (id, release_id, stage_id, seq, attempt, status)
         VALUES (?, ?, 'submit', 2, ?, ?)`,
      );
      insert.run(randomUUID(), releaseId, 1, 'failed');
      insert.run(randomUUID(), releaseId, 2, 'success');

      const rows = db
        .prepare<[], { attempt: number; status: string }>(
          'SELECT attempt, status FROM release_stages ORDER BY attempt',
        )
        .all();
      assert.deepEqual(rows, [
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'success' },
      ]);

      // 同一 attempt 重复写入被拒
      assert.throws(() => insert.run(randomUUID(), releaseId, 2, 'success'), /UNIQUE/);
    } finally {
      db.close();
    }
  });
});

describe('locationKey', () => {
  it('键序不影响结果', () => {
    assert.equal(locationKey({ a: 1, b: 2 }), locationKey({ b: 2, a: 1 }));
  });

  it('嵌套对象的键序同样不影响结果', () => {
    assert.equal(
      locationKey({ outer: { x: 1, y: 2 }, z: 3 }),
      locationKey({ z: 3, outer: { y: 2, x: 1 } }),
    );
  });

  it('不同值产生不同结果', () => {
    assert.notEqual(locationKey({ appid: 'a' }), locationKey({ appid: 'b' }));
  });

  it('空值与缺失视为等同', () => {
    assert.equal(locationKey({ a: 1, b: null }), locationKey({ a: 1 }));
  });

  it('数组顺序有意义', () => {
    assert.notEqual(locationKey({ a: [1, 2] }), locationKey({ a: [2, 1] }));
  });
});
