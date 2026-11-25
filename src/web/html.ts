/**
 * 服务端 HTML 渲染与页面骨架。
 *
 * 为什么不是 React + Vite（design.md D9 原本这么写）：这是单人用的后台，
 * 交互量是「表单 + 列表 + 轮询日志」。SPA 会让 Dockerfile 多一个构建阶段、
 * 产物多一套静态资源、调试多一层 source map，而换来的体验差别在这个量级
 * 上看不出来。偏离已记进 design.md D9。
 *
 * 视觉上走「工业台账」：深墨绿侧栏 + 暖纸色正文 + 朱砂色强调，标题用衬线，
 * 微标签与数字用等宽。左侧导航按「流水线 / 配置」分组，页面内容只放当前
 * 一屏该看的东西，创建表单、检查详情、凭据与包类型都退到各自的二级页面。
 *
 * 转义是这里唯一不能出错的事：游戏名、目标名、日志都是用户输入，直接拼进
 * HTML 就是 XSS。所有插值一律走 esc()，拼 HTML 的地方不接受裸字符串。
 */

/** HTML 文本转义。属性值与文本节点都用它。 */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 已转义的 HTML 片段。
 *
 * 用对象包装而不是品牌字符串：字符串是值类型，运行期无法判别「这段是不是
 * 已经转义过的」。包成对象后，html`` 能在运行期区分「要转义的数据」和
 * 「已就绪的片段」，嵌套组合才不会被二次转义。
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** 标记一段字符串为可信 HTML。只对自己构造的片段使用，绝不对用户输入使用。 */
export function raw(markup: string): Html {
  return new Html(markup);
}

/** 把若干片段连起来。 */
export function join(parts: readonly Html[], separator = ''): Html {
  return new Html(parts.map((p) => p.value).join(separator));
}

/**
 * 模板标签：插值自动转义，嵌套的 Html 片段原样保留。
 *
 * 用它而不是手工拼接，是为了让「忘记转义」变成需要刻意绕过的事
 * （只有显式 raw() 能绕）。
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let result = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value instanceof Html) {
      result += value.value;
    } else if (Array.isArray(value)) {
      result += value
        .map((item) => (item instanceof Html ? item.value : esc(item)))
        .join('');
    } else if (value === null || value === undefined) {
      result += '';
    } else {
      result += esc(value);
    }
    result += strings[i + 1] ?? '';
  }
  return new Html(result);
}

/* ------------------------------- 页面骨架 ------------------------------- */

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export interface LayoutOptions {
  readonly title: string;
  readonly body: Html;
  /** 当前路径，用于点亮左侧导航。 */
  readonly pathname?: string;
  /** 顶栏面包屑。缺省显示产品名。 */
  readonly crumbs?: readonly Crumb[];
  readonly refreshSeconds?: number;
  /** `plain` 用于登录/首次设置：没有侧栏，垂直居中。 */
  readonly chrome?: 'app' | 'plain';
}

interface NavItem {
  readonly index: string;
  readonly href: string;
  readonly label: string;
}

interface NavSection {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: '流水线',
    items: [
      { index: '01', href: '/', label: '游戏' },
      { index: '02', href: '/builds', label: '构建' },
      { index: '03', href: '/releases', label: '发布记录' },
    ],
  },
  {
    label: '配置',
    items: [
      { index: '04', href: '/settings/ci-keys', label: 'CI key' },
      { index: '05', href: '/settings/cli', label: '平台 CLI' },
      { index: '06', href: '/settings/credentials', label: '凭据' },
      { index: '07', href: '/settings/package-types', label: '包类型' },
      { index: '08', href: '/settings/selfcheck', label: '自检' },
    ],
  },
];

