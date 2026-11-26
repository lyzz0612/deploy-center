/**
 * 环境检测的编排（publish-targets spec：环境检测分两级）。
 *
 * 类型级（CLI 装没装）同类型实例共享一次结果，不逐实例重复跑——三个微信号
 * 不该在设置页显示三份重复的 CLI 状态，而且三份可能因探测时机不同而不一致。
 *
 * 实例级（凭据对不对、平台通不通）每个实例各跑一次。
 */
import { readSecrets } from '../credentials/index.js';
import type { Db } from '../db/index.js';
import { getTargetKind, type CheckLevel, type CheckResult, type PublishContext } from '../registry/index.js';
import { getTarget, type Target } from '../targets/index.js';
import { probeCli, type CliProbeResult } from './probe.js';

export interface LeveledCheck {
  readonly id: string;
  readonly name: string;
  readonly level: CheckLevel;
  readonly result: CheckResult;
}

/** 某个目标类型的类型级状态。 */
export interface KindStatus {
  readonly kindId: string;
  readonly displayName: string;
  /** 所需 CLI 的探测结果。 */
  readonly clis: readonly CliProbeResult[];
  /** 插件自己声明的类型级检查。 */
  readonly checks: readonly LeveledCheck[];
  /** 全部类型级检查是否通过。不通过时该类型的所有实例都无法发布。 */
  readonly ok: boolean;
}

/** 某个目标实例的实例级状态。 */
export interface TargetStatus {
  readonly targetId: string;
  readonly name: string;
  readonly checks: readonly LeveledCheck[];
  readonly ok: boolean;
}

/**
 * 类型级检查：CLI 可用性 + 插件声明的 global checks。
 *
 * 结果可以缓存（同类型实例共享），缓存由调用方决定，这里只负责算一次。
 */
export async function checkKind(cliHome: string, kindId: string): Promise<KindStatus> {
  const kind = getTargetKind(kindId);

  const clis: CliProbeResult[] = [];
  for (const cliId of kind.manifest.requiresCli) {
    clis.push(await probeCli(cliHome, cliId));
  }

  const checks: LeveledCheck[] = [];
  for (const check of kind.globalChecks) {
    try {
      checks.push({
        id: check.id,
        name: check.name,
        level: check.level,
        result: await check.run({ cliHome }),
      });
    } catch (error) {
      checks.push({
        id: check.id,
        name: check.name,
        level: check.level,
        result: {
          ok: false,
          message: `检查本身出错：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  const ok = clis.every((c) => c.install.ok) && checks.every((c) => c.result.ok);
  return { kindId, displayName: kind.manifest.displayName, clis, checks, ok };
}

export interface CheckTargetDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
}

/**
 * 实例级检查：凭据可用 + 平台可达。
 *
 * 构造一个「只够做检查」的 ctx：没有产物目录（检查不需要），但有凭据与
 * 目标配置。插件的 targetChecks 通过它调平台只读 API。
 */
export async function checkTarget(deps: CheckTargetDeps, targetId: string): Promise<TargetStatus> {
  const target: Target = getTarget(deps.db, targetId);
  const kind = getTargetKind(target.kind);

  const secrets =
    target.credentialId === null ? {} : readSecrets(deps.db, target.credentialId, deps.masterKey);

  const controller = new AbortController();
  const ctx: PublishContext = {
    artifactDir: '',
    workdir: '',
    // 检查阶段不针对某次构建，给一个明确的占位而不是假数据
    build: {
      buildId: '',
      commitSha: null,
      packageTypeId: '',
      sha256: '',
      sizeBytes: 0,
    },
    target: target.location,
    params: {},
    cliHome: deps.cliHome,
    secret(field) {
      const value = secrets[field];
      if (value === undefined) {
        throw new Error(`凭据里没有字段 ${field}`);
      }
      return value;
    },
    async secretFile() {
      // 检查阶段不物化凭据文件：那需要一个工作目录与清理时机，而检查
      // 是只读的、随时可能被并发调用。需要文件的检查应改用 secret()。
      throw new Error('环境检查阶段不支持 secretFile，请改用 secret() 直接取值');
    },
    log: () => {},
    progress: () => {},
    signal: controller.signal,
  };

  const checks: LeveledCheck[] = [];
  for (const check of kind.targetChecks) {
    try {
      checks.push({
        id: check.id,
        name: check.name,
        level: check.level,
        result: await check.run(ctx),
      });
    } catch (error) {
      checks.push({
        id: check.id,
        name: check.name,
        level: check.level,
        result: {
          ok: false,
          message: `检查本身出错：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  return {
    targetId,
    name: target.name,
    checks,
    ok: checks.every((c) => c.result.ok),
  };
}

export interface PreflightResult {
  readonly ok: boolean;
  /** 未通过的项，供界面显示「为什么不能发布」。 */
  readonly blockers: readonly string[];
}

/**
 * 发布前检查（release-execution spec：任一检查未通过 MUST 阻止发起）。
 *
 * 在发布弹窗打开时跑，而不是点了发布之后等 30 秒才看到一个莫名其妙的失败。
 */
export async function preflight(deps: CheckTargetDeps, targetId: string): Promise<PreflightResult> {
  const target = getTarget(deps.db, targetId);
  const blockers: string[] = [];

  const kindStatus = await checkKind(deps.cliHome, target.kind);
  for (const cli of kindStatus.clis) {
    if (!cli.install.ok) blockers.push(cli.install.message);
  }
  for (const check of kindStatus.checks) {
    if (!check.result.ok) blockers.push(`${check.name}：${check.result.message}`);
  }

  const targetStatus = await checkTarget(deps, targetId);
  for (const check of targetStatus.checks) {
    if (!check.result.ok) blockers.push(`${check.name}：${check.result.message}`);
  }

  return { ok: blockers.length === 0, blockers };
}
