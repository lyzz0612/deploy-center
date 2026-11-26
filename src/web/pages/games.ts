/**
 * 游戏列表、游戏详情、发布目标详情与目标新增页。
 *
 * 列表页只负责「有哪些」；创建表单、环境检查、位置字段这些都退到二级页面，
 * 避免一屏塞进所有可操作的东西。
 */
import {
  checkKind,
  checkTarget,
  type KindStatus,
  type TargetStatus,
} from '../../cli/index.js';
import { getBuild } from '../../builds/index.js';
import {
  listGames,
  listPackageTypes,
  type Game,
  getGame,
} from '../../catalog/index.js';
import { listCredentials } from '../../credentials/index.js';
import type { Db } from '../../db/index.js';
import { listReleases } from '../../releases/index.js';
import { findTargetKind, listTargetKinds, type Field, type TargetKind } from '../../registry/index.js';
import { listTargets, type Target } from '../../targets/index.js';
import { NotFoundError } from '../../shared/errors.js';
import {
  copyButton,
  emptyPanel,
  esc,
  html,
  join,
  okBadge,
  pageHeader,
  raw,
  sectionTitle,
  shortTime,
  statusBadge,
  type Html,
} from '../html.js';

/* -------------------------------- 游戏列表 -------------------------------- */

export function gamesListPage(db: Db, flash: { message?: string } = {}): Html {
  const games = listGames(db);

  const rows = games.map((game) => {
    const targets = listTargets(db, { gameId: game.id });
    const builds = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM builds WHERE game_id = ?')
      .get(game.id);
    return html`
      <tr>
        <td>
          <div class="cell-title"><a href="/games/${game.slug}">${game.displayName}</a></div>
          <div class="cell-sub">创建于 ${shortTime(game.createdAt)}</div>
        </td>
        <td><code>${game.slug}</code></td>
        <td class="num">${targets.length}</td>
        <td class="num">${builds?.n ?? 0}</td>
        <td><a class="btn secondary small" href="/games/${game.slug}">详情</a></td>
      </tr>
    `;
  });

  const table =
    games.length === 0
      ? emptyPanel(
          html`<strong>还没有游戏</strong>
            每款游戏有自己的发布目标与构建历史。先登记一款游戏，CI 才能上报构建。`,
          html`<a class="btn" href="/games/new">登记第一款游戏</a>`,
        )
      : html`
          <div class="panel">
            <div class="panel-head">
              <span class="panel-title">全部游戏</span>
              <span class="subtle">${games.length} 款</span>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>游戏</th><th>slug</th><th>发布目标</th><th>构建</th><th></th></tr>
                </thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          </div>
        `;

  return html`
    ${pageHeader({
      title: '游戏',
      lead: html`每款游戏有独立的发布目标与构建历史。slug 会出现在 CI 上报里，创建后不可更改。`,
      actions: html`<a class="btn" href="/games/new">新建游戏</a>`,
    })}
    ${flash.message === undefined
      ? html``
      : html`<div class="notice ok">${flash.message}</div>`}
    ${table}
  `;
}

/* -------------------------------- 新建游戏 -------------------------------- */

export function newGamePage(): Html {
  return html`
    ${pageHeader({
      title: '新建游戏',
      lead: html`登记之后，CI 才能用这个 slug 上报构建。`,
      actions: html`<a class="btn secondary" href="/">返回游戏列表</a>`,
    })}
    <form class="panel" method="post" action="/games">
      <div class="panel-body">
        <div class="form-grid">
          <div class="field">
            <label>slug</label>
            <input
              type="text"
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="demo"
              autofocus
            >
            <span class="hint">
              小写字母、数字与连字符。会出现在 CI 上报与产物路径里，创建后不可更改。
            </span>
          </div>
          <div class="field">
            <label>显示名</label>
            <input type="text" name="displayName" required placeholder="示例游戏">
            <span class="hint">可以随时改，只影响界面显示。</span>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">创建游戏</button>
          <span class="subtle">slug 一旦确定，历史构建都会与它绑定。</span>
        </div>
      </div>
    </form>
  `;
}

/* -------------------------------- 游戏详情 -------------------------------- */

export interface GameDetailDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
}

function renderLocation(location: Record<string, unknown>): Html {
  const entries = Object.entries(location);
  if (entries.length === 0) return html`<span class="subtle">（无位置字段）</span>`;
  return html`
    <div class="loc-summary">
      ${join(
        entries.map(
          ([key, value]) => html`
            <div><span class="loc-key">${key}</span><span class="mono">${String(value)}</span></div>
          `,
        ),
      )}
    </div>
  `;
}

