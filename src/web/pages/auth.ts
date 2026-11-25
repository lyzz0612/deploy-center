/**
 * 登录与首次设置口令。这两个页面走 `chrome: 'plain'`，没有侧栏。
 */
import { html, type Html } from '../html.js';

export function loginPage(options: { readonly error?: string } = {}): Html {
  return html`
    <div class="login-card">
      <h1>登录</h1>
      <p class="lead">输入管理员口令继续。</p>
      ${options.error === undefined ? html`` : html`<div class="notice err">${options.error}</div>`}
      <form method="post" action="/login">
        <div class="field">
          <label>管理员口令</label>
          <input type="password" name="password" required autofocus>
        </div>
        <button class="btn" type="submit" style="width:100%;margin-top:20px">登录</button>
      </form>
    </div>
  `;
}

export function setupPage(options: { readonly error?: string } = {}): Html {
  return html`
    <div class="login-card">
      <h1>首次设置</h1>
      <p class="lead">
        还没有设置管理员口令。系统刚起来时谁都没有口令，这是必然的初始窗口，
        <strong>请立刻设置</strong>。
      </p>
      ${options.error === undefined ? html`` : html`<div class="notice err">${options.error}</div>`}
      <form method="post" action="/setup">
        <div class="field">
          <label>管理员口令</label>
          <input type="password" name="password" required minlength="8" autofocus>
          <span class="hint">至少 8 个字符。</span>
        </div>
        <button class="btn" type="submit" style="width:100%;margin-top:20px">设置并登录</button>
      </form>
    </div>
  `;
}