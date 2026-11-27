import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createSessionStore } from '../auth/session.js';
import { issueCiKey, setPassword } from '../auth/store.js';
import { createGame, createPackageType } from '../catalog/index.js';
import { ensureSchema, open, type Db } from '../db/index.js';
import { appendLog, enqueue, finish, listJobs } from '../jobs/index.js';
import type { RuntimeConfig } from '../shared/config.js';
import { createApp } from './server.js';

const config: RuntimeConfig = {
  dataDir: ':memory:',
  cliHome: ':memory:',
  port: 0,
  masterKey: 'test-master-key-0123456789',
};

let db: Db;
let base: string;
let server: ReturnType<typeof createApp>;

before(async () => {
  db = open({ file: ':memory:' });
  ensureSchema(db);
  server = createApp({ config, db, sessions: createSessionStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

/**
 * 设一个口令，不依赖当前状态。
 *
 * 这些测试共用一个 db，而 setPassword 在已设口令时要求提供当前口令。
 * 先清再设，让每条测试都不依赖执行顺序。
 */
function resetPassword(password: string): void {
  db.prepare('UPDATE settings SET password_hash = NULL WHERE id = 1').run();
  setPassword(db, password, undefined);
}

function now(): string {
  return new Date().toISOString();
}

describe('公开端点', () => {
  it('健康检查返回 200', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('未知 API 路径返回 404', async () => {
    const res = await fetch(`${base}/api/no-such-endpoint`, {
      headers: { 'x-ci-key': 'bogus' },
    });
    // 无效 CI key 先被拦住，说明 /api/* 没有被页面路由吞掉
    assert.equal(res.status, 401);
  });

  it('未设口令时任何页面都导向首次设置', async () => {
    db.prepare('UPDATE settings SET password_hash = NULL WHERE id = 1').run();
    try {
      const res = await fetch(`${base}/nope`);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await res.text(), /首次设置/, '没有口令时该引导设置，而不是给登录框');
    } finally {
      // 恢复，避免影响其他共用这个 db 的测试
      resetPassword('restored-after-setup-check');
    }
  });

  it('已设口令但未登录时，页面路径给登录页而不是一段 JSON', async () => {
    resetPassword('page-route-password');

    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /管理员口令/);
  });
});

describe('管理 API 鉴权', () => {
  it('无会话访问管理 API 返回 401', async () => {
    const res = await fetch(`${base}/api/games`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthenticated' });
  });

  it('CI key 不能当会话用', async () => {
    const issued = issueCiKey(db, 'for-cross-check', config.masterKey);
    const res = await fetch(`${base}/api/games`, {
      headers: { authorization: `Bearer ${issued.value!}` },
    });
    assert.equal(res.status, 401);
  });

  it('口令登录后可访问管理 API', async () => {
    resetPassword('admin-password-1');

    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(bad.status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password-1' }),
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie, '登录应返回会话 Cookie');
    assert.match(cookie, /HttpOnly/);

    // 已登录后管理 API 不再是 401（端点未实现所以是 404）
    const res = await fetch(`${base}/api/games`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.equal(res.status, 404);
  });
});

describe('设置页：CI key', () => {
  async function adminCookie(): Promise<string> {
    const password = 'ci-key-page-password';
    resetPassword(password);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return login.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('/settings 跳到 CI key 分区', async () => {
    const cookie = await adminCookie();
    const res = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/settings/ci-keys');
  });

  it('保存自定义值后，页面上能直接看到完整 key', async () => {
    const cookie = await adminCookie();
    const value = 'self-use-key-20261125';
    const created = await fetch(`${base}/settings/ci-keys`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ name: '页面可见性测试', value }).toString(),
      redirect: 'manual',
    });
    assert.equal(created.status, 303);

    const res = await fetch(`${base}/settings/ci-keys`, { headers: { cookie } });
    const body = await res.text();
    assert.match(body, /self-use-key-20261125/);
    assert.match(body, /页面可见性测试/);
    assert.doesNotMatch(body, /只显示这一次/);
  });

  it('可以随时换值，旧值立即失效', async () => {
    const cookie = await adminCookie();
    const oldValue = 'replace-me-key-0001';
    await fetch(`${base}/settings/ci-keys`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ name: '可替换值测试', value: oldValue }).toString(),
      redirect: 'manual',
    });

    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM ci_keys WHERE name = ?')
      .get('可替换值测试');
    assert.ok(row);

    const updated = await fetch(`${base}/settings/ci-keys/${row.id}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ name: '可替换值测试', value: 'replacement-key-0002' }).toString(),
      redirect: 'manual',
    });
    assert.equal(updated.status, 303);

    const page = await fetch(`${base}/settings/ci-keys`, { headers: { cookie } });
    const body = await page.text();
    assert.match(body, /replacement-key-0002/);

    const rejected = await fetch(`${base}/api/ci/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldValue}` },
    });
    assert.equal(rejected.status, 401, '换值后旧 key 必须立即失效');
  });
});

describe('删除被引用的记录：页面与接口同一个状态码', () => {
  async function adminCookie(): Promise<string> {
    const password = 'delete-status-password';
    resetPassword(password);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return login.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('被引用的凭据删除回 409 而不是 400', async () => {
    const cookie = await adminCookie();

    // 造一条被目标引用的凭据
    const credId = randomUUID();
    db.prepare(
      `INSERT INTO credentials (id, name, type, secrets, created_at, updated_at)
       VALUES (?, ?, 'file', ?, ?, ?)`,
    ).run(credId, `ref-cred-${credId.slice(0, 8)}`, Buffer.from('x'), now(), now());

    const gameId = randomUUID();
    db.prepare('INSERT INTO games (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      gameId,
      `g-${credId.slice(0, 8)}`,
      'G',
      now(),
    );
    db.prepare(
      `INSERT INTO targets (id, game_id, kind, name, credential_id, location, location_key, created_at, updated_at)
       VALUES (?, ?, 'wechat', 'T', ?, '{}', ?, ?, ?)`,
    ).run(randomUUID(), gameId, credId, credId, now(), now());

    const res = await fetch(`${base}/settings/credentials/${credId}/delete`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });

    // 409 而不是 400：请求本身合法，是与当前状态冲突。
    // 这里曾经回 400——UI 的错误映射漏了 ReferencedError。
    assert.equal(res.status, 409);
    const body = await res.text();
    assert.match(body, /不能删除/);
    assert.doesNotMatch(body, /归档/, '归档已移除，提示里不该再出现');
  });
});

describe('CI 上报：包类型校验', () => {
  async function report(body: unknown): Promise<Response> {
    const issued = issueCiKey(db, `k-${Math.random()}`, config.masterKey);
    return fetch(`${base}/api/ci/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.value!}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const payload = {
    game: 'ingest-demo',
    packageType: 'ingest-wechat',
    buildId: 'b1',
    artifactUrl: 'https://example.com/a.zip',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
  };

  it('未登记的包类型返回 400，且构建表无新增', async () => {
    createGame(db, { slug: 'ingest-demo', displayName: '示例' });
    // 包类型故意不登记
    const before = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();

    const res = await report(payload);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /包类型「ingest-wechat」未登记/);

    const after = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
    assert.equal(after?.n, before?.n, '拒绝时不应写入构建记录');
  });

  it('未登记的游戏返回 400', async () => {
    const res = await report({ ...payload, game: 'no-such-game' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /游戏「no-such-game」未登记/);
  });

  it('载荷缺 sha256 返回 400', async () => {
    const { sha256, ...incomplete } = payload;
    const res = await report(incomplete);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /sha256/);
  });

  it('游戏与包类型都已登记时登记成功，返回 201', async () => {
    createPackageType(db, { id: 'ingest-wechat', displayName: '微信' });
    const res = await report(payload);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { created: boolean; buildId: string };
    assert.equal(body.created, true);
    assert.equal(body.buildId, 'b1');
  });

  it('重复上报返回 200 且构建数不变', async () => {
    const before = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
    const res = await report(payload);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { created: boolean };
    assert.equal(body.created, false);

    const after = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM builds').get();
    assert.equal(after?.n, before?.n);
  });
});

