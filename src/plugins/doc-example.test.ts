/**
 * 验证 docs/add-a-target-kind.md：照那份文档写出来的插件能不能跑通，
 * 以及过程中有没有必须改核心的地方。
 *
 * 这不是在测那个示例插件——它什么都不做。测的是**文档的完整性**：
 * 文档承诺的每一项（ctx 给什么、核心自动做什么、自检挡什么）是否成立。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { buildZip, sha256 } from '../artifacts/zip-fixture.test-helper.js';
import { createGame, createPackageType } from '../catalog/index.js';
import { createCredential } from '../credentials/index.js';
import { ensureSchema, open, type Db } from '../db/index.js';
import { enqueue, startRunner } from '../jobs/index.js';
import { createRelease, executeRelease, getRelease, releaseStages } from '../releases/index.js';
import {
  checkRegistries,
  registerTargetKind,
  resetTargetKinds,
  targetKindsAccepting,
  validateFields,
} from '../registry/index.js';
import { createTarget, listTargets } from '../targets/index.js';
import {
  createDocExamplePlugin,
  DOC_EXAMPLE_KIND_ID,
  freshTrace,
  type DocExampleTrace,
} from './doc-example.test-helper.js';

const KEY = 'test-master-key-of-enough-length';
const scratch = mkdtempSync(join(tmpdir(), 'doc-example-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const zipBody = buildZip([{ name: 'index.html', content: Buffer.from('<html></html>') }]);

let server: Server;
let base: string;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(zipBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => resetTargetKinds());

interface Scenario {
  readonly db: Db;
  readonly releaseId: string;
  readonly trace: DocExampleTrace;
}

/** 按文档说的「注册一行就完事」搭出一次完整发布。 */
function setup(): Scenario {
  const trace = freshTrace();
  // 文档步骤 4：注册。核心应当自动把它纳入全部流程。
  const plugin = createDocExamplePlugin(trace);
  registerTargetKind(plugin);

  const db = open({ file: ':memory:' });
  ensureSchema(db);

  const game = createGame(db, { slug: 'demo', displayName: '示例' });
  createPackageType(db, { id: 'h5', displayName: 'H5' });
  const credential = createCredential(
    db,
    { name: 'c', type: 'secretText', secrets: { secret: 'SECRET' } },
    KEY,
  );

  const target = createTarget(
    db,
    {
      gameId: game.id,
      kind: DOC_EXAMPLE_KIND_ID,
      name: '示例目标',
      credentialId: credential.id,
      location: { slot: 'a' },
    },
    KEY,
  );

  const buildPk = randomUUID();
  db.prepare(
    `INSERT INTO builds (id, game_id, package_type_id, build_id, artifact_url, size_bytes, sha256, reported_at)
     VALUES (?, ?, 'h5', 'doc-b1', ?, ?, ?, ?)`,
  ).run(buildPk, game.id, `${base}/pkg.zip`, zipBody.length, sha256(zipBody), new Date().toISOString());

  const release = createRelease(db, {
    buildId: buildPk,
    targetId: target.id,
    params: { tag: 'v1' },
    stageIds: releaseStages(plugin),
  });

  return { db, releaseId: release.id, trace };
}

async function run(s: Scenario): Promise<void> {
  const runner = startRunner({
    db: s.db,
    handlers: {
      publish: (job) =>
        executeRelease(
          { db: s.db, masterKey: KEY, cliHome: join(scratch, 'cli'), workParentDir: scratch },
          job,
        ),
    },
    timeoutMs: 20_000,
  });
  try {
    enqueue(s.db, 'publish', s.releaseId);
    await runner.tick();
  } finally {
    runner.stop();
  }
}

describe('照文档写的插件：注册一行就能跑通发布', () => {
  it('发布成功，核心完成了编排', async () => {
    const s = setup();
    try {
      await run(s);
      const release = getRelease(s.db, s.releaseId);
      assert.equal(release.status, 'success', '照文档写的插件应能直接跑通');
      assert.deepEqual(s.trace.stages, ['deploy']);
    } finally {
      s.db.close();
    }
  });

  it('ctx 真的提供了文档承诺的每一项', async () => {
    const s = setup();
    try {
      await run(s);
      // 文档的「ctx 给你什么」表格里列的东西
      assert.equal(s.trace.buildId, 'doc-b1', 'ctx.build.buildId');
      assert.equal(s.trace.slot, 'a', 'ctx.target 的位置字段');
      assert.equal(s.trace.tag, 'v1', 'ctx.params 的发布参数');
      assert.notEqual(s.trace.secretFilePath, '', 'ctx.secretFile() 应返回路径');
    } finally {
      s.db.close();
    }
  });

  it('核心替插件删掉了凭据文件（文档承诺「核心负责删除」）', async () => {
    const s = setup();
    try {
      await run(s);
      assert.throws(
        () => readFileSync(s.trace.secretFilePath),
        /ENOENT/,
        '文档说核心负责删除凭据文件，这条必须成立',
      );
    } finally {
      s.db.close();
    }
  });

  it('声明了 verify 就会被调用', async () => {
    const s = setup();
    try {
      await run(s);
      assert.equal(s.trace.verified, true);
    } finally {
      s.db.close();
    }
  });
});

