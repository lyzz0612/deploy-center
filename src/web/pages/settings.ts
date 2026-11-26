/**
 * 设置分区页：CI key、平台 CLI、凭据、包类型、自检。
 *
 * 每个分区独立成页（`/settings/<section>`），不再把所有配置堆在一张长页里。
 * 新建类表单也退到各自的 `new` 页，列表页只负责看与改。
 */
import { listCiKeys, type CiKeySummary } from '../../auth/store.js';
import { listPackageTypes } from '../../catalog/index.js';
import { probeAllClis, type CliProbeResult } from '../../cli/index.js';
import { listCredentials, type CredentialSummary } from '../../credentials/index.js';
import type { Db } from '../../db/index.js';
import {
  checkStoredTargets,
  findCredentialType,
  listCredentialTypes,
  listTargetKinds,
  type CredentialType,
  type SelfCheckProblem,
} from '../../registry/index.js';
import { NotFoundError } from '../../shared/errors.js';
import {
  copyButton,
  emptyPanel,
  html,
  join,
  pageHeader,
  raw,
  sectionTitle,
  shortTime,
  type Html,
} from '../html.js';

/** 操作结果提示。由路由从 query 参数翻译过来。 */
export interface SettingsFlash {
  readonly message?: string;
  readonly error?: string;
}

function flashNotice(flash: SettingsFlash): Html {
  return html`
    ${flash.error === undefined ? html`` : html`<div class="notice err">${flash.error}</div>`}
    ${flash.message === undefined ? html`` : html`<div class="notice ok">${flash.message}</div>`}
  `;
}

/* --------------------------------- CI key --------------------------------- */

