export {
  checkKind,
  checkTarget,
  preflight,
  type CheckTargetDeps,
  type KindStatus,
  type LeveledCheck,
  type PreflightResult,
  type TargetStatus,
} from './checks.js';

export {
  binaryPath,
  currentPrefix,
  installCli,
  npmCliCandidates,
  npmCliCandidatesFor,
  npmCliPath,
  run,
  versionPrefix,
  type InstallOptions,
  type InstallResult,
  type RunResult,
} from './install.js';

export { probeAllClis, probeCli, type CliProbeResult } from './probe.js';

export {
  readRegistry,
  recordInstall,
  registryPath,
  switchVersion,
  writeRegistry,
  type CliEntry,
  type CliRegistry,
  type InstalledVersion,
} from './registry-file.js';