/** 判断某个导航项是否命中当前路径。游戏详情、目标详情都归到「游戏」。 */
function isActive(pathname: string | undefined, href: string): boolean {
  if (pathname === undefined) return false;
  if (href === '/') {
    return (
      pathname === '/' ||
      pathname.startsWith('/games') ||
      pathname.startsWith('/targets')
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function renderSidebar(pathname: string | undefined): string {
  const sections = NAV_SECTIONS.map(
    (section) => `
      <div class="nav-group">
        <p class="nav-label">${esc(section.label)}</p>
        ${section.items
          .map(
            (item) => `
          <a class="nav-link${isActive(pathname, item.href) ? ' active' : ''}" href="${esc(item.href)}">
            <span class="nav-index">${esc(item.index)}</span>
            <span>${esc(item.label)}</span>
          </a>`,
          )
          .join('')}
      </div>`,
  ).join('');

  return `
  <aside class="sidebar">
    <a class="brand" href="/">
      <span class="brand-mark">MG</span>
      <span>
        <span class="brand-name">发布中控台</span>
        <span class="brand-sub">MINIGAMES CONSOLE</span>
      </span>
    </a>
    <nav class="nav">${sections}</nav>
    <div class="side-foot">
      <span class="side-meta">自用实例 · 单管理员</span>
      <span class="side-meta">SESSION 12H</span>
    </div>
  </aside>`;
}

function renderCrumbs(crumbs: readonly Crumb[] | undefined): string {
  const items = crumbs === undefined || crumbs.length === 0 ? [{ label: '发布中控台' }] : crumbs;
  return items
    .map((crumb, index) => {
      const last = index === items.length - 1;
      if (last) return `<span class="current">${esc(crumb.label)}</span>`;
      if (crumb.href === undefined) return `<span>${esc(crumb.label)}</span>`;
      return `<a href="${esc(crumb.href)}">${esc(crumb.label)}</a>`;
    })
    .join('<span class="sep">/</span>');
}

const PAGE_SCRIPT = `
<script>
(() => {
  const pad = (value) => String(value).padStart(2, '0');
  // 服务端渲染的是 UTC 兜底文本；浏览器里统一换成访问者本地时区。
  for (const element of document.querySelectorAll('time[datetime]')) {
    const date = new Date(element.getAttribute('datetime'));
    if (Number.isNaN(date.getTime())) continue;
    element.textContent =
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
    if (!target) return;
    const selector = target.getAttribute('data-copy');
    const source = selector ? document.querySelector(selector) : null;
    if (!source) return;
    const text = source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement
      ? source.value
      : (source.textContent || '');
    const done = () => {
      const original = target.getAttribute('data-label') || '复制';
      target.textContent = '已复制';
      window.setTimeout(() => { target.textContent = original; }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => {});
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('copy'); done(); } catch (error) { /* 忽略，用户可手动复制 */ }
    selection.removeAllRanges();
  });
})();
</script>`;

/** 页面骨架。 */
export function layout(options: LayoutOptions): string {
  const refresh =
    options.refreshSeconds === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`;

  if (options.chrome === 'plain') {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(options.title)} · 发布中控台</title>
${refresh}
<style>${STYLES}</style>
</head>
<body class="plain">
<div class="plain-wrap">
  <div class="plain-brand">
    <span class="brand-mark">MG</span>
    <span>
      <span class="brand-name">发布中控台</span>
      <span class="brand-sub">MINIGAMES CONSOLE</span>
    </span>
  </div>
  ${options.body.value}
</div>
${PAGE_SCRIPT}
</body>
</html>`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(options.title)} · 发布中控台</title>
${refresh}
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${renderSidebar(options.pathname)}
<div class="content">
  <div class="topbar">
    <div class="crumbs">${renderCrumbs(options.crumbs)}</div>
    <div class="top-actions">
      <span class="top-tag">SELF-HOSTED</span>
      <form method="post" action="/logout">
        <button class="logout-btn" type="submit">退出登录</button>
      </form>
    </div>
  </div>
  <main>
${options.body.value}
  </main>
</div>
</div>
${PAGE_SCRIPT}
</body>
</html>`;
}

/* ------------------------------ 内容片段 ------------------------------ */

/** 页面标题区：标题 + 说明 + 右侧操作。 */
export function pageHeader(options: {
  readonly title: Html | string;
  readonly lead?: Html;
  readonly actions?: Html;
}): Html {
  return html`
    <div class="page-head">
      <div>
        <h1>${options.title}</h1>
        ${options.lead === undefined ? html`` : html`<p class="lead">${options.lead}</p>`}
      </div>
      ${options.actions === undefined
        ? html``
        : html`<div class="page-actions">${options.actions}</div>`}
    </div>
  `;
}

/** 段落标题：等宽小字 + 右侧延伸线。 */
export function sectionTitle(title: string, aside?: Html): Html {
  return html`
    <h2 class="section-title">
      <span>${title}</span>
      ${aside === undefined ? html`` : aside}
      <span class="rule"></span>
    </h2>
  `;
}

/** 空状态。 */
export function emptyPanel(content: Html, action?: Html): Html {
  return html`
    <div class="empty">
      ${content}
      ${action === undefined ? html`` : html`<p>${action}</p>`}
    </div>
  `;
}

/** 复制按钮。selector 指向要复制的元素（通常是一个 code 块的 id）。 */
export function copyButton(selector: string, label = '复制'): Html {
  return html`<button type="button" class="btn secondary small" data-copy="${selector}" data-label="${label}">${label}</button>`;
}

/** 状态徽标。 */
export function statusBadge(status: string): Html {
  const cls =
    status === 'success'
      ? 'ok'
      : status === 'failed' || status === 'timeout'
        ? 'err'
        : status === 'running'
          ? 'run'
          : status === 'queued'
            ? 'warn'
            : '';
  const label =
    {
      queued: '排队中',
      running: '执行中',
      success: '成功',
      failed: '失败',
      timeout: '超时',
      cancelled: '已取消',
      skipped: '已跳过',
    }[status] ?? status;
  return raw(`<span class="badge ${cls}">${esc(label)}</span>`);
}

/** 通过 / 未通过之类的是非徽标。 */
export function okBadge(ok: boolean, okLabel = '通过', failLabel = '未通过'): Html {
  return html`<span class="badge ${ok ? 'ok' : 'err'}">${ok ? okLabel : failLabel}</span>`;
}

/** 字节数的人类可读形式。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 时间的简短形式。输出 `<time>`，由页面脚本转成访问者本地时区。 */
export function shortTime(iso: string | null): Html {
  if (iso === null || iso === '') return html`—`;
  const fallback = iso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  return raw(
    `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(fallback)}</time>`,
  );
}

/* -------------------------------- 样式 -------------------------------- */

const STYLES = `
:root {
  color-scheme: light;
  --paper: #f1ede4;
  --paper-2: #e8e2d5;
  --surface: #fdfbf5;
  --surface-2: #f7f3ea;
  --ink: #171a18;
  --ink-soft: #3b423c;
  --muted: #6a716a;
  --faint: #969c92;
  --line: #d9d2c3;
  --line-soft: #e9e3d6;
  --line-strong: #b9b1a0;
  --sidebar: #141816;
  --sidebar-line: #2a322d;
  --sidebar-ink: #ece9e0;
  --sidebar-muted: #8b948c;
  --accent: #b4471f;
  --accent-2: #d15b2c;
  --accent-tint: #f5e4da;
  --ok: #2b6b49; --ok-tint: #e9f2ec; --ok-line: #b9d5c3;
  --warn: #8a5a12; --warn-tint: #f8efd9; --warn-line: #e3ce9d;
  --err: #9c3225; --err-tint: #f8e8e4; --err-line: #e3bcb4;
  --run: #28566f; --run-tint: #e8f1f5; --run-line: #bcd4df;
  --radius: 3px;
  --font-sans: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
  --font-display: Georgia, "Songti SC", "STSong", "Noto Serif SC", "SimSun", serif;
  --font-mono: "Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.65 var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background-image: radial-gradient(rgba(23, 26, 24, .07) .6px, transparent .6px);
  background-size: 4px 4px; opacity: .45;
}
a { color: var(--accent); text-decoration: none; text-underline-offset: 3px; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1, h2, h3 { margin: 0; font-weight: 600; }
p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }
hr { border: none; border-top: 1px solid var(--line-soft); margin: 18px 0; }

/* 骨架 */
.shell {
  position: relative; z-index: 1;
  display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh;
}
.sidebar {
  position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column; gap: 30px;
  padding: 26px 18px 20px;
  background: var(--sidebar); color: var(--sidebar-ink);
  border-right: 1px solid var(--sidebar-line);
}
.sidebar::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(130% 70% at 0% 0%, rgba(180, 71, 31, .16), transparent 62%);
}
.sidebar > * { position: relative; z-index: 1; }
.brand { display: flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; }
.brand:hover { text-decoration: none; }
.brand-mark {
  width: 36px; height: 36px; flex: none; display: grid; place-items: center;
  background: var(--accent); color: #fff8f2; border-radius: 2px;
  font: 700 12px/1 var(--font-mono); letter-spacing: .06em;
  box-shadow: inset 0 -11px 0 rgba(0, 0, 0, .14);
}
.brand-name { display: block; font: 600 15px/1.3 var(--font-sans); letter-spacing: .08em; }
.brand-sub { display: block; margin-top: 3px; font: 9.5px/1.2 var(--font-mono); letter-spacing: .19em; color: var(--sidebar-muted); }
.nav { display: flex; flex-direction: column; gap: 28px; flex: 1; overflow-y: auto; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-label {
  margin: 0 0 8px 10px; font: 10px/1 var(--font-mono);
  letter-spacing: .22em; text-transform: uppercase; color: var(--sidebar-muted);
}
.nav-link {
  position: relative; display: flex; align-items: center; gap: 11px;
  padding: 8px 10px; border-radius: 2px; color: #c8cec7;
  font: 500 13.5px/1.4 var(--font-sans); text-decoration: none;
  transition: background .15s, color .15s;
}
.nav-link:hover { background: rgba(255, 255, 255, .05); color: #fff; text-decoration: none; }
.nav-link.active { background: rgba(255, 255, 255, .09); color: #fff; }
.nav-link.active::before {
  content: ""; position: absolute; left: -18px; top: 7px; bottom: 7px;
  width: 2px; background: var(--accent);
}
.nav-index { font: 10px/1 var(--font-mono); letter-spacing: .05em; color: var(--sidebar-muted); }
.nav-link.active .nav-index { color: var(--accent-2); }
.side-foot {
  display: flex; flex-direction: column; gap: 6px;
  padding-top: 16px; border-top: 1px solid var(--sidebar-line);
}
.side-meta { font: 9.5px/1.6 var(--font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--sidebar-muted); }

.content { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  height: 56px; padding: 0 40px;
  background: rgba(241, 237, 228, .88);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
}
.crumbs {
  display: flex; align-items: center; gap: 9px; min-width: 0;
  font: 10.5px/1 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
}
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--accent); text-decoration: none; }
.crumbs .sep { color: var(--line-strong); }
.crumbs .current { color: var(--ink); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.top-actions { display: flex; align-items: center; gap: 16px; flex: none; }
.top-tag { font: 9.5px/1 var(--font-mono); letter-spacing: .16em; color: var(--faint); }
.logout-btn {
  border: 0; background: none; padding: 0; cursor: pointer;
  font: 500 12px/1 var(--font-sans); color: var(--muted);
}
.logout-btn:hover { color: var(--accent); }

main {
  width: 100%; max-width: 1120px; margin: 0 auto;
  padding: 34px 40px 96px;
  animation: rise .35s ease-out both;
}
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* 标题区 */
.page-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  flex-wrap: wrap; margin-bottom: 26px; padding-bottom: 22px;
  border-bottom: 1px solid var(--line);
}
.page-head h1 {
  font: 600 28px/1.16 var(--font-display); letter-spacing: .01em;
}
.page-head .lead { margin: 9px 0 0; max-width: 72ch; color: var(--muted); font-size: 13.5px; }
.page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.section-title {
  display: flex; align-items: center; gap: 12px;
  margin: 36px 0 12px;
  font: 600 11px/1 var(--font-mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted);
}
.section-title .rule { flex: 1; height: 1px; background: var(--line); }
.section-title:first-child { margin-top: 0; }
.subtle { color: var(--muted); font-size: 12.5px; }

/* 面板与表格 */
.panel {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden; margin-bottom: 16px;
}
.panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 13px 18px; background: var(--surface-2); border-bottom: 1px solid var(--line-soft);
}
.panel-title { font: 600 13px/1.4 var(--font-sans); }
.panel-body { padding: 20px; }
.panel-body.tight { padding: 0; }
.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table th {
  padding: 10px 16px; text-align: left; white-space: nowrap;
  font: 500 10px/1.4 var(--font-mono); letter-spacing: .12em; text-transform: uppercase;
  color: var(--faint); background: var(--surface-2); border-bottom: 1px solid var(--line);
}
.table td { padding: 13px 16px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
.table th:last-child, .table td:last-child { width: 1%; white-space: nowrap; }
.table tbody tr:last-child td { border-bottom: none; }
.table tbody tr:hover { background: #fbf7ee; }
.table .num { font-family: var(--font-mono); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.table .row-actions { display: flex; gap: 6px; justify-content: flex-end; }
.cell-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; white-space: nowrap; }
.cell-sub { margin-top: 3px; color: var(--muted); font-size: 12px; }
.targets-table th:nth-child(1), .targets-table td:nth-child(1) { width: 220px; }
.targets-table td:nth-child(2) { word-break: break-all; }
.loc-summary { display: grid; gap: 2px; font-size: 12px; }
.loc-summary .loc-key {
  display: inline-block; min-width: 88px; margin-right: 8px;
  font: 10.5px/1.5 var(--font-mono); letter-spacing: .04em; color: var(--muted);
}
.loc-summary .mono { word-break: break-all; }

code, .mono { font-family: var(--font-mono); font-size: 12.5px; }
code {
  display: inline-block; padding: 1px 6px; border: 1px solid var(--line-soft);
  border-radius: 2px; background: var(--surface-2); color: var(--ink-soft);
  vertical-align: 1px;
}
pre {
  margin: 0; padding: 14px 16px; overflow: auto; max-height: 460px;
  background: #121614; color: #d8ded7; border: 1px solid #202822; border-radius: 2px;
  font: 12.5px/1.65 var(--font-mono); white-space: pre-wrap; word-break: break-word;
}
pre.light { background: var(--surface-2); color: var(--ink-soft); border-color: var(--line-soft); }

/* 徽标 */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border: 1px solid var(--line); border-radius: 2px;
  background: var(--surface-2); color: var(--muted);
  font: 500 11px/1.5 var(--font-sans); letter-spacing: .02em; white-space: nowrap;
}
.badge.ok { color: var(--ok); background: var(--ok-tint); border-color: var(--ok-line); }
.badge.err { color: var(--err); background: var(--err-tint); border-color: var(--err-line); }
.badge.warn { color: var(--warn); background: var(--warn-tint); border-color: var(--warn-line); }
.badge.run { color: var(--run); background: var(--run-tint); border-color: var(--run-line); }
.badge.muted { color: var(--faint); }

/* 按钮 */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 15px; border: 1px solid var(--ink); border-radius: var(--radius);
  background: var(--ink); color: #fbf7ee; cursor: pointer; text-decoration: none;
  font: 500 13px/1.2 var(--font-sans); white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.btn:hover { background: var(--accent); border-color: var(--accent); color: #fff; text-decoration: none; }
.btn.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
.btn.secondary:hover { background: transparent; border-color: var(--accent); color: var(--accent); }
.btn.danger { background: transparent; border-color: var(--line); color: var(--err); }
.btn.danger:hover { background: var(--err); border-color: var(--err); color: #fff; }
.btn.small { padding: 5px 10px; font-size: 12px; }
.btn[disabled] { opacity: .42; cursor: not-allowed; }
.btn[disabled]:hover { background: var(--ink); border-color: var(--ink); color: #fbf7ee; }
summary.btn { display: inline-flex; }
summary::-webkit-details-marker { display: none; }

/* 表单 */
label {
  display: block; margin-bottom: 6px;
  font: 600 12px/1.4 var(--font-sans); color: var(--ink-soft); letter-spacing: .02em;
}
.hint { display: block; margin-top: 4px; font: 400 12px/1.55 var(--font-sans); color: var(--muted); }
input[type=text], input[type=password], input[type=number], input[type=url], select, textarea {
  width: 100%; padding: 9px 11px;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: #fffdf9; color: var(--ink);
  font: 14px/1.5 var(--font-sans);
  transition: border-color .15s, box-shadow .15s;
}
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(180, 71, 31, .12);
}
textarea { min-height: 120px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; }
input[type=checkbox] {
  width: 16px; height: 16px; margin: 0 8px 0 0; vertical-align: -3px;
  accent-color: var(--accent);
}
.check-label { display: flex; align-items: flex-start; gap: 2px; font-weight: 400; color: var(--ink); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 22px; }
.form-grid .span-2 { grid-column: 1 / -1; }
.field { min-width: 0; }
.form-actions {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line-soft);
}
.form-actions .spacer { flex: 1; }

/* 提示条 */
.notice {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 16px; margin-bottom: 18px;
  border: 1px solid var(--line); border-left: 3px solid var(--muted);
  border-radius: 2px; background: var(--surface-2); font-size: 13.5px;
}
.notice.ok { border-color: var(--ok-line); border-left-color: var(--ok); background: var(--ok-tint); }
.notice.warn { border-color: var(--warn-line); border-left-color: var(--warn); background: var(--warn-tint); }
.notice.err { border-color: var(--err-line); border-left-color: var(--err); background: var(--err-tint); }
.notice strong { font-weight: 600; }
.blockers { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 4px; color: var(--err); font-size: 12.5px; }
.blockers li::before { content: "— "; }

/* 空状态 */
.empty {
  padding: 38px 24px; text-align: center; color: var(--muted); font-size: 13.5px;
  border: 1px dashed var(--line-strong); border-radius: var(--radius);
  background: rgba(253, 251, 245, .55);
}
.empty strong { display: block; margin-bottom: 4px; color: var(--ink); font-size: 15px; }
.empty p { margin: 12px 0 0; }

/* 元信息 */
.meta { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px 18px; margin: 0; }
.meta dt {
  font: 500 10px/1.7 var(--font-mono); letter-spacing: .12em;
  text-transform: uppercase; color: var(--faint);
}
.meta dd { margin: 0; font-size: 13.5px; min-width: 0; }
.meta code { word-break: break-all; }

/* CI key */
.key-card { padding: 18px 20px; border-bottom: 1px solid var(--line-soft); }
.key-card:last-child { border-bottom: none; }
.key-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.key-title { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.key-title strong { font-size: 14px; }
.key-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.key-value { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.key-value code {
  padding: 7px 10px; background: #fffdf9; border-color: var(--line-soft);
  color: var(--ink); word-break: break-all; font-size: 12.5px;
}
.key-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 9px; font: 10.5px/1.4 var(--font-mono); color: var(--faint); letter-spacing: .04em; }
.key-edit { margin-top: 12px; }
.key-edit[open] .key-edit-body { margin-top: 12px; padding-top: 14px; border-top: 1px solid var(--line-soft); }

/* CLI */
.cli-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; padding: 18px 20px; border-bottom: 1px solid var(--line-soft); }
.cli-card:last-child { border-bottom: none; }
.cli-main { min-width: 0; flex: 1; }
.cli-title { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cli-title strong { font-size: 14px; }
.cli-meta { margin-top: 7px; font-size: 12.5px; color: var(--muted); }
.cli-actions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; flex: none; }
.cli-switch { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line-soft); }

/* 构建与发布 */
.build-group { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); overflow: hidden; margin-bottom: 14px; }
.build-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 12px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line-soft);
}
.commit { font: 600 13px/1.4 var(--font-mono); letter-spacing: .02em; }
.build-meta { margin-top: 3px; font-size: 12px; color: var(--muted); }
.target-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.target-card { display: block; border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 14px; color: inherit; text-decoration: none; transition: border-color .15s, background .15s; }
a.target-card:hover { border-color: var(--accent); background: #fffdfa; text-decoration: none; }
.target-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.target-grid .target-card { margin-bottom: 0; }
.target-card-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; }
.stage { border: 1px solid var(--line); border-left: 3px solid var(--line-strong); background: var(--surface); border-radius: 2px; margin-bottom: 12px; overflow: hidden; }
.stage.ok { border-left-color: var(--ok); }
.stage.err { border-left-color: var(--err); }
.stage.run { border-left-color: var(--run); }
.stage.warn { border-left-color: var(--warn); }
.stage-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line-soft); }
.stage-head strong { font-size: 13.5px; }
.stage-body { padding: 14px 16px; }
.stage-body pre { max-height: 360px; }

