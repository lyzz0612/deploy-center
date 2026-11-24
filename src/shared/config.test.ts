import assert from 'node:assert/strict';
import { env } from 'node:process';
import { afterEach, describe, it } from 'node:test';

import { loadConfig } from './config.js';

const saved = { ...env };

afterEach(() => {
  for (const key of ['MASTER_KEY', 'DATA_DIR', 'CLI_HOME', 'PORT']) {
    delete env[key];
    if (saved[key] !== undefined) env[key] = saved[key];
  }
});

describe('loadConfig', () => {
  it('缺少 MASTER_KEY 时拒绝启动', () => {
    delete env.MASTER_KEY;
    assert.throws(() => loadConfig(), /缺少环境变量 MASTER_KEY/);
  });

  it('MASTER_KEY 过短时拒绝启动', () => {
    env.MASTER_KEY = 'tooshort';
    assert.throws(() => loadConfig(), /至少需要 16 个字符/);
  });

  it('cliHome 缺省落在 dataDir 下', () => {
    env.MASTER_KEY = 'a-sufficiently-long-master-key';
    env.DATA_DIR = '/srv/console';
    delete env.CLI_HOME;
    const config = loadConfig();
    assert.equal(config.dataDir, '/srv/console');
    assert.ok(
      config.cliHome.replaceAll('\\', '/').endsWith('/srv/console/cli'),
      `cliHome 应在 dataDir 下，实际为 ${config.cliHome}`,
    );
  });

  it('CLI_HOME 显式给定时优先', () => {
    env.MASTER_KEY = 'a-sufficiently-long-master-key';
    env.DATA_DIR = '/srv/console';
    env.CLI_HOME = '/opt/cli';
    assert.equal(loadConfig().cliHome, '/opt/cli');
  });

  it('PORT 不是正整数时报错', () => {
    env.MASTER_KEY = 'a-sufficiently-long-master-key';
    env.PORT = 'not-a-number';
    assert.throws(() => loadConfig(), /必须是正整数/);
  });
});
