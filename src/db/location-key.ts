/**
 * 目标实例「位置字段」的规范化。
 *
 * 为什么需要它：`targets.location` 存的是 kind 特有的位置字段（微信是
 * appid，H5 是 bucket + prefix），形状由插件声明，所以只能是 JSON 文本。
 * 但直接对 JSON 文本建唯一约束是无效的——`{"a":1,"b":2}` 和 `{"b":2,"a":1}`
 * 语义相同、文本不同，重复实例会绕过约束写进去，然后在发布时互相覆盖。
 *
 * 所以额外存一列 `location_key`：键名排序后序列化的结果。
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function normalize(value: unknown): Json {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, Json> = {};
    // 键名排序，使键序不影响结果。
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key]);
      // 丢掉值为 undefined / null 的键：「没填」与「填了空」在位置标识
      // 上是同一件事，不该产生两个不同的 key。
      if (normalized === null) continue;
      result[key] = normalized;
    }
    return result;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === undefined) return null;

  throw new Error(`位置字段不支持的类型：${typeof value}`);
}

/**
 * 把位置字段算成稳定的标识串。键序与空值写法不同的等价输入得到同一结果。
 */
export function locationKey(location: Record<string, unknown>): string {
  return JSON.stringify(normalize(location));
}
