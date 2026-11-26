import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { ensureSchema, open, type Db } from './connection.js';
import { locationKey } from './location-key.js';
import {
  deleteIfUnreferenced,
  findReferences,
  protectedTables,
  ReferencedError,
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
  it('四处受保护的表都在清单里', () => {
    assert.deepEqual(protectedTables().slice().sort(), [
      'credentials',
      'games',
      'package_types',
      'targets',
    ]);
  });

  it('清单外的表被拒绝操作，而不是拼出一条 SQL', () => {
    const db = freshDb();
    try {
      for (const fn of [findReferences, deleteIfUnreferenced]) {
        assert.throws(() => fn(db, 'releases', 'x'), /不在引用保护清单里/);
      }
    } finally {
      db.close();
    }
  });

  it('没有归档入口了：模块只导出查引用与删除', async () => {
    const mod = await import('./references.js');
    assert.equal('archive' in mod, false, '归档已移除，不该还能调用');
    assert.equal('unarchive' in mod, false);
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

  it('删掉引用它的目标后，凭据就变成可删', () => {
    const db = freshDb();
    try {
      const f = seedAll(db, false);
      assert.equal(findReferences(db, 'credentials', f.credentialId).referenced, true);

      deleteIfUnreferenced(db, 'targets', f.targetId);
      assert.equal(findReferences(db, 'credentials', f.credentialId).referenced, false);
      deleteIfUnreferenced(db, 'credentials', f.credentialId);

      const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM credentials').get();
      assert.equal(row?.n, 0);
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

describe('游戏 ← 构建 / 目标', () => {
  it('能查出游戏被谁引用（级联删除前要展示给用户）', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      const check = findReferences(db, 'games', f.gameId);
      assert.equal(check.referenced, true);
      // 一条构建 + 一个目标
      assert.equal(check.count, 2);
      const labels = check.samples.map((s) => s.label).join(' ');
      assert.match(labels, /构建 b20261124/);
      assert.match(labels, /目标 微信正式号/);
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

describe('错误信息', () => {
  it('说的是「不能删除」而不是「只能归档」', () => {
    const db = freshDb();
    try {
      const f = seedAll(db);
      assert.throws(
        () => deleteIfUnreferenced(db, 'targets', f.targetId),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.ok(error instanceof ReferencedError);
          assert.match(message, /不能删除/);
          assert.equal(/归档/.test(message), false, '归档已不存在，不该出现在提示里');
          return true;
        },
      );
    } finally {
      db.close();
    }
  });
});
