/**
 * 登记册：游戏与包类型。两者都是纯数据（design.md D2）。
 */
export {
  archiveGame,
  createGame,
  findGameBySlug,
  getGame,
  listGames,
  renameGame,
  requireActiveGame,
  unarchiveGame,
  type CreateGameInput,
  type Game,
  type ListGamesOptions,
} from './games.js';

export {
  archivePackageType,
  createPackageType,
  deletePackageType,
  findPackageType,
  getPackageType,
  listPackageTypes,
  renamePackageType,
  requireActivePackageType,
  unarchivePackageType,
  type CreatePackageTypeInput,
  type ListPackageTypesOptions,
  type PackageType,
} from './package-types.js';
