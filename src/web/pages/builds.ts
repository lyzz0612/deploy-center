/**
 * 构建列表与发布页。
 *
 * 构建按 commit 聚合：一次构建通常产出多个包，真正要回答的是「这次构建
 * 发完了没有」。发布页只列出声明接受该包类型的目标，并逐个跑预检。
 */
import { listBuilds, type BuildGroup } from '../../builds/index.js';
import { listGames, listPackageTypes } from '../../catalog/index.js';
import { preflight, type PreflightResult } from '../../cli/index.js';
import type { Db } from '../../db/index.js';
import { getTargetKind } from '../../registry/index.js';
import { listTargets, type Target } from '../../targets/index.js';
import {
  emptyPanel,
  esc,
  html,
  humanSize,
  join,
  pageHeader,
  raw,
  shortTime,
  type Html,
} from '../html.js';

export interface BuildsPageOptions {
  readonly gameSlug?: string;
  readonly packageTypeId?: string;
}

function renderTargetBadges(build: BuildGroup['builds'][number]): Html {
  if (build.targets.length === 0) {
    return html`<span class="badge muted">未发布</span>`;
  }
  return html`<div class="target-badges">
    ${join(
      build.targets.map(
        (target) => html`
          <span class="badge ${statusClass(target.status)}">
            ${target.targetName} · ${statusLabel(target.status)}
          </span>
        `,
      ),
    )}
  </div>`;
}

function statusClass(status: string): string {
  if (status === 'success') return 'ok';
  if (status === 'failed' || status === 'timeout') return 'err';
  if (status === 'running') return 'run';
  if (status === 'queued') return 'warn';
  return '';
}

function statusLabel(status: string): string {
  return (
    {
      queued: '排队中',
      running: '执行中',
      success: '成功',
      failed: '失败',
      timeout: '超时',
      cancelled: '已取消',
    }[status] ?? status
  );
}

export function buildsPage(db: Db, options: BuildsPageOptions = {}): Html {
  const games = listGames(db);
  const packageTypes = listPackageTypes(db);

  const game =
    options.gameSlug === undefined ? undefined : games.find((g) => g.slug === options.gameSlug);
  const groups = listBuilds(db, {
    ...(game !== undefined && { gameId: game.id }),
    ...(options.packageTypeId !== undefined && { packageTypeId: options.packageTypeId }),
  });

  const filter = html`
    <form class="toolbar" method="get" action="/builds">
      <div class="field">
        <label>游戏</label>
        <select name="game">
          <option value="">全部</option>
          ${join(
            games.map(
              (g) => html`
                <option value="${g.slug}"${raw(g.slug === options.gameSlug ? ' selected' : '')}>
                  ${g.displayName}
                </option>
              `,
            ),
          )}
        </select>
      </div>
      <div class="field">
        <label>包类型</label>
        <select name="packageType">
          <option value="">全部</option>
          ${join(
            packageTypes.map(
              (type) => html`
                <option value="${type.id}"${raw(type.id === options.packageTypeId ? ' selected' : '')}>
                  ${type.displayName}
                </option>
              `,
            ),
          )}
        </select>
      </div>
      <div>
        <button class="btn secondary" type="submit">筛选</button>
      </div>
      <div class="spacer" style="flex:1"></div>
      <span class="subtle">按 commit 聚合 · ${groups.length} 组</span>
    </form>
  `;

  const list =
    groups.length === 0
      ? emptyPanel(
          html`<strong>还没有构建</strong>
            等 CI 上报后就会出现在这里。上报契约见 <code>docs/ci-report.md</code>。`,
          html`<a class="btn secondary" href="/settings/ci-keys">查看 CI key</a>`,
        )
      : join(
          groups.map(
            (group) => html`
              <div class="build-group">
                <div class="build-head">
                  <div>
                    <div class="commit">
                      ${group.commitSha === null ? '（无 commit）' : group.commitSha}
                    </div>
                    <div class="build-meta">
                      ${group.description ?? '无描述'} · ${shortTime(group.reportedAt)}
                    </div>
                  </div>
                  <span class="subtle">${group.builds.length} 个包</span>
                </div>
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>包类型</th><th>构建标识</th><th>大小</th><th>各目标状态</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${join(
                        group.builds.map(
                          (build) => html`
                            <tr>
                              <td>${build.packageTypeName}</td>
                              <td><code>${build.buildId}</code></td>
                              <td class="num">${humanSize(build.sizeBytes)}</td>
                              <td>${renderTargetBadges(build)}</td>
                              <td>
                                <div class="row-actions">
                                  <a class="btn secondary small" href="/builds/${build.id}/publish">
                                    发布
                                  </a>
                                </div>
                              </td>
                            </tr>
                          `,
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            `,
          ),
        );

  return html`
    ${pageHeader({
      title: '构建',
      lead: html`CI 上报的产物。同一次构建产出的多个包按 commit 聚合成一组。`,
    })}
    ${filter}
    ${list}
  `;
}

/* -------------------------------- 发布页 -------------------------------- */

