/**
 * 可逆加密（design.md D5）。
 *
 * 与 hash.ts 的分工：那边处理「只需验证、不需取回」的东西（管理员口令），
 * 用单向哈希；这边处理必须取回原文的数据：交给平台 CLI 的凭据，以及
 * 设置页要随时展示的 CI key 原文。两者用不同的 HKDF info 派生密钥，
 * 密文互不相通。
 *
 * 三个选择的理由：
 *
 * - **AES-256-GCM 而不是 CBC**：GCM 带认证标签，密文被改动会在解密时报错。
 *   没有认证的话，攻击者改掉密文里的几个字节，我们会把一段垃圾当成密钥
 *   交给 CLI，错误发生在远处。
 * - **从主密钥派生而不是直接用**：主密钥是人给的字符串，长度与熵都不定。
 *   用 HKDF 派生出定长的 32 字节密钥，顺带用 info 把用途绑进去。
 * - **每条记录独立随机 nonce**：GCM 的 nonce 复用会直接泄漏明文异或关系，
 *   这是它最锋利的那条红线。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** 载荷版本号，写在密文头部。将来换算法时用它区分旧数据。 */
const FORMAT_VERSION = 1;

/**
 * HKDF 的 info 参数，把派生密钥绑定到具体用途上。
 * 同一个主密钥给不同用途派生出互不相同的密钥——即使一处泄漏，
 * 也解不开另一类密文。
 */
const CREDENTIAL_HKDF_INFO = 'minigames-console/credential/v1';
const CI_KEY_HKDF_INFO = 'minigames-console/ci-key/v1';

/**
 * 从主密钥派生加密密钥。
 *
 * salt 用固定值而非随机：密文的 salt 得跟数据一起存，而我们已经为每条
 * 记录用了独立 nonce，随机 salt 不再提供额外保护，只会让每次解密都要
 * 多读一段。这里的作用是域分隔，固定值足够。
 */
function deriveKey(masterKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'minigames-console', info, KEY_BYTES));
}

/**
 * 加密一段文本。密文布局：`[1 字节版本][12 字节 nonce][密文][16 字节标签]`
 */
function seal(plaintext: string, masterKey: string, info: string): Buffer {
  const key = deriveKey(masterKey, info);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext, tag]);
}

/** 解密一段文本。任何异常都直接抛，不返回空值。 */
function unseal(payload: Buffer, masterKey: string, info: string, label: string): string {
  if (payload.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error(`${label}密文长度不足，数据已损坏`);
  }

  const version = payload[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`不支持的${label}密文版本 ${version}，本程序只认识 ${FORMAT_VERSION}`);
  }

  const nonce = payload.subarray(1, 1 + NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(1 + NONCE_BYTES, payload.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey, info), nonce);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM 的认证失败在这里统一变成一句人话。原始错误是
    // 「Unsupported state or unable to authenticate data」，看不出所以然。
    throw new Error(`${label}解密失败：主密钥不正确，或密文已被篡改`);
  }
}

/**
 * 加密一组凭据字段。
 *
 * 整组一起加密而不是逐字段：字段名本身（`accessKeyId` 还是 `privateKey`）
 * 也是信息，整体加密顺带把它藏起来，而且省掉逐字段的 nonce 管理。
 */
export function encryptSecrets(
  secrets: Record<string, string>,
  masterKey: string,
): Buffer {
  return seal(JSON.stringify(secrets), masterKey, CREDENTIAL_HKDF_INFO);
}

/**
 * 解密一组凭据字段。
 *
 * 任何异常都直接抛，不返回空对象：解密失败意味着主密钥不对或数据损坏，
 * 悄悄返回空值会让一次发布拿着空密钥打到平台上去，错误跑到远处才出现。
 */
export function decryptSecrets(payload: Buffer, masterKey: string): Record<string, string> {
  const plaintext = unseal(payload, masterKey, CREDENTIAL_HKDF_INFO, '凭据');

  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('凭据明文不是对象，数据已损坏');
  }

  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`凭据字段 ${field} 不是字符串，数据已损坏`);
    }
    result[field] = value;
  }
  return result;
}

/**
 * 加密 CI key 原文。
 *
 * CI key 本来只需哈希校验，但自用后台要求「随时能看到、随时能改」，
 * 于是额外存一份可逆密文供设置页读取。校验仍然走哈希，不依赖解密。
 */
export function encryptCiKeyValue(value: string, masterKey: string): Buffer {
  return seal(value, masterKey, CI_KEY_HKDF_INFO);
}

/** 解密 CI key 原文。 */
export function decryptCiKeyValue(payload: Buffer, masterKey: string): string {
  return unseal(payload, masterKey, CI_KEY_HKDF_INFO, 'CI key ');
}
