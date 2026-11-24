/**
 * CI 上报的载荷解析与前置校验。
 *
 * 上报只存事实，不下结论（design.md D8）：后台不判断产物「好不好」，
 * 只记录它存在、多大、摘要是什么、来自哪个 commit。产物可用性在**发布时**
 * 才验证，因为链接可能在上报之后失效。
 */
import { requireActiveGame, requireActivePackageType, type Game, type PackageType } from '../catalog/index.js';
import type { Db } from '../db/index.js';

/** sha256 的十六进制形式。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface BuildReport {
  readonly game: string;
  readonly packageType: string;
  readonly buildId: string;
  readonly artifactUrl: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly commitSha?: string;
  readonly description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`字段 ${field} 必须是字符串`);
  }
  return value;
}

/**
 * 解析上报载荷。
 *
 * sha256 与 size 是必填：没有它们，就没有任何手段证明「后台发出去的那个包
 * 正是 CI 构建出来的那个包」（build-ingestion spec）。
 */
export function parseBuildReport(body: unknown): BuildReport {
  if (!isRecord(body)) {
    throw new Error('请求体必须是 JSON 对象');
  }

  const artifactUrl = requireString(body, 'artifactUrl');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(artifactUrl);
  } catch {
    throw new Error('artifactUrl 不是合法的 URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('artifactUrl 必须是 http 或 https');
  }

  const sizeRaw = body['sizeBytes'];
  if (typeof sizeRaw !== 'number' || !Number.isInteger(sizeRaw) || sizeRaw <= 0) {
    throw new Error('字段 sizeBytes 必须是正整数');
  }

  const sha256 = requireString(body, 'sha256');
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('字段 sha256 必须是 64 位十六进制字符串');
  }

  const commitSha = optionalString(body, 'commitSha');
  const description = optionalString(body, 'description');

  return {
    game: requireString(body, 'game'),
    packageType: requireString(body, 'packageType'),
    buildId: requireString(body, 'buildId'),
    artifactUrl,
    sizeBytes: sizeRaw,
    sha256: sha256.toLowerCase(),
    // exactOptionalPropertyTypes 下不能直接赋 undefined，所以按需展开。
    ...(commitSha !== undefined && { commitSha }),
    ...(description !== undefined && { description }),
  };
}

export interface ResolvedReport {
  readonly report: BuildReport;
  readonly game: Game;
  readonly packageType: PackageType;
}

/**
 * 校验上报指向的游戏与包类型都已登记且未归档。
 *
 * 两者都在写入**之前**查，不写入任何记录——「未登记包类型拒绝写入」
 * 要的是零副作用的拒绝（game-catalog spec）。
 */
export function resolveReport(db: Db, report: BuildReport): ResolvedReport {
  const game = requireActiveGame(db, report.game);
  const packageType = requireActivePackageType(db, report.packageType);
  return { report, game, packageType };
}
