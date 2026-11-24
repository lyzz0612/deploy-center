/**
 * 字段声明：插件用它描述「目标实例要填什么」与「每次发布要填什么」，
 * 核心据此渲染表单并校验输入。
 *
 * 为什么要有这一层：差异只能靠声明表达，不能靠核心代码里的条件分支。
 * 核心出现 `if (kind === 'wechat')` 即视为抽象失败（design.md D4 规则 3）。
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'select';

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface Field {
  /** 字段键名，出现在 location / params 的 JSON 里。 */
  readonly key: string;
  /** 表单上显示的名称。 */
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  /** 填写说明，解释这个值从哪里来。 */
  readonly help?: string;
  readonly placeholder?: string;
  /** `type: 'select'` 时的可选项。 */
  readonly options?: readonly FieldOption[];
  /** 校验用的正则（字符串字段）。 */
  readonly pattern?: string;
  /**
   * 是否参与「同一游戏内目标实例去重」的位置标识。
   *
   * 只有真正决定「发到哪」的字段该参与：微信的 appid 要算，备注不该算。
   * 否则改个备注就能绕过去重，造出两个互相覆盖的实例。
   */
  readonly identity?: boolean;
}

export interface FieldError {
  readonly key: string;
  readonly message: string;
}

/**
 * 按字段声明校验一组值。返回全部错误而不是遇到第一个就停——表单要一次
 * 把问题都标出来。
 */
export function validateFields(
  fields: readonly Field[],
  values: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];
  const declared = new Set(fields.map((f) => f.key));

  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      errors.push({ key, message: `未声明的字段 ${key}` });
    }
  }

  for (const field of fields) {
    const value = values[field.key];
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (field.required) {
        errors.push({ key: field.key, message: `${field.label} 为必填` });
      }
      continue;
    }

    switch (field.type) {
      case 'string':
      case 'select': {
        if (typeof value !== 'string') {
          errors.push({ key: field.key, message: `${field.label} 必须是字符串` });
          break;
        }
        if (field.type === 'select') {
          const allowed = field.options?.map((o) => o.value) ?? [];
          if (!allowed.includes(value)) {
            errors.push({
              key: field.key,
              message: `${field.label} 必须是以下之一：${allowed.join(', ')}`,
            });
          }
        }
        if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
          errors.push({ key: field.key, message: `${field.label} 格式不正确` });
        }
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push({ key: field.key, message: `${field.label} 必须是数字` });
        }
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          errors.push({ key: field.key, message: `${field.label} 必须是布尔值` });
        }
        break;
      }
    }
  }

  return errors;
}

/** 从一组值里取出参与去重的字段，用于算 location_key。 */
export function identityValues(
  fields: readonly Field[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.identity === true && values[field.key] !== undefined) {
      result[field.key] = values[field.key];
    }
  }
  return result;
}
