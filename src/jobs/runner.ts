/**
 * 任务执行循环（design.md D7）。
 *
 * 串行是刻意的：发布与 CLI 安装互相排队，单人场景可接受，而且省掉了
 * 「并发度」这个要调的参数。平台 CLI 一律 spawn 成子进程，不占事件循环。
 */
import type { Db } from '../db/index.js';
import { appendLog, claimNext, finish, recoverInterrupted, type Job } from './store.js';
import type { JobKind, JobStatus } from './types.js';

/** 任务执行上下文，交给具体的 handler。 */
export interface JobContext {
  readonly job: Job;
  /** 追加一行日志，立即落库，这样执行中也能在界面上看到进展。 */
  log(line: string): void;
  /** 超时或取消时触发。handler 必须把它传给 spawn 出的子进程。 */
  readonly signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  readonly db: Db;
  /** 按任务类型分派的 handler。 */
  readonly handlers: Partial<Record<JobKind, JobHandler>>;
  /** 轮询间隔（毫秒）。缺省 1000。 */
  readonly pollIntervalMs?: number;
  /** 单个任务的超时（毫秒）。缺省 30 分钟。 */
  readonly timeoutMs?: number;
  /**
   * 启动时发现被中断的任务后调用。
   *
   * 任务自己已被标为失败，但它关联的记录（发布记录与阶段）也停在
   * 中断时的状态，需要调用方一并收拾——否则界面上会永远显示「执行中」。
   */
  readonly onRecovered?: (jobs: readonly Job[]) => void;
}

export interface RunnerHandle {
  /** 停止循环。不会打断正在执行的任务，只是不再领新的。 */
  stop(): void;
  /** 立刻跑一轮，不等轮询间隔。供测试与「投递后立即执行」使用。 */
  tick(): Promise<boolean>;
  /** 是否正在执行某个任务。 */
  readonly busy: boolean;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 执行一个任务并落地结果。
 *
 * 超时的处理方式是 abort 信号 + 竞速：只改状态不发信号的话，子进程会继续
 * 在后台跑，于是「超时」只是界面上的字，实际副作用还在发生。
 */
async function runOne(
  db: Db,
  job: Job,
  handler: JobHandler | undefined,
  timeoutMs: number,
): Promise<JobStatus> {
  if (handler === undefined) {
    finish(db, job.id, 'failed', `没有注册 ${job.kind} 类型的执行器`);
    return 'failed';
  }

  const controller = new AbortController();
  const ctx: JobContext = {
    job,
    log: (line) => appendLog(db, job.id, line),
    signal: controller.signal,
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('任务超时'));
  }, timeoutMs);

  try {
    await handler(ctx);
    if (timedOut) {
      finish(db, job.id, 'timeout', `任务超过 ${timeoutMs} 毫秒未完成`);
      return 'timeout';
    }
    finish(db, job.id, 'success');
    return 'success';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      // 超时导致的异常算超时，不算普通失败：两者的下一步动作不同
      // （超时要考虑平台侧是否已生效，失败通常可以直接重试）。
      appendLog(db, job.id, `[超时] ${message}`);
      finish(db, job.id, 'timeout', `任务超过 ${timeoutMs} 毫秒未完成`);
      return 'timeout';
    }
    appendLog(db, job.id, `[失败] ${message}`);
    finish(db, job.id, 'failed', message);
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

export function startRunner(options: RunnerOptions): RunnerHandle {
  const { db, handlers } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stopped = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;

  /** 领一个任务并执行。返回是否真的执行了任务。 */
  async function tick(): Promise<boolean> {
    if (stopped || busy) return false;
    const job = claimNext(db);
    if (job === undefined) return false;

    busy = true;
    try {
      await runOne(db, job, handlers[job.kind], timeoutMs);
    } finally {
      busy = false;
    }
    return true;
  }

  async function loop(): Promise<void> {
    // 一轮里尽量把积压清空，而不是一个轮询间隔只处理一个任务。
    while (!stopped) {
      const ran = await tick();
      if (!ran) break;
    }
    if (!stopped) {
      timer = setTimeout(() => void loop(), pollIntervalMs);
    }
  }

  // 启动时先清理上次中断留下的 running 任务，再开始领新任务。
  const recovered = recoverInterrupted(db);
  if (recovered.length > 0) {
    console.warn(`[warn] ${recovered.length} 个任务在上次运行中被中断，已标记为失败`);
    options.onRecovered?.(recovered);
  }

  void loop();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    tick,
    get busy(): boolean {
      return busy;
    },
  };
}
