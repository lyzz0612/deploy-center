/**
 * 发布记录列表与详情。
 */
import { getBuild } from '../../builds/index.js';
import type { Db } from '../../db/index.js';
import { findTargetKind } from '../../registry/index.js';
import {
  getRelease,
  listReleases,
  listStageAttempts,
  ROLLBACK_STAGE_ID,
  VERIFY_STAGE_ID,
  type Release,
} from '../../releases/index.js';
import { getTarget } from '../../targets/index.js';
import {
  emptyPanel,
  html,
  join,
  pageHeader,
  shortTime,
  statusBadge,
  sectionTitle,
  type Html,
} from '../html.js';

function targetName(db: Db, targetId: string): string {
  try {
    return getTarget(db, targetId).name;
  } catch {
    return targetId;
  }
}

function buildLabel(db: Db, buildPk: string): string {
  try {
    return getBuild(db, buildPk).buildId;
  } catch {
    return buildPk;
  }
}

export function releasesPage(db: Db): Html {
  const releases = listReleases(db, { limit: 100 });

  const rows = releases.map(
    (release) => html`
      <tr>
        <td>${statusBadge(release.status)}</td>
        <td><code>${buildLabel(db, release.buildId)}</code></td>
        <td>${targetName(db, release.targetId)}</td>
        <td>
          <div class="target-badges">
            ${join(
              release.stages.map(
                (stage) => html`
                  <span class="badge ${stageClass(stage.status)}">
                    ${syntheticStageName(stage.stageId) ?? stage.stageId} · ${stageStatusLabel(stage.status)}
                  </span>
                `,
              ),
            )}
          </div>
        </td>
        <td class="subtle">${shortTime(release.createdAt)}</td>
        <td>
          <div class="row-actions">
            <a class="btn secondary small" href="/releases/${release.id}">详情</a>
          </div>
        </td>
      </tr>
    `,
  );

  return html`
    ${pageHeader({
      title: '发布记录',
      lead: html`每次发布一条，维度是「构建 × 目标」。重试会保留历史阶段，不覆盖旧记录。`,
    })}
    ${releases.length === 0
      ? emptyPanel(
          html`<strong>还没有发布记录</strong>到构建列表里挑一个包发布。`,
          html`<a class="btn" href="/builds">前往构建列表</a>`,
        )
      : html`
          <div class="panel">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>状态</th><th>构建</th><th>目标</th><th>阶段</th><th>发起</th><th></th></tr>
                </thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          </div>
        `}
  `;
}

function stageClass(status: string): string {
  if (status === 'success') return 'ok';
  if (status === 'failed' || status === 'timeout') return 'err';
  if (status === 'running') return 'run';
  if (status === 'queued') return 'warn';
  return '';
}

function stageStatusLabel(status: string): string {
  return (
    {
      queued: '排队中',
      running: '执行中',
      success: '成功',
      failed: '失败',
      timeout: '超时',
      cancelled: '已取消',
      skipped: '已跳过',
    }[status] ?? status
  );
}

/**
 * 核心补的合成阶段（验证、回滚）的中文名。
 *
 * 它们不在插件声明的 stages 里，不单独起名就会在页面上露出 `__verify__`
 * 这种内部标识。
 */
function syntheticStageName(stageId: string): string | null {
  if (stageId === VERIFY_STAGE_ID) return '验证发布结果';
  if (stageId === ROLLBACK_STAGE_ID) return '回滚';
  return null;
}

