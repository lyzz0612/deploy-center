/**
 * H5 R2 目标的测试。
 *
 * 全程对着一个真的 HTTP 服务（见 fake-s3.test-helper.ts）跑 AWS SDK，
 * 所以签名、路径风格寻址、翻页、批量删除都真的执行一遍。verify 那一组
 * 另起一个静态服务充当对外地址，验证「外部能不能取到」而不只是「写进去了」。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createContext } from '../../releases/index.js';
import { validateFields } from '../../registry/index.js';
import { classifyStorageError } from './checks.js';
import { startFakeS3, type FakeS3 } from './fake-s3.test-helper.js';
import { h5R2Plugin } from './index.js';
import { h5R2Manifest } from './manifest.js';
import { parsePointer, POINTER_FILE, VERSIONS_DIR } from './pointer.js';
import { h5R2Execute, h5R2Rollback, h5R2Verify } from './publish.js';

const BUCKET = 'test-bucket';
const scratch = mkdtempSync(join(tmpdir(), 'h5r2-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let s3: FakeS3;

before(async () => {
  s3 = await startFakeS3({ buckets: [BUCKET] });
});
after(async () => {
  await s3.close();
});

beforeEach(() => {
  s3.buckets.get(BUCKET)?.clear();
  s3.failNextPut(0);
  s3.calls.put = 0;
  s3.calls.get = 0;
  s3.calls.list = 0;
  s3.calls.delete = 0;
  s3.calls.head = 0;
});

/** 建一个产物目录。 */
async function makeArtifact(
  files: Record<string, string> = { 'index.html': '<html></html>', 'game.js': 'let a=1' },
): Promise<string> {
  const dir = mkdtempSync(join(scratch, 'artifact-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

async function makeCtx(options: {
  artifactDir: string;
  buildId?: string;
  target?: Record<string, unknown>;
  params?: Record<string, unknown>;
  secrets?: Record<string, string>;
  baseUrl?: string;
}): Promise<Awaited<ReturnType<typeof createContext>>> {
  const workdir = mkdtempSync(join(scratch, 'work-'));
  return createContext({
    artifactDir: options.artifactDir,
    workdir,
    build: {
      buildId: options.buildId ?? 'r1',
      commitSha: null,
      packageTypeId: 'h5',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
    },
    target: options.target ?? {
      bucket: BUCKET,
      prefix: 'demo/',
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:1/demo/',
    },
    params: options.params ?? {},
    cliHome: join(scratch, 'empty-cli'),
    // 缺省**不给 region**：它在凭据里声明为可选，而凭据只存有值的字段，
    // 所以真实形状就是「没这个键」。此前这里硬塞了 region: 'auto'，
    // 于是整套测试都没覆盖到用户留空的情况，线上就炸在那里。
    secrets: options.secrets ?? {
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret',
      endpoint: s3.url,
    },
    log: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  });
}

/** 跑完整的 upload + activate。 */
async function publish(options: Parameters<typeof makeCtx>[0]): Promise<void> {
  const { ctx } = await makeCtx(options);
  await h5R2Execute('upload', ctx);
  await h5R2Execute('activate', ctx);
}

function pointerOf(prefix = 'demo/'): ReturnType<typeof parsePointer> {
  const object = s3.object(BUCKET, `${prefix}${POINTER_FILE}`);
  assert.ok(object, '指针对象应存在');
  return parsePointer(object.body.toString('utf8'));
}

describe('manifest 声明', () => {
  it('只接受 h5 包，需要 s3Keys 凭据，不需要 CLI', () => {
    assert.deepEqual(h5R2Manifest.accepts, ['h5']);
    assert.equal(h5R2Manifest.requiresCredential, 's3Keys');
    assert.deepEqual(h5R2Manifest.requiresCli, []);
  });

  it('目标字段里没有任何密钥字段（密钥在凭据里）', () => {
    for (const field of h5R2Manifest.targetFields) {
      assert.equal(
        /secret|password|privatekey|token|accesskey/i.test(field.key),
        false,
        `targetFields 不该含密钥字段 ${field.key}`,
      );
    }
  });

  it('bucket 与 prefix 参与去重，baseUrl 不参与', () => {
    const byKey = new Map(h5R2Manifest.targetFields.map((f) => [f.key, f]));
    assert.equal(byKey.get('bucket')?.identity, true);
    assert.equal(byKey.get('prefix')?.identity, true);
    assert.notEqual(
      byKey.get('baseUrl')?.identity,
      true,
      'baseUrl 是「怎么访问」而不是「发到哪」，参与去重会让同一位置能建出两个实例',
    );
  });

  it('声明 pointer 回滚与 verify，且都实现了', () => {
    assert.equal(h5R2Manifest.capabilities.rollback, 'pointer');
    assert.equal(typeof h5R2Plugin.rollback, 'function');
    assert.equal(h5R2Manifest.capabilities.verify, true);
    assert.equal(typeof h5R2Plugin.verify, 'function');
  });

  it('提供了实例级的凭据层与可达层检查', () => {
    const levels = h5R2Plugin.targetChecks.map((c) => c.level);
    assert.ok(levels.includes('credential'), '应有凭据层检查');
    assert.ok(levels.includes('reachability'), '应有可达层检查');
  });

  it('阶段是 upload → activate', () => {
    assert.deepEqual(h5R2Manifest.stages.map((s) => s.id), ['upload', 'activate']);
  });
});

describe('字段校验', () => {
  it('activate 必须是布尔', () => {
    assert.equal(validateFields(h5R2Manifest.publishFields, {}).length, 0);
    assert.equal(validateFields(h5R2Manifest.publishFields, { activate: true }).length, 0);
    assert.equal(validateFields(h5R2Manifest.publishFields, { activate: 'yes' }).length, 1);
  });

  it('bucket、prefix、baseUrl 必填，keepVersions 可选', () => {
    const fields = h5R2Manifest.targetFields;
    const ok = { bucket: BUCKET, prefix: 'demo/', baseUrl: 'https://x/demo/' };
    assert.equal(validateFields(fields, ok).length, 0);
    assert.equal(validateFields(fields, { ...ok, keepVersions: 3 }).length, 0);
    assert.equal(validateFields(fields, { prefix: 'demo/', baseUrl: 'https://x/' }).length, 1);
  });
});

describe('上传版本目录', () => {
  it('产物按 v/<buildId>/ 上传，键与目录结构一致', async () => {
    const dir = await makeArtifact({
      'index.html': '<html></html>',
      'assets/game.js': 'let a=1',
      'assets/img/logo.png': 'PNG',
    });
    const { ctx } = await makeCtx({ artifactDir: dir, buildId: 'r1' });
    const result = await h5R2Execute('upload', ctx);

    assert.equal(result.outputs?.['version'], 'r1');
    assert.equal(result.outputs?.['fileCount'], '3');
    assert.deepEqual(s3.keys(BUCKET), [
      `demo/${VERSIONS_DIR}/r1/assets/game.js`,
      `demo/${VERSIONS_DIR}/r1/assets/img/logo.png`,
      `demo/${VERSIONS_DIR}/r1/index.html`,
    ]);
  });

  it('版本资源长缓存，指针不缓存——两者策略必须相反', async () => {
    await publish({ artifactDir: await makeArtifact() });

    const asset = s3.object(BUCKET, `demo/${VERSIONS_DIR}/r1/index.html`);
    assert.match(asset?.cacheControl ?? '', /immutable/);
    assert.match(asset?.contentType ?? '', /text\/html/);

    const pointer = s3.object(BUCKET, `demo/${POINTER_FILE}`);
    assert.match(
      pointer?.cacheControl ?? '',
      /no-store/,
      '指针被缓存的话切流与回滚都不会生效',
    );
    assert.match(pointer?.contentType ?? '', /application\/json/);
  });

  it('重发同一版本先清旧对象，不留下两次产物的混合体', async () => {
    const first = await makeArtifact({ 'index.html': 'v1', 'old.js': '要消失的文件' });
    await publish({ artifactDir: first, buildId: 'r1' });
    assert.ok(s3.keys(BUCKET).includes(`demo/${VERSIONS_DIR}/r1/old.js`));

    const second = await makeArtifact({ 'index.html': 'v2' });
    await publish({ artifactDir: second, buildId: 'r1' });

    assert.equal(
      s3.keys(BUCKET).includes(`demo/${VERSIONS_DIR}/r1/old.js`),
      false,
      '上一次有、这一次没有的文件必须被清掉',
    );
    assert.equal(
      s3.object(BUCKET, `demo/${VERSIONS_DIR}/r1/index.html`)?.body.toString('utf8'),
      'v2',
    );
  });

  it('空产物目录被拒，而不是上传出一个空版本', async () => {
    const dir = mkdtempSync(join(scratch, 'empty-'));
    const { ctx } = await makeCtx({ artifactDir: dir });
    await assert.rejects(h5R2Execute('upload', ctx), /产物目录是空的/);
  });

  it('危险的构建标识被拒，产物不会落到版本前缀之外', async () => {
    const dir = await makeArtifact();
    for (const bad of ['../escape', 'a/b', '.hidden', 'has space', '']) {
      const { ctx } = await makeCtx({ artifactDir: dir, buildId: bad });
      await assert.rejects(h5R2Execute('upload', ctx), /不能作为版本前缀/, `${bad} 应被拒`);
    }
  });

  it('缺 endpoint 时直接报错，而不是去连 AWS', async () => {
    const dir = await makeArtifact();
    for (const secrets of [
      // 填了空串
      { accessKeyId: 'k', secretAccessKey: 's', endpoint: '' },
      // 根本没这个键（凭据不存空值，这才是用户留空后的真实形状）
      { accessKeyId: 'k', secretAccessKey: 's' },
    ]) {
      const { ctx } = await makeCtx({ artifactDir: dir, secrets });
      await assert.rejects(h5R2Execute('upload', ctx), /endpoint 为空/);
    }
  });

  it('没填 region 也能正常发布（可选字段，缺省 auto）', async () => {
    const dir = await makeArtifact();
    const { ctx } = await makeCtx({
      artifactDir: dir,
      secrets: { accessKeyId: 'k', secretAccessKey: 's', endpoint: s3.url },
    });
    await h5R2Execute('upload', ctx);
    await h5R2Execute('activate', ctx);
    assert.equal(pointerOf().active, 'r1');
  });

  it('未知阶段报错', async () => {
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact() });
    await assert.rejects(h5R2Execute('bogus', ctx), /没有阶段 bogus/);
  });

  it('偶发的 5xx 由 SDK 重试吃掉，不让一次抖动毁掉整次发布', async () => {
    const dir = await makeArtifact({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    s3.failNextPut(1);
    const { ctx } = await makeCtx({ artifactDir: dir });

    const result = await h5R2Execute('upload', ctx);
    assert.equal(result.outputs?.['fileCount'], '3');
    assert.equal(s3.keys(BUCKET).length, 3, '重试后三个文件都该在');
  });

  it('持续失败时抛出，不把失败咽掉当成功', async () => {
    const dir = await makeArtifact({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    // 大于重试上限，确保它不是「重试后成功」
    s3.failNextPut(50);
    const { ctx } = await makeCtx({ artifactDir: dir });
    await assert.rejects(h5R2Execute('upload', ctx));
  });
});

describe('指针与切流', () => {
  it('首次发布：active 是新版本，prev 为 null', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    const pointer = pointerOf();
    assert.equal(pointer.active, 'r1');
    assert.equal(pointer.prev, null);
    assert.equal(pointer.base, `demo/${VERSIONS_DIR}/r1/`);
  });

  it('第二次发布：prev 指向被替换掉的版本', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    await publish({ artifactDir: await makeArtifact(), buildId: 'r2' });
    const pointer = pointerOf();
    assert.equal(pointer.active, 'r2');
    assert.equal(pointer.prev, 'r1');
  });

  it('重复发布同一版本不会把 prev 冲成自己', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    await publish({ artifactDir: await makeArtifact(), buildId: 'r2' });
    await publish({ artifactDir: await makeArtifact(), buildId: 'r2' });

    const pointer = pointerOf();
    assert.equal(pointer.active, 'r2');
    assert.equal(pointer.prev, 'r1', 'prev 是回滚目标，不该被同版本重发冲掉');
  });

  it('activate: false 时只上传不切流', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      params: { activate: false },
    });
    await h5R2Execute('upload', ctx);
    const result = await h5R2Execute('activate', ctx);

    assert.equal(result.outputs?.['activated'], 'false');
    assert.equal(s3.object(BUCKET, `demo/${POINTER_FILE}`), undefined, '不该写出指针');
    assert.ok(s3.keys(BUCKET).some((k) => k.includes(`${VERSIONS_DIR}/r1/`)), '版本应已上传');
  });

  it('指针损坏时报错，而不是当成「没有指针」把 prev 悄悄丢掉', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    s3.buckets.get(BUCKET)?.set(`demo/${POINTER_FILE}`, {
      body: Buffer.from('{ 这不是合法 JSON'),
      contentType: 'application/json',
      cacheControl: 'no-store',
    });

    const { ctx } = await makeCtx({ artifactDir: await makeArtifact(), buildId: 'r2' });
    await h5R2Execute('upload', ctx);
    await assert.rejects(h5R2Execute('activate', ctx), /解析现有指针失败/);
  });

  it('不同前缀互不干扰（同一个桶放多个游戏或环境）', async () => {
    await publish({
      artifactDir: await makeArtifact(),
      buildId: 'r1',
      target: { bucket: BUCKET, prefix: 'demo/', baseUrl: 'http://x/demo/' },
    });
    await publish({
      artifactDir: await makeArtifact(),
      buildId: 'r9',
      target: { bucket: BUCKET, prefix: 'demo-staging/', baseUrl: 'http://x/demo-staging/' },
    });

    assert.equal(pointerOf('demo/').active, 'r1');
    assert.equal(pointerOf('demo-staging/').active, 'r9');
  });
});