function keyCard(key: CiKeySummary): Html {
  const valueCell =
    key.value === null
      ? html`<p class="subtle" style="margin:10px 0 0">
          原文不可恢复（旧记录，或主密钥变更后解不开）。直接换一个新值即可。
        </p>`
      : html`
          <div class="key-value">
            <code id="key-${key.id}">${key.value}</code>
            ${copyButton(`#key-${key.id}`)}
          </div>
        `;

  return html`
    <div class="key-card">
      <div class="key-head">
        <div>
          <div class="key-title">
            <strong>${key.name}</strong>
          </div>
          <div class="key-meta">
            <span>创建 ${shortTime(key.createdAt)}</span>
            <span>最近使用 ${shortTime(key.lastUsedAt)}</span>
            <span>前缀 ${key.prefix}…</span>
          </div>
        </div>
        <div class="key-actions">
          <form
            method="post"
            action="/settings/ci-keys/${key.id}/delete"
            data-confirm="删除「${key.name}」？用它上报的 CI 会立即开始失败，且不可恢复。"
          >
            <button class="btn danger small" type="submit">删除</button>
          </form>
        </div>
      </div>

      ${valueCell}

      <details class="key-edit">
        <summary class="btn secondary small">更换值 / 改名</summary>
        <div class="key-edit-body">
          <form method="post" action="/settings/ci-keys/${key.id}">
            <div class="form-grid">
              <div class="field">
                <label>名称</label>
                <input type="text" name="name" value="${key.name}" required>
              </div>
              <div class="field">
                <label>新的 key 值</label>
                <input
                  type="text"
                  name="value"
                  placeholder="留空表示不改值"
                  autocomplete="off"
                  spellcheck="false"
                >
                <span class="hint">至少 8 个字符。保存后旧值立即失效。</span>
              </div>
            </div>
            <div class="form-actions" style="margin-top:16px;padding-top:14px">
              <button class="btn" type="submit">保存</button>
            </div>
          </form>
        </div>
      </details>
    </div>
  `;
}

export function ciKeysPage(db: Db, masterKey: string, flash: SettingsFlash = {}): Html {
  const keys = listCiKeys(db, masterKey);

  return html`
    ${pageHeader({
      title: 'CI key',
      lead: html`给 CI 上报构建用。<strong>值加密保存在本机</strong>，随时可以复制、改名或替换——
        自用后台不需要「只显示一次」的仪式。不用了直接删除，列表里不留已失效的记录。`,
    })}
    ${flashNotice(flash)}

    ${sectionTitle('用法')}
    <div class="panel">
      <div class="panel-body">
        <pre class="light">POST /api/ci/builds
Authorization: Bearer &lt;CI_KEY&gt;

# 或
X-CI-Key: &lt;CI_KEY&gt;</pre>
        <p class="subtle" style="margin-top:10px">
          上报契约与 GitHub Actions 示例见 <code>docs/ci-report.md</code>。
        </p>
      </div>
    </div>

    ${sectionTitle('全部 key', html`<span class="badge">${keys.length}</span>`)}
    <div class="panel">
      ${keys.length === 0
        ? html`<div class="panel-body">
            <p class="subtle" style="margin:0">还没有 CI key。在下面新建一个，或直接用你习惯的固定值。</p>
          </div>`
        : join(keys.map(keyCard))}
    </div>

    ${sectionTitle('新建 key')}
    <form class="panel" method="post" action="/settings/ci-keys">
      <div class="panel-body">
        <div class="form-grid">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" required placeholder="github-actions">
            <span class="hint">只用于在列表里区分来源。</span>
          </div>
          <div class="field">
            <label>值（可选）</label>
            <input
              type="text"
              name="value"
              placeholder="留空自动生成 256 位随机值"
              autocomplete="off"
              spellcheck="false"
            >
            <span class="hint">想用固定的值就直接填。至少 8 个字符。</span>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">保存 key</button>
          <span class="subtle">保存后可在上方随时查看和复制。</span>
        </div>
      </div>
    </form>
  `;
}

/* --------------------------------- 平台 CLI -------------------------------- */

function cliCard(cli: CliProbeResult): Html {
  return html`
    <div class="cli-card">
      <div class="cli-main">
        <div class="cli-title">
          <strong>${cli.displayName}</strong>
          <span class="badge ${raw(cli.install.ok ? 'ok' : 'err')}">
            ${cli.install.ok ? '可用' : '不可用'}
          </span>
          ${cli.installKind === 'manual'
            ? html`<span class="badge warn">需人工安装</span>`
            : html``}
        </div>
        <div class="cli-meta">
          ${cli.install.message}
          ${cli.install.detail === undefined
            ? html``
            : html`<div class="mono" style="margin-top:4px">${cli.install.detail}</div>`}
          ${cli.availableVersions.length === 0
            ? html``
            : html`<div style="margin-top:4px">
                已安装：${cli.availableVersions.join('、')}
                ${cli.version === null ? '' : `（当前 ${cli.version}）`}
              </div>`}
          ${cli.manualInstructions === undefined
            ? html``
            : html`<div style="margin-top:6px">${cli.manualInstructions}</div>`}
        </div>

        ${cli.availableVersions.length > 1
          ? html`
              <details class="cli-switch">
                <summary class="btn secondary small">切换版本</summary>
                <form
                  method="post"
                  action="/settings/cli/${cli.cliId}/switch"
                  style="margin-top:12px"
                >
                  <div class="form-grid">
                    <div class="field">
                      <label>当前版本</label>
                      <select name="version">
                        ${join(
                          cli.availableVersions.map(
                            (version) => html`
                              <option value="${version}"${raw(version === cli.version ? ' selected' : '')}>
                                ${version}
                              </option>
                            `,
                          ),
                        )}
                      </select>
                      <span class="hint">升级装坏了用这里回退。</span>
                    </div>
                    <div class="field" style="align-self:end">
                      <button class="btn secondary" type="submit">切换</button>
                    </div>
                  </div>
                </form>
              </details>
            `
          : html``}
      </div>

      <div class="cli-actions">
        ${cli.installKind === 'manual'
          ? html`<span class="subtle">只能人工安装</span>`
          : html`
              <form method="post" action="/settings/cli/${cli.cliId}/install">
                <button class="btn small" type="submit">
                  ${cli.installed ? '重新安装 / 升级' : '安装'}
                </button>
              </form>
            `}
      </div>
    </div>
  `;
}

export async function cliPage(
  cliHome: string,
  flash: SettingsFlash = {},
): Promise<Html> {
  const clis = await probeAllClis(cliHome);

  return html`
    ${pageHeader({
      title: '平台 CLI',
      lead: html`装在持久卷里，容器重建不丢。装 → 验 → 用都在这里可见；
        类型级与实例级检查在目标详情页现跑。`,
    })}
    ${flashNotice(flash)}
    ${clis.length === 0
      ? emptyPanel(html`没有注册任何 CLI。`)
      : html`<div class="panel">${join(clis.map(cliCard))}</div>`}
    <p class="subtle">
      安装是长任务，会投递到任务队列执行；投递后可在
      <a href="/releases">发布记录</a> 旁的任务状态里看进展。这里刷新页面只反映当前结果。
    </p>
  `;
}

/* --------------------------------- 凭据 --------------------------------- */

export function credentialsPage(db: Db, masterKey: string): Html {
  const credentials = listCredentials(db, masterKey);

  const rows = credentials.map(
    (credential) => html`
      <tr>
        <td>
          <div class="cell-title">${credential.name}</div>
          <div class="cell-sub">更新于 ${shortTime(credential.updatedAt)}</div>
        </td>
        <td>${credential.typeDisplayName}</td>
        <td>
          <span class="mono small">
            ${Object.entries(credential.fieldsSet)
              .map(([key, set]) => `${key}${set ? '✓' : '—'}`)
              .join(' ')}
          </span>
        </td>
        <td class="num">${credential.referenceCount}</td>
        <td>
          <div class="row-actions">
            ${credential.referenceCount === 0
              ? html`
                  <form
                    method="post"
                    action="/settings/credentials/${credential.id}/delete"
                    data-confirm="删除凭据「${credential.name}」？不可恢复。"
                  >
                    <button class="btn danger small" type="submit">删除</button>
                  </form>
                `
              : html`<span class="subtle small"
                  >被 ${String(credential.referenceCount)} 个目标引用，不能删除</span
                >`}
          </div>
        </td>
      </tr>
    `,
  );

  return html`
    ${pageHeader({
      title: '凭据',
      lead: html`加密存储，任何页面都不回显值，只显示哪些字段已设置。
        发布目标只引用凭据，所以轮换只改这一处；没有目标引用的可以直接删除。`,
      actions: html`<a class="btn" href="/settings/credentials/new">新建凭据</a>`,
    })}
    ${credentials.length === 0
      ? emptyPanel(
          html`<strong>还没有凭据</strong>平台密钥、私钥这类东西统一放这里，发布目标只引用它们。`,
          html`<a class="btn" href="/settings/credentials/new">创建第一个凭据</a>`,
        )
      : html`
          <div class="panel">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>名称</th><th>类型</th><th>字段</th><th>被引用</th><th></th></tr>
                </thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          </div>
        `}
  `;
}

function credentialFieldControl(type: CredentialType, key: string, required: boolean): Html {
  const requiredAttr = required ? ' required' : '';
  const field = type.fields.find((f) => f.key === key);
  const label = field?.label ?? key;
  const help = field?.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`;

  if (key === 'privateKey' || key === 'content') {
    return html`
      <div class="field span-2">
        <label>${label}${required ? '' : '（可选）'}${help}</label>
        <textarea name="secrets.${key}"${raw(requiredAttr)}></textarea>
      </div>
    `;
  }
  return html`
    <div class="field">
      <label>${label}${required ? '' : '（可选）'}${help}</label>
      <input type="password" name="secrets.${key}"${raw(requiredAttr)}>
    </div>
  `;
}

