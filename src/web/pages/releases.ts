/**
 * 发布记录列表与详情（11.4）。
 */
import { getBuild } from '../../builds/index.js';
import type { Db } from '../../db/index.js';
import { findTargetKind } from '../../registry/index.js';
import { getRelease, listReleases, listStageAttempts, type Release } from '../../releases/index.js';
import { getTarget } from '../../targets/index.js';
import { html, join, shortTime, statusBadge, type Html } from '../html.js';

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
        <td class="small">
          ${join(
            release.stages.map(
              (stage) => html`<span>${stage.stageId} ${statusBadge(stage.status)}</span>`,
            ),
            ' ',
          )}
        </td>
        <td class="muted small">${shortTime(release.createdAt)}</td>
        <td><a href="/releases/${release.id}">详情</a></td>
      </tr>
    `,
  );

  return html`
    <h1>发布记录</h1>
    <p class="lead">每次发布一条，维度是「构建 × 目标」。</p>
    <div class="card">
      ${releases.length === 0
        ? html`<p class="empty">还没有发布记录。</p>`
        : html`
            <table>
              <thead>
                <tr><th>状态</th><th>构建</th><th>目标</th><th>阶段</th><th>发起时间</th><th></th></tr>
              </thead>
              <tbody>${join(rows)}</tbody>
            </table>
          `}
    </div>
  `;
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

  const stageCards = join(
    release.stages.map((stage) => {
      const attempts = listStageAttempts(db, release.id, stage.stageId);
      const declaredName =
        kind?.manifest.stages.find((s) => s.id === stage.stageId)?.name ?? stage.stageId;

      return html`
        <div class="card">
          <strong>${declaredName}</strong>
          ${statusBadge(stage.status)}
          <span class="muted small">
            第 ${stage.attempt} 次尝试 ·
            ${shortTime(stage.startedAt)} → ${shortTime(stage.finishedAt)}
          </span>
          ${stage.log === ''
            ? html`<p class="muted small">没有日志输出。</p>`
            : html`<pre>${stage.log}</pre>`}
          ${attempts.length > 1
            ? html`
                <details>
                  <summary class="small">之前的 ${attempts.length - 1} 次尝试</summary>
                  ${join(
                    attempts
                      .filter((a) => a.attempt !== stage.attempt)
                      .map(
                        (a) => html`
                          <p class="small">
                            第 ${a.attempt} 次 ${statusBadge(a.status)}
                            <span class="muted">${shortTime(a.finishedAt)}</span>
                          </p>
                          ${a.log === '' ? html`` : html`<pre>${a.log}</pre>`}
                        `,
                      ),
                  )}
                </details>
              `
            : html``}
        </div>
      `;
    }),
  );

  // 回滚入口按目标类型声明的能力显示，不是所有目标都有
  const rollbackSection =
    rollbackMode === 'none'
      ? html`<p class="small muted">该目标类型不支持回滚。</p>`
      : rollbackMode === 'pointer'
        ? html`
            <p class="small">
              该目标支持指针回退：只改生效指针，不重新写入产物。
              ${kind === undefined
                ? html``
                : html`<span class="muted">
                    预计 ${kind.manifest.capabilities.activateLatencySeconds} 秒生效。
                  </span>`}
            </p>
            <form method="post" action="/releases/${release.id}/rollback">
              <button class="secondary" type="submit">切回上一版本</button>
            </form>
          `
        : html`
            <p class="small">
              该平台没有回滚动作，只能把旧版本重新发一次。到
              <a href="/builds">构建列表</a> 选择旧版本发布。
            </p>
          `;

  return html`
    <h1>发布详情</h1>
    <p class="lead">
      ${statusBadge(release.status)}
      <code>${buildLabel(db, release.buildId)}</code> →
      ${target === null ? release.targetId : target.name}
      · 发起于 ${shortTime(release.createdAt)}
      · 操作者 ${release.createdBy}
    </p>

    <div class="card">
      <h3>发布参数</h3>
      <pre>${JSON.stringify(release.params, null, 2)}</pre>
    </div>

    <h2>阶段</h2>
    ${stageCards}

    <h2>操作</h2>
    <div class="card">
      ${retriable
        ? html`
            <p class="small">
              重试会从第一个未成功的阶段继续，已成功的阶段不会重新执行。
            </p>
            <form method="post" action="/releases/${release.id}/retry">
              <button type="submit">重试失败阶段</button>
            </form>
            <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
          `
        : html``}
      ${rollbackSection}
    </div>
  `;
}

/** 正在执行时自动刷新，让日志能看到进展。 */
export function shouldAutoRefresh(release: Release): boolean {
  return release.status === 'queued' || release.status === 'running';
}
