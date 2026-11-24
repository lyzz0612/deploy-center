/**
 * 凭据类型（代码侧注册表）。
 *
 * 字段集由**类型**决定，不由目标类型决定（design.md D5）。这样 `h5-r2` 和
 * 未来任何对象存储目标共用同一种 `s3Keys` 凭据，轮换只改一处。
 *
 * 这是 Jenkins 的做法：凭据有类型，使用方只声明「我要一个什么类型的凭据」。
 */
import type { Field } from './fields.js';

export type CredentialTypeId =
  | 'secretText'
  | 'usernamePassword'
  | 'sshKey'
  | 's3Keys'
  | 'file';

export interface CredentialType {
  readonly id: CredentialTypeId;
  readonly displayName: string;
  readonly description: string;
  /**
   * 密文字段。全部加密落库，任何读取接口只回「是否已设置」。
   *
   * 这些字段的 `identity` 永远不生效：凭据不参与目标去重。
   */
  readonly fields: readonly Field[];
}

const TYPES: readonly CredentialType[] = [
  {
    id: 'secretText',
    displayName: '密钥文本',
    description: '单个密钥、token 或 API key。',
    fields: [{ key: 'secret', label: '密钥', type: 'string', required: true }],
  },
  {
    id: 'usernamePassword',
    displayName: '用户名与密码',
    description: '需要账号密码登录的平台。',
    fields: [
      { key: 'username', label: '用户名', type: 'string', required: true },
      { key: 'password', label: '密码', type: 'string', required: true },
    ],
  },
  {
    id: 'sshKey',
    displayName: 'SSH 私钥',
    description: '通过 SSH 写入目标主机时使用。',
    fields: [
      { key: 'privateKey', label: '私钥', type: 'string', required: true },
      { key: 'passphrase', label: '私钥口令', type: 'string', required: false },
      { key: 'username', label: '登录用户名', type: 'string', required: false },
    ],
  },
  {
    id: 's3Keys',
    displayName: '对象存储密钥对',
    description: 'S3 兼容存储（R2、OSS、COS 等）的访问密钥。',
    fields: [
      { key: 'accessKeyId', label: 'Access Key ID', type: 'string', required: true },
      { key: 'secretAccessKey', label: 'Secret Access Key', type: 'string', required: true },
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'string',
        required: false,
        help: '非 AWS 的 S3 兼容服务需要填，例如 R2 的 account endpoint。',
      },
      { key: 'region', label: 'Region', type: 'string', required: false },
    ],
  },
  {
    id: 'file',
    displayName: '密钥文件',
    description: '需要以文件形式交给 CLI 的凭据，例如微信的代码上传私钥。',
    fields: [
      {
        key: 'content',
        label: '文件内容',
        type: 'string',
        required: true,
        help: '执行发布时由后台物化成临时文件，任务结束后删除。',
      },
    ],
  },
];

const BY_ID = new Map<string, CredentialType>(TYPES.map((t) => [t.id, t]));

export function listCredentialTypes(): readonly CredentialType[] {
  return TYPES;
}

export function findCredentialType(id: string): CredentialType | undefined {
  return BY_ID.get(id);
}

/** 按 id 取凭据类型，不存在时报错而不是返回 undefined 让调用方忘记处理。 */
export function getCredentialType(id: string): CredentialType {
  const type = BY_ID.get(id);
  if (type === undefined) {
    throw new Error(`未注册的凭据类型：${id}`);
  }
  return type;
}