export function releaseDetailPage(db: Db, release: Release): Html {
  const target = (() => {
    try {
      return getTarget(db, release.targetId);
    } catch {
      return null;
    }
  })();
  const kind = target === null ? undefined : findTargetKind(target.kind);
  const rollbackMode = kind?.manifest.capabilities.rollback ?? 'none';

  const retriable =
    release.status !== 'running' &&
    release.status !== 'queued' &&
    release.stages.some((s) => s.status !== 'success');

  // 只有已结束的能删：queued 还在队列里等执行器取走，running 正在跑
  const deletable = release.status !== 'running' && release.status !== 'queued';

  const stageCards = join(
    release.stages.map((stage) => {
      const attempts = listStageAttempts(db, release.id, stage.stageId);
      const declaredName =
        syntheticStageName(stage.stageId) ??
        kind?.manifest.stages.find((s) => s.id === stage.stageId)?.name ??
        stage.stageId;
      const previous = attempts.filter((a) => a.attempt !== stage.attempt);

      return html`
        <div class="stage ${stageClass(stage.status)}">
          <div class="stage-head">
            <strong>${declaredName}</strong>
            ${statusBadge(stage.status)}
            <span class="subtle">
              第 ${stage.attempt} 次尝试 · ${shortTime(stage.startedAt)} → ${shortTime(stage.finishedAt)}
            </span>
          </div>
          <div class="stage-body">
            ${stage.log === ''
              ? html`<p class="subtle" style="margin:0">没有日志输出。</p>`
              : html`<pre>${stage.log}</pre>`}
            ${previous.length === 0
              ? html``
              : html`
                  <details style="margin-top:14px">
                    <summary class="subtle">之前的 ${previous.length} 次尝试</summary>
                    ${join(
                      previous.map(
                        (attempt) => html`
                          <p class="small" style="margin-top:12px">
                            第 ${attempt.attempt} 次 ${statusBadge(attempt.status)}
                            <span class="subtle">${shortTime(attempt.finishedAt)}</span>
                          </p>
                          ${attempt.log === '' ? html`` : html`<pre>${attempt.log}</pre>`}
                        `,
                      ),
                    )}
                  </details>
                `}
          </div>
        </div>
      `;
    }),
  );

  // 回滚入口按目标类型声明的能力显示，不是所有目标都有
  const rollbackSection =
    rollbackMode === 'none'
      ? html`<p class="subtle" style="margin:0">该目标类型不支持回滚。</p>`
      : rollbackMode === 'pointer'
        ? html`
            <p class="subtle">
              该目标支持指针回退：只改生效指针，不重新写入产物。
              ${kind === undefined
                ? ''
                : `预计 ${kind.manifest.capabilities.activateLatencySeconds} 秒生效。`}
            </p>
            <form method="post" action="/releases/${release.id}/rollback">
              <button class="btn secondary" type="submit">切回上一版本</button>
            </form>
          `
        : html`
            <p class="subtle" style="margin:0">
              该平台没有回滚动作，只能把旧版本重新发一次。到
              <a href="/builds">构建列表</a> 选择旧版本发布。
            </p>
          `;

  return html`
    ${pageHeader({
      title: `发布 ${buildLabel(db, release.buildId)}`,
      lead: html`${statusBadge(release.status)}
        → ${target === null ? release.targetId : target.name} ·
        发起于 ${shortTime(release.createdAt)} · 操作者 ${release.createdBy}`,
      actions: html`<a class="btn secondary" href="/releases">返回发布记录</a>`,
    })}

    ${sectionTitle('概要')}
    <div class="panel">
      <div class="panel-body">
        <dl class="meta">
          <dt>构建</dt>
          <dd><code>${buildLabel(db, release.buildId)}</code></dd>
          <dt>目标</dt>
          <dd>
            ${target === null
              ? release.targetId
              : html`<a href="/targets/${target.id}">${target.name}</a>
                  <span class="subtle">（${target.kindDisplayName}）</span>`}
          </dd>
          <dt>发布参数</dt>
          <dd><pre class="light">${JSON.stringify(release.params, null, 2)}</pre></dd>
          <dt>完成时间</dt>
          <dd>${shortTime(release.finishedAt)}</dd>
        </dl>
      </div>
    </div>

    ${sectionTitle('阶段')}
    ${stageCards}

    ${sectionTitle('操作')}
    <div class="panel">
      <div class="panel-body">
        ${retriable
          ? html`
              <p class="subtle" style="margin-bottom:12px">
                重试会从第一个未成功的阶段继续，已成功的阶段不会重新执行。
              </p>
              <form method="post" action="/releases/${release.id}/retry">
                <button class="btn" type="submit">重试失败阶段</button>
              </form>
              <hr>
            `
          : html``}
        ${rollbackSection}
      </div>
    </div>

    ${sectionTitle('删除这条记录')}
    <div class="panel">
      <div class="panel-body">
        ${deletable
          ? html`
              <p class="subtle" style="margin:0 0 12px">
                删除后这条发布的阶段与日志一并消失，不可恢复。
                删掉最后一条引用该目标的记录后，那个目标才可以被删除。
              </p>
              <form
                method="post"
                action="/releases/${release.id}/delete"
                data-confirm="删除这条发布记录及其全部阶段日志？不可恢复。"
              >
                <button class="btn danger" type="submit">删除发布记录</button>
              </form>
            `
          : html`
              <p class="subtle" style="margin:0">
                这条记录还在 ${statusText(release.status)}，不能删除。请先等它结束。
              </p>
            `}
      </div>
    </div>
  `;
}

/** 状态的中文说法，用于句子里。 */
function statusText(status: Release['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    default:
      return status;
  }
}

/** 正在执行时自动刷新，让日志能看到进展。 */
export function shouldAutoRefresh(release: Release): boolean {
  return release.status === 'queued' || release.status === 'running';
}