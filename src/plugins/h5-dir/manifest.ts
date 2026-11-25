/**
 * H5 静态目录发布目标的声明。
 *
 * 这个 kind 把产物写进本机（容器内）的一个目录，由外部的 nginx / Caddy /
 * 任何静态服务器对外提供。它是 H5 目标里最简单的一种，也是实现其他 H5
 * 目标（对象存储、SSH、WebDAV）的参照：
 *
 *   差异只在「怎么把字节放上去」，而指针机制、版本目录布局、回滚语义
 *   三者完全一致。
 */
import type { TargetKindManifest } from '../../registry/index.js';

export const H5_DIR_KIND_ID = 'h5-dir';

export const h5DirManifest: TargetKindManifest = {
  id: H5_DIR_KIND_ID,
  displayName: 'H5 静态目录',
  description:
    '把产物写进一个本地目录（通常挂载给 nginx 之类的静态服务器），通过覆盖一个 2KB 的指针文件切流。',

  accepts: ['h5'],

  // 写本地目录不需要凭据。对象存储型需要 s3Keys，SSH 型需要 sshKey——
  // 那是各自 kind 的事，不是这个 kind 的。
  requiresCredential: null,
  requiresCli: [],

  targetFields: [
    {
      key: 'rootDir',
      label: '站点根目录',
      type: 'string',
      required: true,
      identity: true,
      placeholder: '/srv/h5',
      help: '容器内的绝对路径，通常是一个挂载卷。',
    },
    {
      key: 'prefix',
      label: '路径前缀',
      type: 'string',
      required: true,
      identity: true,
      placeholder: 'demo/',
      help: '同一个根目录下用它区分不同游戏或环境，例如 demo/ 与 demo-staging/。',
    },
    {
      key: 'baseUrl',
      label: '对外地址',
      type: 'string',
      required: true,
      // 不参与去重：它是「怎么访问」，不是「发到哪」。两个实例指向同一
      // 目录却写不同的 baseUrl，仍然是互相覆盖的重复实例。
      placeholder: 'https://h5.example.com/demo/',
      help: '用于发布后回读指针做验证。必须是这个前缀对外的 http(s) 地址。',
    },
    {
      key: 'keepVersions',
      label: '保留版本数',
      type: 'number',
      required: false,
      help: '超出的旧版本目录会被清理。缺省 5。回滚只能回到仍保留的版本。',
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
    { id: 'upload', name: '写入版本目录', timeoutMs: 10 * 60 * 1000 },
    { id: 'activate', name: '切换生效指针', timeoutMs: 60 * 1000 },
  ],

  capabilities: {
    // H5 的回滚只改指针，不重新写产物——这是「多版本并行在线」的回报。
    rollback: 'pointer',
    verify: true,
    // 写本地目录没有传播延迟。对象存储 + CDN 的 kind 要如实写大。
    activateLatencySeconds: 0,
  },
};
