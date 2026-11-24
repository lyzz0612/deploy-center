import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ensureSchema, open, type Db } from '../db/index.js';
import { locationKey } from '../db/location-key.js';
import type { Field } from './fields.js';
import { checkRegistries, checkStoredTargets, runSelfCheck } from './selfcheck.js';
import { registerTargetKind, resetTargetKinds } from './target-kind-registry.js';
import type { TargetKind, TargetKindManifest } from './target-kind.js';

afterEach(() => resetTargetKinds());

const baseManifest: TargetKindManifest = {
  id: 'ok-kind',
  displayName: 'OK',
  description: 'test',
  accepts: ['h5'],
  requiresCredential: 's3Keys',
  requiresCli: [],
  targetFields: [{ key: 'bucket', label: 'Bucket', type: 'string', required: true, identity: true }],
  publishFields: [],
  stages: [{ id: 'upload', name: '上传', timeoutMs: 60_000 }],
  capabilities: { rollback: 'pointer', verify: false, activateLatencySeconds: 1 },
};

function kindWith(overrides: Partial<TargetKindManifest>, extra: Partial<TargetKind> = {}): TargetKind {
  return {
    manifest: { ...baseManifest, ...overrides },
    globalChecks: [],
    targetChecks: [],
    execute: async () => ({}),
    ...extra,
  };
}

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

describe('注册表自检：通过的情形', () => {
  it('合法插件无问题', () => {
    registerTargetKind(kindWith({}));
    assert.deepEqual(checkRegistries(), []);
  });

  it('accepts 全部已登记时无问题', () => {
    registerTargetKind(kindWith({}));
    assert.deepEqual(checkRegistries({ knownPackageTypes: ['h5', 'wechat'] }), []);
  });

  it('不传已登记包类型时跳过该项检查（包类型是数据，可能还没登记）', () => {
    registerTargetKind(kindWith({ accepts: ['not-yet-registered'] }));
    assert.deepEqual(checkRegistries(), []);
  });
});

describe('注册表自检：引用完整性', () => {
  it('accepts 指向未登记的包类型被报出', () => {
    registerTargetKind(kindWith({ accepts: ['kuaishou'] }));
    const problems = checkRegistries({ knownPackageTypes: ['h5'] });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /未登记的包类型 kuaishou/);
  });

  it('requiresCredential 指向未注册的凭据类型被报出', () => {
    registerTargetKind(
      kindWith({ requiresCredential: 'bogusType' as never }),
    );
    const problems = checkRegistries();
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /未注册的凭据类型/);
  });

  it('requiresCli 指向未注册的 CLI 被报出', () => {
    registerTargetKind(kindWith({ requiresCli: ['no-such-cli'] }));
    const problems = checkRegistries();
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /未注册的 CLI/);
  });

  it('requiresCredential 为 null 是合法的（不需要凭据的目标）', () => {
    registerTargetKind(kindWith({ requiresCredential: null }));
    assert.deepEqual(checkRegistries(), []);
  });

  it('一次报出全部问题而不是只报第一个', () => {
    registerTargetKind(
      kindWith({
        accepts: [],
        requiresCli: ['no-such-cli'],
        stages: [],
      }),
    );
    const problems = checkRegistries();
    assert.ok(problems.length >= 3, `应报出多个问题，实际 ${problems.length} 个`);
  });
});

describe('注册表自检：阶段与能力', () => {
  it('没有阶段被报出', () => {
    registerTargetKind(kindWith({ stages: [] }));
    assert.match(checkRegistries()[0]!.message, /没有声明任何阶段/);
  });

  it('阶段 id 重复被报出', () => {
    registerTargetKind(
      kindWith({
        stages: [
          { id: 'upload', name: '上传', timeoutMs: 1000 },
          { id: 'upload', name: '又上传', timeoutMs: 1000 },
        ],
      }),
    );
    assert.match(checkRegistries()[0]!.message, /阶段 id 重复/);
  });

  it('非正数超时被报出', () => {
    registerTargetKind(kindWith({ stages: [{ id: 'upload', name: '上传', timeoutMs: 0 }] }));
    assert.match(checkRegistries()[0]!.message, /超时必须为正数/);
  });

  it('声明 verify 但没实现被报出', () => {
    registerTargetKind(
      kindWith({ capabilities: { rollback: 'none', verify: true, activateLatencySeconds: 0 } }),
    );
    assert.match(checkRegistries()[0]!.message, /没有实现 verify/);
  });

  it('实现了 verify 但没声明也被报出（它永远不会被调用）', () => {
    registerTargetKind(
      kindWith(
        { capabilities: { rollback: 'none', verify: false, activateLatencySeconds: 0 } },
        { verify: async () => ({ ok: true, message: 'ok' }) },
      ),
    );
    assert.match(checkRegistries()[0]!.message, /永远不会被调用/);
  });
});