describe('构建列表接口', () => {
  async function adminCookie(): Promise<string> {
    const password = 'builds-list-password';
    resetPassword(password);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return login.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('无会话时返回 401', async () => {
    const res = await fetch(`${base}/api/builds`);
    assert.equal(res.status, 401);
  });

  it('已登录时返回聚合后的构建组', async () => {
    const cookie = await adminCookie();
    const res = await fetch(`${base}/api/builds`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { groups: unknown[] };
    assert.ok(Array.isArray(body.groups));
  });

  it('limit 非正整数时返回 400', async () => {
    const cookie = await adminCookie();
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await fetch(`${base}/api/builds?limit=${bad}`, { headers: { cookie } });
      assert.equal(res.status, 400, `limit=${bad} 应被拒`);
    }
  });
});

describe('CI 上报鉴权', () => {
  it('无 CI key 上报返回 401', async () => {
    const res = await fetch(`${base}/api/ci/builds`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'invalid_ci_key' });
  });

  it('错误 CI key 返回 401', async () => {
    const res = await fetch(`${base}/api/ci/builds`, {
      method: 'POST',
      headers: { authorization: 'Bearer mgc_not-a-real-key' },
    });
    assert.equal(res.status, 401);
  });

  it('有效 CI key 通过鉴权（载荷为空所以落在 400 而非 401）', async () => {
    const issued = issueCiKey(db, 'ci-auth-check', config.masterKey);
    for (const headers of [
      { authorization: `Bearer ${issued.value!}` },
      { 'x-ci-key': issued.value! },
    ]) {
      const res = await fetch(`${base}/api/ci/builds`, { method: 'POST', headers });
      assert.equal(res.status, 400, `headers=${JSON.stringify(headers)}`);
    }
  });

  it('会话不能当 CI key 用', async () => {
    // 不依赖其他测试是否设过口令：直接清掉再设，避免测试间顺序耦合。
    const password = 'cross-check-password';
    resetPassword(password);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie, '登录应返回会话 Cookie');

    const res = await fetch(`${base}/api/ci/builds`, {
      method: 'POST',
      headers: { cookie: setCookie.split(';')[0]! },
    });
    assert.equal(res.status, 401);
  });
});

