/**
 * 游戏列表与游戏详情页（11.1）。
 */
import { checkKind, checkTarget, type KindStatus, type TargetStatus } from '../../cli/index.js';
import { listGames, listPackageTypes, type Game } from '../../catalog/index.js';
import { listCredentials } from '../../credentials/index.js';
import type { Db } from '../../db/index.js';
import { listTargetKinds, type Field } from '../../registry/index.js';
import { listTargets, type Target } from '../../targets/index.js';
import { esc, html, join, raw, shortTime, type Html } from '../html.js';

export function gamesListPage(db: Db): Html {
  const games = listGames(db);

  const rows = games.map((game) => {
    const targets = listTargets(db, { gameId: game.id });
    const builds = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM builds WHERE game_id = ?')
      .get(game.id);
    return html`
      <tr>
        <td><a href="/games/${game.slug}">${game.displayName}</a></td>
        <td><code>${game.slug}</code></td>
        <td class="num">${targets.length}</td>
        <td class="num">${builds?.n ?? 0}</td>
        <td class="muted small">${shortTime(game.createdAt)}</td>
      </tr>
    `;
  });

  const table =
    games.length === 0
      ? html`<p class="empty">还没有游戏。下面创建第一个。</p>`
      : html`
          <table>
            <thead>
              <tr><th>游戏</th><th>slug</th><th>发布目标</th><th>构建</th><th>创建时间</th></tr>
            </thead>
            <tbody>${join(rows)}</tbody>
          </table>
        `;

  return html`
    <h1>游戏</h1>
    <p class="lead">每款游戏有自己的发布目标与构建历史。</p>
    <div class="card">${table}</div>

    <h2>新建游戏</h2>
    <form class="card" method="post" action="/games">
      <div class="row">
        <div>
          <label>slug
            <span class="hint">小写字母、数字与连字符。创建后不可更改——它会出现在 CI 上报里。</span>
          </label>
          <input type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="demo">
        </div>
        <div>
          <label>显示名<span class="hint">可以随时改。</span></label>
          <input type="text" name="displayName" required placeholder="示例游戏">
        </div>
      </div>
      <p><button type="submit">创建</button></p>
    </form>
  `;
}

