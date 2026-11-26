import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createGame } from '../catalog/index.js';
import { createCredential, deleteCredential } from '../credentials/index.js';
import { ensureSchema, open, ReferencedError, type Db } from '../db/index.js';
import { randomUUID } from 'node:crypto';
import {
  registerTargetKind,
  resetTargetKinds,
  type CredentialTypeId,
  type Field,
  type TargetKind,
} from '../registry/index.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import {
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  requirePublishableTarget,
  updateTarget,
} from './store.js';

const KEY = 'test-master-key-of-enough-length';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

interface KindOptions {
  readonly accepts?: string[];
  readonly requiresCredential?: CredentialTypeId | null;
  readonly targetFields?: readonly Field[];
}

function makeKind(id: string, options: KindOptions = {}): TargetKind {
  return {
    manifest: {
      id,
      displayName: id,
      description: '',
      accepts: options.accepts ?? ['wechat'],
      requiresCredential: options.requiresCredential ?? null,
      requiresCli: [],
      targetFields: options.targetFields ?? [
        { key: 'appid', label: 'AppID', type: 'string', required: true, identity: true },
        { key: 'note', label: '备注', type: 'string', required: false },
      ],
      publishFields: [],
      stages: [{ id: 'upload', name: '上传', timeoutMs: 1000 }],
      capabilities: { rollback: 'none', verify: false, activateLatencySeconds: 0 },
    },
    globalChecks: [],
    targetChecks: [],
    execute: async () => ({}),
  };
}

function setup(kinds: TargetKind[] = [makeKind('wechat')]): { db: Db; gameId: string } {
  for (const kind of kinds) registerTargetKind(kind);
  const db = freshDb();
  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  return { db, gameId: game.id };
}

afterEach(() => resetTargetKinds());

describe('创建目标实例', () => {
  it('保存后可读回，位置字段原样保留', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '微信正式号', location: { appid: 'wx-prod', note: '生产' } },
        KEY,
      );
      assert.equal(target.name, '微信正式号');
      assert.deepEqual(target.location, { appid: 'wx-prod', note: '生产' });
      assert.deepEqual(target.accepts, ['wechat']);
      assert.equal(target.releaseCount, 0);
    } finally {
      db.close();
    }
  });

  it('同类型不同 appid 可共存（正式号 + 测试号）', () => {
    const { db, gameId } = setup();
    try {
      createTarget(db, { gameId, kind: 'wechat', name: '正式号', location: { appid: 'wx-prod' } }, KEY);
      createTarget(db, { gameId, kind: 'wechat', name: '测试号', location: { appid: 'wx-test' } }, KEY);
      assert.equal(listTargets(db, { gameId }).length, 2);
    } finally {
      db.close();
    }
  });

  it('必填位置字段缺失被拒', () => {
    const { db, gameId } = setup();
    try {
      assert.throws(
        () => createTarget(db, { gameId, kind: 'wechat', name: 'x', location: {} }, KEY),
        /AppID 为必填/,
      );
    } finally {
      db.close();
    }
  });

  it('未声明的位置字段被拒', () => {
    const { db, gameId } = setup();
    try {
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId, kind: 'wechat', name: 'x', location: { appid: 'wx', surprise: 1 } },
            KEY,
          ),
        /未声明的字段 surprise/,
      );
    } finally {
      db.close();
    }
  });

  it('未注册的 kind 被拒', () => {
    const { db, gameId } = setup();
    try {
      assert.throws(
        () => createTarget(db, { gameId, kind: 'no-such-kind', name: 'x', location: {} }, KEY),
        /未注册的目标类型/,
      );
    } finally {
      db.close();
    }
  });

  it('空名称被拒', () => {
    const { db, gameId } = setup();
    try {
      assert.throws(
        () => createTarget(db, { gameId, kind: 'wechat', name: ' ', location: { appid: 'wx' } }, KEY),
        /名称不能为空/,
      );
    } finally {
      db.close();
    }
  });

  it('不存在的游戏被拒', () => {
    const { db } = setup();
    try {
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId: randomUUID(), kind: 'wechat', name: 'x', location: { appid: 'wx' } },
            KEY,
          ),
        /游戏或凭据不存在/,
      );
    } finally {
      db.close();
    }
  });
});

