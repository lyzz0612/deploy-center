/**
 * 登录与首次设置口令。
 */
import { html, type Html } from '../html.js';

export function loginPage(options: { readonly error?: string } = {}): Html {
  return html`
    <h1>登录</h1>
    ${options.error === undefined ? html`` : html`<div class="notice err">${options.error}</div>`}
    <form class="card" method="post" action="/login" style="max-width:420px">
      <label>管理员口令</label>
      <input type="password" name="password" required autofocus>
      <p><button type="submit">登录</button></p>
    </form>
  `;
}

export function setupPage(options: { readonly error?: string } = {}): Html {
  return html`
    <h1>首次设置</h1>
    <p class="lead">
      还没有设置管理员口令。系统刚起来时谁都没有口令，这是必然的初始窗口，
      <strong>请立刻设置</strong>。
    </p>
    ${options.error === undefined ? html`` : html`<div class="notice err">${options.error}</div>`}
    <form class="card" method="post" action="/setup" style="max-width:420px">
      <label>管理员口令<span class="hint">至少 8 个字符。</span></label>
      <input type="password" name="password" required minlength="8" autofocus>
      <p><button type="submit">设置并登录</button></p>
    </form>
  `;
}
