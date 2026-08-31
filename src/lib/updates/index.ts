/**
 * Agent CLI update flow (Issue #2069).
 *
 * `codex.ts` is deliberately untouched by this feature: reading
 * `~/.codex/version.json` and running `codex update` are neither session
 * lifecycle nor screen scraping, and putting them in the tool class would put a
 * child-process spawner inside the module every pane's `startSession` goes
 * through.
 *
 * @module lib/updates
 */

export {
  CODEX_HOME_ENV_VAR,
  CODEX_VERSION_FILENAME,
  CODEX_VERSION_FILE_MAX_BYTES,
  EMPTY_CODEX_VERSION_FILE,
  getCodexHomeForVersionRead,
  getCodexVersionFilePath,
  readCodexVersionFile,
  evaluateCodexUpdate,
} from './codex-version';
export type { CodexVersionFile, CodexUpdateStatus, CodexVersionEnv } from './codex-version';

export {
  UPDATABLE_AGENT_TOOLS,
  CODEX_NPM_PACKAGE,
  CODEX_NATIVE_UPDATE_MIN_VERSION,
  AGENT_UPDATE_TIMEOUT_MS,
  AGENT_UPDATE_MAX_BUFFER_BYTES,
  isUpdatableAgentTool,
  resolveAgentUpdatePlan,
  runAgentUpdate,
  acquireAgentUpdateLock,
  releaseAgentUpdateLock,
  isAgentUpdateInProgress,
} from './agent-updater';
export type {
  UpdatableAgentTool,
  AgentUpdatePlan,
  AgentUpdatePlanResult,
  AgentUpdatePlanFailure,
  AgentUpdateStrategy,
  AgentUpdateChunk,
  AgentUpdateResult,
  RunAgentUpdateOptions,
} from './agent-updater';

export {
  AGENT_VERSIONS_CACHE_TTL_MS,
  getAgentVersions,
  clearAgentVersionsCache,
} from './agent-versions';
export type { AgentVersionRow } from './agent-versions';
