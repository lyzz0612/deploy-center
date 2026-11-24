import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decryptSecrets, encryptSecrets } from './crypto.js';

const KEY = 'a-master-key-of-sufficient-length';

describe('凭据加密', () => {
  it('加密后能原样解回', () => {
    const secrets = { accessKeyId: 'AKIA123', secretAccessKey: 'very-secret' };
    const payload = encryptSecrets(secrets, KEY);
    assert.deepEqual(decryptSecrets(payload, KEY), secrets);
  });

  it('密文里不含任何明文片段', () => {
    const secrets = { privateKey: 'UNIQUE-PLAINTEXT-MARKER', username: 'alice' };
    const payload = encryptSecrets(secrets, KEY);
    const asText = payload.toString('utf8');
    const asBase64 = payload.toString('base64');
    for (const value of Object.values(secrets)) {
      assert.equal(asText.includes(value), false, `密文含明文 ${value}`);
      assert.equal(asBase64.includes(value), false);
    }
    // 字段名也不该出现：整组加密顺带把它藏起来
    assert.equal(asText.includes('privateKey'), false);
  });

  it('同一内容两次加密产生不同密文（nonce 不复用）', () => {
    const secrets = { secret: 'same-value' };
    const a = encryptSecrets(secrets, KEY);
    const b = encryptSecrets(secrets, KEY);
    assert.notEqual(a.toString('base64'), b.toString('base64'));
    // 但都能解回同一内容
    assert.deepEqual(decryptSecrets(a, KEY), secrets);
    assert.deepEqual(decryptSecrets(b, KEY), secrets);
  });

  it('错误的主密钥解不开，且报错说得清是什么问题', () => {
    const payload = encryptSecrets({ secret: 'x' }, KEY);
    assert.throws(
      () => decryptSecrets(payload, 'a-different-master-key-here'),
      /主密钥不正确，或密文已被篡改/,
    );
  });

  it('密文被改动一个字节就解不开（AEAD 认证生效）', () => {
    const payload = encryptSecrets({ secret: 'x' }, KEY);
    const tampered = Buffer.from(payload);
    // 改密文正文中间的一个字节
    const pos = Math.floor(tampered.length / 2);
    tampered[pos] = tampered[pos]! ^ 0xff;
    assert.throws(() => decryptSecrets(tampered, KEY), /篡改/);
  });

  it('认证标签被改动也解不开', () => {
    const payload = encryptSecrets({ secret: 'x' }, KEY);
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    assert.throws(() => decryptSecrets(tampered, KEY), /篡改/);
  });

  it('长度不足的数据直接报错而不是返回空对象', () => {
    assert.throws(() => decryptSecrets(Buffer.from([1, 2, 3]), KEY), /长度不足/);
  });

  it('不认识的版本号直接报错', () => {
    const payload = encryptSecrets({ secret: 'x' }, KEY);
    const future = Buffer.from(payload);
    future[0] = 99;
    assert.throws(() => decryptSecrets(future, KEY), /不支持的凭据密文版本 99/);
  });

  it('空字段集也能往返', () => {
    const payload = encryptSecrets({}, KEY);
    assert.deepEqual(decryptSecrets(payload, KEY), {});
  });

  it('多字节字符正确往返', () => {
    const secrets = { note: '中文密钥 🔑 with emoji' };
    assert.deepEqual(decryptSecrets(encryptSecrets(secrets, KEY), KEY), secrets);
  });
});
