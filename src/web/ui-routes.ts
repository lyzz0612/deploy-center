/**
 * 中控台页面路由。
 *
 * 全部走管理员会话。未登录时一律跳到登录页（或首次设置页），而不是返回
 * JSON 401——那是 API 的行为，浏览器里看到一段 JSON 没有意义。
 *
 * 页面按「一屏一件事」拆分：列表页只负责看，创建表单、环境检查、设置
 * 分区各走自己的二级页面。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isAdmin, readCookie, SESSION_COOKIE } from '../auth/guard.js';
import type { SessionStore } from '../auth/session.js';
import {
  checkPassword,
  isPasswordSet,
  issueCiKey,
  revokeCiKey,
  setPassword,
  updateCiKey,
} from '../auth/store.js';
import { getBuild } from '../builds/index.js';
import { createGame, createPackageType, findGameBySlug, getGame } from '../catalog/index.js';
import { switchVersion } from '../cli/index.js';
import { archiveCredential, createCredential } from '../credentials/index.js';
import { archive, unarchive, type Db } from '../db/index.js';
import { enqueue } from '../jobs/index.js';
import { getCredentialType, getTargetKind } from '../registry/index.js';
import { createRelease, getRelease, prepareRetry, ROLLBACK_STAGE_ID } from '../releases/index.js';
import type { RuntimeConfig } from '../shared/config.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import { createTarget, getTarget, requirePublishableTarget } from '../targets/index.js';
import { collectFields, readFormBody, requireField } from './forms.js';
import { layout, raw, type Crumb, type Html } from './html.js';
import { loginPage, setupPage } from './pages/auth.js';
import { buildsPage, publishPage } from './pages/builds.js';
import {
  gameDetailPage,
  gamesListPage,
  newGamePage,
  newTargetPage,
  targetDetailPage,
} from './pages/games.js';
import {
  releaseDetailPage,
  releasesPage,
  shouldAutoRefresh,
} from './pages/releases.js';
import {
  ciKeysPage,
  cliPage,
  credentialsPage,
  newCredentialPage,
  newPackageTypePage,
  packageTypesPage,
  selfCheckPage,
  type SettingsFlash,
} from './pages/settings.js';

export interface UiDeps {
  readonly config: RuntimeConfig;
  readonly db: Db;
  readonly sessions: SessionStore;
}

interface PageOptions {
  readonly title: string;
  readonly body: Html;
  readonly pathname: string;
  readonly crumbs?: readonly Crumb[];
  readonly status?: number;
  readonly refreshSeconds?: number;
  readonly chrome?: 'app' | 'plain';
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function page(res: ServerResponse, options: PageOptions): void {
  send(
    res,
    options.status ?? 200,
    layout({
      title: options.title,
      body: options.body,
      pathname: options.pathname,
      ...(options.crumbs !== undefined && { crumbs: options.crumbs }),
      ...(options.refreshSeconds !== undefined && { refreshSeconds: options.refreshSeconds }),
      ...(options.chrome !== undefined && { chrome: options.chrome }),
    }),
  );
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

/** 只取 referer 的路径部分，避免把用户导向站外。 */
function backTo(req: IncomingMessage, fallback: string): string {
  const referer = req.headers.referer;
  if (referer === undefined) return fallback;
  try {
    const parsed = new URL(referer);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}

/** 把 query 里的 notice 翻译成一句人话。 */
function noticeFromQuery(url: URL): SettingsFlash {
  const notice = url.searchParams.get('notice');
  const cli = url.searchParams.get('cli');
  switch (notice) {
    case 'key-created':
      return { message: 'CI key 已保存。值会一直保存在本机，随时可以复制。' };
    case 'key-updated':
      return { message: 'CI key 已更新。旧值如果用过，记得同步换掉 CI 那边的 secret。' };
    case 'key-revoked':
      return { message: 'CI key 已吊销，之后的上报会被拒绝。' };
    case 'install-queued':
      return {
        message: `安装任务已投递${cli === null ? '' : `（${cli}）`}。npm 安装通常要一两分钟，稍后刷新查看结果。`,
      };
    case 'cli-switched':
      return { message: 'CLI 版本已切换。' };
    default:
      return {};
  }
}

/** 把错误渲染成页面。浏览器里看 JSON 没有意义。 */
function errorPage(
  res: ServerResponse,
  req: IncomingMessage,
  pathname: string,
  error: unknown,
  fallbackBack: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 400;
  send(
    res,
    status,
    layout({
      title: '出错了',
      pathname,
      body: raw(
        `<div class="page-head"><div><h1>操作未完成</h1></div></div>
<div class="notice err">${escapeHtml(message)}</div>
<p><a class="btn secondary" href="${escapeHtml(backTo(req, fallbackBack))}">返回</a></p>`,
      ),
    }),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 处理页面请求。返回 false 表示这个路径不属于 UI，交给 API 路由。
 */
export async function handleUi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // API 与健康检查不走这里
  if (path.startsWith('/api/') || path === '/healthz') return false;

  /* ------------------------------ 未登录 ------------------------------ */

  const authed = isAdmin(req, deps.sessions);
  const passwordSet = isPasswordSet(deps.db);

  if (!passwordSet) {
    if (path === '/setup' && method === 'POST') {
      const form = await readFormBody(req);
      try {
        setPassword(deps.db, requireField(form, 'password', '口令'));
      } catch (error) {
        page(res, {
          title: '首次设置',
          pathname: path,
          chrome: 'plain',
          body: setupPage({ error: messageOf(error) }),
        });
        return true;
      }
      const token = deps.sessions.create();
      res.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      );
      redirect(res, '/');
      return true;
    }
    page(res, {
      title: '首次设置',
      pathname: path,
      chrome: 'plain',
      body: setupPage(),
    });
    return true;
  }

  if (path === '/login' && method === 'POST') {
    const form = await readFormBody(req);
    const password = form.get('password') ?? '';
    if (!checkPassword(deps.db, password)) {
      page(res, {
        title: '登录',
        pathname: path,
        chrome: 'plain',
        status: 401,
        body: loginPage({ error: '口令不正确' }),
      });
      return true;
    }
    const token = deps.sessions.create();
    res.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    redirect(res, '/');
    return true;
  }

  if (!authed) {
    page(res, {
      title: '登录',
      pathname: path,
      chrome: 'plain',
      status: path === '/login' ? 200 : 401,
      body: loginPage(),
    });
    return true;
  }

  if (path === '/login' && method === 'GET') {
    redirect(res, '/');
    return true;
  }

  /* ------------------------------- 已登录 ------------------------------- */

  const ui = { db: deps.db, masterKey: deps.config.masterKey, cliHome: deps.config.cliHome };

  try {
    /* --------------------------------- 游戏 --------------------------------- */

    if (path === '/' && method === 'GET') {
      page(res, { title: '游戏', body: gamesListPage(deps.db), pathname: path });
      return true;
    }

    if (path === '/games/new' && method === 'GET') {
      page(res, {
        title: '新建游戏',
        body: newGamePage(),
        pathname: path,
        crumbs: [{ label: '游戏', href: '/' }, { label: '新建游戏' }],
      });
      return true;
    }

    if (path === '/games' && method === 'POST') {
      const form = await readFormBody(req);
      const game = createGame(deps.db, {
        slug: requireField(form, 'slug', 'slug'),
        displayName: requireField(form, 'displayName', '显示名'),
      });
      redirect(res, `/games/${game.slug}`);
      return true;
    }

    const gameMatch = /^\/games\/([a-z0-9][a-z0-9-]*)$/.exec(path);
    if (gameMatch !== null && method === 'GET') {
      const game = findGameBySlug(deps.db, gameMatch[1]!);
      if (game === undefined) throw new NotFoundError(`游戏 ${gameMatch[1]} 不存在`);
      page(res, {
        title: game.displayName,
        body: await gameDetailPage(ui, game),
        pathname: path,
        crumbs: [{ label: '游戏', href: '/' }, { label: game.displayName }],
      });
      return true;
    }

    const newTargetMatch = /^\/games\/([a-z0-9][a-z0-9-]*)\/targets\/new$/.exec(path);
    if (newTargetMatch !== null && method === 'GET') {
      const game = findGameBySlug(deps.db, newTargetMatch[1]!);
      if (game === undefined) throw new NotFoundError(`游戏 ${newTargetMatch[1]} 不存在`);
      const kindParam = url.searchParams.get('kind');
      page(res, {
        title: '添加发布目标',
        body: newTargetPage(ui, {
          game,
          ...(kindParam !== null && kindParam !== '' && { kindId: kindParam }),
        }),
        pathname: path,
        crumbs: [
          { label: '游戏', href: '/' },
          { label: game.displayName, href: `/games/${game.slug}` },
          { label: '添加发布目标' },
        ],
      });
      return true;
    }

    const targetsMatch = /^\/games\/([a-z0-9][a-z0-9-]*)\/targets$/.exec(path);
    if (targetsMatch !== null && method === 'POST') {
      const slug = targetsMatch[1]!;
      const game = findGameBySlug(deps.db, slug);
      if (game === undefined) throw new NotFoundError(`游戏 ${slug} 不存在`);

      const form = await readFormBody(req);
      const kindId = requireField(form, 'kind', '目标类型');
      const kind = getTargetKind(kindId);
      const target = createTarget(
        deps.db,
        {
          gameId: game.id,
          kind: kindId,
          name: requireField(form, 'name', '名称'),
          credentialId: form.get('credentialId'),
          location: collectFields(form, 'location', kind.manifest.targetFields),
        },
        deps.config.masterKey,
      );
      redirect(res, `/targets/${target.id}`);
      return true;
    }

    const targetMatch = /^\/targets\/([0-9a-f-]+)$/.exec(path);
    if (targetMatch !== null && method === 'GET') {
      const target = getTarget(deps.db, targetMatch[1]!);
      let gameCrumb: Crumb | undefined;
      try {
        const game = getGame(deps.db, target.gameId);
        gameCrumb = { label: game.displayName, href: `/games/${game.slug}` };
      } catch {
        gameCrumb = undefined;
      }
      page(res, {
        title: target.name,
        body: await targetDetailPage(ui, target),
        pathname: path,
        crumbs: [
          { label: '游戏', href: '/' },
          ...(gameCrumb === undefined ? [] : [gameCrumb]),
          { label: target.name },
        ],
      });
      return true;
    }

    const archiveMatch = /^\/targets\/([0-9a-f-]+)\/(archive|unarchive)$/.exec(path);
    if (archiveMatch !== null && method === 'POST') {
      const [, targetId, action] = archiveMatch as unknown as [string, string, string];
      if (action === 'archive') archive(deps.db, 'targets', targetId);
      else unarchive(deps.db, 'targets', targetId);
      redirect(res, backTo(req, `/targets/${targetId}`));
      return true;
    }

    /* --------------------------------- 构建 --------------------------------- */

    if (path === '/builds' && method === 'GET') {
      const gameSlug = url.searchParams.get('game');
      const packageTypeId = url.searchParams.get('packageType');
      page(res, {
        title: '构建',
        body: buildsPage(deps.db, {
          ...(gameSlug !== null && gameSlug !== '' && { gameSlug }),
          ...(packageTypeId !== null && packageTypeId !== '' && { packageTypeId }),
        }),
        pathname: path,
      });
      return true;
    }

    const publishMatch = /^\/builds\/([0-9a-f-]+)\/publish$/.exec(path);
    if (publishMatch !== null) {
      const buildPk = publishMatch[1]!;
      const build = getBuild(deps.db, buildPk);
      const game = deps.db
        .prepare<[string], { slug: string }>('SELECT slug FROM games WHERE id = ?')
        .get(build.gameId);

      if (method === 'GET') {
        page(res, {
          title: `发布 ${build.buildId}`,
          pathname: path,
          crumbs: [{ label: '构建', href: '/builds' }, { label: `发布 ${build.buildId}` }],
          body: await publishPage(ui, {
            buildId: buildPk,
            buildLabel: build.buildId,
            packageTypeId: build.packageTypeId,
            gameSlug: game?.slug ?? '',
          }),
        });
        return true;
      }

      if (method === 'POST') {
        const form = await readFormBody(req);
        const targetId = requireField(form, 'targetId', '发布目标');
        // 即使绕过 UI 直接提交，跨类型组合也会在这里被拒
        const target = requirePublishableTarget(deps.db, targetId, build.packageTypeId);
        const kind = getTargetKind(target.kind);

        const release = createRelease(deps.db, {
          buildId: buildPk,
          targetId,
          params: collectFields(form, 'params', kind.manifest.publishFields),
          stageIds: kind.manifest.stages.map((s) => s.id),
        });
        enqueue(deps.db, 'publish', release.id);
        redirect(res, `/releases/${release.id}`);
        return true;
      }
    }

    /* -------------------------------- 发布记录 -------------------------------- */

    if (path === '/releases' && method === 'GET') {
      page(res, { title: '发布记录', body: releasesPage(deps.db), pathname: path });
      return true;
    }

    const releaseMatch = /^\/releases\/([0-9a-f-]+)$/.exec(path);
    if (releaseMatch !== null && method === 'GET') {
      const release = getRelease(deps.db, releaseMatch[1]!);
      page(res, {
        title: `发布 ${release.id.slice(0, 8)}`,
        body: releaseDetailPage(deps.db, release),
        pathname: path,
        crumbs: [{ label: '发布记录', href: '/releases' }, { label: '详情' }],
        // 执行中自动刷新，让日志能看到进展
        ...(shouldAutoRefresh(release) && { refreshSeconds: 3 }),
      });
      return true;
    }

    const retryMatch = /^\/releases\/([0-9a-f-]+)\/retry$/.exec(path);
    if (retryMatch !== null && method === 'POST') {
      const releaseId = retryMatch[1]!;
      prepareRetry(deps.db, releaseId);
      enqueue(deps.db, 'publish', releaseId);
      redirect(res, `/releases/${releaseId}`);
      return true;
    }

    const rollbackMatch = /^\/releases\/([0-9a-f-]+)\/rollback$/.exec(path);
    if (rollbackMatch !== null && method === 'POST') {
      const releaseId = rollbackMatch[1]!;
      const release = getRelease(deps.db, releaseId);
      const target = requirePublishableTarget(
        deps.db,
        release.targetId,
        getBuild(deps.db, release.buildId).packageTypeId,
      );
      const kind = getTargetKind(target.kind);
      if (kind.manifest.capabilities.rollback !== 'pointer') {
        throw new ConflictError(`${kind.manifest.displayName} 不支持原地回滚`);
      }
      // 回滚是一次独立的发布记录，只跑最后一个阶段（切指针）
      const rollbackRelease = createRelease(deps.db, {
        buildId: release.buildId,
        targetId: release.targetId,
        params: release.params,
        stageIds: [ROLLBACK_STAGE_ID],
      });
      enqueue(deps.db, 'publish', rollbackRelease.id);
      redirect(res, `/releases/${rollbackRelease.id}`);
      return true;
    }

    /* --------------------------------- 设置 --------------------------------- */

    if (path === '/settings' && method === 'GET') {
      redirect(res, '/settings/ci-keys');
      return true;
    }

    if (path === '/settings/ci-keys' && method === 'GET') {
      page(res, {
        title: 'CI key',
        body: ciKeysPage(deps.db, deps.config.masterKey, noticeFromQuery(url)),
        pathname: path,
        crumbs: [{ label: '设置' }, { label: 'CI key' }],
      });
      return true;
    }

    if (path === '/settings/ci-keys' && method === 'POST') {
      const form = await readFormBody(req);
      const value = (form.get('value') ?? '').trim();
      issueCiKey(
        deps.db,
        requireField(form, 'name', '名称'),
        deps.config.masterKey,
        value === '' ? undefined : value,
      );
      redirect(res, '/settings/ci-keys?notice=key-created');
      return true;
    }

    const ciKeyUpdateMatch = /^\/settings\/ci-keys\/([0-9a-f-]+)$/.exec(path);
    if (ciKeyUpdateMatch !== null && method === 'POST') {
      const form = await readFormBody(req);
      const value = (form.get('value') ?? '').trim();
      updateCiKey(
        deps.db,
        ciKeyUpdateMatch[1]!,
        {
          name: requireField(form, 'name', '名称'),
          ...(value === '' ? {} : { value }),
        },
        deps.config.masterKey,
      );
      redirect(res, '/settings/ci-keys?notice=key-updated');
      return true;
    }

    const ciKeyRevokeMatch = /^\/settings\/ci-keys\/([0-9a-f-]+)\/revoke$/.exec(path);
    if (ciKeyRevokeMatch !== null && method === 'POST') {
      revokeCiKey(deps.db, ciKeyRevokeMatch[1]!);
      redirect(res, '/settings/ci-keys?notice=key-revoked');
      return true;
    }

    if (path === '/settings/cli' && method === 'GET') {
      page(res, {
        title: '平台 CLI',
        body: await cliPage(deps.config.cliHome, noticeFromQuery(url)),
        pathname: path,
        crumbs: [{ label: '设置' }, { label: '平台 CLI' }],
      });
      return true;
    }

    if (path === '/settings/credentials' && method === 'GET') {
      page(res, {
        title: '凭据',
        body: credentialsPage(deps.db, deps.config.masterKey),
        pathname: path,
        crumbs: [{ label: '设置' }, { label: '凭据' }],
      });
      return true;
    }

    if (path === '/settings/credentials/new' && method === 'GET') {
      const typeParam = url.searchParams.get('type');
      page(res, {
        title: '新建凭据',
        body: newCredentialPage(typeParam === null || typeParam === '' ? undefined : typeParam),
        pathname: path,
        crumbs: [
          { label: '设置' },
          { label: '凭据', href: '/settings/credentials' },
          { label: '新建' },
        ],
      });
      return true;
    }

    if (path === '/settings/credentials' && method === 'POST') {
      const form = await readFormBody(req);
      const typeId = requireField(form, 'type', '凭据类型');
      const type = getCredentialType(typeId);
      const secrets: Record<string, string> = {};
      for (const field of type.fields) {
        const value = form.get(`secrets.${field.key}`);
        if (value !== null && value !== '') secrets[field.key] = value;
      }
      createCredential(
        deps.db,
        { name: requireField(form, 'name', '名称'), type: type.id, secrets },
        deps.config.masterKey,
      );
      redirect(res, '/settings/credentials');
      return true;
    }

    const credArchiveMatch = /^\/settings\/credentials\/([0-9a-f-]+)\/archive$/.exec(path);
    if (credArchiveMatch !== null && method === 'POST') {
      archiveCredential(deps.db, credArchiveMatch[1]!);
      redirect(res, '/settings/credentials');
      return true;
    }

    if (path === '/settings/package-types' && method === 'GET') {
      page(res, {
        title: '包类型',
        body: packageTypesPage(deps.db),
        pathname: path,
        crumbs: [{ label: '设置' }, { label: '包类型' }],
      });
      return true;
    }

    if (path === '/settings/package-types/new' && method === 'GET') {
      page(res, {
        title: '新增包类型',
        body: newPackageTypePage(),
        pathname: path,
        crumbs: [
          { label: '设置' },
          { label: '包类型', href: '/settings/package-types' },
          { label: '新增' },
        ],
      });
      return true;
    }

    if (path === '/settings/package-types' && method === 'POST') {
      const form = await readFormBody(req);
      createPackageType(deps.db, {
        id: requireField(form, 'id', '标识'),
        displayName: requireField(form, 'displayName', '显示名'),
      });
      redirect(res, '/settings/package-types');
      return true;
    }

    if (path === '/settings/selfcheck' && method === 'GET') {
      page(res, {
        title: '自检',
        body: selfCheckPage(deps.db),
        pathname: path,
        crumbs: [{ label: '设置' }, { label: '自检' }],
      });
      return true;
    }

    const cliInstallMatch = /^\/settings\/cli\/([A-Za-z0-9._-]+)\/install$/.exec(path);
    if (cliInstallMatch !== null && method === 'POST') {
      // 安装是长任务，投递进队列而不是在请求里同步装——npm i 两分钟
      // 是常态，反代通常 60 秒就断了
      enqueue(deps.db, 'cli_install', cliInstallMatch[1]!);
      redirect(res, `/settings/cli?notice=install-queued&cli=${encodeURIComponent(cliInstallMatch[1]!)}`);
      return true;
    }

    const cliSwitchMatch = /^\/settings\/cli\/([A-Za-z0-9._-]+)\/switch$/.exec(path);
    if (cliSwitchMatch !== null && method === 'POST') {
      const form = await readFormBody(req);
      await switchVersion(
        deps.config.cliHome,
        cliSwitchMatch[1]!,
        requireField(form, 'version', '版本'),
      );
      redirect(res, '/settings/cli?notice=cli-switched');
      return true;
    }

    /* -------------------------------- 退出登录 -------------------------------- */

    if (path === '/logout' && method === 'POST') {
      const token = readCookie(req, SESSION_COOKIE);
      if (token !== undefined) deps.sessions.destroy(token);
      res.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`,
      );
      redirect(res, '/login');
      return true;
    }
  } catch (error) {
    errorPage(res, req, path, error, '/');
    return true;
  }

  send(
    res,
    404,
    layout({
      title: '找不到',
      pathname: path,
      body: raw(
        '<div class="page-head"><div><h1>找不到这个页面</h1></div></div><p><a class="btn secondary" href="/">返回首页</a></p>',
      ),
    }),
  );
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}