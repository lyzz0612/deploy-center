/**
 * 服务端 HTML 渲染。
 *
 * 为什么不是 React + Vite（design.md D9 原本这么写）：这是单人用的后台，
 * 交互量是「表单 + 列表 + 轮询日志」。SPA 会让 Dockerfile 多一个构建阶段、
 * 产物多一套静态资源、调试多一层 source map，而换来的体验差别在这个量级
 * 上看不出来。偏离已记进 design.md D9。
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

/** 页面骨架。 */
export function layout(options: {
  readonly title: string;
  readonly body: Html;
  readonly nav?: Html;
  readonly refreshSeconds?: number;
}): string {
  const refresh =
    options.refreshSeconds === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)} · 发布中控台</title>
${refresh}
<style>${STYLES}</style>
</head>
<body>
<header>
  <a class="brand" href="/">发布中控台</a>
  <nav>
    <a href="/">游戏</a>
    <a href="/builds">构建</a>
    <a href="/releases">发布记录</a>
    <a href="/settings">设置</a>
  </nav>
</header>
<main>
${options.nav === undefined ? '' : options.nav.value}
${options.body.value}
</main>
</body>
</html>`;
}

const STYLES = `
:root {
  --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6761; --line: #e2ddd5;
  --accent: #1f5f4a; --ok: #1f7a3d; --warn: #9a6a00; --err: #a62b1f;
  --card: #fff;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, "Segoe UI", system-ui, "Noto Sans SC", sans-serif;
}
header {
  display: flex; align-items: center; gap: 24px;
  padding: 14px 28px; background: var(--card); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; color: var(--accent); text-decoration: none; }
header nav { display: flex; gap: 18px; }
header nav a { color: var(--muted); text-decoration: none; }
header nav a:hover { color: var(--fg); }
main { max-width: 1100px; margin: 0 auto; padding: 24px 28px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 12px; }
h3 { font-size: 15px; margin: 20px 0 8px; }
p.lead { color: var(--muted); margin: 0 0 24px; }
a { color: var(--accent); }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 18px 20px; margin-bottom: 16px;
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
th { font-weight: 600; font-size: 13px; color: var(--muted); }
td.num { font-variant-numeric: tabular-nums; }
code, pre, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
pre {
  background: #15140f; color: #e8e3d8; padding: 14px 16px; border-radius: 6px;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 460px;
}
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 11px;
  font-size: 12px; border: 1px solid var(--line); background: #f5f2ec;
}
.badge.ok { color: var(--ok); border-color: #bfe0c8; background: #f1f9f3; }
.badge.err { color: var(--err); border-color: #e8c4bf; background: #fdf3f2; }
.badge.warn { color: var(--warn); border-color: #e6d6a8; background: #fdf9ee; }
.badge.run { color: #1f4f7a; border-color: #bfd4e0; background: #f1f6f9; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
form.inline { display: inline; }
label { display: block; margin: 12px 0 4px; font-size: 13px; font-weight: 600; }
label .hint { display: block; font-weight: 400; color: var(--muted); margin-top: 2px; }
input[type=text], input[type=password], input[type=number], select, textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 5px; font: inherit; background: #fff;
}
textarea { min-height: 90px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
button {
  padding: 8px 16px; border: 1px solid var(--accent); background: var(--accent);
  color: #fff; border-radius: 5px; font: inherit; cursor: pointer;
}
button.secondary { background: #fff; color: var(--fg); border-color: var(--line); }
button:disabled { opacity: .45; cursor: not-allowed; }
.row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.row > * { flex: 1 1 220px; }
.blockers { margin: 10px 0 0; padding-left: 20px; color: var(--err); font-size: 13px; }
.notice {
  padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 14px;
  border: 1px solid #e6d6a8; background: #fdf9ee; color: var(--warn);
}
.notice.err { border-color: #e8c4bf; background: #fdf3f2; color: var(--err); }
.notice.ok { border-color: #bfe0c8; background: #f1f9f3; color: var(--ok); }
.empty { color: var(--muted); padding: 28px 0; text-align: center; }
`;

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

/** 时间的简短形式。 */
export function shortTime(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
}