describe('核心自动做到的事（文档「到这里就结束了」那一段）', () => {
  it('按 accepts 过滤发布候选', () => {
    const trace = freshTrace();
    registerTargetKind(createDocExamplePlugin(trace));

    assert.deepEqual(
      targetKindsAccepting('h5').map((k) => k.manifest.id),
      [DOC_EXAMPLE_KIND_ID],
    );
    assert.deepEqual(targetKindsAccepting('wechat'), [], '不接受的包类型不该出现');
  });

  it('目标实例列表按包类型过滤', () => {
    const s = setup();
    try {
      assert.equal(listTargets(s.db, { acceptsPackageType: 'h5' }).length, 1);
      assert.equal(listTargets(s.db, { acceptsPackageType: 'wechat' }).length, 0);
    } finally {
      s.db.close();
    }
  });

  it('两套表单的字段声明可直接用于校验', () => {
    const trace = freshTrace();
    const plugin = createDocExamplePlugin(trace);

    // 目标表单
    assert.equal(validateFields(plugin.manifest.targetFields, { slot: 'a' }).length, 0);
    assert.equal(validateFields(plugin.manifest.targetFields, {}).length, 1);

    // 发布表单
    assert.equal(validateFields(plugin.manifest.publishFields, { tag: 'v1' }).length, 0);
    assert.equal(validateFields(plugin.manifest.publishFields, {}).length, 1);
  });

  it('凭据类型不匹配时创建目标被拒（核心替插件校验）', () => {
    const s = setup();
    try {
      const game = s.db.prepare<[], { id: string }>('SELECT id FROM games LIMIT 1').get()!;
      // manifest 声明需要 secretText，这里故意给一个 file 型凭据
      const fileCredential = createCredential(
        s.db,
        { name: 'file-cred', type: 'file', secrets: { content: 'x' } },
        KEY,
      );
      assert.throws(
        () =>
          createTarget(
            s.db,
            {
              gameId: game.id,
              kind: DOC_EXAMPLE_KIND_ID,
              name: '类型不符',
              credentialId: fileCredential.id,
              location: { slot: 'b' },
            },
            KEY,
          ),
        /类型是 file，而.*需要 secretText/,
      );
    } finally {
      s.db.close();
    }
  });
});

describe('启动自检挡住文档列出的每一类问题', () => {
  function kindWith(overrides: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    const trace = freshTrace();
    const base = createDocExamplePlugin(trace);
    registerTargetKind({
      ...base,
      ...extra,
      manifest: { ...base.manifest, ...overrides },
    } as Parameters<typeof registerTargetKind>[0]);
  }

  it('accepts 指向未登记的包类型', () => {
    kindWith({ accepts: ['never-registered'] });
    const problems = checkRegistries({ knownPackageTypes: ['h5'] });
    assert.match(problems.map((p) => p.message).join('\n'), /未登记的包类型/);
  });

  it('requiresCredential 指向未注册的凭据类型', () => {
    kindWith({ requiresCredential: 'bogus' });
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /未注册的凭据类型/);
  });

  it('requiresCli 指向未注册的 CLI', () => {
    kindWith({ requiresCli: ['no-such-cli'] });
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /未注册的 CLI/);
  });

  it('声明 verify 却没实现', () => {
    kindWith(
      { capabilities: { rollback: 'none', verify: true, activateLatencySeconds: 0 } },
      { verify: undefined, rollback: undefined },
    );
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /没有实现 verify/);
  });

  it('声明 pointer 回滚却没实现', () => {
    kindWith(
      { capabilities: { rollback: 'pointer', verify: false, activateLatencySeconds: 0 } },
      { verify: undefined, rollback: undefined },
    );
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /没有实现 rollback/);
  });

  it('targetFields 含疑似密钥字段', () => {
    kindWith({
      targetFields: [
        { key: 'slot', label: '位置', type: 'string', required: true, identity: true },
        { key: 'accessKey', label: '密钥', type: 'string', required: true },
      ],
    });
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /密钥必须放在凭据里/);
  });

  it('targetFields 没有 identity 字段', () => {
    kindWith({
      targetFields: [{ key: 'slot', label: '位置', type: 'string', required: true }],
    });
    assert.match(checkRegistries().map((p) => p.message).join('\n'), /没有任何 identity 字段/);
  });

  it('阶段 id 重复与超时非正数', () => {
    kindWith({
      stages: [
        { id: 'deploy', name: '部署', timeoutMs: 0 },
        { id: 'deploy', name: '又部署', timeoutMs: 1000 },
      ],
    });
    const message = checkRegistries().map((p) => p.message).join('\n');
    assert.match(message, /阶段 id 重复/);
    assert.match(message, /超时必须为正数/);
  });

  it('合规的插件无任何问题', () => {
    const trace = freshTrace();
    registerTargetKind(createDocExamplePlugin(trace));
    assert.deepEqual(checkRegistries({ knownPackageTypes: ['h5'] }), []);
  });
});
