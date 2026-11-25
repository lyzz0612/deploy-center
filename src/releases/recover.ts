/**
 * 进程中断后的发布记录收尾。
 *
 * jobs 表的恢复（jobs/store.ts 的 recoverInterrupted）只管任务自己。发布
 * 记录与它的阶段也停在中断时的状态，如果不一并收拾，界面上那条发布会
 * 永远显示「执行中」：页面一直自动刷新，而重试入口因为状态是 running
 * 根本不出现——用户被卡在一个死局里。
 */
import type { Db } from '../db/index.js';
import { appendStageLog, finishStage, getRelease, setReleaseStatus } from './store.js';

export interface RecoveredRelease {
  readonly releaseId: string;
  readonly interruptedStage: string | null;
}

/**
 * 把一条中断的发布记录标记为失败。
 *
 * 阶段的处理分两种：执行中的那个标为失败（它确实没做完），还没开始的
 * 标为跳过。都不标的话，重试时 prepareRetry 会从第一个「非 success」
 * 的阶段继续——那是对的，但界面上一排 queued 看不出发生过什么。
 */
export function recoverRelease(db: Db, releaseId: string): RecoveredRelease | null {
  let release;
  try {
    release = getRelease(db, releaseId);
  } catch {
    // 任务引用的发布记录已不存在，不是这里要处理的问题
    return null;
  }

  if (release.status !== 'running' && release.status !== 'queued') {
    return null;
  }

  const REASON =
    '[恢复] 进程在这次发布执行中退出，已标记为失败。' +
    '请先确认平台侧状态（可能已经收到包），再决定是否重试。';

  let interrupted: string | null = null;
  let explained = false;

  for (const stage of release.stages) {
    if (stage.status === 'running') {
      interrupted = stage.stageId;
      appendStageLog(db, releaseId, stage.stageId, stage.attempt, REASON);
      explained = true;
      finishStage(db, releaseId, stage.stageId, stage.attempt, 'failed');
    } else if (stage.status === 'queued') {
      // 第一个还没开始的阶段上留一句说明：否则用户看到一条失败的发布、
      // 几个 skipped 阶段，没有任何原因可看——中断原因只在 jobs 表里，
      // 而发布详情页展示的是阶段日志。
      if (!explained) {
        appendStageLog(db, releaseId, stage.stageId, stage.attempt, REASON);
        explained = true;
      }
      finishStage(db, releaseId, stage.stageId, stage.attempt, 'skipped');
    }
  }

  setReleaseStatus(db, releaseId, 'failed');
  return { releaseId, interruptedStage: interrupted };
}