describe('旧版本清理', () => {
  it('超出保留数的旧版本被删，当前与 prev 永不删', async () => {
    const target = {
      bucket: BUCKET,
      prefix: 'prune/',
      baseUrl: 'http://x/prune/',
      keepVersions: 3,
    };
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      await publish({ artifactDir: await makeArtifact(), buildId: id, target });
    }

    const versions = new Set(
      s3
        .keys(BUCKET)
        .filter((k) => k.startsWith(`prune/${VERSIONS_DIR}/`))
        .map((k) => k.slice(`prune/${VERSIONS_DIR}/`.length).split('/')[0]),
    );
    assert.ok(versions.has('p4'), '当前版本必须保留');
    assert.ok(versions.has('p3'), 'prev 必须保留，否则回滚失去目标');
    assert.equal(versions.size, 3, `keepVersions: 3 应只留 3 个版本，实际 ${[...versions]}`);
  });
});

describe('回滚', () => {
  it('回滚只改指针，产物不动', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    await publish({ artifactDir: await makeArtifact(), buildId: 'r2' });

    const before = s3.keys(BUCKET).filter((k) => k.includes(`${VERSIONS_DIR}/`));
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact(), buildId: 'r2' });
    const result = await h5R2Rollback(ctx);

    assert.equal(result.outputs?.['version'], 'r1');
    assert.equal(result.outputs?.['previousVersion'], 'r2');

    const pointer = pointerOf();
    assert.equal(pointer.active, 'r1');
    assert.equal(pointer.prev, 'r2', '回滚后要能再切回去');
    assert.deepEqual(
      s3.keys(BUCKET).filter((k) => k.includes(`${VERSIONS_DIR}/`)),
      before,
      '回滚不该动任何产物对象',
    );
  });

  it('没有指针时拒绝回滚', async () => {
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact() });
    await assert.rejects(h5R2Rollback(ctx), /还没有指针/);
  });

  it('没有上一版本时拒绝回滚', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact(), buildId: 'r1' });
    await assert.rejects(h5R2Rollback(ctx), /没有上一版本/);
  });

  it('上一版本的对象已被清掉时拒绝回滚，而不是切到一个 404 的线上版本', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1' });
    await publish({ artifactDir: await makeArtifact(), buildId: 'r2' });

    // 手动清掉 r1 的对象，模拟保留策略已经收走它
    for (const key of s3.keys(BUCKET)) {
      if (key.startsWith(`demo/${VERSIONS_DIR}/r1/`)) s3.buckets.get(BUCKET)?.delete(key);
    }

    const { ctx } = await makeCtx({ artifactDir: await makeArtifact(), buildId: 'r2' });
    await assert.rejects(h5R2Rollback(ctx), /已不存在/);
  });
});