export function newCredentialPage(typeId?: string): Html {
  const types = listCredentialTypes();

  if (typeId === undefined) {
    const cards = types.map(
      (type) => html`
        <a class="target-card" href="/settings/credentials/new?type=${type.id}">
          <div class="target-card-head">
            <strong>${type.displayName}</strong>
            <span class="badge">${type.id}</span>
          </div>
          <p class="subtle" style="margin:0 0 8px">${type.description}</p>
          <div class="key-meta">
            <span>${type.fields.length} 个字段</span>
            <span>${type.fields.filter((f) => f.required).length} 个必填</span>
          </div>
        </a>
      `,
    );

    return html`
      ${pageHeader({
        title: '新建凭据',
        lead: html`先选择凭据类型。字段与加密方式由类型决定。`,
        actions: html`<a class="btn secondary" href="/settings/credentials">返回凭据列表</a>`,
      })}
      ${types.length === 0
        ? emptyPanel(html`没有注册任何凭据类型。`)
        : html`<div class="target-grid">${join(cards)}</div>`}
    `;
  }

  const type = findCredentialType(typeId);
  if (type === undefined) throw new NotFoundError(`凭据类型 ${typeId} 未注册`);

  return html`
    ${pageHeader({
      title: type.displayName,
      lead: html`${type.description}`,
      actions: html`
        <a class="btn secondary" href="/settings/credentials/new">换一种类型</a>
        <a class="btn secondary" href="/settings/credentials">返回凭据列表</a>
      `,
    })}
    <form class="panel" method="post" action="/settings/credentials">
      <div class="panel-body">
        <input type="hidden" name="type" value="${type.id}">
        <div class="form-grid">
          <div class="field span-2">
            <label>名称</label>
            <input type="text" name="name" required placeholder="R2 生产密钥" autofocus>
            <span class="hint">在选择凭据时显示。</span>
          </div>
          ${join(
            type.fields.map((field) => credentialFieldControl(type, field.key, field.required)),
          )}
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">创建凭据</button>
          <span class="subtle">值加密后保存，之后任何页面都不会回显。</span>
        </div>
      </div>
    </form>
  `;
}

/* -------------------------------- 包类型 -------------------------------- */

