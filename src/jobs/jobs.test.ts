import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureSchema, open, type Db } from '../db/index.js';
import { startRunner, type JobHandler } from './runner.js';
import {
  appendLog,
  cancel,
  claimNext,
  enqueue,
  finish,
  getJob,
  listJobs,
  recoverInterrupted,
} from './store.js';
import { assertTransition, canTransition, isTerminal, JOB_STATUSES } from './types.js';

function freshDb(): Db {
  const db = open({ file: ':memory:' });
  ensureSchema(db);
  return db;
}

describe('状态机', () => {
  it('只允许 queued/running 转到终止态', () => {
    assert.equal(canTransition('queued', 'running'), true);
    assert.equal(canTransition('queued', 'cancelled'), true);
    assert.equal(canTransition('running', 'success'), true);
    assert.equal(canTransition('running', 'failed'), true);
    assert.equal(canTransition('running', 'timeout'), true);
    assert.equal(canTransition('running', 'cancelled'), true);
  });

  it('终止态不能再转移（包括转回 queued）', () => {
    for (const terminal of ['success', 'failed', 'timeout', 'cancelled'] as const) {
      for (const to of JOB_STATUSES) {
        assert.equal(
          canTransition(terminal, to),
          false,
          `${terminal} → ${to} 应被拒`,
        );
      }
    }
  });

  it('queued 不能直接跳到 success', () => {
    assert.equal(canTransition('queued', 'success'), false);
  });

  it('非法转移抛错而不是静默忽略', () => {
    assert.throws(() => assertTransition('success', 'running'), /不能从 success 转移到 running/);
  });

  it('isTerminal 判定正确', () => {
    assert.equal(isTerminal('queued'), false);
    assert.equal(isTerminal('running'), false);
    assert.equal(isTerminal('success'), true);
    assert.equal(isTerminal('timeout'), true);
  });
});

describe('任务队列', () => {
  it('投递后状态是 queued', () => {
    const db = freshDb();
    try {
      const job = enqueue(db, 'publish', 'release-1');
      assert.equal(job.status, 'queued');
      assert.equal(job.attempts, 0);
      assert.equal(job.startedAt, null);
    } finally {
      db.close();
    }
  });

  it('claimNext 原子地标为 running 并递增 attempts', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      const claimed = claimNext(db);
      assert.ok(claimed);
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.attempts, 1);
      assert.notEqual(claimed.startedAt, null);
    } finally {
      db.close();
    }
  });

  it('同一个任务不会被领两次', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      const first = claimNext(db);
      const second = claimNext(db);
      assert.ok(first);
      assert.equal(second, undefined, '队列里只有一个任务，第二次应领不到');
    } finally {
      db.close();
    }
  });

  it('按投递顺序领取（FIFO）', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'first');
      enqueue(db, 'publish', 'second');
      assert.equal(claimNext(db)?.refId, 'first');
      assert.equal(claimNext(db)?.refId, 'second');
    } finally {
      db.close();
    }
  });

  it('同一毫秒投递的多个任务仍按投递顺序领取', () => {
    const db = freshDb();
    try {
      // 不做任何时间间隔：这些任务的 created_at 会相同，顺序只能靠 seq
      const refs = ['wechat', 'douyin', 'h5'];
      for (const ref of refs) enqueue(db, 'publish', ref);

      const claimed: string[] = [];
      for (let i = 0; i < refs.length; i += 1) {
        claimed.push(claimNext(db)!.refId);
      }
      assert.deepEqual(claimed, refs, '同毫秒投递也必须保持 FIFO');
    } finally {
      db.close();
    }
  });

  it('队列空时返回 undefined', () => {
    const db = freshDb();
    try {
      assert.equal(claimNext(db), undefined);
    } finally {
      db.close();
    }
  });

  it('日志是追加的，不覆盖', () => {
    const db = freshDb();
    try {
      const job = enqueue(db, 'publish', 'r1');
      appendLog(db, job.id, '第一行');
      appendLog(db, job.id, '第二行');
      assert.equal(getJob(db, job.id).log, '第一行\n第二行\n');
    } finally {
      db.close();
    }
  });

  it('错误原因单独存一列，便于在列表里显示', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      const job = claimNext(db)!;
      const finished = finish(db, job.id, 'failed', '上传被平台拒绝');
      assert.equal(finished.status, 'failed');
      assert.equal(finished.error, '上传被平台拒绝');
      assert.notEqual(finished.finishedAt, null);
    } finally {
      db.close();
    }
  });

  it('可以取消尚未开始的任务', () => {
    const db = freshDb();
    try {
      const job = enqueue(db, 'publish', 'r1');
      assert.equal(cancel(db, job.id).status, 'cancelled');
    } finally {
      db.close();
    }
  });

  it('按状态与类型筛选', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      enqueue(db, 'cli_install', 'miniprogram-ci');
      const job = claimNext(db)!;
      finish(db, job.id, 'success');

      assert.equal(listJobs(db, { status: 'queued' }).length, 1);
      assert.equal(listJobs(db, { status: 'success' }).length, 1);
      assert.equal(listJobs(db, { kind: 'cli_install' }).length, 1);
      assert.equal(listJobs(db, { refId: 'r1' }).length, 1);
    } finally {
      db.close();
    }
  });
});