describe('凭据引用校验', () => {
  it('凭据类型与 kind 声明一致时通过', () => {
    const { db, gameId } = setup([makeKind('wechat', { requiresCredential: 'file' })]);
    try {
      const cred = createCredential(db, { name: 'wx-key', type: 'file', secrets: { content: 'k' } }, KEY);
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: 'x', credentialId: cred.id, location: { appid: 'wx' } },
        KEY,
      );
      assert.equal(target.credentialId, cred.id);
    } finally {
      db.close();
    }
  });

  it('凭据类型不匹配时被拒（而不是等到发布时才发现）', () => {
    const { db, gameId } = setup([makeKind('wechat', { requiresCredential: 'file' })]);
    try {
      const wrong = createCredential(
        db,
        { name: 's3', type: 's3Keys', secrets: { accessKeyId: 'a', secretAccessKey: 'b' } },
        KEY,
      );
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId, kind: 'wechat', name: 'x', credentialId: wrong.id, location: { appid: 'wx' } },
            KEY,
          ),
        /类型是 s3Keys，而 wechat 需要 file/,
      );
    } finally {
      db.close();
    }
  });

  it('需要凭据却没选时被拒', () => {
    const { db, gameId } = setup([makeKind('wechat', { requiresCredential: 'file' })]);
    try {
      assert.throws(
        () => createTarget(db, { gameId, kind: 'wechat', name: 'x', location: { appid: 'wx' } }, KEY),
        /需要一个「file」类型的凭据/,
      );
    } finally {
      db.close();
    }
  });

  it('不需要凭据却选了时被拒', () => {
    const { db, gameId } = setup([makeKind('wechat', { requiresCredential: null })]);
    try {
      const cred = createCredential(db, { name: 'c', type: 'file', secrets: { content: 'k' } }, KEY);
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId, kind: 'wechat', name: 'x', credentialId: cred.id, location: { appid: 'wx' } },
            KEY,
          ),
        /不需要凭据/,
      );
    } finally {
      db.close();
    }
  });

  it('已删除的凭据不能用于新目标', () => {
    const { db, gameId } = setup([makeKind('wechat', { requiresCredential: 'file' })]);
    try {
      const cred = createCredential(db, { name: 'c', type: 'file', secrets: { content: 'k' } }, KEY);
      deleteCredential(db, cred.id);
      // 凭据没有停用态：删掉就是不存在，错误该说「不存在」而不是「已归档」
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId, kind: 'wechat', name: 'x', credentialId: cred.id, location: { appid: 'wx' } },
            KEY,
          ),
        /不存在/,
      );
    } finally {
      db.close();
    }
  });
});