describe('verify：回读对外地址', () => {
  let site: Server;
  let siteUrl: string;

  before(async () => {
    // 充当绑在桶前缀上的公开域名：从假 S3 里取同一份对象
    site = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const key = `demo${path}`;
      const object = s3.object(BUCKET, key);
      if (object === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': object.contentType }).end(object.body);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  });

  after(async () => {
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });

  function target(): Record<string, unknown> {
    return { bucket: BUCKET, prefix: 'demo/', baseUrl: siteUrl };
  }

  it('外部取到新版本时通过', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1', target: target() });
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      buildId: 'r1',
      target: target(),
    });
    const result = await h5R2Verify(ctx);
    assert.equal(result.ok, true, result.message);
  });

  it('对外地址上还是旧版本时失败，并说明可能是缓存', async () => {
    await publish({ artifactDir: await makeArtifact(), buildId: 'r1', target: target() });
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      buildId: 'r2',
      target: target(),
    });
    const result = await h5R2Verify(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /缓存/);
  });

  it('对外地址取不到指针时失败，并指向自定义域配置', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      target: { bucket: BUCKET, prefix: 'demo/', baseUrl: siteUrl },
    });
    const result = await h5R2Verify(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 404|自定义域/);
  });

  it('activate: false 时跳过生效验证', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      params: { activate: false },
      target: target(),
    });
    const result = await h5R2Verify(ctx);
    assert.equal(result.ok, true);
    assert.match(result.message, /跳过/);
  });

  it('对外地址连不上时，把底层原因一起写进结论', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      target: { bucket: BUCKET, prefix: 'demo/', baseUrl: 'http://no-such-host.invalid/' },
    });
    const result = await h5R2Verify(ctx);
    assert.equal(result.ok, false);
    // 只有「fetch failed」的话，用户不知道是 DNS、证书还是连接被拒
    assert.match(result.message, /no-such-host\.invalid/);
    assert.match(result.message, /ENOTFOUND|getaddrinfo|EAI_AGAIN/);
  });
});