export interface PublishPageDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
}

export interface PublishPageData {
  readonly buildId: string;
  readonly buildLabel: string;
  readonly packageTypeId: string;
  readonly gameSlug: string;
}

/**
 * 发布页。
 *
 * 候选目标只列出 `accepts` 含该包类型的实例——错配在这一层就不可能出现。
 * 每个候选都跑一次发布前检查，未通过的**按钮不可点并显示原因**，而不是
 * 让人点了之后等 30 秒看到一个莫名其妙的失败。
 */
export async function publishPage(
  deps: PublishPageDeps,
  data: PublishPageData,
): Promise<Html> {
  const { db } = deps;
  const game = listGames(db, { includeArchived: true }).find((g) => g.slug === data.gameSlug);
  const candidates = listTargets(db, {
    ...(game !== undefined && { gameId: game.id }),
    acceptsPackageType: data.packageTypeId,
  });

  const checked: Array<{ target: Target; preflight: PreflightResult }> = [];
  for (const target of candidates) {
    try {
      checked.push({ target, preflight: await preflight(deps, target.id) });
    } catch (error) {
      checked.push({
        target,
        preflight: {
          ok: false,
          blockers: [`检查未能执行：${error instanceof Error ? error.message : String(error)}`],
        },
      });
    }
  }

  const forms =
    checked.length === 0
      ? emptyPanel(
          html`<strong>没有可用的发布目标</strong>
            没有目标类型接受 <code>${data.packageTypeId}</code> 包。`,
          html`<a class="btn" href="/games/${data.gameSlug}/targets/new">添加发布目标</a>`,
        )
      : join(
          checked.map(({ target, preflight: pre }) => {
            let fields: Html;
            try {
              const kind = getTargetKind(target.kind);
              fields = renderPublishFields(kind.manifest.publishFields);
            } catch {
              fields = html`<p class="notice err" style="margin:0">该目标的类型未注册。</p>`;
            }

            return html`
              <div class="target-card">
                <div class="target-card-head">
                  <strong>${target.name}</strong>
                  <span class="badge">${target.kindDisplayName}</span>
                  ${pre.ok
                    ? html`<span class="badge ok">检查通过</span>`
                    : html`<span class="badge err">检查未通过</span>`}
                </div>

                ${pre.ok
                  ? html``
                  : html`
                      <div class="notice err">
                        <ul class="blockers">
                          ${join(pre.blockers.map((b) => html`<li>${b}</li>`))}
                        </ul>
                      </div>
                    `}

                <form method="post" action="/builds/${data.buildId}/publish">
                  <input type="hidden" name="targetId" value="${target.id}">
                  ${pre.ok ? fields : html``}
                  <div class="form-actions" style="margin-top:16px">
                    <button class="btn" type="submit"${raw(pre.ok ? '' : ' disabled')}>
                      ${pre.ok ? '发布到这个目标' : '检查未通过，无法发布'}
                    </button>
                  </div>
                </form>
              </div>
            `;
          }),
        );

  return html`
    ${pageHeader({
      title: `发布 ${data.buildLabel}`,
      lead: html`包类型 <code>${data.packageTypeId}</code> ·
        ${game === undefined ? '' : `游戏 ${game.displayName} · `}
        只列出声明接受该包类型的目标。`,
      actions: html`<a class="btn secondary" href="/builds">返回构建列表</a>`,
    })}
    ${forms}
  `;
}

/** 发布参数表单。字段由插件声明，核心只负责渲染。 */
function renderPublishFields(fields: readonly import('../../registry/index.js').Field[]): Html {
  if (fields.length === 0) {
    return html`<p class="subtle">该类型不需要额外参数。</p>`;
  }
  return html`
    <div class="form-grid">
      ${join(
        fields.map((field) => {
          const name = `params.${field.key}`;
          const required = field.required ? ' required' : '';
          const hint =
            field.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`;

          if (field.type === 'boolean') {
            return html`
              <div class="field span-2">
                <label class="check-label">
                  <input type="checkbox" name="${name}" value="true" checked>
                  <span>${field.label}${hint}</span>
                </label>
              </div>
            `;
          }
          if (field.type === 'select') {
            return html`
              <div class="field">
                <label>${field.label}${hint}</label>
                <select name="${name}"${raw(required)}>
                  ${join(
                    (field.options ?? []).map(
                      (option) => html`<option value="${option.value}">${option.label}</option>`,
                    ),
                  )}
                </select>
              </div>
            `;
          }
          const pattern = field.pattern === undefined ? '' : ` pattern="${esc(field.pattern)}"`;
          const placeholder =
            field.placeholder === undefined ? '' : ` placeholder="${esc(field.placeholder)}"`;
          return html`
            <div class="field">
              <label>${field.label}${hint}</label>
              <input
                type="${field.type === 'number' ? 'number' : 'text'}"
                name="${name}"${raw(required)}${raw(pattern)}${raw(placeholder)}
              >
            </div>
          `;
        }),
      )}
    </div>
  `;
}