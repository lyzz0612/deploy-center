/**
 * 数据库结构定义（design.md D7b：建表，不是迁移框架）。
 *
 * 系统没有存量数据，所以这里只有 `CREATE TABLE IF NOT EXISTS`。
 * 第一次需要改动已上线的表结构时，再引入真正的迁移机制。
 *
 * SCHEMA_VERSION 写进 `PRAGMA user_version`，只用于「知道当前在哪一版」。
 * 改动下面任何一条 DDL 时必须同时 +1，否则已有库会与代码悄悄不一致。
 *
 * 两条贯穿全表的约定：
 *
 * - **归档用时间戳而不是布尔**（`archived_at`）。被引用的记录只允许归档、
 *   不允许物理删除（design.md D3），而「什么时候归档的」本身有用，
 *   用布尔还得再加一列存时间。
 * - **时间统一存 ISO-8601 文本**。SQLite 没有日期类型，文本可读、可排序、
 *   可直接比较，比存 epoch 数字更省心。
 */

/** 当前结构版本。改 DDL 必须同时递增。 */
export const SCHEMA_VERSION = 3;

/**
 * 建表语句。顺序即依赖顺序（被引用的表在前）。
 */
export const DDL: readonly string[] = [
  /* ------------------------------ 鉴权与设置 ------------------------------ */

  // 单行配置表：管理员口令哈希等。用固定主键 1 约束「只能有一行」。
  `CREATE TABLE IF NOT EXISTS settings (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     password_hash   TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   )`,

  // CI key。只存哈希，永不存原文：CI key 只需验证，不需取回
  // （与 Credential 不同，后者要交给平台 CLI 使用，必须可逆）。
  `CREATE TABLE IF NOT EXISTS ci_keys (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     prefix       TEXT NOT NULL,
     token_hash   TEXT NOT NULL UNIQUE,
     created_at   TEXT NOT NULL,
     last_used_at TEXT,
     revoked_at   TEXT
   )`,

  /* -------------------------------- 全局数据 -------------------------------- */

  // 包类型：纯标签，不携带任何影响产物处理的行为字段（design.md D2）。
  // 一旦有人想加「解压策略」这类字段，它就跨过数据/代码分界线了。
  `CREATE TABLE IF NOT EXISTS package_types (
     id           TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     archived_at  TEXT
   )`,

  // 凭据：类型化的加密键值袋。字段集由 type 决定，不由目标类型决定。
  // secrets 列是整体加密后的密文，库里任何位置都不出现明文。
  `CREATE TABLE IF NOT EXISTS credentials (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     type         TEXT NOT NULL,
     secrets      BLOB NOT NULL,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     archived_at  TEXT
   )`,

  /* -------------------------------- 游戏级数据 ------------------------------- */

  // 游戏。slug 创建后不可改：它出现在构建上报与产物路径里。
  `CREATE TABLE IF NOT EXISTS games (
     id           TEXT PRIMARY KEY,
     slug         TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     archived_at  TEXT
   )`,

  // 发布目标实例。kind 是代码侧注册的目标类型 id（不建外键，它不在库里）。
  //
  // location 存 kind 特有的位置字段（微信是 appid，H5 是 bucket + prefix），
  // 形状由插件的 targetSchema 决定，所以只能是 JSON。
  //
  // location_key 是 location 的规范化形式（键名排序后序列化），专供唯一
  // 约束使用：直接对 JSON 文本建唯一约束是无效的，`{"a":1,"b":2}` 与
  // `{"b":2,"a":1}` 语义相同但文本不同，会绕过约束。
  `CREATE TABLE IF NOT EXISTS targets (
     id             TEXT PRIMARY KEY,
     game_id        TEXT NOT NULL REFERENCES games(id),
     kind           TEXT NOT NULL,
     name           TEXT NOT NULL,
     credential_id  TEXT REFERENCES credentials(id),
     location       TEXT NOT NULL,
     location_key   TEXT NOT NULL,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL,
     archived_at    TEXT
   )`,

  // 同一游戏内不允许「同类型 + 同凭据 + 同位置」的重复实例：那是互相覆盖
  // 的定时炸弹（publish-targets spec：目标实例去重）。
  //
  // credential_id 可为空，而 SQLite 的 UNIQUE 认为 NULL 彼此不相等，会让
  // 多条无凭据的重复实例都通过。用 COALESCE 把 NULL 折成固定字符串。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_identity
     ON targets (game_id, kind, COALESCE(credential_id, ''), location_key)`,

  // 构建：CI 上报的事实，不可变。
  // package_type 必须已登记（game-catalog spec：未登记包类型拒绝写入）。
  `CREATE TABLE IF NOT EXISTS builds (
     id              TEXT PRIMARY KEY,
     game_id         TEXT NOT NULL REFERENCES games(id),
     package_type_id TEXT NOT NULL REFERENCES package_types(id),
     build_id        TEXT NOT NULL,
     artifact_url    TEXT NOT NULL,
     size_bytes      INTEGER NOT NULL,
     sha256          TEXT NOT NULL,
     commit_sha      TEXT,
     description     TEXT,
     reported_at     TEXT NOT NULL,
     ci_key_id       TEXT REFERENCES ci_keys(id)
   )`,

  // 上报幂等键：同一游戏、同一包类型、同一构建标识重复上报应更新而非新增
  // （build-ingestion spec：上报幂等）。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_builds_identity
     ON builds (game_id, package_type_id, build_id)`,

  `CREATE INDEX IF NOT EXISTS idx_builds_commit
     ON builds (game_id, commit_sha)`,

  /* --------------------------------- 发布记录 -------------------------------- */

  // 发布记录。维度是「构建 × 目标」而非「构建 × 平台」：同一构建可以发到
  // 正式号和测试号，同一 H5 包可以发到生产和灰度。
  //
  // build 与 target 的外键刻意不加 ON DELETE：被发布记录引用的目标只能归档，
  // 物理删除由 API 层拦截（design.md D3）。
  `CREATE TABLE IF NOT EXISTS releases (
     id           TEXT PRIMARY KEY,
     build_id     TEXT NOT NULL REFERENCES builds(id),
     target_id    TEXT NOT NULL REFERENCES targets(id),
     params       TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (
                    status IN ('queued','running','success','failed','timeout','cancelled')
                  ),
     created_by   TEXT NOT NULL DEFAULT 'owner',
     created_at   TEXT NOT NULL,
     finished_at  TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_releases_target
     ON releases (target_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_releases_build
     ON releases (build_id, created_at DESC)`,

  // 阶段执行记录。主键含 attempt，所以重试天然留痕而不是覆盖上一次
  // （release-execution spec：重试保留一次新的尝试记录）。
  //
  // 「当前状态」是每个阶段 attempt 最大的那一行；seq 保证阶段顺序可排。
  `CREATE TABLE IF NOT EXISTS release_stages (
     id           TEXT PRIMARY KEY,
     release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
     stage_id     TEXT NOT NULL,
     seq          INTEGER NOT NULL,
     attempt      INTEGER NOT NULL,
     status       TEXT NOT NULL CHECK (
                    status IN ('queued','running','success','failed','timeout','cancelled','skipped')
                  ),
     log          TEXT NOT NULL DEFAULT '',
     started_at   TEXT,
     finished_at  TEXT
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_release_stages_attempt
     ON release_stages (release_id, stage_id, attempt)`,

  /* ---------------------------------- 任务 ---------------------------------- */

  // 任务队列。进程内单循环顺序取用，不引入外部队列中间件（design.md D7）。
  //
  // ref_id 指向任务对象（publish 指向 releases.id，cli_install 指向 CLI 名称），
  // 因为指向不同表所以不加外键。
  // seq 是领取顺序的唯一依据，用自增整数而不是按 created_at 排：同一毫秒
  // 投递的多个任务（例如一次把三个平台都发出去）时间戳相同，排序会退化到
  // 按 id，而 id 是随机 UUID，于是 FIFO 不成立。
  //
  // seq 作主键（SQLite 里只有 INTEGER PRIMARY KEY 才自增），id 仍是对外
  // 使用的稳定标识。
  `CREATE TABLE IF NOT EXISTS jobs (
     seq          INTEGER PRIMARY KEY AUTOINCREMENT,
     id           TEXT NOT NULL UNIQUE,
     kind         TEXT NOT NULL CHECK (kind IN ('publish','cli_install')),
     ref_id       TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (
                    status IN ('queued','running','success','failed','timeout','cancelled')
                  ),
     attempts     INTEGER NOT NULL DEFAULT 0,
     log          TEXT NOT NULL DEFAULT '',
     error        TEXT,
     created_at   TEXT NOT NULL,
     started_at   TEXT,
     finished_at  TEXT
   )`,

  // 取下一个待执行任务时按状态 + seq 扫，给它一个索引。
  `CREATE INDEX IF NOT EXISTS idx_jobs_pending
     ON jobs (status, seq)`,
];

/**
 * 期望存在的表名。建表后用它核对实际结构，防止「表已存在所以静默跳过」
 * 导致代码与库不一致。
 */
export const EXPECTED_TABLES: readonly string[] = [
  'settings',
  'ci_keys',
  'package_types',
  'credentials',
  'games',
  'targets',
  'builds',
  'releases',
  'release_stages',
  'jobs',
];

/**
 * 期望存在的索引名。与表一样要核对：唯一约束缺失不会让查询报错，
 * 只会让重复数据悄悄写进去。
 */
export const EXPECTED_INDEXES: readonly string[] = [
  'idx_targets_identity',
  'idx_builds_identity',
  'idx_builds_commit',
  'idx_releases_target',
  'idx_releases_build',
  'idx_release_stages_attempt',
  'idx_jobs_pending',
];