/** 渲染一组字段为表单控件。 */
function renderFields(fields: readonly Field[], namePrefix: string): Html {
  return join(
    fields.map((field) => {
      const name = `${namePrefix}.${field.key}`;
      const required = field.required ? ' required' : '';
      const hint =
        field.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`;

      if (field.type === 'boolean') {
        return html`
          <label>
            <input type="checkbox" name="${name}" value="true"${raw(required)}>
            ${field.label}
            ${hint}
          </label>
        `;
      }
      if (field.type === 'select') {
        const options = (field.options ?? []).map(
          (option) => html`<option value="${option.value}">${option.label}</option>`,
        );
        return html`
          <label>${field.label}${hint}</label>
          <select name="${name}"${raw(required)}>${join(options)}</select>
        `;
      }
      const inputType = field.type === 'number' ? 'number' : 'text';
      const pattern = field.pattern === undefined ? '' : ` pattern="${esc(field.pattern)}"`;
      const placeholder =
        field.placeholder === undefined ? '' : ` placeholder="${esc(field.placeholder)}"`;
      return html`
        <label>${field.label}${hint}</label>
        <input type="${inputType}" name="${name}"${raw(required)}${raw(pattern)}${raw(placeholder)}>
      `;
    }),
  );
}

function renderCheckList(checks: TargetStatus['checks']): Html {
  if (checks.length === 0) {
    return html`<p class="muted small">该类型没有声明实例级检查。</p>`;
  }
  return html`
    <table class="small">
      <tbody>
        ${join(
          checks.map(
            (check) => html`
              <tr>
                <td style="width:160px">${check.name}</td>
                <td>
                  <span class="badge ${raw(check.result.ok ? 'ok' : 'err')}">
                    ${check.result.ok ? '通过' : '未通过'}
                  </span>
                </td>
                <td>
                  ${check.result.message}
                  ${check.result.detail === undefined
                    ? html``
                    : html`<div class="muted mono">${check.result.detail}</div>`}
                </td>
              </tr>
            `,
          ),
        )}
      </tbody>
    </table>
  `;
}

export interface GameDetailDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
}

export async function gameDetailPage(deps: GameDetailDeps, game: Game): Promise<Html> {
  const { db } = deps;
  const targets = listTargets(db, { gameId: game.id, includeArchived: true });
  const kinds = listTargetKinds();
  const credentials = listCredentials(db, deps.masterKey);
  const packageTypes = listPackageTypes(db);

  // 类型级检查按 kind 跑一次，而不是每个实例一次。同类型的三个微信号
  // 不该显示三份重复的 CLI 状态（publish-targets spec：环境检测分两级）。
  const usedKinds = [...new Set(targets.filter((t) => t.archivedAt === null).map((t) => t.kind))];
  const kindStatuses = new Map<string, KindStatus>();
  for (const kindId of usedKinds) {
    try {
      kindStatuses.set(kindId, await checkKind(deps.cliHome, kindId));
    } catch {
      // 插件下线时不该让整页打不开
    }
  }

  const targetStatuses = new Map<string, TargetStatus>();
  for (const target of targets) {
    if (target.archivedAt !== null) continue;
    try {
      targetStatuses.set(target.id, await checkTarget(deps, target.id));
    } catch {
      // 凭据解不开等问题在下面以「检查未执行」呈现
    }
  }

  const kindSection =
    usedKinds.length === 0
      ? html``
      : html`
          <h2>类型级检查</h2>
          <p class="lead small">同类型的实例共享这份结果，不逐个重复探测。</p>
          ${join(
            usedKinds.map((kindId) => {
              const status = kindStatuses.get(kindId);
              if (status === undefined) {
                return html`<div class="card"><strong>${kindId}</strong>
                  <span class="badge err">类型未注册</span></div>`;
              }
              return html`
                <div class="card">
                  <strong>${status.displayName}</strong>
                  <span class="badge ${raw(status.ok ? 'ok' : 'err')}">
                    ${status.ok ? '就绪' : '未就绪'}
                  </span>
                  ${status.clis.length === 0
                    ? html`<p class="muted small">不依赖任何 CLI。</p>`
                    : html`
                        <table class="small">
                          <tbody>
                            ${join(
                              status.clis.map(
                                (cli) => html`
                                  <tr>
                                    <td style="width:200px">${cli.displayName}</td>
                                    <td>
                                      <span class="badge ${raw(cli.install.ok ? 'ok' : 'err')}">
                                        ${cli.install.ok ? '可用' : '不可用'}
                                      </span>
                                    </td>
                                    <td>${cli.install.message}</td>
                                  </tr>
                                `,
                              ),
                            )}
                          </tbody>
                        </table>
                        ${status.ok
                          ? html``
                          : html`<p class="small"><a href="/settings">到设置页安装 CLI →</a></p>`}
                      `}
                </div>
              `;
            }),
          )}
        `;

  const targetCards =
    targets.length === 0
      ? html`<p class="empty">还没有发布目标。</p>`
      : join(
          targets.map((target) => {
            const status = targetStatuses.get(target.id);
            const credential =
              target.credentialId === null
                ? null
                : (credentials.find((c) => c.id === target.credentialId) ?? null);
            return html`
              <div class="card">
                <div class="row">
                  <div style="flex: 2 1 320px">
                    <strong>${target.name}</strong>
                    ${target.archivedAt === null
                      ? html``
                      : html`<span class="badge">已归档</span>`}
                    <div class="muted small">
                      ${target.kindDisplayName} · 接受 ${target.accepts.join('、') || '（无）'}
                    </div>
                    <div class="small mono">${JSON.stringify(target.location)}</div>
                    <div class="small muted">
                      凭据：${credential === null ? '不需要' : credential.name}
                      · 发布记录 ${target.releaseCount} 条
                    </div>
                  </div>
                  <div>
                    ${target.archivedAt === null
                      ? html`
                          <form class="inline" method="post" action="/targets/${target.id}/archive">
                            <button class="secondary" type="submit">归档</button>
                          </form>
                        `
                      : html`
                          <form class="inline" method="post" action="/targets/${target.id}/unarchive">
                            <button class="secondary" type="submit">取消归档</button>
                          </form>
                        `}
                  </div>
                </div>
                ${target.archivedAt === null && status !== undefined
                  ? renderCheckList(status.checks)
                  : html``}
              </div>
            `;
          }),
        );

  // 每个 kind 一个表单：字段形状不同，不能共用一个
  const addForms = join(
    kinds.map((kind) => {
      const needs = kind.manifest.requiresCredential;
      const usable =
        needs === null ? [] : credentials.filter((c) => c.type === needs && c.archivedAt === null);
      const credentialField =
        needs === null
          ? html`<p class="small muted">该类型不需要凭据。</p>`
          : usable.length === 0
            ? html`
                <p class="small" style="color:var(--err)">
                  还没有 ${needs} 类型的凭据。
                  <a href="/settings#credentials">先创建一个 →</a>
                </p>
              `
            : html`
                <label>凭据<span class="hint">只列出类型匹配的。密钥本身在凭据里，不在这里填。</span></label>
                <select name="credentialId" required>
                  ${join(usable.map((c) => html`<option value="${c.id}">${c.name}</option>`))}
                </select>
              `;

      return html`
        <details class="card">
          <summary><strong>${kind.manifest.displayName}</strong>
            <span class="muted small"> — ${kind.manifest.description}</span></summary>
          <form method="post" action="/games/${game.slug}/targets">
            <input type="hidden" name="kind" value="${kind.manifest.id}">
            <label>名称<span class="hint">用于在列表里区分，例如「微信正式号」。</span></label>
            <input type="text" name="name" required>
            ${credentialField}
            ${renderFields(kind.manifest.targetFields, 'location')}
            <p>
              <button type="submit"${raw(needs !== null && usable.length === 0 ? ' disabled' : '')}>
                添加目标
              </button>
            </p>
          </form>
        </details>
      `;
    }),
  );

  const orphanTypes = packageTypes.filter((t) => t.supportedBy.length === 0);

  return html`
    <h1>${game.displayName}</h1>
    <p class="lead">
      <code>${game.slug}</code>
      ${game.archivedAt === null ? html`` : html`<span class="badge">已归档</span>`}
      · <a href="/builds?game=${game.slug}">查看构建</a>
    </p>

    ${orphanTypes.length === 0
      ? html``
      : html`
          <div class="notice">
            这些包类型没有任何发布目标类型接受它，上报的包将无法发布：
            ${orphanTypes.map((t) => t.id).join('、')}
          </div>
        `}

    <h2>发布目标</h2>
    ${targetCards}

    <h2>添加发布目标</h2>
    ${addForms}

    ${kindSection}
  `;
}
