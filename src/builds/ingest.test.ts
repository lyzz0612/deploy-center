import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGame, createPackageType } from '../catalog/index.js';
import { ensureSchema, open, type Db } from '../db/index.js';
import { parseBuildReport, resolveReport } from './ingest.js';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

const validBody = {
  game: 'demo',
  packageType: 'wechat',
  buildId: 'b20261124',
  artifactUrl: 'https://example.com/a.zip',
  sizeBytes: 8_421_376,
  sha256: 'a'.repeat(64),
  commitSha: 'a1b2c3d',
  description: 'feat: 新手引导',
};

describe('上报载荷解析', () => {
  it('完整载荷被接受', () => {
    const report = parseBuildReport(validBody);
    assert.equal(report.game, 'demo');
    assert.equal(report.buildId, 'b20261124');
    assert.equal(report.sizeBytes, 8_421_376);
    assert.equal(report.commitSha, 'a1b2c3d');
  });

  it('可选字段缺失时不出现在结果里', () => {
    const { commitSha, description, ...minimal } = validBody;
    const report = parseBuildReport(minimal);
    assert.equal('commitSha' in report, false);
    assert.equal('description' in report, false);
  });

  it('sha256 统一转小写', () => {
    const report = parseBuildReport({ ...validBody, sha256: 'A'.repeat(64) });
    assert.equal(report.sha256, 'a'.repeat(64));
  });

  it('缺 sha256 被拒', () => {
    const { sha256, ...body } = validBody;
    assert.throws(() => parseBuildReport(body), /sha256 必须是非空字符串/);
  });

  it('sha256 格式不对被拒', () => {
    for (const bad of ['tooshort', 'z'.repeat(64), 'a'.repeat(63)]) {
      assert.throws(
        () => parseBuildReport({ ...validBody, sha256: bad }),
        /64 位十六进制/,
        `${bad} 应被拒`,
      );
    }
  });

  it('缺 sizeBytes 被拒', () => {
    const { sizeBytes, ...body } = validBody;
    assert.throws(() => parseBuildReport(body), /sizeBytes 必须是正整数/);
  });

  it('sizeBytes 非正整数被拒', () => {
    for (const bad of [0, -1, 1.5, '100']) {
      assert.throws(
        () => parseBuildReport({ ...validBody, sizeBytes: bad }),
        /必须是正整数/,
        `${bad} 应被拒`,
      );
    }
  });

  it('artifactUrl 不是合法 URL 被拒', () => {
    assert.throws(() => parseBuildReport({ ...validBody, artifactUrl: 'not a url' }), /不是合法的 URL/);
  });

  it('artifactUrl 协议不是 http(s) 被拒', () => {
    for (const url of ['file:///etc/passwd', 'ftp://host/a.zip', 'javascript:alert(1)']) {
      assert.throws(
        () => parseBuildReport({ ...validBody, artifactUrl: url }),
        /必须是 http 或 https/,
        `${url} 应被拒`,
      );
    }
  });

  it('必填字符串为空被拒', () => {
    for (const field of ['game', 'packageType', 'buildId']) {
      assert.throws(
        () => parseBuildReport({ ...validBody, [field]: '   ' }),
        new RegExp(`${field} 必须是非空字符串`),
      );
    }
  });

  it('请求体不是对象被拒', () => {
    for (const body of [null, undefined, 'string', 42, []]) {
      assert.throws(() => parseBuildReport(body), /必须是 JSON 对象/);
    }
  });
});

describe('上报目标解析', () => {
  it('游戏与包类型都已登记时通过', () => {
    const db = freshDb();
    try {
      createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });

      const resolved = resolveReport(db, parseBuildReport(validBody));
      assert.equal(resolved.game.slug, 'demo');
      assert.equal(resolved.packageType.id, 'wechat');
    } finally {
      db.close();
    }
  });

  it('未登记的包类型被拒，且不写入任何记录', () => {
    const db = freshDb();
    try {
      createGame(db, { slug: 'demo', displayName: '示例' });
      // 包类型故意不登记

      assert.throws(() => resolveReport(db, parseBuildReport(validBody)), /包类型「wechat」未登记/);

      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
      assert.equal(count?.n, 0, '拒绝时不应写入任何构建记录');
    } finally {
      db.close();
    }
  });

  it('未登记的游戏被拒，且不写入任何记录', () => {
    const db = freshDb();
    try {
      createPackageType(db, { id: 'wechat', displayName: '微信' });

      assert.throws(() => resolveReport(db, parseBuildReport(validBody)), /游戏「demo」未登记/);

      const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
      assert.equal(count?.n, 0);
    } finally {
      db.close();
    }
  });

  it('归档的包类型被拒', () => {
    const db = freshDb();
    try {
      createGame(db, { slug: 'demo', displayName: '示例' });
      createPackageType(db, { id: 'wechat', displayName: '微信' });
      db.prepare('UPDATE package_types SET archived_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        'wechat',
      );
      assert.throws(() => resolveReport(db, parseBuildReport(validBody)), /已归档/);
    } finally {
      db.close();
    }
  });
});