describe('错误分类', () => {
  it('桶不存在、无权限、密钥错、网络不通各给不同的下一步', () => {
    const notFound = classifyStorageError(
      Object.assign(new Error('no bucket'), { $metadata: { httpStatusCode: 404 } }),
      'b',
    );
    assert.match(notFound.message, /不存在/);

    const denied = classifyStorageError(
      Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } }),
      'b',
    );
    assert.match(denied.message, /权限/);

    const badKey = classifyStorageError(
      Object.assign(new Error('bad sig'), { name: 'SignatureDoesNotMatch' }),
      'b',
    );
    assert.match(badKey.message, /Access Key ID|Secret/);

    const offline = classifyStorageError(new Error('getaddrinfo ENOTFOUND x'), 'b');
    assert.match(offline.message, /出网|连不上/);
  });

  it('分类结果都带上原始错误，便于排查', () => {
    const result = classifyStorageError(new Error('原始信息在这里'), 'b');
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /原始信息在这里/);
  });
});

describe('实例级检查', () => {
  function check(id: string) {
    const found = h5R2Plugin.targetChecks.find((c) => c.id === id);
    assert.ok(found, `应有检查 ${id}`);
    return found;
  }

  it('凭据缺字段时凭据层检查失败', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      secrets: { accessKeyId: '', secretAccessKey: 's', endpoint: s3.url, region: 'auto' },
    });
    const result = await check('r2-credential').run(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /accessKeyId/);
  });

  it('endpoint 不是 http(s) 时凭据层检查失败', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      secrets: {
        accessKeyId: 'k',
        secretAccessKey: 's',
        endpoint: 'r2.example.com',
        region: 'auto',
      },
    });
    const result = await check('r2-credential').run(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /http/);
  });

  it('桶存在时可达性检查通过', async () => {
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact() });
    const result = await check('r2-reachable').run(ctx);
    assert.equal(result.ok, true, result.message);
  });

  it('桶不存在时可达性检查失败并说明不会自动建桶', async () => {
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      target: { bucket: 'no-such-bucket', prefix: 'demo/', baseUrl: 'http://x/' },
    });
    const result = await check('r2-reachable').run(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /不存在/);
  });

  it('没填 region 时两层检查都照常通过——它是可选字段', async () => {
    // 回归：此前可达性检查会报「凭据里没有字段 region」，一个与「桶通不通」
    // 毫无关系的结论，而 region 在凭据里本来就声明为可选。
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      secrets: { accessKeyId: 'k', secretAccessKey: 's', endpoint: s3.url },
    });

    const credential = await check('r2-credential').run(ctx);
    assert.equal(credential.ok, true, credential.message);

    const reachable = await check('r2-reachable').run(ctx);
    assert.equal(reachable.ok, true, reachable.message);
    assert.doesNotMatch(reachable.message, /region/);
  });

  it('可达性检查是真的发请求，而不是本地预校验', async () => {
    const before = s3.calls.head;
    const { ctx } = await makeCtx({ artifactDir: await makeArtifact() });
    await check('r2-reachable').run(ctx);
    assert.ok(s3.calls.head > before, '必须真的对桶发出一次 HeadBucket');
  });

  it('连请求都发不出去时如实说明，不伪装成可达性结论', async () => {
    // 缺 endpoint：客户端建不起来，这类问题 L2 已经报过
    const { ctx } = await makeCtx({
      artifactDir: await makeArtifact(),
      secrets: { accessKeyId: 'k', secretAccessKey: 's' },
    });
    const result = await check('r2-reachable').run(ctx);
    assert.equal(result.ok, false);
    assert.match(result.message, /没能发起请求/);
  });
});
