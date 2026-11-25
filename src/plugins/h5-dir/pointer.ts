/**
 * H5 生效指针（config.json）的格式。
 *
 * 这是整个 H5 方案的核心物件：入口 index.html 固定不变、可以长缓存，
 * 它只去读这个 2KB 的 JSON 来决定加载哪个版本。于是「必须最新」的面积
 * 被压缩到一个 URL 上。
 *
 * 壳要尽量笨：base 放在 config 里而不是让壳自己拼，这样以后改目录结构
 * 改的是 JSON 而不是已经被缓存了一年的壳。
 */

/** 指针文件名。壳固定去读这个名字。 */
export const POINTER_FILE = 'config.json';

/** 版本目录的父目录名。 */
export const VERSIONS_DIR = 'v';

export interface Pointer {
  /**
   * 格式版本。
   *
   * 壳被长期缓存，所以老壳会读到新 config。只能加字段、不能改语义，
   * 而这个号让壳能自己判断「这是我认识的格式吗」。
   */
  readonly schema: 1;
  /** 当前生效的版本标识。 */
  readonly active: string;
  /** 上一个版本，供一键回滚。没有时为 null。 */
  readonly prev: string | null;
  /** 资源基路径。壳直接用它拼，不自己推导。 */
  readonly base: string;
  readonly updatedAt: string;
}

export function makePointer(options: {
  active: string;
  prev: string | null;
  prefix: string;
}): Pointer {
  return {
    schema: 1,
    active: options.active,
    prev: options.prev,
    base: `${normalizePrefix(options.prefix)}${VERSIONS_DIR}/${options.active}/`,
    updatedAt: new Date().toISOString(),
  };
}

/** 前缀统一以 / 结尾、不以 / 开头，便于拼接。 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

export function parsePointer(raw: string): Pointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('指针文件不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('指针文件不是对象');
  }
  const candidate = parsed as Partial<Pointer>;
  if (candidate.schema !== 1) {
    throw new Error(`不认识的指针格式版本 ${String(candidate.schema)}`);
  }
  if (typeof candidate.active !== 'string' || candidate.active === '') {
    throw new Error('指针文件缺少 active');
  }
  return {
    schema: 1,
    active: candidate.active,
    prev: typeof candidate.prev === 'string' ? candidate.prev : null,
    base: typeof candidate.base === 'string' ? candidate.base : '',
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
  };
}