describe('注册表自检：字段声明', () => {
  it('targetFields 含疑似密钥字段被报出（密钥必须放凭据里）', () => {
    for (const key of ['secretAccessKey', 'password', 'privateKey', 'apiToken']) {
      resetTargetKinds();
      const fields: readonly Field[] = [
        { key: 'bucket', label: 'B', type: 'string', required: true, identity: true },
        { key, label: key, type: 'string', required: false },
      ];
      registerTargetKind(kindWith({ targetFields: fields }));
      const problems = checkRegistries();
      assert.equal(problems.length, 1, `${key} 应被报出`);
      assert.match(problems[0]!.message, /密钥必须放在凭据里/);
    }
  });

  it('targetFields 没有 identity 字段被报出', () => {
    registerTargetKind(
      kindWith({
        targetFields: [{ key: 'bucket', label: 'B', type: 'string', required: true }],
      }),
    );
    assert.match(checkRegistries()[0]!.message, /没有任何 identity 字段/);
  });

  it('字段 key 重复被报出', () => {
    registerTargetKind(
      kindWith({
        publishFields: [
          { key: 'version', label: '版本', type: 'string', required: true },
          { key: 'version', label: '又版本', type: 'string', required: true },
        ],
      }),
    );
    assert.match(checkRegistries()[0]!.message, /字段 key 重复/);
  });

  it('select 没有选项被报出', () => {
    registerTargetKind(
      kindWith({
        publishFields: [{ key: 'mode', label: '模式', type: 'select', required: false }],
      }),
    );
    assert.match(checkRegistries()[0]!.message, /没有选项/);
  });

  it('非法正则被报出', () => {
    registerTargetKind(
      kindWith({
        publishFields: [
          { key: 'v', label: '版本', type: 'string', required: true, pattern: '([unclosed' },
        ],
      }),
    );
    assert.match(checkRegistries()[0]!.message, /不是合法正则/);
  });
});

describe('存量目标实例自检', () => {
  function seedTarget(db: Db, kind: string, location: Record<string, unknown>): void {
    const gameId = randomUUID();
    db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      gameId,
      `g-${gameId.slice(0, 8)}`,
      'g',
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO targets (id, game_id, kind, name, location, location_key, created_at, updated_at)
       VALUES (?, ?, ?, 'inst', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      gameId,
      kind,
      JSON.stringify(location),
      locationKey(location),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  it('空库无问题', () => {
    const db = freshDb();
    try {
      assert.deepEqual(checkStoredTargets(db), []);
    } finally {
      db.close();
    }
  });

  it('实例引用了未注册的类型时报告（而不是让进程起不来）', () => {
    const db = freshDb();
    try {
      seedTarget(db, 'deleted-plugin', { bucket: 'b' });
      const problems = checkStoredTargets(db);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!.message, /未注册/);

      // 这类问题只是警告，不抛
      registerTargetKind(kindWith({}));
      const result = runSelfCheck(db);
      assert.equal(result.warnings.length, 1);
    } finally {
      db.close();
    }
  });

  it('实例配置与当前声明不符时报告', () => {
    const db = freshDb();
    try {
      registerTargetKind(kindWith({ id: 'ok-kind' }));
      // bucket 是必填，这条实例却只有一个未声明的字段
      seedTarget(db, 'ok-kind', { oldFieldName: 'x' });
      const problems = checkStoredTargets(db);
      assert.ok(problems.length >= 1);
      assert.match(problems.map((p) => p.message).join('\n'), /与当前 ok-kind 声明不符/);
    } finally {
      db.close();
    }
  });

  it('归档的实例不参与检查', () => {
    const db = freshDb();
    try {
      seedTarget(db, 'deleted-plugin', { bucket: 'b' });
      db.prepare('UPDATE targets SET archived_at = ?').run(new Date().toISOString());
      assert.deepEqual(checkStoredTargets(db), []);
    } finally {
      db.close();
    }
  });
});

describe('runSelfCheck', () => {
  it('注册表有问题时抛出，错误信息含全部问题', () => {
    const db = freshDb();
    try {
      registerTargetKind(kindWith({ stages: [], requiresCli: ['no-such-cli'] }));
      assert.throws(
        () => runSelfCheck(db),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /启动自检未通过/);
          assert.match(message, /没有声明任何阶段/);
          assert.match(message, /未注册的 CLI/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('注册表无问题时返回警告列表', () => {
    const db = freshDb();
    try {
      registerTargetKind(kindWith({}));
      assert.deepEqual(runSelfCheck(db).warnings, []);
    } finally {
      db.close();
    }
  });
});