export function packageTypesPage(db: Db): Html {
  const types = listPackageTypes(db);

  const rows = types.map(
    (type) => html`
      <tr>
        <td><code>${type.id}</code></td>
        <td>${type.displayName}</td>
        <td>
          ${type.supportedBy.length === 0
            ? html`<span class="badge err">无目标类型接受</span>`
            : html`<span class="subtle">${type.supportedBy.join('、')}</span>`}
        </td>
        <td class="num">${type.buildCount}</td>
        <td>
          <div class="row-actions">
            ${type.buildCount === 0
              ? html`
                  <form
                    method="post"
                    action="/settings/package-types/${type.id}/delete"
                    data-confirm="删除包类型「${type.id}」？插件声明的类型下次启动会自动补回。"
                  >
                    <button class="btn danger small" type="submit">删除</button>
                  </form>
                `
              : html`<span class="subtle small"
                  >有 ${String(type.buildCount)} 条构建引用，不能删除</span
                >`}
          </div>
        </td>
      </tr>
    `,
  );

  return html`
    ${pageHeader({
      title: '包类型',
      lead: html`纯数据，新增不用改代码。但要能发布，需要有发布目标类型声明接受它。
        没有构建引用的可以直接删除——插件声明的类型（h5、wechat）删掉后下次启动会补回。`,
      actions: html`<a class="btn" href="/settings/package-types/new">新增包类型</a>`,
    })}
    ${types.length === 0
      ? emptyPanel(html`还没有包类型。`)
      : html`
          <div class="panel">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>标识</th><th>显示名</th><th>可发布到</th><th>构建数</th><th></th></tr>
                </thead>
                <tbody>${join(rows)}</tbody>
              </table>
            </div>
          </div>
        `}
  `;
}

export function newPackageTypePage(): Html {
  return html`
    ${pageHeader({
      title: '新增包类型',
      lead: html`它只是一个标签，不携带解压或处理策略。`,
      actions: html`<a class="btn secondary" href="/settings/package-types">返回包类型</a>`,
    })}
    <form class="panel" method="post" action="/settings/package-types">
      <div class="panel-body">
        <div class="form-grid">
          <div class="field">
            <label>标识</label>
            <input
              type="text"
              name="id"
              required
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="wechat"
              autofocus
            >
            <span class="hint">小写字母、数字与连字符，会出现在 CI 上报里。</span>
          </div>
          <div class="field">
            <label>显示名</label>
            <input type="text" name="displayName" required placeholder="微信小游戏">
          </div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">新增</button>
        </div>
      </div>
    </form>
  `;
}

/* --------------------------------- 自检 --------------------------------- */

export function selfCheckPage(db: Db): Html {
  const warnings: readonly SelfCheckProblem[] = checkStoredTargets(db);
  const kinds = listTargetKinds();

  const rows = kinds.map(
    (kind) => html`
      <tr>
        <td>
          <div class="cell-title">${kind.manifest.displayName}</div>
          <div class="cell-sub mono">${kind.manifest.id}</div>
        </td>
        <td class="subtle">${kind.manifest.accepts.join('、') || '（无）'}</td>
        <td class="subtle">${kind.manifest.requiresCredential ?? '不需要'}</td>
        <td class="subtle">${kind.manifest.requiresCli.join('、') || '不需要'}</td>
        <td class="subtle">
          ${{
            pointer: '指针回退',
            republish: '重新发布',
            none: '不支持',
          }[kind.manifest.capabilities.rollback]}
        </td>
      </tr>
    `,
  );

  return html`
    ${pageHeader({
      title: '自检',
      lead: html`注册表层面的问题会让进程启动失败；这里显示的是已注册类型与存量数据检查。`,
    })}

    ${sectionTitle('已注册的发布目标类型')}
    <div class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>类型</th><th>接受包类型</th><th>所需凭据</th><th>所需 CLI</th><th>回滚</th></tr>
          </thead>
          <tbody>${join(rows)}</tbody>
        </table>
      </div>
    </div>

    ${sectionTitle('存量数据检查')}
    <div class="panel">
      <div class="panel-body">
        ${warnings.length === 0
          ? html`<p class="subtle" style="color:var(--ok);margin:0">没有发现问题。</p>`
          : html`
              <ul class="blockers">
                ${join(warnings.map((warning) => html`<li>[${warning.where}] ${warning.message}</li>`))}
              </ul>
            `}
        <p class="subtle" style="margin:12px 0 0">
          能看到这个页面，说明注册表声明（类型、包类型、凭据、CLI 引用）在这一层都对得上。
        </p>
      </div>
    </div>
  `;
}