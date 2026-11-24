import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { ensureSchema, locationKey, open, ReferencedError, type Db } from '../db/index.js';
import { listCredentialTypes } from '../registry/index.js';
import {
  archiveCredential,
  createCredential,
  deleteCredential,
  getCredential,
  listCredentials,
  readSecrets,
  updateCredential,
} from './store.js';

const KEY = 'test-master-key-of-enough-length';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

/** 建一个引用指定凭据的发布目标。 */
function seedTargetUsing(db: Db, credentialId: string): string {
  const gameId = randomUUID();
  db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
    gameId,
    `g-${gameId.slice(0, 8)}`,
    'G',
    new Date().toISOString(),
  );
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
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return targetId;
}

describe('创建凭据', () => {
  it('保存后返回的摘要不含任何明文', () => {
    const db = freshDb();
    try {
      const summary = createCredential(
        db,
        {
          name: 'r2-prod',
          type: 's3Keys',
          secrets: { accessKeyId: 'AKIA-MARKER', secretAccessKey: 'SECRET-MARKER' },
        },
        KEY,
      );

      const serialized = JSON.stringify(summary);
      assert.equal(serialized.includes('AKIA-MARKER'), false);
      assert.equal(serialized.includes('SECRET-MARKER'), false);

      assert.deepEqual(summary.fieldsSet, {
        accessKeyId: true,
        secretAccessKey: true,
        endpoint: false,
        region: false,
      });
      assert.equal(summary.typeDisplayName, '对象存储密钥对');
    } finally {
      db.close();
    }
  });

  it('库里存的是密文，不含明文', () => {
    const db = freshDb();
    try {
      createCredential(
        db,
        { name: 'c', type: 'secretText', secrets: { secret: 'PLAINTEXT-MARKER' } },
        KEY,
      );
      const row = db.prepare<[], { secrets: Buffer }>('SELECT secrets FROM credentials').get();
      assert.ok(row);
      assert.equal(row.secrets.toString('utf8').includes('PLAINTEXT-MARKER'), false);
      assert.equal(row.secrets.toString('base64').includes('PLAINTEXT-MARKER'), false);
    } finally {
      db.close();
    }
  });

  it('同名凭据被拒，错误信息说清是重名', () => {
    const db = freshDb();
    try {
      createCredential(db, { name: 'dup', type: 'secretText', secrets: { secret: 'a' } }, KEY);
      assert.throws(
        () => createCredential(db, { name: 'dup', type: 'secretText', secrets: { secret: 'b' } }, KEY),
        /已存在名为「dup」的凭据/,
      );
    } finally {
      db.close();
    }
  });

  it('空名称被拒', () => {
    const db = freshDb();
    try {
      assert.throws(
        () => createCredential(db, { name: '   ', type: 'secretText', secrets: { secret: 'a' } }, KEY),
        /名称不能为空/,
      );
    } finally {
      db.close();
    }
  });
});

describe('五种内置类型的字段校验', () => {
  // 每种类型各有一个「缺必填字段」与一个「字段完整」的用例。
  const cases: Array<{
    type: 'secretText' | 'usernamePassword' | 'sshKey' | 's3Keys' | 'file';
    complete: Record<string, string>;
    incomplete: Record<string, string>;
    missingField: string;
  }> = [
    {
      type: 'secretText',
      complete: { secret: 'token' },
      incomplete: {},
      missingField: '密钥',
    },
    {
      type: 'usernamePassword',
      complete: { username: 'alice', password: 'pw' },
      incomplete: { username: 'alice' },
      missingField: '密码',
    },
    {
      type: 'sshKey',
      complete: { privateKey: '-----BEGIN-----' },
      incomplete: { passphrase: 'only-passphrase' },
      missingField: '私钥',
    },
    {
      type: 's3Keys',
      complete: { accessKeyId: 'AK', secretAccessKey: 'SK' },
      incomplete: { accessKeyId: 'AK' },
      missingField: 'Secret Access Key',
    },
    {
      type: 'file',
      complete: { content: 'key-bytes' },
      incomplete: {},
      missingField: '文件内容',
    },
  ];

  it('五种类型都被覆盖', () => {
    const covered = cases.map((c) => c.type).sort();
    const registered = listCredentialTypes()
      .map((t) => t.id)
      .sort();
    assert.deepEqual(covered, registered);
  });

  for (const testCase of cases) {
    it(`${testCase.type}：缺必填字段被拒`, () => {
      const db = freshDb();
      try {
        assert.throws(
          () =>
            createCredential(
              db,
              { name: `c-${testCase.type}`, type: testCase.type, secrets: testCase.incomplete },
              KEY,
            ),
          new RegExp(testCase.missingField),
        );
      } finally {
        db.close();
      }
    });

    it(`${testCase.type}：字段完整时通过`, () => {
      const db = freshDb();
      try {
        const summary = createCredential(
          db,
          { name: `ok-${testCase.type}`, type: testCase.type, secrets: testCase.complete },
          KEY,
        );
        assert.equal(summary.type, testCase.type);
        for (const field of Object.keys(testCase.complete)) {
          assert.equal(summary.fieldsSet[field], true, `${field} 应标记为已设置`);
        }
      } finally {
        db.close();
      }
    });
  }

  it('未声明的字段被拒', () => {
    const db = freshDb();
    try {
      assert.throws(
        () =>
          createCredential(
            db,
            { name: 'c', type: 'secretText', secrets: { secret: 'a', bogus: 'b' } },
            KEY,
          ),
        /未声明的字段 bogus/,
      );
    } finally {
      db.close();
    }
  });
});

