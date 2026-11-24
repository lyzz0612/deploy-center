/**
 * 把领域错误映射成 HTTP 状态码。
 *
 * 为什么要这一层：领域代码只管「拒绝并说清原因」，不该知道 HTTP。而
 * 接口层若对所有错误一律回 400，用户就分不清「我填错了」和「这条记录
 * 正被引用」——后者该是 409。
 */
import { ReferencedError } from '../db/index.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

export interface HttpErrorShape {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export function toHttpError(error: unknown): HttpErrorShape {
  if (error instanceof NotFoundError) {
    return { status: 404, code: 'not_found', message: error.message };
  }
  if (error instanceof ReferencedError || error instanceof ConflictError) {
    return { status: 409, code: 'conflict', message: error.message };
  }
  if (error instanceof Error) {
    return { status: 400, code: 'bad_request', message: error.message };
  }
  return { status: 500, code: 'internal_error', message: String(error) };
}
