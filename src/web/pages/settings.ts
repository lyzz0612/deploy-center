/**
 * 全局设置页（11.5）：CI key、包类型、凭据、CLI 管理、自检结果。
 */
import { listCiKeys, type CiKeySummary } from '../../auth/store.js';
import { listPackageTypes } from '../../catalog/index.js';
import { probeAllClis, type CliProbeResult } from '../../cli/index.js';
import { listCredentials, type CredentialSummary } from '../../credentials/index.js';
import type { Db } from '../../db/index.js';
import {
  checkStoredTargets,
  listCredentialTypes,
  listTargetKinds,
  type SelfCheckProblem,
} from '../../registry/index.js';
import { html, join, raw, shortTime, type Html } from '../html.js';

export interface SettingsDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly cliHome: string;
}

/** 刚签发的 CI key，明文只在这一次显示。 */
export interface SettingsFlash {
  readonly issuedKey?: { readonly name: string; readonly key: string };
  readonly message?: string;
  readonly error?: string;
}

function ciKeySection(keys: readonly CiKeySummary[], flash: SettingsFlash): Html {
  const issued =
    flash.issuedKey === undefined
      ? html``
      : html`
          <div class="notice ok">
            <strong>${flash.issuedKey.name}</strong> 已签发。
            <strong>明文只显示这一次</strong>，立刻存进 CI 的 secret：
            <pre>${flash.issuedKey.key}</pre>
          </div>
        `;

  const rows = keys.map(
    (key) => html`
      <tr>
        <td>${key.name}</td>
        <td><code>${key.prefix}…</code></td>
        <td class="muted small">${shortTime(key.createdAt)}</td>
        <td class="muted small">${shortTime(key.lastUsedAt)}</td>
        <td>
          ${key.revokedAt === null
            ? html`
                <form class="inline" method="post" action="/settings/ci-keys/${key.id}/revoke">
                  <button class="secondary" type="submit">吊销</button>
                </form>
              `
            : html`<span class="badge">已吊销</span>`}
        </td>
      </tr>
    `,
  );

  return html`
    <h2 id="ci-keys">CI key</h2>
    <p class="lead small">
      给 CI 上报构建用。只存哈希，签发后无法再取回明文。
      可以签发多个，便于按流水线区分来源与单独吊销。
    </p>
    ${issued}
    <div class="card">
      ${keys.length === 0
        ? html`<p class="empty">还没有 CI key。</p>`
        : html`
            <table>
              <thead>
                <tr><th>名称</th><th>前缀</th><th>创建</th><th>最近使用</th><th></th></tr>
              </thead>
              <tbody>${join(rows)}</tbody>
            </table>
          `}
      <form method="post" action="/settings/ci-keys" style="margin-top:14px">
        <div class="row">
          <div>
            <label>名称<span class="hint">例如 github-actions。</span></label>
            <input type="text" name="name" required>
          </div>
          <div style="flex:0 0 auto; align-self:flex-end">
            <button type="submit">签发</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function cliSection(clis: readonly CliProbeResult[]): Html {
  return html`
    <h2 id="cli">平台 CLI</h2>
    <p class="lead small">
      装在持久卷里，容器重建不丢。探测分三层：安装完好 / 凭据可用 / 平台可达——
      后两层在各发布目标上单独显示（见游戏详情页）。
    </p>
    ${join(
      clis.map(
        (cli) => html`
          <div class="card">
            <div class="row">
              <div style="flex:2 1 300px">
                <strong>${cli.displayName}</strong>
                <span class="badge ${raw(cli.install.ok ? 'ok' : 'err')}">
                  ${cli.install.ok ? '可用' : '不可用'}
                </span>
                ${cli.installKind === 'manual'
                  ? html`<span class="badge warn">需人工安装</span>`
                  : html``}
                <div class="small">${cli.install.message}</div>
                ${cli.install.detail === undefined
                  ? html``
                  : html`<div class="muted mono small">${cli.install.detail}</div>`}
                ${cli.availableVersions.length === 0
                  ? html``
                  : html`
                      <div class="muted small">
                        已安装版本：${cli.availableVersions.join('、')}
                        ${cli.version === null ? '' : `（当前 ${cli.version}）`}
                      </div>
                    `}
                ${cli.manualInstructions === undefined
                  ? html``
                  : html`<div class="small">${cli.manualInstructions}</div>`}
              </div>
              <div style="flex:0 0 auto">
                ${cli.installKind === 'manual'
                  ? html`<span class="muted small">只能人工安装</span>`
                  : html`
                      <form class="inline" method="post" action="/settings/cli/${cli.cliId}/install">
                        <button type="submit">
                          ${cli.installed ? '重新安装 / 升级' : '安装'}
                        </button>
                      </form>
                    `}
              </div>
            </div>
            ${cli.availableVersions.length > 1
              ? html`
                  <form method="post" action="/settings/cli/${cli.cliId}/switch" style="margin-top:10px">
                    <div class="row">
                      <div>
                        <label>切换当前版本<span class="hint">升级装坏了用这个回退。</span></label>
                        <select name="version">
                          ${join(
                            cli.availableVersions.map(
                              (v) => html`
                                <option value="${v}"${raw(v === cli.version ? ' selected' : '')}>
                                  ${v}
                                </option>
                              `,
                            ),
                          )}
                        </select>
                      </div>
                      <div style="flex:0 0 auto; align-self:flex-end">
                        <button class="secondary" type="submit">切换</button>
                      </div>
                    </div>
                  </form>
                `
              : html``}
          </div>
        `,
      ),
    )}
  `;
}

function credentialSection(credentials: readonly CredentialSummary[]): Html {
  const types = listCredentialTypes();

  const rows = credentials.map(
    (credential) => html`
      <tr>
        <td>${credential.name}</td>
        <td class="small">${credential.typeDisplayName}</td>
        <td class="small">
          ${Object.entries(credential.fieldsSet)
            .map(([key, set]) => `${key}${set ? '✓' : '—'}`)
            .join(' ')}
        </td>
        <td class="num">${credential.referenceCount}</td>
        <td class="muted small">${shortTime(credential.updatedAt)}</td>
        <td>
          ${credential.archivedAt === null
            ? html`
                <form class="inline" method="post" action="/settings/credentials/${credential.id}/archive">
                  <button class="secondary" type="submit">归档</button>
                </form>
              `
            : html`<span class="badge">已归档</span>`}
        </td>
      </tr>
    `,
  );

  const forms = join(
    types.map(
      (type) => html`
        <details class="card">
          <summary><strong>${type.displayName}</strong>
            <span class="muted small"> — ${type.description}</span></summary>
          <form method="post" action="/settings/credentials">
            <input type="hidden" name="type" value="${type.id}">
            <label>名称<span class="hint">在选择凭据时显示。</span></label>
            <input type="text" name="name" required>
            ${join(
              type.fields.map(
                (field) => html`
                  <label>
                    ${field.label}${field.required ? '' : '（可选）'}
                    ${field.help === undefined ? html`` : html`<span class="hint">${field.help}</span>`}
                  </label>
                  ${field.key === 'privateKey' || field.key === 'content'
                    ? html`<textarea name="secrets.${field.key}"${raw(
                        field.required ? ' required' : '',
                      )}></textarea>`
                    : html`<input type="password" name="secrets.${field.key}"${raw(
                        field.required ? ' required' : '',
                      )}>`}
                `,
              ),
            )}
            <p><button type="submit">创建</button></p>
          </form>
        </details>
      `,
    ),
  );

  return html`
    <h2 id="credentials">凭据</h2>
    <p class="lead small">
      加密存储，任何页面都不回显值，只显示哪些字段已设置。
      发布目标只引用凭据，不自己存密钥——所以轮换只改这一处。
    </p>
    <div class="card">
      ${credentials.length === 0
        ? html`<p class="empty">还没有凭据。</p>`
        : html`
            <table>
              <thead>
                <tr><th>名称</th><th>类型</th><th>字段</th><th>被引用</th><th>更新</th><th></th></tr>
              </thead>
              <tbody>${join(rows)}</tbody>
            </table>
          `}
    </div>
    <h3>新建凭据</h3>
    ${forms}
  `;
}

function packageTypeSection(db: Db): Html {
  const types = listPackageTypes(db, { includeArchived: true });

  return html`
    <h2 id="package-types">包类型</h2>
    <p class="lead small">
      纯数据，新增不用改代码。但要能发布，需要有发布目标类型声明接受它。
    </p>
    <div class="card">
      <table>
        <thead>
          <tr><th>标识</th><th>显示名</th><th>可发布到</th><th>构建数</th><th></th></tr>
        </thead>
        <tbody>
          ${join(
            types.map(
              (type) => html`
                <tr>
                  <td><code>${type.id}</code></td>
                  <td>${type.displayName}</td>
                  <td class="small">
                    ${type.supportedBy.length === 0
                      ? html`<span class="badge err">无目标类型接受</span>`
                      : html`${type.supportedBy.join('、')}`}
                  </td>
                  <td class="num">${type.buildCount}</td>
                  <td>
                    ${type.archivedAt === null
                      ? html``
                      : html`<span class="badge">已归档</span>`}
                  </td>
                </tr>
              `,
            ),
          )}
        </tbody>
      </table>
      <form method="post" action="/settings/package-types" style="margin-top:14px">
        <div class="row">
          <div>
            <label>标识<span class="hint">小写字母、数字与连字符，会出现在 CI 上报里。</span></label>
            <input type="text" name="id" required pattern="[a-z0-9][a-z0-9-]*">
          </div>
          <div>
            <label>显示名</label>
            <input type="text" name="displayName" required>
          </div>
          <div style="flex:0 0 auto; align-self:flex-end">
            <button type="submit">新增</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function selfCheckSection(warnings: readonly SelfCheckProblem[]): Html {
  const kinds = listTargetKinds();

  return html`
    <h2 id="selfcheck">自检</h2>
    <div class="card">
      <h3>已注册的发布目标类型</h3>
      <table class="small">
        <thead>
          <tr><th>类型</th><th>接受包类型</th><th>所需凭据</th><th>所需 CLI</th><th>回滚</th></tr>
        </thead>
        <tbody>
          ${join(
            kinds.map(
              (kind) => html`
                <tr>
                  <td>${kind.manifest.displayName} <code>${kind.manifest.id}</code></td>
                  <td>${kind.manifest.accepts.join('、')}</td>
                  <td>${kind.manifest.requiresCredential ?? '不需要'}</td>
                  <td>${kind.manifest.requiresCli.join('、') || '不需要'}</td>
                  <td>
                    ${{
                      pointer: '指针回退',
                      republish: '重新发布',
                      none: '不支持',
                    }[kind.manifest.capabilities.rollback]}
                  </td>
                </tr>
              `,
            ),
          )}
        </tbody>
      </table>

      <h3>存量数据检查</h3>
      ${warnings.length === 0
        ? html`<p class="small" style="color:var(--ok)">没有发现问题。</p>`
        : html`
            <ul class="blockers">
              ${join(warnings.map((w) => html`<li>[${w.where}] ${w.message}</li>`))}
            </ul>
          `}
      <p class="muted small">
        注册表层面的问题（声明与实现不符、引用不存在的类型）会让进程启动失败，
        所以能看到这个页面就说明那一层没问题。
      </p>
    </div>
  `;
}

export async function settingsPage(
  deps: SettingsDeps,
  flash: SettingsFlash = {},
): Promise<Html> {
  const clis = await probeAllClis(deps.cliHome);

  return html`
    <h1>设置</h1>
    <p class="lead">
      <a href="#ci-keys">CI key</a> ·
      <a href="#cli">平台 CLI</a> ·
      <a href="#credentials">凭据</a> ·
      <a href="#package-types">包类型</a> ·
      <a href="#selfcheck">自检</a>
    </p>

    ${flash.error === undefined ? html`` : html`<div class="notice err">${flash.error}</div>`}
    ${flash.message === undefined ? html`` : html`<div class="notice ok">${flash.message}</div>`}

    ${ciKeySection(listCiKeys(deps.db), flash)}
    ${cliSection(clis)}
    ${credentialSection(listCredentials(deps.db, deps.masterKey, { includeArchived: true }))}
    ${packageTypeSection(deps.db)}
    ${selfCheckSection(checkStoredTargets(deps.db))}
  `;
}