describe('读取凭据', () => {
  it('列表与详情都不返回明文', () => {
    const db = freshDb();
    try {
      createCredential(
        db,
        { name: 'c1', type: 'secretText', secrets: { secret: 'LIST-MARKER' } },
        KEY,
      );
      const list = listCredentials(db, KEY);
      assert.equal(JSON.stringify(list).includes('LIST-MARKER'), false);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.fieldsSet['secret'], true);
    } finally {
      db.close();
    }
  });

  it('按类型过滤（用于「选择凭据」下拉框）', () => {
    const db = freshDb();
    try {
      createCredential(db, { name: 'a', type: 's3Keys', secrets: { accessKeyId: 'k', secretAccessKey: 's' } }, KEY);
      createCredential(db, { name: 'b', type: 'file', secrets: { content: 'x' } }, KEY);

      const s3Only = listCredentials(db, KEY, { type: 's3Keys' });
      assert.equal(s3Only.length, 1);
      assert.equal(s3Only[0]!.name, 'a');
    } finally {
      db.close();
    }
  });

  it('缺省不列已归档的', () => {
    const db = freshDb();
    try {
      const c = createCredential(db, { name: 'c', type: 'secretText', secrets: { secret: 'a' } }, KEY);
      archiveCredential(db, c.id);
      assert.equal(listCredentials(db, KEY).length, 0);
      assert.equal(listCredentials(db, KEY, { includeArchived: true }).length, 1);
    } finally {
      db.close();
    }
  });

  it('不存在的 id 报错', () => {
    const db = freshDb();
    try {
      assert.throws(() => getCredential(db, 'no-such-id', KEY), /不存在/);
    } finally {
      db.close();
    }
  });

  it('readSecrets 是取明文的唯一入口', () => {
    const db = freshDb();
    try {
      const c = createCredential(
        db,
        { name: 'c', type: 'usernamePassword', secrets: { username: 'alice', password: 'pw' } },
        KEY,
      );
      assert.deepEqual(readSecrets(db, c.id, KEY), { username: 'alice', password: 'pw' });
    } finally {
      db.close();
    }
  });
});