describe('设置页：平台 CLI 安装任务', () => {
  async function adminCookie(): Promise<string> {
    resetPassword('cli-page-password');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'cli-page-password' }),
    });
    return login.headers.get('set-cookie')!.split(';')[0]!;
  }

  /** 清空任务表，让每条测试的状态都从零构造，不依赖执行顺序。 */
  function clearJobs(): void {
    db.prepare('DELETE FROM jobs').run();
  }

  function runningInstallJob(cliId: string, log: string): string {
    clearJobs();
    const job = enqueue(db, 'cli_install', cliId);
    db.prepare('UPDATE jobs SET status = ?, started_at = ? WHERE id = ?').run(
      'running',
      now(),
      job.id,
    );
    if (log !== '') appendLog(db, job.id, log);
    return job.id;
  }

  it('点安装投递任务并重定向，页面出现任务面板与自动刷新', async () => {
    clearJobs();
    const cookie = await adminCookie();

    const res = await fetch(`${base}/settings/cli/miniprogram-ci/install`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /notice=install-queued/);
    assert.equal(listJobs(db, { kind: 'cli_install' }).length, 1, '应投递一条安装任务');

    const page = await fetch(`${base}/settings/cli`, { headers: { cookie } });
    const html = await page.text();
    // 排队中的任务在页面上可见：状态徽标 + 队列信息 + 自动刷新
    assert.match(html, /排队中/);
    assert.match(html, /即将执行|前面还有/);
    assert.match(html, /http-equiv="refresh"/, '有任务排队时页面应自动刷新');
    assert.match(html, /安装任务/, 'CLI 卡片应带安装任务面板');
  });

  it('执行中显示日志与已运行时间，重复点安装被挡住', async () => {
    runningInstallJob('tt-minigame-ide-cli', 'npm http fetch GET 200 https://registry.npmjs.org/tt-minigame-ide-cli');
    const cookie = await adminCookie();

    const page = await fetch(`${base}/settings/cli`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /执行中/);
    assert.match(html, /已运行/);
    assert.match(html, /registry\.npmjs\.org\/tt-minigame-ide-cli/, '日志应显示在页面上');
    assert.match(html, /安装中/, '卡片标题应显示安装中徽标');
    assert.match(html, /http-equiv="refresh"/, '执行中页面应自动刷新');

    // 已有任务在跑时再点安装：不投递新任务，提示正在执行
    const res = await fetch(`${base}/settings/cli/tt-minigame-ide-cli/install`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /notice=install-running/);
    assert.equal(listJobs(db, { kind: 'cli_install' }).length, 1, '不应重复投递');
  });

  it('失败的任务显示原因与日志，页面不再自动刷新', async () => {
    const jobId = runningInstallJob(
      'miniprogram-ci',
      '安装 miniprogram-ci@2.1.31 到 /opt/cli/miniprogram-ci/2.1.31',
    );
    finish(db, jobId, 'failed', '安装失败（npm 退出码 1）：network timeout');
    const cookie = await adminCookie();

    const page = await fetch(`${base}/settings/cli`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /失败/);
    assert.match(html, /安装失败（npm 退出码 1）：network timeout/, '失败原因应显示在面板上');
    assert.match(html, /安装 miniprogram-ci@2\.1\.31/, '日志应保留在面板里');
    assert.doesNotMatch(html, /http-equiv="refresh"/, '任务结束后不再自动刷新');
  });

  it('日志超长时只渲染最后一段，并标注总行数', async () => {
    const jobId = runningInstallJob('miniprogram-ci', '');
    for (let i = 1; i <= 120; i += 1) {
      appendLog(db, jobId, `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i}`);
    }
    const cookie = await adminCookie();

    const page = await fetch(`${base}/settings/cli`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /共 120 行，显示最后 80 行/);
    assert.doesNotMatch(html, /pkg-1\b/, '最早的日志行不渲染');
    assert.match(html, /pkg-120/, '最新 80 行内的日志要渲染');
  });

  it('成功的任务显示成功徽标', async () => {
    const jobId = runningInstallJob('miniprogram-ci', '安装完成：miniprogram-ci@2.1.31');
    finish(db, jobId, 'success');
    const cookie = await adminCookie();

    const page = await fetch(`${base}/settings/cli`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /安装任务/);
    assert.match(html, /安装完成：miniprogram-ci@2\.1\.31/);
    // 任务面板有成功徽标（探测仍未安装是另一件事，页面上两个状态并存）
    assert.match(html, /耗时/);
  });
});
