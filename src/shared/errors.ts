/**
 * 领域错误。
 *
 * 放在 shared 而不是 web 下：领域代码要能表达「这是冲突不是参数错误」，
 * 但不该知道 HTTP 状态码。映射成状态码是 web/errors.ts 的事。
 */

/** 请求指向的东西不存在。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * 请求本身合法，但与当前状态冲突：重名、被引用、跨类型发布、重复实例。
 *
 * 与普通 Error（参数错误）分开，是为了让调用方能区分「我填错了」和
 * 「这个操作在当前状态下不成立」——前者改输入，后者要先改状态。
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
