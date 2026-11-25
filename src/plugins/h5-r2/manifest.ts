/**
 * H5 对象存储（Cloudflare R2）发布目标的声明。
 *
 * 产物按版本写进 bucket，再覆盖一个 2KB 的指针对象切流。入口 index.html
 * 固定不变、可以长缓存，它只去读指针决定加载哪个版本，于是「必须最新」的
 * 面积被压缩到一个对象上。
 *
 * R2 讲 S3 协议，所以这个 kind 用的是通用的 `s3Keys` 凭据，换成 OSS/COS
 * 之类的 S3 兼容存储也只是换凭据里的 endpoint，不必再写一个 kind。
 */
import type { TargetKindManifest } from '../../registry/index.js';

export const H5_R2_KIND_ID = 'h5-r2';

export const h5R2Manifest: TargetKindManifest = {
  id: H5_R2_KIND_ID,
  displayName: 'H5 对象存储（R2）',
  description:
    '把产物按版本上传到 Cloudflare R2（或任何 S3 兼容存储），通过覆盖一个 2KB 的指针对象切流。',

  accepts: ['h5'],

  // 密钥全部在凭据里：同一种 s3Keys 可以被多个实例共用，轮换只改一处。
  // endpoint 与 region 也在凭据里——它们属于「这个账号怎么连」，
  // 而不是「这次发到哪」。
  requiresCredential: 's3Keys',
  requiresCli: [],

  targetFields: [
    {
      key: 'bucket',
      label: 'Bucket',
      type: 'string',
      required: true,
      identity: true,
      placeholder: 'minigames-h5',
      help: 'R2 里的存储桶名。桶要已创建，后台不会自动建桶。',
    },
    {
      key: 'prefix',
      label: '路径前缀',
      type: 'string',
      required: true,
      identity: true,
      placeholder: 'demo/',
      help: '同一个桶下用它区分不同游戏或环境，例如 demo/ 与 demo-staging/。',
    },
    {
      key: 'baseUrl',
      label: '对外地址',
      type: 'string',
      required: true,
      // 不参与去重：它是「怎么访问」，不是「发到哪」。两个实例指向同一
      // 桶与前缀却写不同的 baseUrl，仍然是互相覆盖的重复实例。
      placeholder: 'https://h5.example.com/demo/',
      help: '绑定在这个前缀上的公开域名（R2 自定义域或 Workers 路由），用于发布后回读指针做验证。',
    },
    {
      key: 'keepVersions',
      label: '保留版本数',
      type: 'number',
      required: false,
      help: '超出的旧版本会被删除。缺省 5。回滚只能回到仍保留的版本。',
    },
  ],

  publishFields: [
    {
      key: 'activate',
      label: '立即切为线上版本',
      type: 'boolean',
      required: false,
      help: '不勾选时只上传版本目录，之后可以在发布记录里再切。缺省勾选。',
    },
  ],

  stages: [
    { id: 'upload', name: '上传版本目录', timeoutMs: 15 * 60 * 1000 },
    { id: 'activate', name: '切换生效指针', timeoutMs: 60 * 1000 },
  ],

  capabilities: {
    // H5 的回滚只改指针，不重新上传产物——这是「多版本并存」的回报。
    rollback: 'pointer',
    verify: true,
    // 指针对象是 no-store 上传的，R2 自身强一致；但自定义域前面通常还有
    // 一层 Cloudflare 缓存，所以不写 0。
    activateLatencySeconds: 30,
  },
};
