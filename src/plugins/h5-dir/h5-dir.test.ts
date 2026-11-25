import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createContext } from '../../releases/index.js';
import { validateFields } from '../../registry/index.js';
import { h5DirPlugin } from './index.js';
import { h5DirManifest } from './manifest.js';
import { makePointer, normalizePrefix, parsePointer, POINTER_FILE, VERSIONS_DIR } from './pointer.js';
import { h5DirExecute, h5DirRollback, h5DirVerify } from './publish.js';

const scratch = mkdtempSync(join(tmpdir(), 'h5dir-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/* --------------------- 真实静态服务器（验证外部可访问） --------------------- */

let server: Server;
let siteRoot: string;
let baseOrigin: string;

before(async () => {
  siteRoot = mkdtempSync(join(scratch, 'site-'));
  server = createServer((req, res) => {
    // 去掉查询串（指针请求会带 ?t=<version> 绕缓存）
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(siteRoot, path);
    // 真实静态服务器也必须防跳出站点根
    if (!file.startsWith(siteRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => {
      res.writeHead(404);
      res.end('not found');
    });
    stream.on('open', () => {
      res.writeHead(200, { 'cache-control': 'no-store' });
      stream.pipe(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ---------------------------------- 工具 ---------------------------------- */

interface CtxOptions {
  readonly buildId: string;
  readonly prefix?: string;
  readonly activate?: boolean;
  readonly keepVersions?: number;
  readonly files?: Record<string, string>;
  readonly baseUrl?: string;
}

async function makeCtx(options: CtxOptions): Promise<{
  ctx: Awaited<ReturnType<typeof createContext>>['ctx'];
  logs: string[];
  cleanup: () => Promise<void>;
}> {
  const artifactDir = mkdtempSync(join(scratch, 'artifact-'));
  const files = options.files ?? {
    'index.html': `<html><!-- ${options.buildId} --></html>`,
    'app.js': `console.log('${options.buildId}')`,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(artifactDir, name), content, 'utf8');
  }

  const prefix = options.prefix ?? 'demo/';
  const managed = await createContext({
    artifactDir,
    workdir: mkdtempSync(join(scratch, 'work-')),
    build: {
      buildId: options.buildId,
      commitSha: null,
      packageTypeId: 'h5',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
    },
    target: {
      rootDir: siteRoot,
      prefix,
      baseUrl: options.baseUrl ?? `${baseOrigin}/${normalizePrefix(prefix)}`,
      ...(options.keepVersions !== undefined && { keepVersions: options.keepVersions }),
    },
    params: options.activate === undefined ? {} : { activate: options.activate },
    cliHome: join(scratch, 'no-cli'),
    secrets: {},
    log: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  });

  const logs: string[] = [];
  const ctx = { ...managed.ctx, log: (line: string) => logs.push(line) };
  return { ctx, logs, cleanup: () => managed.cleanupSecrets() };
}

/** 跑完整的两个阶段。 */
async function publish(options: CtxOptions): Promise<{ logs: string[] }> {
  const { ctx, logs, cleanup } = await makeCtx(options);
  try {
    await h5DirExecute('upload', ctx);
    await h5DirExecute('activate', ctx);
    return { logs };
  } finally {
    await cleanup();
  }
}

function pointerFileOf(prefix = 'demo/'): string {
  return join(siteRoot, ...normalizePrefix(prefix).split('/').filter((s) => s !== ''), POINTER_FILE);
}

async function fetchPointer(prefix = 'demo/'): Promise<ReturnType<typeof parsePointer>> {
  const url = `${baseOrigin}/${normalizePrefix(prefix)}${POINTER_FILE}?t=${Date.now()}`;
  const response = await fetch(url);
  assert.equal(response.ok, true, `指针应可通过外部 URL 取到：${url}`);
  return parsePointer(await response.text());
}

/* ---------------------------------- 测试 ---------------------------------- */

describe('manifest 声明', () => {
  it('只接受 h5 包，不需要凭据与 CLI', () => {
    assert.deepEqual(h5DirManifest.accepts, ['h5']);
    assert.equal(h5DirManifest.requiresCredential, null);
    assert.deepEqual(h5DirManifest.requiresCli, []);
  });

  it('回滚声明为 pointer 且实现了 rollback', () => {
    assert.equal(h5DirManifest.capabilities.rollback, 'pointer');
    assert.equal(typeof h5DirPlugin.rollback, 'function');
  });

  it('rootDir 与 prefix 参与去重，baseUrl 不参与', () => {
    const byKey = new Map(h5DirManifest.targetFields.map((f) => [f.key, f]));
    assert.equal(byKey.get('rootDir')?.identity, true);
    assert.equal(byKey.get('prefix')?.identity, true);
    // baseUrl 是「怎么访问」，不是「发到哪」：两个实例写同一目录却填不同
    // 地址，仍然是互相覆盖的重复实例
    assert.notEqual(byKey.get('baseUrl')?.identity, true);
  });

  it('两个阶段：先写目录，再切指针', () => {
    assert.deepEqual(
      h5DirManifest.stages.map((s) => s.id),
      ['upload', 'activate'],
    );
  });
});

describe('指针格式', () => {
  it('base 放在指针里，壳不自己拼路径', () => {
    const pointer = makePointer({ active: 'b1', prev: null, prefix: 'demo/' });
    assert.equal(pointer.base, 'demo/v/b1/');
    assert.equal(pointer.schema, 1);
  });

  it('前缀写法不一致时结果一致', () => {
    for (const prefix of ['demo', 'demo/', '/demo', '/demo/']) {
      assert.equal(makePointer({ active: 'b1', prev: null, prefix }).base, 'demo/v/b1/');
    }
  });

  it('空前缀时 base 直接从 v/ 开始', () => {
    assert.equal(makePointer({ active: 'b1', prev: null, prefix: '' }).base, 'v/b1/');
  });

  it('不认识的格式版本被拒（壳据此判断能不能用）', () => {
    assert.throws(() => parsePointer(JSON.stringify({ schema: 2, active: 'b1' })), /不认识的指针格式版本 2/);
  });

  it('坏 JSON 与缺 active 都被拒', () => {
    assert.throws(() => parsePointer('not json'), /不是合法 JSON/);
    assert.throws(() => parsePointer(JSON.stringify({ schema: 1 })), /缺少 active/);
  });
});

describe('发布：写目录 + 切指针', () => {
  it('发布后外部通过 URL 能取到新版本入口', async () => {
    await publish({ buildId: 'v1' });

    // 这是 10.1 的核心验证：走真实 HTTP 请求，不是读本地文件
    const pointer = await fetchPointer();
    assert.equal(pointer.active, 'v1');
    assert.equal(pointer.base, 'demo/v/v1/');

    // 按指针给的 base 取资源，确认真的能加载
    const assetUrl = `${baseOrigin}/${pointer.base}index.html`;
    const asset = await fetch(assetUrl);
    assert.equal(asset.ok, true, `应能取到 ${assetUrl}`);
    assert.match(await asset.text(), /v1/);
  });

  it('第二次发布切到新版本，prev 记下旧版本', async () => {
    await publish({ buildId: 'v2' });
    const pointer = await fetchPointer();
    assert.equal(pointer.active, 'v2');
    assert.equal(pointer.prev, 'v1', 'prev 应是被替换掉的版本');
  });

  it('多版本并行在线：旧版本目录仍可访问', async () => {
    // 正在玩的会话还在请求旧版本的资源，所以旧目录不能消失
    const old = await fetch(`${baseOrigin}/demo/${VERSIONS_DIR}/v1/index.html`);
    assert.equal(old.ok, true, '旧版本目录应仍然可访问');
    assert.match(await old.text(), /v1/);
  });

  it('activate=false 时只写目录不切流', async () => {
    const { logs } = await publish({ buildId: 'v3', activate: false });
    assert.ok(logs.some((l) => /跳过切流/.test(l)), `日志应说明跳过，实际：${JSON.stringify(logs)}`);

    const pointer = await fetchPointer();
    assert.equal(pointer.active, 'v2', '指针不应变化');

    // 但目录已就绪，之后可以再切
    const staged = await fetch(`${baseOrigin}/demo/${VERSIONS_DIR}/v3/index.html`);
    assert.equal(staged.ok, true, '版本目录应已写好');
  });

  it('重发同一版本落在同一目录，且 prev 不被冲成自己', async () => {
    await publish({ buildId: 'v2' });
    const pointer = await fetchPointer();
    assert.equal(pointer.active, 'v2');
    assert.equal(pointer.prev, 'v1', '重发同一版本不该把 prev 改成自己');
  });

  it('重发时清掉残留文件，目录内容与产物一致', async () => {
    await publish({ buildId: 'r1', files: { 'a.txt': 'first', 'stale.txt': 'remove me' } });
    await publish({ buildId: 'r1', files: { 'a.txt': 'second' } });

    const entries = await readdir(join(siteRoot, 'demo', VERSIONS_DIR, 'r1'));
    assert.deepEqual(entries, ['a.txt'], '残留文件会让版本变成两次产物的混合体');
    assert.equal(
      readFileSync(join(siteRoot, 'demo', VERSIONS_DIR, 'r1', 'a.txt'), 'utf8'),
      'second',
    );
  });

  it('不同前缀互不影响（生产 + 灰度）', async () => {
    await publish({ buildId: 'g1', prefix: 'demo-staging/' });

    assert.equal((await fetchPointer('demo-staging/')).active, 'g1');
    assert.equal((await fetchPointer('demo/')).active, 'r1', '另一个前缀不该被影响');
  });

  it('构建标识含路径分隔符时被拒（防写到站点外）', async () => {
    for (const bad of ['../escape', 'a/b', '.hidden', 'has space']) {
      const { ctx, cleanup } = await makeCtx({ buildId: bad });
      try {
        await assert.rejects(h5DirExecute('upload', ctx), /不能作为目录名/, `${bad} 应被拒`);
      } finally {
        await cleanup();
      }
    }
  });

  it('未知阶段被拒', async () => {
    const { ctx, cleanup } = await makeCtx({ buildId: 'x1' });
    try {
      await assert.rejects(h5DirExecute('bogus', ctx), /没有阶段 bogus/);
    } finally {
      await cleanup();
    }
  });

  it('站点根目录不是绝对路径时被拒', async () => {
    const managed = await createContext({
      artifactDir: scratch,
      workdir: scratch,
      build: { buildId: 'x', commitSha: null, packageTypeId: 'h5', sha256: '', sizeBytes: 0 },
      target: { rootDir: 'relative/path', prefix: 'demo/', baseUrl: 'http://x/' },
      params: {},
      cliHome: '',
      secrets: {},
      log: () => {},
      progress: () => {},
      signal: new AbortController().signal,
    });
    try {
      await assert.rejects(h5DirExecute('upload', managed.ctx), /必须是绝对路径/);
    } finally {
      await managed.cleanupSecrets();
    }
  });
});

describe('verify：回读生效指针', () => {
  it('切流成功时验证通过', async () => {
    const { ctx, cleanup } = await makeCtx({ buildId: 'ver1' });
    try {
      await h5DirExecute('upload', ctx);
      await h5DirExecute('activate', ctx);

      const result = await h5DirVerify(ctx);
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /外部已可取到新版本/);
    } finally {
      await cleanup();
    }
  });

  it('对外地址不可达时验证失败（本地写成功不等于外部能取到）', async () => {
    const { ctx, cleanup } = await makeCtx({
      buildId: 'ver2',
      baseUrl: 'http://127.0.0.1:1/nope/',
    });
    try {
      await h5DirExecute('upload', ctx);
      await h5DirExecute('activate', ctx);

      const result = await h5DirVerify(ctx);
      assert.equal(result.ok, false);
      assert.match(result.message, /回读指针出错/);
    } finally {
      await cleanup();
    }
  });

  it('外部读到的版本不是刚发布的那个时验证失败', async () => {
    // 先发 A 并切流，再构造一个「发了 B 但指针还是 A」的状态
    await publish({ buildId: 'verA' });

    const { ctx, cleanup } = await makeCtx({ buildId: 'verB' });
    try {
      await h5DirExecute('upload', ctx);
      // 故意不执行 activate
      const result = await h5DirVerify(ctx);
      assert.equal(result.ok, false);
      assert.match(result.message, /生效版本是 verA，不是刚发布的 verB/);
    } finally {
      await cleanup();
    }
  });

  it('activate=false 时跳过生效验证', async () => {
    const { ctx, cleanup } = await makeCtx({ buildId: 'verC', activate: false });
    try {
      await h5DirExecute('upload', ctx);
      await h5DirExecute('activate', ctx);
      const result = await h5DirVerify(ctx);
      assert.equal(result.ok, true);
      assert.match(result.message, /未切流，跳过/);
    } finally {
      await cleanup();
    }
  });
});

describe('回滚：指针回退', () => {
  it('回滚后指针指回上一版本，且未重新写入产物', async () => {
    const prefix = 'rollback/';
    await publish({ buildId: 'rb1', prefix });
    await publish({ buildId: 'rb2', prefix });
    assert.equal((await fetchPointer(prefix)).active, 'rb2');

    // 记下版本目录的修改时间，回滚后应完全没变
    const rb1Dir = join(siteRoot, 'rollback', VERSIONS_DIR, 'rb1');
    const beforeEntries = await readdir(rb1Dir);

    const { ctx, logs, cleanup } = await makeCtx({ buildId: 'rb2', prefix });
    try {
      const result = await h5DirRollback(ctx);
      assert.equal(result.outputs?.['version'], 'rb1');
      assert.equal(result.outputs?.['previousVersion'], 'rb2');
      assert.ok(logs.some((l) => /已回滚到 rb1/.test(l)));
    } finally {
      await cleanup();
    }

    // 核心断言：外部看到的生效版本回到了 rb1
    const pointer = await fetchPointer(prefix);
    assert.equal(pointer.active, 'rb1');
    assert.equal(pointer.prev, 'rb2', '回滚后能再切回去');

    // 产物没被重新写入
    assert.deepEqual(await readdir(rb1Dir), beforeEntries, '回滚不应重写产物');

    // 按新指针取资源，确认拿到的是旧版本内容
    const asset = await fetch(`${baseOrigin}/${pointer.base}index.html`);
    assert.match(await asset.text(), /rb1/);
  });

  it('没有上一版本时回滚被拒', async () => {
    const prefix = 'single/';
    await publish({ buildId: 'only', prefix });

    const { ctx, cleanup } = await makeCtx({ buildId: 'only', prefix });
    try {
      await assert.rejects(h5DirRollback(ctx), /没有上一版本/);
    } finally {
      await cleanup();
    }
  });

  it('上一版本目录已被清理时回滚被拒（而不是切到一个空目录）', async () => {
    const prefix = 'pruned/';
    await publish({ buildId: 'p1', prefix });
    await publish({ buildId: 'p2', prefix });

    // 手动删掉 p1 的目录，模拟被保留策略清掉
    rmSync(join(siteRoot, 'pruned', VERSIONS_DIR, 'p1'), { recursive: true, force: true });

    const { ctx, cleanup } = await makeCtx({ buildId: 'p2', prefix });
    try {
      await assert.rejects(h5DirRollback(ctx), /目录已不存在/);
    } finally {
      await cleanup();
    }
  });

  it('站点上没有指针时回滚被拒', async () => {
    const { ctx, cleanup } = await makeCtx({ buildId: 'x', prefix: 'never-published/' });
    try {
      await assert.rejects(h5DirRollback(ctx), /还没有指针/);
    } finally {
      await cleanup();
    }
  });
});

describe('旧版本清理', () => {
  it('超出保留数的旧版本被清理，但生效版本与 prev 永不清理', async () => {
    const prefix = 'prune/';
    for (const id of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      await publish({ buildId: id, prefix, keepVersions: 3 });
    }

    const remaining = (await readdir(join(siteRoot, 'prune', VERSIONS_DIR))).sort();
    const pointer = await fetchPointer(prefix);

    assert.ok(remaining.includes(pointer.active), '生效版本不能被清理');
    assert.ok(remaining.includes(pointer.prev!), 'prev 不能被清理——否则回滚失去目标');
    assert.ok(remaining.length <= 3, `应清理到保留数以内，实际剩 ${remaining.join(', ')}`);

    // 回滚仍然可用
    const { ctx, cleanup } = await makeCtx({ buildId: 'k5', prefix });
    try {
      await assert.doesNotReject(h5DirRollback(ctx), '清理后回滚仍应可用');
    } finally {
      await cleanup();
    }
  });
});

describe('发布参数校验', () => {
  it('activate 是可选布尔', () => {
    assert.equal(validateFields(h5DirManifest.publishFields, {}).length, 0);
    assert.equal(validateFields(h5DirManifest.publishFields, { activate: true }).length, 0);
    assert.equal(validateFields(h5DirManifest.publishFields, { activate: 'yes' }).length, 1);
  });

  it('目标字段校验', () => {
    const fields = h5DirManifest.targetFields;
    assert.equal(
      validateFields(fields, { rootDir: '/srv/h5', prefix: 'demo/', baseUrl: 'https://x/' }).length,
      0,
    );
    // 三个必填字段缺失
    assert.equal(validateFields(fields, {}).length, 3);
  });
});

describe('指针损坏时的行为', () => {
  it('指针损坏时报错而不是当成没有指针（否则回滚退路会悄悄消失）', async () => {
    const prefix = 'corrupt/';
    await publish({ buildId: 'c1', prefix });
    await writeFile(pointerFileOf(prefix), 'this is not json', 'utf8');

    const { ctx, cleanup } = await makeCtx({ buildId: 'c2', prefix });
    try {
      await h5DirExecute('upload', ctx);
      await assert.rejects(h5DirExecute('activate', ctx), /读取现有指针失败/);
    } finally {
      await cleanup();
    }
  });
});
