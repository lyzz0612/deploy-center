/**
 * 构建列表与发布弹窗（11.2 + 11.3）。
 */
import { listBuilds, type BuildGroup } from '../../builds/index.js';
import { listGames, listPackageTypes } from '../../catalog/index.js';
import { preflight, type PreflightResult } from '../../cli/index.js';
import type { Db } from '../../db/index.js';
import { getTargetKind } from '../../registry/index.js';
import { listTargets, type Target } from '../../targets/index.js';
import { esc, html, humanSize, join, raw, shortTime, statusBadge, type Html } from '../html.js';

export interface BuildsPageOptions {
  readonly gameSlug?: string;
  readonly packageTypeId?: string;
}

function renderTargetBadges(build: BuildGroup['builds'][number]): Html {
  if (build.targets.length === 0) {
    return html`<span class="muted small">未发布</span>`;
  }
  return join(
    build.targets.map(
      (target) => html`
        <span class="small">
          ${target.targetName} ${statusBadge(target.status)}
        </span>
      `,
    ),
    ' ',
  );
}

export function buildsPage(db: Db, options: BuildsPageOptions = {}): Html {
  const games = listGames(db);
  const packageTypes = listPackageTypes(db);

  const game = options.gameSlug === undefined ? undefined : games.find((g) => g.slug === options.gameSlug);
  const groups = listBuilds(db, {
    ...(game !== undefined && { gameId: game.id }),
    ...(options.packageTypeId !== undefined && { packageTypeId: options.packageTypeId }),
  });

  const filter = html`
    <form class="card" method="get" action="/builds">
      <div class="row">
        <div>
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
        <div>
          <label>包类型<span class="hint">主视角是按 commit 聚合，筛选是次要动作。</span></label>
          <select name="packageType">
            <option value="">全部</option>
            ${join(
              packageTypes.map(
                (t) => html`
                  <option value="${t.id}"${raw(t.id === options.packageTypeId ? ' selected' : '')}>
                    ${t.displayName}
                  </option>
                `,
              ),
            )}
          </select>
        </div>
        <div style="flex:0 0 auto; align-self:flex-end">
          <button class="secondary" type="submit">筛选</button>
        </div>
      </div>
    </form>
  `;

  const list =
    groups.length === 0
      ? html`<p class="empty">还没有构建。CI 上报后会出现在这里（见 docs/ci-report.md）。</p>`
      : join(
          groups.map(
            (group) => html`
              <div class="card">
                <div class="row">
                  <div style="flex: 3 1 400px">
                    <strong>${group.commitSha === null ? '（无 commit）' : group.commitSha}</strong>
                    <div class="muted small">
                      ${group.description ?? '无描述'} · ${shortTime(group.reportedAt)}
                    </div>
                  </div>
                </div>
                <table class="small">
                  <thead>
                    <tr><th>包类型</th><th>构建标识</th><th>大小</th><th>各目标状态</th><th></th></tr>
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
                            <td><a href="/builds/${build.id}/publish">发布</a></td>
                          </tr>
                        `,
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            `,
          ),
        );

  return html`
    <h1>构建</h1>
    <p class="lead">同一次构建产出的多个包按 commit 聚合成一行。</p>
    ${filter}
    ${list}
  `;
}

/* ------------------------------- 发布弹窗 ------------------------------- */

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
      ? html`
          <p class="empty">
            没有能接受 <code>${data.packageTypeId}</code> 包的发布目标。
            <a href="/games/${data.gameSlug}">到游戏详情页添加一个 →</a>
          </p>
        `
      : join(
          checked.map(({ target, preflight: pre }) => {
            let fields: Html;
            try {
              const kind = getTargetKind(target.kind);
              fields = renderPublishFields(kind.manifest.publishFields);
            } catch {
              fields = html`<p class="small" style="color:var(--err)">该目标的类型未注册。</p>`;
            }

            return html`
              <div class="card">
                <strong>${target.name}</strong>
                <span class="muted small">${target.kindDisplayName}</span>
                ${pre.ok
                  ? html`<span class="badge ok">检查通过</span>`
                  : html`<span class="badge err">检查未通过</span>`}

                ${pre.ok
                  ? html``
                  : html`
                      <ul class="blockers">
                        ${join(pre.blockers.map((b) => html`<li>${b}</li>`))}
                      </ul>
                    `}

                <form method="post" action="/builds/${data.buildId}/publish">
                  <input type="hidden" name="targetId" value="${target.id}">
                  ${pre.ok ? fields : html``}
                  <p>
                    <button type="submit"${raw(pre.ok ? '' : ' disabled')}>
                      ${pre.ok ? '发布' : '检查未通过，无法发布'}
                    </button>
                  </p>
                </form>
              </div>
            `;
          }),
        );

  return html`
    <h1>发布 ${data.buildLabel}</h1>
    <p class="lead">
      包类型 <code>${data.packageTypeId}</code> ·
      只列出声明接受该包类型的目标。
    </p>
    ${forms}
  `;
}

/** 发布参数表单。字段由插件声明，核心只负责渲染。 */
function renderPublishFields(fields: readonly import('../../registry/index.js').Field[]): Html {
  if (fields.length === 0) {
    return html`<p class="small muted">该类型不需要额外参数。</p>`;
  }
  return join(
    fields.map((field) => {
      const name = `params.${field.key}`;
      const required = field.required ? ' required' : '';
      const hint = field.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`;

      if (field.type === 'boolean') {
        return html`
          <label>
            <input type="checkbox" name="${name}" value="true" checked>
            ${field.label}${hint}
          </label>
        `;
      }
      if (field.type === 'select') {
        return html`
          <label>${field.label}${hint}</label>
          <select name="${name}"${raw(required)}>
            ${join(
              (field.options ?? []).map(
                (o) => html`<option value="${o.value}">${o.label}</option>`,
              ),
            )}
          </select>
        `;
      }
      const pattern = field.pattern === undefined ? '' : ` pattern="${esc(field.pattern)}"`;
      const placeholder =
        field.placeholder === undefined ? '' : ` placeholder="${esc(field.placeholder)}"`;
      return html`
        <label>${field.label}${hint}</label>
        <input type="${field.type === 'number' ? 'number' : 'text'}" name="${name}"${raw(
          required,
        )}${raw(pattern)}${raw(placeholder)}>
      `;
    }),
  );
}
