import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getCredentialType, listCredentialTypes } from './credential-type.js';
import { getCliSpec, listCliSpecs } from './cli-spec.js';
import { identityValues, validateFields, type Field } from './fields.js';
import {
  accepts,
  findTargetKind,
  getTargetKind,
  listTargetKinds,
  registerTargetKind,
  resetTargetKinds,
  targetKindsAccepting,
} from './target-kind-registry.js';
import type { TargetKind } from './target-kind.js';

function fakeKind(id: string, acceptsTypes: string[]): TargetKind {
  return {
    manifest: {
      id,
      displayName: id,
      description: 'test',
      accepts: acceptsTypes,
      requiresCredential: null,
      requiresCli: [],
      targetFields: [],
      publishFields: [],
      stages: [{ id: 'upload', name: '上传', timeoutMs: 1000 }],
      capabilities: { rollback: 'none', verify: false, activateLatencySeconds: 0 },
    },
    globalChecks: [],
    targetChecks: [],
    execute: async () => ({}),
  };
}

afterEach(() => resetTargetKinds());

describe('目标类型注册表', () => {
  it('注册后可按 id 取回', () => {
    const kind = fakeKind('fake-kind', ['h5']);
    registerTargetKind(kind);
    assert.equal(getTargetKind('fake-kind'), kind);
    assert.equal(findTargetKind('fake-kind'), kind);
    assert.equal(listTargetKinds().length, 1);
  });

  it('未注册的 id 取回时报错，而不是返回 undefined 让调用方忘记处理', () => {
    assert.throws(() => getTargetKind('nope'), /未注册的目标类型/);
    assert.equal(findTargetKind('nope'), undefined);
  });

  it('重复注册同一 id 报错而不是静默覆盖', () => {
    registerTargetKind(fakeKind('dup', ['h5']));
    assert.throws(() => registerTargetKind(fakeKind('dup', ['h5'])), /已注册/);
  });

  it('按包类型过滤候选目标类型', () => {
    registerTargetKind(fakeKind('wechat', ['wechat']));
    registerTargetKind(fakeKind('h5-r2', ['h5']));
    registerTargetKind(fakeKind('h5-nginx', ['h5']));

    const forH5 = targetKindsAccepting('h5').map((k) => k.manifest.id);
    assert.deepEqual(forH5.sort(), ['h5-nginx', 'h5-r2']);

    const forWechat = targetKindsAccepting('wechat').map((k) => k.manifest.id);
    assert.deepEqual(forWechat, ['wechat']);

    // 没有任何 kind 接受的包类型 → 空候选（UI 应显式提示「无法发布」）
    assert.deepEqual(targetKindsAccepting('kuaishou'), []);
  });

  it('accepts 判定跨类型组合', () => {
    registerTargetKind(fakeKind('wechat', ['wechat']));
    assert.equal(accepts('wechat', 'wechat'), true);
    assert.equal(accepts('wechat', 'h5'), false);
    assert.equal(accepts('unknown-kind', 'h5'), false);
  });
});

describe('凭据类型注册表', () => {
  it('五种内置类型都可取回且字段非空', () => {
    const ids = listCredentialTypes().map((t) => t.id);
    assert.deepEqual(ids.sort(), ['file', 's3Keys', 'secretText', 'sshKey', 'usernamePassword']);
    for (const id of ids) {
      assert.ok(getCredentialType(id).fields.length > 0, `${id} 应有字段`);
    }
  });

  it('未注册类型报错', () => {
    assert.throws(() => getCredentialType('bogus'), /未注册的凭据类型/);
  });
});

describe('CLI 规格注册表', () => {
  it('两个平台 CLI 都已登记且可取回', () => {
    const ids = listCliSpecs().map((s) => s.id);
    assert.ok(ids.includes('miniprogram-ci'));
    assert.ok(ids.includes('tt-minigame-ide-cli'));
  });

  it('npm 型 CLI 必须有包名与固定版本（不能是 latest）', () => {
    for (const spec of listCliSpecs()) {
      if (spec.kind !== 'npm') continue;
      assert.ok(spec.packageName, `${spec.id} 缺包名`);
      assert.ok(spec.defaultVersion, `${spec.id} 缺默认版本`);
      assert.notEqual(spec.defaultVersion, 'latest', `${spec.id} 不应用 latest`);
    }
  });

  it('未注册 CLI 报错', () => {
    assert.throws(() => getCliSpec('bogus'), /未注册的 CLI/);
  });
});

describe('字段校验', () => {
  const fields: readonly Field[] = [
    { key: 'appid', label: 'AppID', type: 'string', required: true, identity: true },
    { key: 'note', label: '备注', type: 'string', required: false },
    { key: 'robot', label: 'Robot', type: 'number', required: false },
    { key: 'live', label: '立即生效', type: 'boolean', required: false },
    {
      key: 'mode',
      label: '模式',
      type: 'select',
      required: false,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ];

  it('必填缺失时报错', () => {
    const errors = validateFields(fields, {});
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.key, 'appid');
  });

  it('一次返回全部错误而不是只报第一个', () => {
    const errors = validateFields(fields, { robot: 'not-a-number', live: 'yes' });
    const keys = errors.map((e) => e.key).sort();
    assert.deepEqual(keys, ['appid', 'live', 'robot']);
  });

  it('未声明的字段被拒', () => {
    const errors = validateFields(fields, { appid: 'wx', surprise: 1 });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /未声明的字段/);
  });

  it('select 只接受声明的选项', () => {
    assert.equal(validateFields(fields, { appid: 'wx', mode: 'a' }).length, 0);
    assert.equal(validateFields(fields, { appid: 'wx', mode: 'c' }).length, 1);
  });

  it('正则校验生效', () => {
    const withPattern: readonly Field[] = [
      { key: 'v', label: '版本号', type: 'string', required: true, pattern: '^\\d+\\.\\d+\\.\\d+$' },
    ];
    assert.equal(validateFields(withPattern, { v: '1.2.3' }).length, 0);
    assert.equal(validateFields(withPattern, { v: 'v1.2' }).length, 1);
  });

  it('全部合法时无错误', () => {
    assert.deepEqual(validateFields(fields, { appid: 'wx', robot: 1, live: true }), []);
  });
});

describe('identityValues', () => {
  const fields: readonly Field[] = [
    { key: 'appid', label: 'AppID', type: 'string', required: true, identity: true },
    { key: 'note', label: '备注', type: 'string', required: false },
  ];

  it('只取参与去重的字段', () => {
    const values = identityValues(fields, { appid: 'wx123', note: 'anything' });
    assert.deepEqual(values, { appid: 'wx123' });
  });

  it('改备注不会改变去重标识（否则能绕过去重造出互相覆盖的实例）', () => {
    const a = identityValues(fields, { appid: 'wx123', note: 'first' });
    const b = identityValues(fields, { appid: 'wx123', note: 'second' });
    assert.deepEqual(a, b);
  });
});
