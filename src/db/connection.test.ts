import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { databaseFile, ensureSchema, open } from './connection.js';
import { SCHEMA_VERSION } from './schema.js';

const scratch = mkdtempSync(join(tmpdir(), 'console-db-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function userVersion(db: ReturnType<typeof open>): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  return rows[0]!.user_version;
}

describe('ensureSchema', () => {
  it('第一次调用建库并写入结构版本', () => {
    const db = open({ file: join(scratch, 'first.db') });
    try {
      const result = ensureSchema(db);
      assert.equal(result.previousVersion, 0);
      assert.equal(result.version, SCHEMA_VERSION);
      assert.equal(result.created, true);
      assert.equal(userVersion(db), SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('第二次调用幂等：结构版本不变，不再报告为新建', () => {
    const file = join(scratch, 'idempotent.db');

    const first = open({ file });
    try {
      ensureSchema(first);
    } finally {
      first.close();
    }

    const second = open({ file });
    try {
      const result = ensureSchema(second);
      assert.equal(result.previousVersion, SCHEMA_VERSION);
      assert.equal(result.version, SCHEMA_VERSION);
      assert.equal(result.created, false);
      assert.equal(userVersion(second), SCHEMA_VERSION);
    } finally {
      second.close();
    }
  });

  it('库的结构版本高于程序支持时拒绝启动', () => {
    const file = join(scratch, 'from-future.db');
    const seed = open({ file });
    try {
      seed.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    } finally {
      seed.close();
    }

    const db = open({ file });
    try {
      assert.throws(() => ensureSchema(db), /高于本程序支持/);
    } finally {
      db.close();
    }
  });
});

describe('open', () => {
  it('文件库启用 WAL', () => {
    const db = open({ file: join(scratch, 'wal.db') });
    try {
      const mode = db.pragma('journal_mode', { simple: true });
      assert.equal(mode, 'wal');
    } finally {
      db.close();
    }
  });

  it('启用外键约束', () => {
    const db = open({ file: ':memory:' });
    try {
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    } finally {
      db.close();
    }
  });

  it('自动创建缺失的数据目录', () => {
    const nested = join(scratch, 'a', 'b', 'c');
    const db = open({ file: databaseFile(nested) });
    try {
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      db.close();
    }
  });
});