describe('中断恢复', () => {
  it('遗留的 running 任务被标记为失败', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      const job = claimNext(db)!;
      assert.equal(job.status, 'running');

      const count = recoverInterrupted(db);
      assert.equal(count, 1);

      const recovered = getJob(db, job.id);
      assert.equal(recovered.status, 'failed');
      assert.match(recovered.error ?? '', /进程中断/);
      assert.match(recovered.log, /\[恢复\]/);
    } finally {
      db.close();
    }
  });

  it('不自动重跑：恢复后不回到 queued', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      claimNext(db);
      recoverInterrupted(db);

      assert.equal(listJobs(db, { status: 'queued' }).length, 0, '不应回到队列');
      assert.equal(claimNext(db), undefined, '不应被再次领取');
    } finally {
      db.close();
    }
  });

  it('queued 与已完成的任务不受影响', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'queued-one');
      enqueue(db, 'publish', 'done-one');
      const done = claimNext(db)!;
      finish(db, done.id, 'success');

      assert.equal(recoverInterrupted(db), 0);
      assert.equal(listJobs(db, { status: 'queued' }).length, 1);
      assert.equal(listJobs(db, { status: 'success' }).length, 1);
    } finally {
      db.close();
    }
  });
});

describe('执行循环', () => {
  it('handler 正常返回时任务成功', async () => {
    const db = freshDb();
    try {
      let ran = false;
      const handler: JobHandler = async (ctx) => {
        ran = true;
        ctx.log('执行中');
      };
      const runner = startRunner({ db, handlers: { publish: handler } });
      try {
        const job = enqueue(db, 'publish', 'r1');
        await runner.tick();

        assert.equal(ran, true);
        const finished = getJob(db, job.id);
        assert.equal(finished.status, 'success');
        assert.match(finished.log, /执行中/);
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('handler 抛错时任务失败，错误写进记录', async () => {
    const db = freshDb();
    try {
      const handler: JobHandler = async () => {
        throw new Error('平台返回 40013');
      };
      const runner = startRunner({ db, handlers: { publish: handler } });
      try {
        const job = enqueue(db, 'publish', 'r1');
        await runner.tick();

        const finished = getJob(db, job.id);
        assert.equal(finished.status, 'failed');
        assert.equal(finished.error, '平台返回 40013');
        assert.match(finished.log, /\[失败\] 平台返回 40013/);
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('超时的任务进入 timeout 状态并保留已产生的日志', async () => {
    const db = freshDb();
    try {
      const handler: JobHandler = async (ctx) => {
        ctx.log('开始上传');
        // 等待 abort，而不是固定睡眠：这样测试不依赖具体时长
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          setTimeout(resolve, 5000);
        });
      };
      const runner = startRunner({ db, handlers: { publish: handler }, timeoutMs: 50 });
      try {
        const job = enqueue(db, 'publish', 'r1');
        await runner.tick();

        const finished = getJob(db, job.id);
        assert.equal(finished.status, 'timeout');
        assert.match(finished.log, /开始上传/, '超时也要保留已产生的日志');
        assert.match(finished.error ?? '', /超过 50 毫秒/);
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('超时会真的发出 abort 信号（而不只是改状态）', async () => {
    const db = freshDb();
    try {
      let aborted = false;
      const handler: JobHandler = async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
      };
      const runner = startRunner({ db, handlers: { publish: handler }, timeoutMs: 30 });
      try {
        enqueue(db, 'publish', 'r1');
        await runner.tick();
        assert.equal(aborted, true, 'handler 应收到 abort 信号');
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('没有注册 handler 的类型直接失败，而不是卡在 running', async () => {
    const db = freshDb();
    try {
      const runner = startRunner({ db, handlers: {} });
      try {
        const job = enqueue(db, 'publish', 'r1');
        await runner.tick();
        const finished = getJob(db, job.id);
        assert.equal(finished.status, 'failed');
        assert.match(finished.error ?? '', /没有注册 publish 类型的执行器/);
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('串行执行：一个任务跑完才领下一个', async () => {
    const db = freshDb();
    try {
      const order: string[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;
      const handler: JobHandler = async (ctx) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(ctx.job.refId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
      };
      const runner = startRunner({ db, handlers: { publish: handler } });
      try {
        enqueue(db, 'publish', 'a');
        enqueue(db, 'publish', 'b');
        await runner.tick();
        await runner.tick();

        assert.equal(maxConcurrent, 1, '不应有两个任务同时执行');
        assert.deepEqual(order, ['a', 'b']);
      } finally {
        runner.stop();
      }
    } finally {
      db.close();
    }
  });

  it('启动时自动恢复中断的任务', () => {
    const db = freshDb();
    try {
      enqueue(db, 'publish', 'r1');
      const job = claimNext(db)!;

      const runner = startRunner({ db, handlers: {} });
      runner.stop();

      assert.equal(getJob(db, job.id).status, 'failed');
    } finally {
      db.close();
    }
  });
});
