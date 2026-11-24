import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { ensureSchema, open, type Db } from './connection.js';
import { locationKey } from './location-key.js';
import {
  archive,
  deleteIfUnreferenced,
  findReferences,
  protectedTables,
  ReferencedError,
  unarchive,
} from './references.js';

function now(): string {
  return new Date().toISOString();
}

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

interface Fixture {
  readonly gameId: string;
  readonly packageTypeId: string;
  readonly credentialId: string;
  readonly targetId: string;
  readonly buildId: string;
}

/** 建一套完整的关联数据：包类型 ← 构建，凭据 ← 目标，目标 ← 发布记录。 */
function seedAll(db: Db, withReleases = true): Fixture {
  const gameId = randomUUID();
  db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
    gameId,
    'demo',
    'Demo',
    now(),
  );

  const packageTypeId = 'wechat';
  db.prepare('INSERT INTO package_types (id, display_name, created_at) VALUES (?, ?, ?)').run(
    packageTypeId,
    '微信小游戏',
    now(),
  );

  const credentialId = randomUUID();
  db.prepare(
    'INSERT INTO credentials (id, name, type, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(credentialId, 'wx-upload-key', 'file', Buffer.from('cipher'), now(), now());

  const location = { appid: 'wx123' };
  const targetId = randomUUID();
  db.prepare(
    `INSERT INTO targets (id, game_id, kind, name, credential_id, location, location_key, created_at, updated_at)
     VALUES (?, ?, 'wechat', '微信正式号', ?, ?, ?, ?, ?)`,
  ).run(
    targetId,
    gameId,
    credentialId,
    JSON.stringify(location),
    locationKey(location),
    now(),
    now(),
  );

  const buildId = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, commit_sha, reported_at)
     VALUES (?, ?, ?, 'b20261124', 'https://x/a.zip', 100, 'abc', 'a1b2c3d', ?)`,
  ).run(buildId, gameId, packageTypeId, now());

  if (withReleases) {
    db.prepare(
      `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
       VALUES (?, ?, ?, '{}', 'success', ?)`,
    ).run(randomUUID(), buildId, targetId, now());
  }

  return { gameId, packageTypeId, credentialId, targetId, buildId };
}

describe('引用保护清单', () => {
  it('三处受保护的表都在清单里', () => {
    assert.deepEqual(protectedTables().slice().sort(), [
      'credentials',
      'package_types',
      'targets',
    ]);
  });

  it('清单外的表被拒绝操作，而不是拼出一条 SQL', () => {
    const db = freshDb();
    try {
      for (const fn of [findReferences, deleteIfUnreferenced, archive, unarchive]) {
        assert.throws(() => fn(db, 'games', 'x'), /不在引用保护清单里/);
      }
    } finally {
      db.close();
    }
  });
});

describe('包类型 ← 构建', () => {
  it('被构建引用时删除被拒，并指出引用来源', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      const check = findReferences(db, 'package_types', f.packageTypeId);
      assert.equal(check.referenced, true);
      assert.equal(check.count, 1);
      assert.equal(check.samples[0]?.table, 'builds');
      assert.match(check.samples[0]!.label, /b20261124/);

      assert.throws(
        () => deleteIfUnreferenced(db, 'package_types', f.packageTypeId),
        (error: unknown) => {
          assert.ok(error instanceof ReferencedError);
          assert.match(error.message, /该包类型正被引用/);
          assert.match(error.message, /b20261124/);
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
      db.prepare('INSERT INTO package_types (id, display_name, created_at) VALUES (?, ?, ?)').run(
        'unused',
        '没人用',
        now(),
      );
      deleteIfUnreferenced(db, 'package_types', 'unused');
      const row = db
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM package_types WHERE id = ?')
        .get('unused');
      assert.equal(row?.n, 0);
    } finally {
      db.close();
    }
  });
});

describe('凭据 ← 目标', () => {
  it('被目标引用时删除被拒，并列出引用它的目标名', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      assert.throws(
        () => deleteIfUnreferenced(db, 'credentials', f.credentialId),
        (error: unknown) => {
          assert.match((error as Error).message, /该凭据正被引用/);
          assert.match((error as Error).message, /微信正式号/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('目标归档后凭据仍被引用（归档不等于解除引用）', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      archive(db, 'targets', f.targetId);
      const check = findReferences(db, 'credentials', f.credentialId);
      assert.equal(check.referenced, true);
    } finally {
      db.close();
    }
  });
});

describe('目标 ← 发布记录', () => {
  it('有发布历史时删除被拒', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      assert.throws(
        () => deleteIfUnreferenced(db, 'targets', f.targetId),
        /该发布目标正被引用/,
      );
    } finally {
      db.close();
    }
  });

  it('没有发布历史时可以删除', () => {
    const db = freshDb();
    try {
      const f = seedAll(db, false);
      deleteIfUnreferenced(db, 'targets', f.targetId);
      const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM targets').get();
      assert.equal(row?.n, 0);
    } finally {
      db.close();
    }
  });
});

describe('归档', () => {
  it('归档后记录仍可读，历史不丢', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      archive(db, 'targets', f.targetId);

      const row = db
        .prepare<[string], { archived_at: string | null; name: string }>(
          'SELECT archived_at, name FROM targets WHERE id = ?',
        )
        .get(f.targetId);
      assert.ok(row?.archived_at, '应记录归档时间');
      assert.equal(row.name, '微信正式号');

      // 发布记录仍然指得到它
      const releases = db
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM releases WHERE target_id = ?')
        .get(f.targetId);
      assert.equal(releases?.n, 1);
    } finally {
      db.close();
    }
  });

  it('重复归档报错而不是静默成功', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      archive(db, 'targets', f.targetId);
      assert.throws(() => archive(db, 'targets', f.targetId), /没有 id .* 的未归档记录/);
    } finally {
      db.close();
    }
  });

  it('可以取消归档', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      archive(db, 'targets', f.targetId);
      unarchive(db, 'targets', f.targetId);
      const row = db
        .prepare<[string], { archived_at: string | null }>(
          'SELECT archived_at FROM targets WHERE id = ?',
        )
        .get(f.targetId);
      assert.equal(row?.archived_at, null);
    } finally {
      db.close();
    }
  });

  it('取消归档一条未归档的记录报错', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      assert.throws(() => unarchive(db, 'targets', f.targetId), /没有 id .* 的已归档记录/);
    } finally {
      db.close();
    }
  });

  it('归档不存在的记录报错', () => {
    const db = freshDb();
    try {
      assert.throws(() => archive(db, 'targets', 'no-such-id'), /没有 id/);
    } finally {
      db.close();
    }
  });
});

describe('删除不存在的记录', () => {
  it('报错而不是静默成功', () => {
    const db = freshDb();
    try {
      assert.throws(() => deleteIfUnreferenced(db, 'credentials', 'no-such-id'), /没有 id/);
    } finally {
      db.close();
    }
  });
});
