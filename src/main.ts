/**
 * 进程入口：HTTP 服务与任务循环同处一个进程（design.md D1）。
 */
import process from 'node:process';

import { createSessionStore } from './auth/session.js';
import { seedPackageTypes } from './catalog/index.js';
import { installCli } from './cli/index.js';
import { databaseFile, ensureSchema, open, type Db } from './db/index.js';
import { startRunner, type JobHandler, type JobKind } from './jobs/index.js';
import { registerAllPlugins } from './plugins/index.js';
import { runSelfCheck } from './registry/index.js';
import { executeRelease, recoverRelease } from './releases/index.js';
import { loadConfig, type RuntimeConfig } from './shared/config.js';
import { isEntrypoint } from './shared/entrypoint.js';
import { startWeb } from './web/server.js';

function listPackageTypeIds(db: Db): string[] {
  return db
    .prepare<[], { id: string }>('SELECT id FROM package_types WHERE archived_at IS NULL')
    .all()
    .map((r) => r.id);
}

function buildHandlers(db: Db, config: RuntimeConfig): Partial<Record<JobKind, JobHandler>> {
  return {
    publish: (job) =>
      executeRelease(
        { db, masterKey: config.masterKey, cliHome: config.cliHome },
        job,
      ),

    cli_install: async (job) => {
      await installCli({
        cliHome: config.cliHome,
        cliId: job.job.refId,
        signal: job.signal,
        log: (line) => job.log(line),
      });
    },
  };
}

export function main(): void {
  const config = loadConfig();

  const db = open({ file: databaseFile(config.dataDir) });
  const schema = ensureSchema(db);
  console.log(
    schema.created
      ? `database created at schema version ${schema.version}`
      : `database ready at schema version ${schema.version}`,
  );

  registerAllPlugins();

  // 补齐插件声明的包类型。必须在自检之前：自检会校验 accepts 指向的包类型
  // 存在，而一个全新部署的库里什么都没有。
  const seeded = seedPackageTypes(db);
  if (seeded.created.length > 0) {
    console.log(`已登记包类型：${seeded.created.join(', ')}`);
  }

  // 注册表问题是配置错误，runSelfCheck 会抛出；存量数据问题只警告。
  const { warnings } = runSelfCheck(db, { knownPackageTypes: listPackageTypeIds(db) });
  for (const warning of warnings) {
    console.warn(`[warn] [${warning.where}] ${warning.message}`);
  }

  const runner = startRunner({
    db,
    handlers: buildHandlers(db, config),
    // 任务被中断时，它关联的发布记录也停在 running，必须一并收拾：
    // 否则界面上那条发布会永远显示「执行中」，连重试入口都不出现。
    onRecovered: (jobs) => {
      for (const job of jobs) {
        if (job.kind !== 'publish') continue;
        const recovered = recoverRelease(db, job.refId);
        if (recovered !== null) {
          console.warn(
            `[warn] 发布 ${recovered.releaseId} 因进程中断标记为失败` +
              `${recovered.interruptedStage === null ? '' : `（中断于 ${recovered.interruptedStage} 阶段）`}`,
          );
        }
      }
    },
  });

  const sessions = createSessionStore();
  const server = startWeb({ config, db, sessions });
  console.log('job runner started');

  // 刻意不在启动时自动装 CLI：两个平台 CLI 加起来 283 MB，而一个只发 H5
  // 的部署根本用不到它们。装不装由用户在设置页决定（装 → 验 → 用都在
  // 后台可见）。

  const shutdown = (): void => {
    runner.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, shutdown);
  }
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // 配置错误要以非零码退出，而不是让一个半死的进程继续服务。
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
