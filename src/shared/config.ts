import { join } from 'node:path';
import { env } from 'node:process';

/** 运行期配置。缺省值对应容器内的挂载点（见 Dockerfile）。 */
export interface RuntimeConfig {
  /** 数据目录，SQLite 文件所在位置 */
  readonly dataDir: string;
  /** CLI 安装根目录，必须是持久卷 */
  readonly cliHome: string;
  /** HTTP 监听端口 */
  readonly port: number;
  /** 凭据加密主密钥 */
  readonly masterKey: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，实际为 ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** 主密钥最短长度。低于此长度的密钥不足以保护凭据。 */
const MIN_MASTER_KEY_LENGTH = 16;

/**
 * 读取配置。
 *
 * MASTER_KEY 缺失时直接报错而不是生成一个临时密钥：那会让已有凭据在下次
 * 重启后全部解不开，且失败发生在用户真正要发布的时候（design.md D5）。
 */
export function loadConfig(): RuntimeConfig {
  const masterKey = env.MASTER_KEY;
  if (masterKey === undefined || masterKey.length === 0) {
    throw new Error('缺少环境变量 MASTER_KEY：凭据加密主密钥必须由部署方提供');
  }
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `MASTER_KEY 至少需要 ${MIN_MASTER_KEY_LENGTH} 个字符，当前为 ${masterKey.length} 个`,
    );
  }

  const dataDir = env.DATA_DIR ?? './data';

  return {
    dataDir,
    // 缺省落在 dataDir 下而不是硬编码 './data/cli'：本地只设 DATA_DIR 时，
    // 否则数据会分散在两个互不相关的目录里。容器里两者都由环境变量给定。
    cliHome: env.CLI_HOME ?? join(dataDir, 'cli'),
    port: intFromEnv('PORT', 3000),
    masterKey,
  };
}
