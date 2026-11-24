import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * 判断某个模块是否作为进程入口被直接执行。
 *
 * 不要用 `import.meta.url === \`file://${process.argv[1]}\`` 比较：
 * Windows 上 argv[1] 形如 `G:\app\main.js`，而 import.meta.url 形如
 * `file:///G:/app/main.js`，字符串永不相等，于是入口逻辑被静默跳过。
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}
