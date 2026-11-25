/**
 * 表单解析。
 *
 * 表单字段用 `location.appid`、`params.version` 这种点号前缀分组，因为
 * 插件声明的字段要分别进 location 与 params 两个 JSON。这里把它们还原成
 * 嵌套对象，并按声明做类型转换（HTML 表单里一切都是字符串）。
 */
import type { IncomingMessage } from 'node:http';

import type { Field } from '../registry/index.js';

const MAX_BODY_BYTES = 1024 * 1024;

export async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('请求体过大');
    }
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 按字段声明把带前缀的表单值收集成一个对象。
 *
 * 类型转换必须按声明走，不能猜：表单里 `robot=2` 是字符串 "2"，而字段声明
 * 它是 number；复选框未勾选时根本不出现在表单里，而声明它是 boolean。
 * 猜的话会把 "2" 原样存进 location，然后在插件里撞上类型不符。
 */
export function collectFields(
  form: URLSearchParams,
  prefix: string,
  fields: readonly Field[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = form.get(`${prefix}.${field.key}`);

    if (field.type === 'boolean') {
      // 复选框未勾选时不出现在表单里，所以缺失即 false
      result[field.key] = raw === 'true' || raw === 'on';
      continue;
    }

    if (raw === null || raw === '') {
      // 不写入空值：留空等于「没填」，而 validateFields 对缺失与空串
      // 的处理是一致的（都算未填）。写进去只会让 location_key 变脏。
      continue;
    }

    if (field.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`${field.label} 必须是数字，实际为 ${JSON.stringify(raw)}`);
      }
      result[field.key] = value;
      continue;
    }

    result[field.key] = raw;
  }

  return result;
}

/** 取一个必填的表单字段。 */
export function requireField(form: URLSearchParams, name: string, label = name): string {
  const value = form.get(name);
  if (value === null || value.trim() === '') {
    throw new Error(`${label} 为必填`);
  }
  return value;
}
