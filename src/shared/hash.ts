/**
 * 单向哈希与定时安全比较。
 *
 * 这里处理的是**校验路径**：管理员口令只存哈希；CI key 的校验也走哈希
 * （另外在 crypto.ts 里存一份可逆密文供设置页展示）。凭据则必须可逆解密，
 * 交给平台 CLI 使用。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt 参数。N=2^15 实测约 44ms，适合登录这种低频操作。 */
const SCRYPT_N = 32_768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * scrypt 的内存上限。
 *
 * 必须显式给：Node 的默认 maxmem 是 32 MB，而 N=32768、r=8 的内存需求
 * 正好是 128·N·r = 32 MB，加上内部开销就会超限，抛
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS。不显式传的话，第一次设置口令就会失败。
 * 留 2 倍余量，既覆盖开销，也让以后调 N/r 不必再改这里。
 */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2;
}

/**
 * 为人类口令生成可存储的哈希（格式 `scrypt$N$r$p$salt$hash`，均为 hex）。
 *
 * 人类口令熵低，必须用慢哈希加盐，否则泄库后可被字典攻击。
 */
export function hashPassword(password: string): string {
  if (password.length === 0) {
    throw new Error('口令不能为空');
  }
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_r),
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/**
 * 校验口令。哈希串格式不认识时直接报错而不是返回 false——那是数据损坏，
 * 不是「口令不对」，混在一起会让排查无从下手。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error(`无法识别的口令哈希格式：${JSON.stringify(stored.slice(0, 16))}…`);
  }
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new Error('口令哈希的 scrypt 参数不是整数');
  }

  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
  return timingSafeEqual(expected, actual);
}

/**
 * 生成一个高熵 CI key。前缀便于在界面上辨认是哪一条，不含秘密。
 */
export function generateCiKey(): { key: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const prefix = secret.slice(0, 8);
  return { key: `mgc_${secret}`, prefix };
}

/**
 * 为 CI key 生成存储用哈希。
 *
 * 这里用 SHA-256 而不是 scrypt：CI key 是 256 位随机值，不存在字典攻击面，
 * 而它会出现在每次上报请求里——用慢哈希等于给自己的接口加一道无谓延迟。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 定时安全地比较两个 hex 哈希串。 */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
