/**
 * CLI 三层可用性探测（cli-management spec）。
 *
 *   L1 install       能不能跑起来、版本是多少
 *   L2 credential    凭据格式对不对
 *   L3 reachability  平台能不能通
 *
 * 三层独立报告，而不是一个绿点：失败在哪一层决定了下一步做什么完全不同。
 * L3 是唯一能暴露「密钥有效但出口 IP 未在白名单」的一层——那个问题只在
 * 真正调用平台时才出现，装得再好也看不出来。
 */
import { findCliSpec, listCliSpecs, type CheckResult } from '../registry/index.js';
import { binaryPath, currentPrefix, run } from './install.js';
import { readRegistry } from './registry-file.js';

export interface CliProbeResult {
  readonly cliId: string;
  readonly displayName: string;
  /** 'npm' 可自动安装，'manual' 只能人工装。 */
  readonly installKind: string;
  readonly installed: boolean;
  readonly version: string | null;
  /** 已安装的全部版本，供回退选择。 */
  readonly availableVersions: readonly string[];
  readonly install: CheckResult;
  /** 人工安装类型的指引。 */
  readonly manualInstructions?: string;
}

const PROBE_TIMEOUT_MS = 30_000;

/**
 * L1：探测 CLI 是否安装完好。
 *
 * 判据是「能跑起来且退出码为 0」，而不是「目录存在」：装到一半、依赖缺失
 * 的目录同样存在，但一跑就炸。
 */
export async function probeCli(cliHome: string, cliId: string): Promise<CliProbeResult> {
  const spec = findCliSpec(cliId);
  if (spec === undefined) {
    return {
      cliId,
      displayName: cliId,
      installKind: 'unknown',
      installed: false,
      version: null,
      availableVersions: [],
      install: { ok: false, message: `未注册的 CLI：${cliId}` },
    };
  }

  const registry = await readRegistry(cliHome);
  const entry = registry.clis[cliId];
  const availableVersions = entry?.versions.map((v) => v.version) ?? [];

  const base = {
    cliId,
    displayName: spec.displayName,
    installKind: spec.kind,
    availableVersions,
    ...(spec.manualInstructions !== undefined && { manualInstructions: spec.manualInstructions }),
  };

  const current = await currentPrefix(cliHome, cliId);
  if (current === undefined) {
    return {
      ...base,
      installed: false,
      version: null,
      install: {
        ok: false,
        message:
          spec.kind === 'manual'
            ? `${spec.displayName} 需要人工安装`
            : `${spec.displayName} 尚未安装`,
      },
    };
  }

  const bin = binaryPath(current.prefix, spec);
  if (bin === undefined) {
    return {
      ...base,
      installed: true,
      version: current.version,
      install: { ok: true, message: `已记录版本 ${current.version}（该 CLI 未声明探测命令）` },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await run('node', [bin, ...(spec.probeArgs ?? ['--version'])], {
      signal: controller.signal,
    });

    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      // 容器里最容易撞上的两类问题，直接点名而不是让人去猜
      const hint = /DISPLAY|GTK|libgtk|xvfb/i.test(stderr)
        ? '它似乎需要桌面环境，不能在无头容器里运行'
        : /GLIBC|musl|cannot open shared object/i.test(stderr)
          ? '它依赖的系统库缺失，可能是镜像基底不对（不要用 alpine）'
          : '';
      return {
        ...base,
        installed: true,
        version: current.version,
        install: {
          ok: false,
          message: `${spec.displayName} ${current.version} 无法运行（退出码 ${String(result.code)}）${hint === '' ? '' : `：${hint}`}`,
          detail: stderr || result.stdout.trim(),
        },
      };
    }

    const reported = `${result.stdout}${result.stderr}`.trim().split('\n')[0] ?? '';
    return {
      ...base,
      installed: true,
      version: current.version,
      install: {
        ok: true,
        message: `${spec.displayName} ${current.version} 可用`,
        ...(reported !== '' && { detail: reported }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      installed: true,
      version: current.version,
      install: {
        ok: false,
        message: controller.signal.aborted
          ? `探测超时（${PROBE_TIMEOUT_MS} 毫秒），CLI 可能卡在等待输入`
          : `探测失败：${message}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 探测全部已注册的 CLI。 */
export async function probeAllClis(cliHome: string): Promise<CliProbeResult[]> {
  const results: CliProbeResult[] = [];
  for (const spec of listCliSpecs()) {
    results.push(await probeCli(cliHome, spec.id));
  }
  return results;
}