describe('就地轮换', () => {
  it('更新后引用方下次取用拿到新值，详情仍不回显', () => {
    const db = freshDb();
    try {
      const c = createCredential(
        db,
        { name: 'r2', type: 's3Keys', secrets: { accessKeyId: 'AK-OLD', secretAccessKey: 'SK-OLD' } },
        KEY,
      );
      const targetId = seedTargetUsing(db, c.id);

      updateCredential(db, c.id, { secrets: { secretAccessKey: 'SK-NEW' } }, KEY);

      // 引用方没有任何改动
      const target = db
        .prepare<[string], { credential_id: string }>(
          'SELECT credential_id FROM targets WHERE id = ?',
        )
        .get(targetId);
      assert.equal(target?.credential_id, c.id);

      // 取用拿到新值，而未提及的字段保持原样（不是整组替换）
      assert.deepEqual(readSecrets(db, c.id, KEY), {
        accessKeyId: 'AK-OLD',
        secretAccessKey: 'SK-NEW',
      });

      // 详情接口仍不回显
      const summary = getCredential(db, c.id, KEY);
      assert.equal(JSON.stringify(summary).includes('SK-NEW'), false);
      assert.equal(summary.fieldsSet['secretAccessKey'], true);
    } finally {
      db.close();
    }
  });

  it('传空串清掉一个可选字段', () => {
    const db = freshDb();
    try {
      const c = createCredential(
        db,
        {
          name: 'r2',
          type: 's3Keys',
          secrets: { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto' },
        },
        KEY,
      );
      assert.equal(getCredential(db, c.id, KEY).fieldsSet['region'], true);

      updateCredential(db, c.id, { secrets: { region: '' } }, KEY);
      assert.equal(getCredential(db, c.id, KEY).fieldsSet['region'], false);
      assert.equal('region' in readSecrets(db, c.id, KEY), false);
    } finally {
      db.close();
    }
  });

  it('清掉必填字段被拒', () => {
    const db = freshDb();
    try {
      const c = createCredential(
        db,
        { name: 'r2', type: 's3Keys', secrets: { accessKeyId: 'AK', secretAccessKey: 'SK' } },
        KEY,
      );
      assert.throws(
        () => updateCredential(db, c.id, { secrets: { secretAccessKey: '' } }, KEY),
        /Secret Access Key 为必填/,
      );
    } finally {
      db.close();
    }
  });

  it('更新 updated_at 而保留 created_at', () => {
    const db = freshDb();
    try {
      const c = createCredential(db, { name: 'c', type: 'secretText', secrets: { secret: 'a' } }, KEY);
      db.prepare('UPDATE credentials SET created_at = ?, updated_at = ? WHERE id = ?').run(
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        c.id,
      );

      const updated = updateCredential(db, c.id, { secrets: { secret: 'b' } }, KEY);
      assert.equal(updated.createdAt, '2020-01-01T00:00:00.000Z');
      assert.notEqual(updated.updatedAt, '2020-01-01T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('改名到已占用的名称被拒', () => {
    const db = freshDb();
    try {
      createCredential(db, { name: 'taken', type: 'secretText', secrets: { secret: 'a' } }, KEY);
      const b = createCredential(db, { name: 'b', type: 'secretText', secrets: { secret: 'b' } }, KEY);
      assert.throws(() => updateCredential(db, b.id, { name: 'taken' }, KEY), /已存在名为/);
    } finally {
      db.close();
    }
  });
});

describe('引用计数与删除', () => {
  it('摘要里带上有多少目标在引用它', () => {
    const db = freshDb();
    try {
      const c = createCredential(db, { name: 'c', type: 'file', secrets: { content: 'x' } }, KEY);
      assert.equal(getCredential(db, c.id, KEY).referenceCount, 0);
      seedTargetUsing(db, c.id);
      assert.equal(getCredential(db, c.id, KEY).referenceCount, 1);
    } finally {
      db.close();
    }
  });

  it('被引用时删除被拒，并列出引用它的目标', () => {
    const db = freshDb();
    try {
      const c = createCredential(db, { name: 'c', type: 'file', secrets: { content: 'x' } }, KEY);
      seedTargetUsing(db, c.id);
      assert.throws(
        () => deleteCredential(db, c.id),
        (error: unknown) => {
          assert.ok(error instanceof ReferencedError);
          assert.match(error.message, /微信正式号/);
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
      const c = createCredential(db, { name: 'c', type: 'file', secrets: { content: 'x' } }, KEY);
      deleteCredential(db, c.id);
      assert.equal(listCredentials(db, KEY, { includeArchived: true }).length, 0);
    } finally {
      db.close();
    }
  });
});

describe('主密钥不匹配', () => {
  it('换了主密钥后读取报错，而不是返回空凭据', () => {
    const db = freshDb();
    try {
      const c = createCredential(db, { name: 'c', type: 'secretText', secrets: { secret: 'a' } }, KEY);
      assert.throws(
        () => readSecrets(db, c.id, 'a-completely-different-master-key'),
        /主密钥不正确/,
      );
      assert.throws(
        () => getCredential(db, c.id, 'a-completely-different-master-key'),
        /主密钥不正确/,
      );
    } finally {
      db.close();
    }
  });
});
