/**
 * 微信小游戏目标类型的声明。
 */
import type { TargetKindManifest } from '../../registry/index.js';

export const WECHAT_KIND_ID = 'wechat';

/** 微信要求版本号形如 1.0.0。 */
const VERSION_PATTERN = '^\\d+\\.\\d+\\.\\d+$';

export const wechatManifest: TargetKindManifest = {
  id: WECHAT_KIND_ID,
  displayName: '微信小游戏',
  description: '通过 miniprogram-ci 上传代码包到微信公众平台。',

  accepts: ['wechat'],

  // 微信的代码上传密钥是一个文件，由核心物化后交给 CLI（design.md D4 规则 1）。
  requiresCredential: 'file',
  requiresCli: ['miniprogram-ci'],

  targetFields: [
    {
      key: 'appid',
      label: 'AppID',
      type: 'string',
      required: true,
      identity: true,
      pattern: '^wx[0-9a-f]{16}$',
      help: '小游戏的 AppID，形如 wx 开头加 16 位十六进制。',
    },
    {
      key: 'note',
      label: '备注',
      type: 'string',
      required: false,
      help: '只用于在列表里区分，不参与去重。',
    },
  ],

  publishFields: [
    {
      key: 'version',
      label: '版本号',
      type: 'string',
      required: true,
      pattern: VERSION_PATTERN,
      placeholder: '1.0.0',
      // 微信的版本号由运营决定，不是构建号：平台上的版本号是给审核与
      // 用户看的，和 CI 的构建标识是两套东西。
      help: '平台上显示的版本号，由你决定，与构建号无关。',
    },
    {
      key: 'desc',
      label: '版本描述',
      type: 'string',
      required: true,
      help: '这个版本改了什么，会显示在平台的版本列表里。',
    },
    {
      key: 'robot',
      label: 'CI 机器人编号',
      type: 'number',
      required: false,
      help: '1-30，用于在平台上区分来源。缺省 1。',
    },
  ],

  // 第一版只做上传。提审需要开放平台第三方授权，是另一个量级的工作
  // （见 design.md 的 Open Questions）。stages 是数组，加一步不改核心。
  stages: [{ id: 'upload', name: '上传代码包', timeoutMs: 20 * 60 * 1000 }],

  capabilities: {
    // 平台侧没有「回滚」动作，只能把旧版本重新上传一次。
    rollback: 'republish',
    verify: true,
    // 上传完成即在平台可见，不涉及 CDN 传播。
    activateLatencySeconds: 0,
  },
};