export async function gameDetailPage(deps: GameDetailDeps, game: Game): Promise<Html> {
  const { db } = deps;
  const targets = listTargets(db, { gameId: game.id });
  const credentials = listCredentials(db, deps.masterKey);
  const credentialName = new Map(credentials.map((c) => [c.id, c.name]));
  const packageTypes = listPackageTypes(db);

  const buildCount =
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM builds WHERE game_id = ?')
      .get(game.id)?.n ?? 0;
  const releaseCount =
    db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM releases r
         JOIN targets t ON t.id = r.target_id
         WHERE t.game_id = ?`,
      )
      .get(game.id)?.n ?? 0;

  const rows = targets.map((target) => {
    return html`
      <tr>
        <td>
          <div class="cell-title">
            <a href="/targets/${target.id}">${target.name}</a>
          </div>
          <div class="cell-sub">${target.kindDisplayName}</div>
        </td>
        <td>
          ${renderLocation(target.location)}
          ${target.credentialId === null
            ? html`<div class="cell-sub">不需要凭据</div>`
            : html`<div class="cell-sub">凭据：${credentialName.get(target.credentialId) ?? '（已删除）'}</div>`}
        </td>
        <td class="num">${target.releaseCount}</td>
        <td class="subtle">${shortTime(target.updatedAt)}</td>
        <td>
          <div class="row-actions">
            <a class="btn secondary small" href="/targets/${target.id}">环境检查</a>
          </div>
        </td>
      </tr>
    `;
  });

  const targetSection =
    targets.length === 0
      ? emptyPanel(
          html`<strong>还没有发布目标</strong>
            目标决定「发到哪」：一个微信号、一个 H5 桶、一个服务器目录。`,
          html`<a class="btn" href="/games/${game.slug}/targets/new">添加第一个发布目标</a>`,
        )
      : html`
          <div class="panel">
            <div class="panel-head">
              <span class="panel-title">发布目标</span>
              <span class="subtle">${String(targets.length)} 个</span>
            </div>
            <div class="table-wrap">
              <table class="table targets-table">
                <thead>
                  <tr><th>目标</th><th>位置 / 凭据</th><th>发布记录</th><th>更新</th><th></th></tr>
                </thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          </div>
        `;

  const orphanTypes = packageTypes.filter((type) => type.supportedBy.length === 0);

  return html`
    ${pageHeader({
      title: game.displayName,
      lead: html`<code>${game.slug}</code> · ${targets.length} 个发布目标 ·
        ${buildCount} 条构建 · ${releaseCount} 条发布记录`,
      actions: html`
        <a class="btn secondary" href="/builds?game=${game.slug}">查看构建</a>
        <a class="btn" href="/games/${game.slug}/targets/new">添加发布目标</a>
      `,
    })}

    ${orphanTypes.length === 0
      ? html``
      : html`
          <div class="notice warn">
            <span>
              这些包类型没有任何发布目标类型接受，上报的包将无法发布：
              <strong>${orphanTypes.map((t) => t.id).join('、')}</strong>
            </span>
          </div>
        `}

    ${targetSection}

    ${sectionTitle('环境检查')}
    <div class="panel">
      <div class="panel-body">
        <p class="subtle" style="margin:0">
          环境与连通性检查在目标详情页现跑：列表页不主动探测平台，避免每次打开都等网络。
          最近发布可以从 <a href="/releases">发布记录</a> 查看。
        </p>
      </div>
    </div>

    ${sectionTitle('删除这个游戏')}
    <div class="panel">
      <div class="panel-body">
        <p style="margin:0 0 12px">
          删除会连带删掉这个游戏名下的
          <strong>${String(targets.length)} 个发布目标</strong>、
          <strong>${String(buildCount)} 条构建记录</strong>与
          <strong>${String(releaseCount)} 条发布记录</strong>。
          <span class="subtle">不可恢复，也不会留下历史。</span>
        </p>
        <form
          method="post"
          action="/games/${game.slug}/delete"
          data-confirm="确认删除「${game.displayName}」及其名下全部数据？不可恢复。"
        >
          <div class="form-grid">
            <div class="field">
              <label>输入 slug <code>${game.slug}</code> 以确认</label>
              <input type="text" name="confirmSlug" required autocomplete="off" spellcheck="false">
              <span class="hint">这一步是刻意的：删除没有撤销入口。</span>
            </div>
          </div>
          <div class="form-actions" style="margin-top:16px;padding-top:14px">
            <button class="btn danger" type="submit">删除游戏及其全部数据</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/* ------------------------------ 新增发布目标 ------------------------------ */

export interface NewTargetPageData {
  readonly game: Game;
  readonly kindId?: string;
}

function renderFields(fields: readonly Field[], namePrefix: string): Html {
  return join(
    fields.map((field) => {
      const name = `${namePrefix}.${field.key}`;
      const required = field.required ? ' required' : '';
      const hint =
        field.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`;

      if (field.type === 'boolean') {
        return html`
          <div class="field span-2">
            <label class="check-label">
              <input type="checkbox" name="${name}" value="true"${raw(required)}>
              <span>${field.label}${hint}</span>
            </label>
          </div>
        `;
      }
      if (field.type === 'select') {
        const options = (field.options ?? []).map(
          (option) => html`<option value="${option.value}">${option.label}</option>`,
        );
        return html`
          <div class="field">
            <label>${field.label}${hint}</label>
            <select name="${name}"${raw(required)}>${join(options)}</select>
          </div>
        `;
      }
      const inputType = field.type === 'number' ? 'number' : 'text';
      const pattern = field.pattern === undefined ? '' : ` pattern="${esc(field.pattern)}"`;
      const placeholder =
        field.placeholder === undefined ? '' : ` placeholder="${esc(field.placeholder)}"`;
      return html`
        <div class="field">
          <label>${field.label}${hint}</label>
          <input type="${inputType}" name="${name}"${raw(required)}${raw(pattern)}${raw(placeholder)}>
        </div>
      `;
    }),
  );
}

export function newTargetPage(deps: GameDetailDeps, data: NewTargetPageData): Html {
  const { game, kindId } = data;
  const kinds = listTargetKinds();

  if (kindId === undefined) {
    const cards = kinds.map(
      (kind) => html`
        <a class="target-card" href="/games/${game.slug}/targets/new?kind=${kind.manifest.id}">
          <div class="target-card-head">
            <strong>${kind.manifest.displayName}</strong>
            <span class="badge">${kind.manifest.id}</span>
          </div>
          <p class="subtle" style="margin:0 0 8px">${kind.manifest.description}</p>
          <div class="key-meta">
            <span>接受：${kind.manifest.accepts.join('、') || '（无）'}</span>
            <span>凭据：${kind.manifest.requiresCredential ?? '不需要'}</span>
            <span>回滚：${rollbackLabel(kind)}</span>
          </div>
        </a>
      `,
    );

    return html`
      ${pageHeader({
        title: '添加发布目标',
        lead: html`为 <strong>${game.displayName}</strong> 选择一种目标类型。字段形状由类型决定。`,
        actions: html`<a class="btn secondary" href="/games/${game.slug}">返回游戏</a>`,
      })}
      ${kinds.length === 0
        ? emptyPanel(html`还没有注册任何发布目标类型。`)
        : html`<div class="target-grid">${join(cards)}</div>`}
    `;
  }

  const kind: TargetKind = findTargetKind(kindId) ?? failKind(kindId);
  const needs = kind.manifest.requiresCredential;
  const credentials = listCredentials(deps.db, deps.masterKey).filter(
    (credential) => needs !== null && credential.type === needs,
  );

  const credentialField =
    needs === null
      ? html`
          <div class="field">
            <label>凭据</label>
            <p class="subtle" style="margin:0">该类型不需要凭据。</p>
          </div>
        `
      : credentials.length === 0
        ? html`
            <div class="field">
              <label>凭据</label>
              <div class="notice warn" style="margin:0">
                还没有 <strong>${needs}</strong> 类型的凭据。
                发布目标只引用凭据，不自己存密钥。
                <a href="/settings/credentials/new?type=${needs}">先创建一个 →</a>
              </div>
            </div>
          `
        : html`
            <div class="field">
              <label>凭据</label>
              <select name="credentialId" required>
                ${join(credentials.map((c) => html`<option value="${c.id}">${c.name}</option>`))}
              </select>
              <span class="hint">只列出类型匹配的。密钥本身在凭据里，不在这里填。</span>
            </div>
          `;

  const disabled = needs !== null && credentials.length === 0;

  return html`
    ${pageHeader({
      title: kind.manifest.displayName,
      lead: html`在 <strong>${game.displayName}</strong> 下新增一个发布目标。`,
      actions: html`
        <a class="btn secondary" href="/games/${game.slug}/targets/new">换一种类型</a>
        <a class="btn secondary" href="/games/${game.slug}">返回游戏</a>
      `,
    })}

    <form class="panel" method="post" action="/games/${game.slug}/targets">
      <div class="panel-body">
        <input type="hidden" name="kind" value="${kind.manifest.id}">

        <div class="form-grid">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" required placeholder="微信正式号" autofocus>
            <span class="hint">用于在列表里区分，例如「微信正式号」「R2 生产」。</span>
          </div>
          ${credentialField}
          ${renderFields(kind.manifest.targetFields, 'location')}
        </div>

        <div class="form-actions">
          <button class="btn" type="submit"${raw(disabled ? ' disabled' : '')}>
            ${disabled ? '缺少凭据，无法创建' : '创建发布目标'}
          </button>
          <span class="subtle">
            位置相同的同类型目标会被拒绝：它们会互相覆盖。
          </span>
        </div>
      </div>
    </form>
  `;
}

function failKind(kindId: string): never {
  throw new NotFoundError(`发布目标类型 ${kindId} 未注册`);
}

function rollbackLabel(kind: TargetKind): string {
  return {
    pointer: '指针回退',
    republish: '重新发布',
    none: '不支持',
  }[kind.manifest.capabilities.rollback];
}

/** 发布记录里存的是构建主键，界面要显示构建标识。 */
function buildLabel(db: Db, buildPk: string): string {
  try {
    return getBuild(db, buildPk).buildId;
  } catch {
    return buildPk;
  }
}

/* ------------------------------ 发布目标详情 ------------------------------ */

function renderCheckRow(
  name: string,
  ok: boolean,
  message: string,
  detail: string | null,
  okLabel = '通过',
): Html {
  return html`
    <tr>
      <td>
        <div class="cell-title">${name}</div>
        ${detail === null ? html`` : html`<div class="cell-sub mono">${detail}</div>`}
      </td>
      <td>${okBadge(ok, okLabel, '未通过')}</td>
      <td class="subtle">${message}</td>
    </tr>
  `;
}

function renderKindChecks(status: KindStatus): Html {
  const cliRows = status.clis.map((cli) =>
    renderCheckRow(
      cli.displayName,
      cli.install.ok,
      cli.install.message,
      cli.install.detail ?? null,
      '可用',
    ),
  );
  const checkRows = status.checks.map((check) =>
    renderCheckRow(check.name, check.result.ok, check.result.message, check.result.detail ?? null),
  );
  const rows = [...cliRows, ...checkRows];

  return html`
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">类型级检查</span>
        <span>${okBadge(status.ok, '就绪', '未就绪')}</span>
      </div>
      ${rows.length === 0
        ? html`<div class="panel-body">
            <p class="subtle" style="margin:0">该类型不依赖 CLI，也没有声明类型级检查。</p>
          </div>`
        : html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          `}
      ${status.ok
        ? html``
        : html`<div class="panel-body" style="border-top:1px solid var(--line-soft)">
            <p class="subtle" style="margin:0">
              类型级问题会挡住该类型下所有实例的发布。
              <a href="/settings/cli">到平台 CLI 页安装或升级 →</a>
            </p>
          </div>`}
    </div>
  `;
}

function renderTargetChecks(status: TargetStatus): Html {
  if (status.checks.length === 0) {
    return html`
      <div class="panel">
        <div class="panel-head"><span class="panel-title">实例级检查</span></div>
        <div class="panel-body">
          <p class="subtle" style="margin:0">该类型没有声明实例级检查。</p>
        </div>
      </div>
    `;
  }

  return html`
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">实例级检查</span>
        <span>${okBadge(status.ok, '通过', '未通过')}</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead>
          <tbody>
            ${join(
              status.checks.map((check) =>
                renderCheckRow(
                  check.name,
                  check.result.ok,
                  check.result.message,
                  check.result.detail ?? null,
                ),
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export async function targetDetailPage(
  deps: GameDetailDeps,
  target: Target,
  flash: { message?: string } = {},
): Promise<Html> {
  const { db } = deps;
  let game: Game | undefined;
  try {
    game = getGame(db, target.gameId);
  } catch {
    game = undefined;
  }

  const credentials = listCredentials(db, deps.masterKey);
  const credential = credentials.find((c) => c.id === target.credentialId) ?? null;
  const releases = listReleases(db, { targetId: target.id, limit: 12 });

  let kindStatus: KindStatus | undefined;
  let kindError: string | undefined;
  try {
    kindStatus = await checkKind(deps.cliHome, target.kind);
  } catch (error) {
    kindError = error instanceof Error ? error.message : String(error);
  }

  let targetStatus: TargetStatus | undefined;
  let targetError: string | undefined;
  try {
    targetStatus = await checkTarget(deps, target.id);
  } catch (error) {
    targetError = error instanceof Error ? error.message : String(error);
  }

  const kind = findTargetKind(target.kind);
  const releaseRows = releases.map(
    (release) => html`
      <tr>
        <td>${statusBadge(release.status)}</td>
        <td><code>${buildLabel(db, release.buildId)}</code></td>
        <td class="subtle">${shortTime(release.createdAt)}</td>
        <td>
          <div class="row-actions">
            <a class="btn secondary small" href="/releases/${release.id}">详情</a>
          </div>
        </td>
      </tr>
    `,
  );

  const locationEntries = Object.entries(target.location);

  return html`
    ${pageHeader({
      title: html`${target.name}`,
      lead: html`${target.kindDisplayName} · ${game === undefined
        ? '游戏已不存在'
        : html`<a href="/games/${game.slug}">${game.displayName}</a>`}`,
      actions: html`
        ${game === undefined
          ? html``
          : html`<a class="btn" href="/games/${game.slug}">返回游戏</a>`}
      `,
    })}
    ${flash.message === undefined
      ? html``
      : html`<div class="notice ok">${flash.message}</div>`}

    ${sectionTitle('配置')}
    <div class="panel">
      <div class="panel-body">
        <dl class="meta">
          <dt>目标类型</dt>
          <dd>${target.kindDisplayName} <code>${target.kind}</code></dd>
          <dt>接受包类型</dt>
          <dd>${target.accepts.join('、') || '（无）'}</dd>
          <dt>凭据</dt>
          <dd>${target.credentialId === null
            ? '不需要'
            : credential === null
              ? '原凭据已被删除'
              : credential.name}</dd>
          <dt>位置</dt>
          <dd>
            ${locationEntries.length === 0
              ? '（无）'
              : join(
                  locationEntries.map(
                    ([key, value]) => html`<div><code>${key}</code> ${String(value)}</div>`,
                  ),
                )}
          </dd>
          <dt>创建 / 更新</dt>
          <dd>${shortTime(target.createdAt)} / ${shortTime(target.updatedAt)}</dd>
          <dt>回滚能力</dt>
          <dd>${kind === undefined ? '类型未注册' : rollbackLabel(kind)}</dd>
          <dt>目标 ID</dt>
          <dd>
            <code id="target-id">${target.id}</code>
            ${copyButton('#target-id', '复制')}
          </dd>
        </dl>
      </div>
    </div>

    ${sectionTitle('环境检查')}
    ${kindError === undefined
      ? kindStatus === undefined
        ? html``
        : renderKindChecks(kindStatus)
      : html`<div class="notice err">类型级检查未能执行：${kindError}</div>`}
    ${targetError === undefined
      ? targetStatus === undefined
        ? html``
        : renderTargetChecks(targetStatus)
      : html`<div class="notice err">实例级检查未能执行：${targetError}</div>`}

    ${sectionTitle('最近发布')}
    ${releases.length === 0
      ? emptyPanel(
          html`<strong>这个目标还没有发布记录</strong>到构建列表里挑一个包发布。`,
          html`<a class="btn" href="/builds">前往构建列表</a>`,
        )
      : html`
          <div class="panel">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>状态</th><th>构建</th><th>发起</th><th></th></tr></thead>
                <tbody>${join(releaseRows)}</tbody>
              </table>
            </div>
          </div>
        `}

    ${sectionTitle('删除这个目标')}
    <div class="panel">
      <div class="panel-body">
        ${target.releaseCount === 0
          ? html`
              <p class="subtle" style="margin:0 0 12px">没有发布记录引用它，可以直接删除。</p>
              <form
                method="post"
                action="/targets/${target.id}/delete"
                data-confirm="删除发布目标「${target.name}」？不可恢复。"
              >
                <button class="btn danger" type="submit">删除目标</button>
              </form>
            `
          : html`
              <p style="margin:0 0 12px">
                有 <strong>${String(target.releaseCount)} 条发布记录</strong>引用它，所以不能直接删。
                <span class="subtle"
                  >发布历史是「线上曾经是什么版本」的唯一记录，不该被删目标的动作顺手带走。</span
                >
              </p>
              <form
                method="post"
                action="/targets/${target.id}/releases/purge"
                data-confirm="清除「${target.name}」名下已结束的发布记录？不可恢复。正在执行的会保留。"
              >
                <button class="btn danger" type="submit">
                  先清除已结束的发布记录（${String(target.releaseCount)} 条中已结束的部分）
                </button>
              </form>
            `}
      </div>
    </div>
  `;
}