describe('同游戏内目标去重', () => {
  it('同类型同凭据同位置重复保存被拒，并指出冲突的实例', () => {
    const { db, gameId } = setup();
    try {
      createTarget(db, { gameId, kind: 'wechat', name: '第一个', location: { appid: 'wx-prod' } }, KEY);
      assert.throws(
        () =>
          createTarget(db, { gameId, kind: 'wechat', name: '第二个', location: { appid: 'wx-prod' } }, KEY),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.match(error.message, /与已有目标「第一个」/);
          assert.match(error.message, /互相覆盖/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('改备注不能绕过去重（备注不参与位置标识）', () => {
    const { db, gameId } = setup();
    try {
      createTarget(
        db,
        { gameId, kind: 'wechat', name: 'A', location: { appid: 'wx-prod', note: '第一版' } },
        KEY,
      );
      assert.throws(
        () =>
          createTarget(
            db,
            { gameId, kind: 'wechat', name: 'B', location: { appid: 'wx-prod', note: '完全不同的备注' } },
            KEY,
          ),
        /与已有目标「A」/,
      );
    } finally {
      db.close();
    }
  });

  it('同凭据不同路径可共存（生产 + 灰度）', () => {
    const fields: readonly Field[] = [
      { key: 'bucket', label: 'Bucket', type: 'string', required: true, identity: true },
      { key: 'prefix', label: '路径前缀', type: 'string', required: true, identity: true },
    ];
    const { db, gameId } = setup([
      makeKind('h5-r2', { accepts: ['h5'], requiresCredential: 's3Keys', targetFields: fields }),
    ]);
    try {
      const cred = createCredential(
        db,
        { name: 'r2', type: 's3Keys', secrets: { accessKeyId: 'a', secretAccessKey: 'b' } },
        KEY,
      );
      createTarget(
        db,
        { gameId, kind: 'h5-r2', name: '生产', credentialId: cred.id, location: { bucket: 'b', prefix: 'demo/' } },
        KEY,
      );
      createTarget(
        db,
        {
          gameId,
          kind: 'h5-r2',
          name: '灰度',
          credentialId: cred.id,
          location: { bucket: 'b', prefix: 'demo-staging/' },
        },
        KEY,
      );
      assert.equal(listTargets(db, { gameId }).length, 2);
    } finally {
      db.close();
    }
  });

  it('不同游戏可以有完全相同的目标配置', () => {
    const { db, gameId } = setup();
    try {
      const other = createGame(db, { slug: 'other', displayName: '另一个' });
      createTarget(db, { gameId, kind: 'wechat', name: 'A', location: { appid: 'wx' } }, KEY);
      createTarget(db, { gameId: other.id, kind: 'wechat', name: 'B', location: { appid: 'wx' } }, KEY);
      assert.equal(listTargets(db).length, 2);
    } finally {
      db.close();
    }
  });
});

describe('包类型兼容性', () => {
  it('列表按包类型过滤候选（错配不出现在下拉框里）', () => {
    const { db, gameId } = setup([
      makeKind('wechat', { accepts: ['wechat'] }),
      makeKind('h5-r2', { accepts: ['h5'] }),
    ]);
    try {
      createTarget(db, { gameId, kind: 'wechat', name: '微信号', location: { appid: 'wx' } }, KEY);
      createTarget(db, { gameId, kind: 'h5-r2', name: 'H5 站点', location: { appid: 'site' } }, KEY);

      const forWechat = listTargets(db, { gameId, acceptsPackageType: 'wechat' });
      assert.deepEqual(forWechat.map((t) => t.name), ['微信号']);

      const forH5 = listTargets(db, { gameId, acceptsPackageType: 'h5' });
      assert.deepEqual(forH5.map((t) => t.name), ['H5 站点']);

      assert.deepEqual(listTargets(db, { gameId, acceptsPackageType: 'kuaishou' }), []);
    } finally {
      db.close();
    }
  });

  it('跨类型发布被拒，且是冲突而非参数错误', () => {
    const { db, gameId } = setup([makeKind('wechat', { accepts: ['wechat'] })]);
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '微信号', location: { appid: 'wx' } },
        KEY,
      );
      assert.throws(
        () => requirePublishableTarget(db, target.id, 'h5'),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError, '应是 ConflictError（→ 409）');
          assert.match(error.message, /不接受 h5 包/);
          assert.match(error.message, /它只接受：wechat/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('兼容的组合通过', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '微信号', location: { appid: 'wx' } },
        KEY,
      );
      assert.equal(requirePublishableTarget(db, target.id, 'wechat').id, target.id);
    } finally {
      db.close();
    }
  });

  it('已删除的目标不能用于新发布', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '微信号', location: { appid: 'wx' } },
        KEY,
      );
      deleteTarget(db, target.id);
      // 没有「已停用但还在」这个状态了：删掉就是不存在
      assert.throws(() => requirePublishableTarget(db, target.id, 'wechat'), NotFoundError);
    } finally {
      db.close();
    }
  });
});

