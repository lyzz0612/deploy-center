/**
 * 站点入口壳。
 *
 * 指针方案的另一半：桶里必须有一个**内容永不变化**的入口页，它去读无缓存
 * 的指针、再把浏览器送到当前版本目录。没有它，根目录下就只有 config.json
 * 和 v/，站点是打不开的——产物自己的 index.html 躺在 v/<版本>/ 里，不该
 * （也不能）被直接访问到根路径。
 *
 * 壳被长缓存，所以它里面**不能有任何随发布变化的东西**（版本号、构建标识
 * 都不行）：那些全在指针里。改壳的语义 = 改这个文件，且要让老缓存自然过期。
 */

/** 出口壳的固定文件名（静态站点的入口约定）。 */
export const SHELL_FILE = 'index.html';

/** 壳里的一句话标记。发布日志与测试据此确认「这个入口是壳，不是产物」。 */
export const SHELL_MARKER = 'h5-r2-shell';

/**
 * 壳的 HTML。
 *
 * 故意保持「笨」：只做三件事——读指针、拿 base、跳过去。加载失败时把原因
 * 写在自己身上，而不是留一个白屏：根路径打不开时，用户能看到的只有这一页。
 */
export const SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>加载中…</title>
<style>
html,body{margin:0;height:100%;background:#111;color:#ccc;
font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
</style>
</head>
<body>
<!-- ${SHELL_MARKER} -->
<p id="hint">正在加载…</p>
<script>
(function () {
  var hint = document.getElementById('hint');
  function fail(text) { hint.textContent = '加载失败：' + text; }
  // ?t= 每次不同：指针必须回源，不能被浏览器或 CDN 缓存吃掉
  fetch('config.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('config.json HTTP ' + r.status);
      return r.json();
    })
    .then(function (cfg) {
      if (!cfg || typeof cfg.base !== 'string' || cfg.base === '') {
        throw new Error('指针里没有 base');
      }
      location.replace(cfg.base + 'index.html');
    })
    .catch(function (e) { fail(e && e.message ? e.message : String(e)); });
})();
</script>
</body>
</html>
`;