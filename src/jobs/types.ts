/**
 * 任务的状态与类型（design.md D7）。
 */

/**
 * 任务状态。
 *
 * 只允许 queued/running → 终止态，不允许终止态之间互转，也不允许回到
 * queued（release-execution spec：发布状态机）。重试走的是新建一次 attempt，
 * 而不是把终止态改回 queued——后者会抹掉「这次失败过」的事实。
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'success',
  'failed',
  'timeout',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL: readonly JobStatus[] = ['success', 'failed', 'timeout', 'cancelled'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/** 允许的状态转移。键是当前状态，值是可以转到的状态。 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  // queued → failed 是中断恢复用的：进程在任务排队期间被杀，重启后发现
  // 它既没开始也不该自动开始（中断点未知），只能标为失败让人决定。
  queued: ['running', 'cancelled', 'failed'],
  running: ['success', 'failed', 'timeout', 'cancelled'],
  success: [],
  failed: [],
  timeout: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * 校验状态转移，不合法时抛错。
 *
 * 显式报错而不是静默忽略：一次非法转移意味着调用方的状态判断有问题，
 * 悄悄跳过会让任务卡在一个谁都没预期的状态上。
 */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`任务状态不能从 ${from} 转移到 ${to}`);
  }
}

export type JobKind = 'publish' | 'cli_install';
