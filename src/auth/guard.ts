/**
 * 两条互不相通的鉴权入口（design.md：单人使用，不做 RBAC）。
 *
 *   管理台 API  → 管理员会话 Cookie
 *   CI 上报接口 → CI key（Authorization: Bearer / X-CI-Key）
 *
 * 刻意不互通：CI key 不能用来操作中控台，会话也不能用来上报。
 * 否则 CI 里泄漏一个 key 就等于拿到后台控制权。
 */
import type { IncomingMessage } from 'node:http';

import type { Db } from '../db/index.js';
import { verifyCiKey } from './store.js';
import type { SessionStore } from './session.js';

export const SESSION_COOKIE = 'mgc_session';

/** 从 Cookie 头里取一个值。不引入 cookie 解析库，只需读一个名字。 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** 管理员是否已登录。 */
export function isAdmin(req: IncomingMessage, sessions: SessionStore): boolean {
  return sessions.verify(readCookie(req, SESSION_COOKIE));
}

/** 从请求里取 CI key。支持 `Authorization: Bearer <key>` 与 `X-CI-Key: <key>`。 */
export function readCiKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match !== null) return match[1];
  }
  const header = req.headers['x-ci-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  return undefined;
}

/** 校验 CI key，通过时返回 key id。 */
export function authenticateCi(req: IncomingMessage, db: Db): string | null {
  const token = readCiKey(req);
  if (token === undefined) return null;
  return verifyCiKey(db, token);
}
