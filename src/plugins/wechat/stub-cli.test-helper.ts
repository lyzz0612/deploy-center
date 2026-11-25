/**
 * 在 CLI 卷里装一个假的 miniprogram-ci。
 *
 * 为什么需要：微信插件的完整路径（加载 CLI → 建 Project → upload → verify）
 * 只能靠真实账号跑通，而那不在本机可验范围内。装一个行为可控的 stub，
 * 能验证**插件与核心的集成**：阶段编排、输出写入记录、凭据物化与清理、
 * 错误分类是否生效。
 *
 * 它不验证微信平台本身的行为，也不能替代一次真实上传。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { recordInstall, versionPrefix } from '../../cli/index.js';

export interface StubBehavior {
  /** upload 抛出的错误消息。不给则成功。 */
  readonly uploadError?: string;
  /** getLatestVersion 抛出的错误消息。 */
  readonly latestVersionError?: string;
  /** upload 返回的代码包总大小。 */
  readonly totalSize?: number;
  /** getLatestVersion 返回的线上版本号。 */
  readonly latestVersion?: string;
}

/**
 * 在给定的 CLI 卷里装一个 stub，并登记进 registry.json。
 *
 * stub 把每次调用的参数写进 `<cliHome>/calls.json`，测试据此断言插件
 * 真的传了正确的 appid、version、私钥路径。
 */
export async function installStubCli(
  cliHome: string,
  behavior: StubBehavior = {},
): Promise<{ callsFile: string }> {
  const version = '0.0.0-stub';
  const prefix = versionPrefix(cliHome, 'miniprogram-ci', version);
  const pkgDir = join(prefix, 'node_modules', 'miniprogram-ci');
  const binDir = join(pkgDir, 'bin');
  await mkdir(binDir, { recursive: true });

  const callsFile = join(cliHome, 'calls.json');

  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'miniprogram-ci', version, main: 'index.js' }),
    'utf8',
  );

  // CJS 模块，因为真包也是 CJS（插件用 default ?? module 兼容两种）
  await writeFile(
    join(pkgDir, 'index.js'),
    `const fs = require('node:fs');
const callsFile = ${JSON.stringify(callsFile)};
const behavior = ${JSON.stringify(behavior)};

function record(entry) {
  let calls = [];
  try { calls = JSON.parse(fs.readFileSync(callsFile, 'utf8')); } catch {}
  calls.push(entry);
  fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2));
}

class Project {
  constructor(options) {
    this.options = options;
    record({ call: 'Project', options: {
      type: options.type,
      appid: options.appid,
      projectPath: options.projectPath,
      privateKeyPath: options.privateKeyPath,
      privateKeyExists: fs.existsSync(options.privateKeyPath),
      privateKeyContent: fs.existsSync(options.privateKeyPath)
        ? fs.readFileSync(options.privateKeyPath, 'utf8')
        : null,
    } });
  }
}

async function upload(options) {
  record({ call: 'upload', version: options.version, desc: options.desc, robot: options.robot, setting: options.setting });
  if (options.onProgressUpdate) options.onProgressUpdate('stub 上传进度 50%');
  if (behavior.uploadError) throw new Error(behavior.uploadError);
  return { subPackageInfo: [{ name: '__FULL__', size: behavior.totalSize ?? 123456 }] };
}

async function getLatestVersion() {
  record({ call: 'getLatestVersion' });
  if (behavior.latestVersionError) throw new Error(behavior.latestVersionError);
  return { latestVersion: behavior.latestVersion ?? '0.9.0' };
}

module.exports = { Project, upload, getLatestVersion };
`,
    'utf8',
  );

  // 探测用的入口，让 probeCli 也能跑
  await writeFile(join(binDir, 'miniprogram-ci.js'), `console.log(${JSON.stringify(version)});\n`, 'utf8');

  await recordInstall(cliHome, 'miniprogram-ci', version, 'test-stub');
  return { callsFile };
}
