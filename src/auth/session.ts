/**
 * 管理员会话。
 *
 * 单人使用、单进程，会话放内存即可：重启后需要重新登录，这个代价
 * 远小于为它建一张表。会话 token 本身是 256 位随机值。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionStore {
  create(): string;
  verify(token: string | undefined): boolean;
  destroy(token: string): void;
  readonly size: number;
}

export function createSessionStore(ttlMs: number = DEFAULT_TTL_MS): SessionStore {
  /** token -> 过期时刻（epoch ms） */
  const sessions = new Map<string, number>();

  function sweep(nowMs: number): void {
    for (const [token, expiry] of sessions) {
      if (expiry <= nowMs) sessions.delete(token);
    }
  }

  return {
    create(): string {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + ttlMs);
      return token;
    },

    verify(token: string | undefined): boolean {
      if (token === undefined || token.length === 0) return false;
      const nowMs = Date.now();
      sweep(nowMs);

      // 逐条定时安全比较，避免用 Map.get 时的提前返回泄漏信息。
      const candidate = Buffer.from(token);
      for (const [known, expiry] of sessions) {
        const knownBuf = Buffer.from(known);
        if (knownBuf.length !== candidate.length) continue;
        if (timingSafeEqual(knownBuf, candidate) && expiry > nowMs) {
          return true;
        }
      }
      return false;
    },

    destroy(token: string): void {
      sessions.delete(token);
    },

    get size(): number {
      sweep(Date.now());
      return sessions.size;
    },
  };
}
