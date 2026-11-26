/**
 * HTTP 服务：中控台 UI + 管理 API + CI 上报接口。
 *
 * 路由前缀决定走哪条鉴权（src/auth/guard.ts）：
 *   /api/ci/*  → CI key
 *   /api/*     → 管理员会话
 *   其余       → 公开（健康检查、登录、首次设置）
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { authenticateCi, isAdmin, SESSION_COOKIE } from '../auth/guard.js';
import type { SessionStore } from '../auth/session.js';
import { checkPassword, isPasswordSet, setPassword } from '../auth/store.js';
import { listBuilds, parseBuildReport, resolveReport, upsertBuild } from '../builds/index.js';
import type { Db } from '../db/index.js';
import { createTarget, listTargets } from '../targets/index.js';
import type { RuntimeConfig } from '../shared/config.js';
import { toHttpError } from './errors.js';
import { handleUi } from './ui-routes.js';

const MAX_BODY_BYTES = 1024 * 1024;

export interface WebDeps {
  readonly config: RuntimeConfig;
  readonly db: Db;
  readonly sessions: SessionStore;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('请求体过大');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: unknown, field: string): string {
  if (!isRecord(body)) throw new Error('请求体必须是 JSON 对象');
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

async function route(req: IncomingMessage, res: ServerResponse, deps: WebDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // 页面路由优先：它自己处理未登录（跳登录页而不是回 JSON 401）
  if (await handleUi(req, res, deps)) return;

  /* ------------------------------ 公开端点 ------------------------------ */

  if (path === '/healthz') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // 首次设置时需要知道口令是否已设，否则前端不知道该显示登录还是初始化。
  if (path === '/api/auth/state' && method === 'GET') {
    json(res, 200, { passwordSet: isPasswordSet(deps.db), authenticated: isAdmin(req, deps.sessions) });
    return;
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJsonBody(req);
    const next = requireString(body, 'password');
    const alreadySet = isPasswordSet(deps.db);

    // 已设置口令后，改口令属于管理操作：要么已登录，要么提供当前口令。
    if (alreadySet && !isAdmin(req, deps.sessions)) {
      const current = isRecord(body) && typeof body['current'] === 'string' ? body['current'] : undefined;
      setPassword(deps.db, next, current);
      json(res, 200, { ok: true });
      return;
    }
    setPassword(deps.db, next, undefined);
    json(res, 200, { ok: true });
    return;
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const password = requireString(body, 'password');
    if (!checkPassword(deps.db, password)) {
      json(res, 401, { error: 'invalid_credentials' });
      return;
    }
    const token = deps.sessions.create();
    res.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    json(res, 200, { ok: true });
    return;
  }

  /* ---------------------------- CI 上报（CI key） ---------------------------- */

  if (path.startsWith('/api/ci/')) {
    const keyId = authenticateCi(req, deps.db);
    if (keyId === null) {
      json(res, 401, { error: 'invalid_ci_key' });
      return;
    }

    if (path === '/api/ci/builds' && method === 'POST') {
      const report = parseBuildReport(await readJsonBody(req));
      // 游戏与包类型必须已登记，查在写入之前，拒绝时零副作用。
      const resolved = resolveReport(deps.db, report);
      const { build, created } = upsertBuild(deps.db, resolved, keyId);
      json(res, created ? 201 : 200, {
        id: build.id,
        buildId: build.buildId,
        created,
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
    return;
  }

  /* --------------------------- 管理 API（会话） --------------------------- */

  if (path.startsWith('/api/')) {
    if (!isAdmin(req, deps.sessions)) {
      json(res, 401, { error: 'unauthenticated' });
      return;
    }

    if (path === '/api/targets' && method === 'GET') {
      const gameId = url.searchParams.get('gameId');
      const acceptsPackageType = url.searchParams.get('acceptsPackageType');
      json(res, 200, {
        targets: listTargets(deps.db, {
          ...(gameId !== null && { gameId }),
          ...(acceptsPackageType !== null && { acceptsPackageType }),
        }),
      });
      return;
    }

    if (path === '/api/targets' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new Error('请求体必须是 JSON 对象');
      const location = body['location'];
      if (!isRecord(location)) throw new Error('字段 location 必须是对象');

      const target = createTarget(
        deps.db,
        {
          gameId: requireString(body, 'gameId'),
          kind: requireString(body, 'kind'),
          name: requireString(body, 'name'),
          credentialId: typeof body['credentialId'] === 'string' ? body['credentialId'] : null,
          location,
        },
        deps.config.masterKey,
      );
      json(res, 201, { target });
      return;
    }

    if (path === '/api/builds' && method === 'GET') {
      const gameId = url.searchParams.get('gameId');
      const packageTypeId = url.searchParams.get('packageTypeId');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('limit 必须是正整数');
      }
      json(res, 200, {
        groups: listBuilds(deps.db, {
          ...(gameId !== null && { gameId }),
          ...(packageTypeId !== null && { packageTypeId }),
          ...(limit !== undefined && { limit }),
        }),
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
    return;
  }

  json(res, 404, { error: 'not_found' });
}

export function createApp(deps: WebDeps): Server {
  return createServer((req, res) => {
    route(req, res, deps).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const shape = toHttpError(error);
      json(res, shape.status, { error: shape.code, message: shape.message });
    });
  });
}

export function startWeb(deps: WebDeps): Server {
  const server = createApp(deps);
  server.listen(deps.config.port, () => {
    console.log(`http listening on :${deps.config.port}`);
  });
  return server;
}