/* 过滤工具条 */
.toolbar {
  display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap;
  padding: 14px 16px; margin-bottom: 18px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.toolbar .field { flex: 0 1 210px; }
.toolbar .field select { margin: 0; }

/* 登录 */
body.plain { display: grid; place-items: center; min-height: 100vh; padding: 32px; }
.plain-wrap { width: 100%; max-width: 400px; position: relative; z-index: 1; }
.plain-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.plain-brand .brand-name { color: var(--ink); }
.plain-brand .brand-sub { color: var(--faint); }
.login-card {
  padding: 30px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: 0 24px 48px -34px rgba(23, 26, 24, .55);
}
.login-card h1 { font: 600 26px/1.2 var(--font-display); margin-bottom: 8px; }
.login-card .lead { color: var(--muted); font-size: 13px; margin-bottom: 22px; }

@media (max-width: 960px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar {
    position: relative; height: auto; min-width: 0; flex-direction: column; align-items: stretch;
    gap: 10px; padding: 12px 14px 10px; border-right: 0; border-bottom: 1px solid var(--sidebar-line);
  }
  .brand { gap: 10px; }
  .brand-mark { width: 30px; height: 30px; font-size: 10.5px; box-shadow: inset 0 -9px 0 rgba(0, 0, 0, .14); }
  .brand-name { font-size: 13.5px; letter-spacing: .06em; }
  .brand-sub { display: none; }
  .nav {
    flex-direction: row; flex-wrap: nowrap; gap: 2px; width: 100%; min-width: 0;
    overflow-x: auto; scrollbar-width: none; padding-bottom: 2px;
  }
  .nav::-webkit-scrollbar { display: none; }
  .nav-group { flex: none; flex-direction: row; align-items: center; gap: 2px; }
  .nav-label { display: none; }
  .nav-index { display: none; }
  .nav-link { padding: 6px 9px; font-size: 12.5px; white-space: nowrap; flex: none; }
  .nav-link.active::before { display: none; }
  .side-foot { display: none; }
  .topbar { padding: 0 20px; }
  .top-tag { display: none; }
  main { padding: 24px 18px 72px; }
  .page-head { align-items: flex-start; }
  .page-head h1 { font-size: 23px; }
  .form-grid { grid-template-columns: 1fr; }
  .target-grid { grid-template-columns: 1fr; }
  .meta { grid-template-columns: 1fr; gap: 2px 0; }
  .meta dd { margin-bottom: 10px; }
  .cli-card { flex-direction: column; }
  .table th, .table td { padding: 11px 12px; }
  .table .cell-sub { display: none; }
  .targets-table .cell-sub { display: block; }
  .key-head { flex-direction: column; }
  .key-actions { width: 100%; }
}
@media (max-width: 480px) {
  .topbar { height: 50px; }
  .crumbs { font-size: 9.5px; gap: 6px; }
  .page-head { gap: 14px; margin-bottom: 20px; padding-bottom: 18px; }
  .page-actions { width: 100%; }
  .page-actions .btn { flex: 1; }
  .panel-body { padding: 16px; }
  .form-actions { align-items: flex-start; flex-direction: column; }
  .form-actions .btn { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;