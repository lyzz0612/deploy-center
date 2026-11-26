/**
 * 登记册：游戏与包类型。两者都是纯数据（design.md D2）。
 */
export {
  countGameDependents,
  createGame,
  deleteGameCascade,
  findGameBySlug,
  getGame,
  listGames,
  renameGame,
  requireActiveGame,
  type CreateGameInput,
  type Game,
  type GameDeletionImpact,
} from './games.js';

export { seedPackageTypes, type SeedPackageTypesResult } from './seed.js';

export {
  createPackageType,
  deletePackageType,
  findPackageType,
  getPackageType,
  listPackageTypes,
  renamePackageType,
  requireActivePackageType,
  type CreatePackageTypeInput,
  type PackageType,
} from './package-types.js';
