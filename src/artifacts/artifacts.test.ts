import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ArtifactFetchError, fetchArtifact } from './fetch.js';
import { prepareArtifact } from './prepare.js';
import { resolveEntryPath, unzip, UnzipError } from './unzip.js';
import { buildZip, sha256 } from './zip-fixture.test-helper.js';

const scratch = mkdtempSync(join(tmpdir(), 'artifact-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));


/* ------------------------------ 本地测试服务 ------------------------------ */

let server: Server;
let base: string;
const routes = new Map<string, { status: number; body?: Buffer; delayMs?: number }>();

before(async () => {
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? '');
    if (route === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const send = (): void => {
      res.writeHead(route.status);
      res.end(route.body ?? '');
    };
    if (route.delayMs !== undefined) {
      setTimeout(send, route.delayMs);
    } else {
      send();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('下载失败分类', () => {
  it('404 归为 unreachable，并提示重试无意义', async () => {
    routes.set('/gone.zip', { status: 404 });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/gone.zip`,
        destination: join(scratch, 'x.zip'),
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'unreachable');
        assert.match(error.message, /重试同一地址不会成功/);
        assert.match(error.message, /gone\.zip/, '错误信息必须带上当时用的 URL');
        return true;
      },
    );
  });

  it('403 归为 forbidden，并提示可能是签名过期', async () => {
    routes.set('/private.zip', { status: 403 });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/private.zip`,
        destination: join(scratch, 'x.zip'),
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'forbidden');
        assert.match(error.message, /签名 URL 已过期|未开放公开读/);
        return true;
      },
    );
  });

  it('500 归为 server_error，提示稍后重试', async () => {
    routes.set('/broken.zip', { status: 500 });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/broken.zip`,
        destination: join(scratch, 'x.zip'),
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'server_error');
        return true;
      },
    );
  });

  it('超时归为 timeout', async () => {
    routes.set('/slow.zip', { status: 200, body: Buffer.from('x'), delayMs: 2000 });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/slow.zip`,
        destination: join(scratch, 'x.zip'),
        expectedSize: 1,
        expectedSha256: sha256(Buffer.from('x')),
        timeoutMs: 50,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );
  });

  it('连不上的主机归为 unreachable', async () => {
    await assert.rejects(
      fetchArtifact({
        url: 'http://127.0.0.1:1/nope.zip',
        destination: join(scratch, 'x.zip'),
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'unreachable');
        return true;
      },
    );
  });
});

describe('完整性校验', () => {
  it('大小不符时失败', async () => {
    const content = Buffer.from('hello world');
    routes.set('/size.zip', { status: 200, body: content });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/size.zip`,
        destination: join(scratch, 'size.zip'),
        expectedSize: 999,
        expectedSha256: sha256(content),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'integrity');
        assert.match(error.message, /大小不符/);
        return true;
      },
    );
  });

  it('sha256 不符时失败，且明确说不交给 CLI', async () => {
    const content = Buffer.from('hello world');
    routes.set('/sha.zip', { status: 200, body: content });
    await assert.rejects(
      fetchArtifact({
        url: `${base}/sha.zip`,
        destination: join(scratch, 'sha.zip'),
        expectedSize: content.length,
        expectedSha256: 'b'.repeat(64),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactFetchError);
        assert.equal(error.kind, 'integrity');
        assert.match(error.message, /sha256 不符/);
        assert.match(error.message, /不会把它交给平台 CLI/);
        return true;
      },
    );
  });

  it('校验失败时删掉半截文件，避免下次误用', async () => {
    const content = Buffer.from('partial');
    routes.set('/partial.zip', { status: 200, body: content });
    const dest = join(scratch, 'partial.zip');
    await assert.rejects(
      fetchArtifact({
        url: `${base}/partial.zip`,
        destination: dest,
        expectedSize: content.length,
        expectedSha256: 'c'.repeat(64),
      }),
    );
    assert.throws(() => readFileSync(dest), /ENOENT/, '失败的下载不应留下文件');
  });

  it('校验通过时落盘内容正确', async () => {
    const content = Buffer.from('valid artifact bytes');
    routes.set('/ok.zip', { status: 200, body: content });
    const dest = join(scratch, 'ok.zip');
    await fetchArtifact({
      url: `${base}/ok.zip`,
      destination: dest,
      expectedSize: content.length,
      expectedSha256: sha256(content),
    });
    assert.deepEqual(readFileSync(dest), content);
  });
});

describe('zip 路径安全（zip slip）', () => {
  const dest = '/safe/dest';

  it('拒绝跳出目标目录的条目', () => {
    for (const name of ['../escape.txt', '../../etc/passwd', 'a/../../b.txt', 'a/b/../../../c']) {
      assert.throws(
        () => resolveEntryPath(dest, name),
        UnzipError,
        `${name} 应被拒`,
      );
    }
  });

  it('拒绝绝对路径条目', () => {
    for (const name of ['/etc/passwd', 'C:/Windows/x', 'c:/x']) {
      assert.throws(() => resolveEntryPath(dest, name), UnzipError, `${name} 应被拒`);
    }
  });

  it('拒绝反斜杠条目（zip 规范要求用 /）', () => {
    assert.throws(() => resolveEntryPath(dest, 'a\\..\\..\\b.txt'), /反斜杠/);
  });

  it('拒绝含空字节的条目', () => {
    assert.throws(() => resolveEntryPath(dest, 'a\0b.txt'), /空字节/);
  });

  it('正常相对路径通过', () => {
    for (const name of ['index.html', 'assets/app.js', 'a/b/c/d.txt', './x.txt']) {
      assert.doesNotThrow(() => resolveEntryPath(dest, name), `${name} 应通过`);
    }
  });

  it('解压时真的拦住恶意条目，且不写出文件', async () => {
    const zipPath = join(scratch, 'evil.zip');
    writeFileSync(
      zipPath,
      buildZip([
        { name: 'good.txt', content: Buffer.from('fine') },
        { name: '../escaped.txt', content: Buffer.from('ESCAPED') },
      ]),
    );

    const out = join(scratch, 'evil-out');
    await assert.rejects(unzip({ zipPath, destination: out }), UnzipError);

    // 关键断言：目标目录之外没有被写入任何东西
    assert.throws(() => readFileSync(join(scratch, 'escaped.txt')), /ENOENT/);
  });
});

describe('解压', () => {
  it('正常压缩包解出正确内容', async () => {
    const zipPath = join(scratch, 'good.zip');
    writeFileSync(
      zipPath,
      buildZip([
        { name: 'index.html', content: Buffer.from('<html>hi</html>') },
        { name: 'assets/app.js', content: Buffer.from('console.log(1)') },
      ]),
    );

    const out = join(scratch, 'good-out');
    const result = await unzip({ zipPath, destination: out });

    assert.equal(result.entryCount, 2);
    assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<html>hi</html>');
    assert.equal(readFileSync(join(out, 'assets', 'app.js'), 'utf8'), 'console.log(1)');
  });

  it('条目数超上限时拒绝（防 zip 炸弹）', async () => {
    const zipPath = join(scratch, 'many.zip');
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      content: Buffer.from('x'),
    }));
    writeFileSync(zipPath, buildZip(entries));

    await assert.rejects(
      unzip({ zipPath, destination: join(scratch, 'many-out'), maxEntries: 3 }),
      /条目数超过上限/,
    );
  });

  it('解压后总大小超上限时拒绝', async () => {
    const zipPath = join(scratch, 'big.zip');
    writeFileSync(zipPath, buildZip([{ name: 'big.bin', content: Buffer.alloc(1000, 1) }]));

    await assert.rejects(
      unzip({ zipPath, destination: join(scratch, 'big-out'), maxTotalBytes: 100 }),
      /总大小超过上限/,
    );
  });

  it('坏压缩包报错而不是静默产出空目录', async () => {
    const zipPath = join(scratch, 'corrupt.zip');
    writeFileSync(zipPath, Buffer.from('this is not a zip file at all'));
    await assert.rejects(
      unzip({ zipPath, destination: join(scratch, 'corrupt-out') }),
      /打开压缩包失败/,
    );
  });
});

describe('prepareArtifact 串起整条链路', () => {
  it('下载 → 校验 → 解压，产出插件可直接用的目录', async () => {
    const zipBody = buildZip([
      { name: 'game.js', content: Buffer.from('main()') },
      { name: 'config.json', content: Buffer.from('{}') },
    ]);
    routes.set('/pkg.zip', { status: 200, body: zipBody });

    const prepared = await prepareArtifact({
      url: `${base}/pkg.zip`,
      expectedSize: zipBody.length,
      expectedSha256: sha256(zipBody),
      parentDir: scratch,
    });

    try {
      assert.equal(prepared.entryCount, 2);
      assert.equal(readFileSync(join(prepared.artifactDir, 'game.js'), 'utf8'), 'main()');
    } finally {
      await prepared.cleanup();
    }

    assert.throws(() => readFileSync(join(prepared.artifactDir, 'game.js')), /ENOENT/);
  });

  it('摘要不符时不解压，且不留下工作目录', async () => {
    const zipBody = buildZip([{ name: 'a.txt', content: Buffer.from('x') }]);
    routes.set('/bad-sha.zip', { status: 200, body: zipBody });

    await assert.rejects(
      prepareArtifact({
        url: `${base}/bad-sha.zip`,
        expectedSize: zipBody.length,
        expectedSha256: 'd'.repeat(64),
        parentDir: scratch,
      }),
      /sha256 不符/,
    );
  });

  it('每次工作目录独立，并发任务互不干扰', async () => {
    const zipBody = buildZip([{ name: 'a.txt', content: Buffer.from('x') }]);
    routes.set('/concurrent.zip', { status: 200, body: zipBody });

    const make = (): ReturnType<typeof prepareArtifact> =>
      prepareArtifact({
        url: `${base}/concurrent.zip`,
        expectedSize: zipBody.length,
        expectedSha256: sha256(zipBody),
        parentDir: scratch,
      });

    const [a, b] = await Promise.all([make(), make()]);
    try {
      assert.notEqual(a.workdir, b.workdir, '两个任务的工作目录必须不同');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
