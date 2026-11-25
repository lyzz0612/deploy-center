import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureSchema, open, type Db } from '../db/index.js';
import { hashPassword, verifyPassword } from '../shared/hash.js';
import { createSessionStore } from './session.js';
import {
  checkPassword,
  isPasswordSet,
  issueCiKey,
  listCiKeys,
  revokeCiKey,
  setPassword,
  updateCiKey,
  verifyCiKey,
} from './store.js';

const MASTER_KEY = 'test-master-key-0123456789';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

describe('口令哈希', () => {
  it('同一口令两次哈希结果不同（加盐），但都能校验通过', () => {
    const a = hashPassword('correct horse battery');
    const b = hashPassword('correct horse battery');
    assert.notEqual(a, b);
    assert.equal(verifyPassword('correct horse battery', a), true);
    assert.equal(verifyPassword('correct horse battery', b), true);
  });

  it('哈希串里不含原文', () => {
    const stored = hashPassword('my-secret-password');
    assert.equal(stored.includes('my-secret-password'), false);
  });

  it('错误口令不通过', () => {
    const stored = hashPassword('right-password');
    assert.equal(verifyPassword('wrong-password', stored), false);
  });

  it('哈希串损坏时报错而不是静默返回 false', () => {
    assert.throws(() => verifyPassword('x', 'not-a-valid-hash'), /无法识别的口令哈希格式/);
  });
});

describe('管理员口令', () => {
  it('初始状态未设置口令，任何口令都不通过', () => {
    const db = freshDb();
    try {
      assert.equal(isPasswordSet(db), false);
      assert.equal(checkPassword(db, 'anything'), false);
    } finally {
      db.close();
    }
  });

  it('设置后可校验', () => {
    const db = freshDb();
    try {
      setPassword(db, 'initial-password');
      assert.equal(isPasswordSet(db), true);
      assert.equal(checkPassword(db, 'initial-password'), true);
      assert.equal(checkPassword(db, 'other'), false);
    } finally {
      db.close();
    }
  });

  it('过短口令被拒', () => {
    const db = freshDb();
    try {
      assert.throws(() => setPassword(db, 'short'), /至少 8 个字符/);
    } finally {
      db.close();
    }
  });

  it('已设置口令后，不提供当前口令不能更换', () => {
    const db = freshDb();
    try {
      setPassword(db, 'initial-password');
      assert.throws(() => setPassword(db, 'new-password-x'), /必须提供当前口令/);
      assert.throws(() => setPassword(db, 'new-password-x', 'wrong'), /当前口令不正确/);
      setPassword(db, 'new-password-x', 'initial-password');
      assert.equal(checkPassword(db, 'new-password-x'), true);
    } finally {
      db.close();
    }
  });
});

describe('CI key', () => {
  it('签发后可校验，且列表里能取回明文', () => {
    const db = freshDb();
    try {
      const issued = issueCiKey(db, 'github-actions', MASTER_KEY);
      assert.match(issued.value ?? '', /^mgc_/);
      assert.equal(verifyCiKey(db, issued.value!), issued.id);

      const list = listCiKeys(db, MASTER_KEY);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.prefix, issued.prefix);
      assert.equal(list[0]!.value, issued.value);
    } finally {
      db.close();
    }
  });

  it('可以指定 key 值，也可以随时换成另一个值', () => {
    const db = freshDb();
    try {
      const issued = issueCiKey(db, 'self-use', MASTER_KEY, 'my-own-ci-key-0001');
      assert.equal(issued.value, 'my-own-ci-key-0001');
      assert.equal(verifyCiKey(db, 'my-own-ci-key-0001'), issued.id);

      updateCiKey(db, issued.id, { value: 'my-own-ci-key-0002' }, MASTER_KEY);
      assert.equal(verifyCiKey(db, 'my-own-ci-key-0001'), null, '旧值应立即失效');
      assert.equal(verifyCiKey(db, 'my-own-ci-key-0002'), issued.id);
      assert.equal(listCiKeys(db, MASTER_KEY)[0]!.value, 'my-own-ci-key-0002');
    } finally {
      db.close();
    }
  });

  it('过短的自定义 key 被拒', () => {
    const db = freshDb();
    try {
      assert.throws(() => issueCiKey(db, 'k', MASTER_KEY, 'short'), /至少 8 个字符/);
    } finally {
      db.close();
    }
  });

  it('库里存的是哈希与密文，不出现明文', () => {
    const db = freshDb();
    try {
      const issued = issueCiKey(db, 'k', MASTER_KEY);
      const row = db
        .prepare<[], { token_hash: string; token_encrypted: Buffer }>(
          'SELECT token_hash, token_encrypted FROM ci_keys',
        )
        .get();
      assert.ok(row);
      assert.equal(row.token_hash.includes(issued.value!), false);
      assert.match(row.token_hash, /^[0-9a-f]{64}$/);
      assert.equal(row.token_encrypted.toString('utf8').includes(issued.value!), false);
    } finally {
      db.close();
    }
  });

  it('主密钥不对时列表仍能打开，只是取不回明文', () => {
    const db = freshDb();
    try {
      issueCiKey(db, 'k', MASTER_KEY);
      const list = listCiKeys(db, 'another-master-key-9876543210');
      assert.equal(list.length, 1);
      assert.equal(list[0]!.value, null);
    } finally {
      db.close();
    }
  });

  it('错误 key 不通过', () => {
    const db = freshDb();
    try {
      issueCiKey(db, 'k', MASTER_KEY);
      assert.equal(verifyCiKey(db, 'mgc_wrong-key-value'), null);
    } finally {
      db.close();
    }
  });

  it('吊销后不再通过，也不能再改值', () => {
    const db = freshDb();
    try {
      const issued = issueCiKey(db, 'k', MASTER_KEY);
      revokeCiKey(db, issued.id);
      assert.equal(verifyCiKey(db, issued.value!), null);
      assert.throws(() => revokeCiKey(db, issued.id), /已吊销/);
      assert.throws(
        () => updateCiKey(db, issued.id, { value: 'another-key-0001' }, MASTER_KEY),
        /已吊销/,
      );
    } finally {
      db.close();
    }
  });

  it('校验成功会记录使用时间', () => {
    const db = freshDb();
    try {
      const issued = issueCiKey(db, 'k', MASTER_KEY);
      assert.equal(listCiKeys(db, MASTER_KEY)[0]!.lastUsedAt, null);
      verifyCiKey(db, issued.value!);
      assert.notEqual(listCiKeys(db, MASTER_KEY)[0]!.lastUsedAt, null);
    } finally {
      db.close();
    }
  });
});

describe('管理员会话', () => {
  it('创建的 token 可校验，未知 token 不通过', () => {
    const sessions = createSessionStore();
    const token = sessions.create();
    assert.equal(sessions.verify(token), true);
    assert.equal(sessions.verify('unknown-token'), false);
    assert.equal(sessions.verify(undefined), false);
  });

  it('销毁后不再通过', () => {
    const sessions = createSessionStore();
    const token = sessions.create();
    sessions.destroy(token);
    assert.equal(sessions.verify(token), false);
  });

  it('过期后不再通过且被清理', () => {
    const sessions = createSessionStore(1);
    const token = sessions.create();
    const until = Date.now() + 20;
    while (Date.now() < until) {
      /* 等待过期 */
    }
    assert.equal(sessions.verify(token), false);
    assert.equal(sessions.size, 0);
  });
});
