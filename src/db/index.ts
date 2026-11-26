/**
 * 数据访问层：SQLite 连接、建表与仓储。
 */
export { open, ensureSchema, databaseFile, type Db, type EnsureSchemaResult } from './connection.js';
export { SCHEMA_VERSION } from './schema.js';
export { locationKey } from './location-key.js';
export {
  deleteIfUnreferenced,
  findReferences,
  protectedTables,
  ReferencedError,
  type ReferenceCheck,
  type ReferenceSource,
} from './references.js';