describe('更新目标', () => {
  it('可改名与位置，kind 不在可改范围内', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '旧名', location: { appid: 'wx-old' } },
        KEY,
      );
      const updated = updateTarget(db, target.id, { name: '新名', location: { appid: 'wx-new' } }, KEY);
      assert.equal(updated.name, '新名');
      assert.deepEqual(updated.location, { appid: 'wx-new' });
      assert.equal(updated.kind, 'wechat', 'kind 不应变化');
    } finally {
      db.close();
    }
  });

  it('改到与另一个实例完全相同的位置被拒', () => {
    const { db, gameId } = setup();
    try {
      createTarget(db, { gameId, kind: 'wechat', name: 'A', location: { appid: 'wx-a' } }, KEY);
      const b = createTarget(db, { gameId, kind: 'wechat', name: 'B', location: { appid: 'wx-b' } }, KEY);
      assert.throws(
        () => updateTarget(db, b.id, { location: { appid: 'wx-a' } }, KEY),
        /与已有目标「A」/,
      );
    } finally {
      db.close();
    }
  });

  it('只传部分字段时其余保持不变', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '名字', location: { appid: 'wx', note: '备注' } },
        KEY,
      );
      const updated = updateTarget(db, target.id, { name: '新名字' }, KEY);
      assert.deepEqual(updated.location, { appid: 'wx', note: '备注' });
    } finally {
      db.close();
    }
  });
});

describe('删除', () => {
  it('删除后从候选列表消失，库里也不留记录', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: '微信号', location: { appid: 'wx' } },
        KEY,
      );
      assert.equal(listTargets(db, { gameId }).length, 1);

      deleteTarget(db, target.id);

      assert.equal(listTargets(db, { gameId }).length, 0);
      assert.throws(() => getTarget(db, target.id), NotFoundError, '不是软删除');
    } finally {
      db.close();
    }
  });

  it('有发布历史时删除被拒', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: 'x', location: { appid: 'wx' } },
        KEY,
      );
      // 造一条发布记录
      db.prepare('INSERT INTO package_types (id, display_name, created_at) VALUES (?, ?, ?)').run(
        'wechat',
        '微信',
        new Date().toISOString(),
      );
      const buildId = randomUUID();
      db.prepare(
        `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
         VALUES (?, ?, 'wechat', 'b1', 'https://x/a.zip', 1, 'h', ?)`,
      ).run(buildId, gameId, new Date().toISOString());
      db.prepare(
        `INSERT INTO releases (id, build_id, target_id, params, status, created_at)
         VALUES (?, ?, ?, '{}', 'success', ?)`,
      ).run(randomUUID(), buildId, target.id, new Date().toISOString());

      assert.equal(getTarget(db, target.id).releaseCount, 1);
      assert.throws(() => deleteTarget(db, target.id), ReferencedError);
    } finally {
      db.close();
    }
  });

  it('没有发布历史时可以删除', () => {
    const { db, gameId } = setup();
    try {
      const target = createTarget(
        db,
        { gameId, kind: 'wechat', name: 'x', location: { appid: 'wx' } },
        KEY,
      );
      deleteTarget(db, target.id);
      assert.equal(listTargets(db).length, 0);
    } finally {
      db.close();
    }
  });

  it('不存在的 id 抛 NotFoundError（→ 404）', () => {
    const { db } = setup();
    try {
      assert.throws(() => getTarget(db, randomUUID()), NotFoundError);
    } finally {
      db.close();
    }
  });
});

describe('插件下线后的存量实例', () => {
  it('列表不因一条坏数据整页打不开', () => {
    const { db, gameId } = setup();
    try {
      createTarget(db, { gameId, kind: 'wechat', name: 'x', location: { appid: 'wx' } }, KEY);
      // 模拟插件下线
      resetTargetKinds();

      const targets = listTargets(db, { gameId });
      assert.equal(targets.length, 1);
      assert.match(targets[0]!.kindDisplayName, /类型未注册/);
      assert.deepEqual(targets[0]!.accepts, [], '未注册的类型不接受任何包');
    } finally {
      db.close();
    }
  });
});
