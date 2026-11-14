/**
 * The one way a role gets into a launch (Issue #4115, Epic #4112).
 *
 * Every interactive start goes through `BaseCLITool.startSession`, including the
 * relaunch a driver does inside a send, and that calls {@link requestLaunchRole}
 * once. The answer is a frozen {@link LaunchRoleSnapshot}. It reaches the launch
 * line through an `AsyncLocalStorage`, because `AgentLaunchContext` must not carry
 * the database and seven `launchSession` signatures need not change.
 *
 * ## "The same role"
 *
 * - A new launch resolves the latest settings.
 * - Retries inside one launch (Codex's relaunch after its update) use the same
 *   snapshot, and {@link noteLaunchProcessReplaced} moves the generation on, so the
 *   `launched` record names the process that is actually there at the end.
 * - A process being reused gets nothing: only a launch line that was really built
 *   opens a generation, so reconnecting never records anything as applied.
 *
 * ## Refusals
 *
 * A snapshot can carry a refusal instead of a role. It is thrown when a launch would
 * actually happen, so a live process can still be reconnected to (its role was
 * fixed when it started). It never falls back to "no role", and it does not use
 * `prepareLaunch`'s fail-open: many CLIs carry on without a role when handed a bad
 * one (§8), so the file is inspected before anything is typed.
 *
 * ## Evidence
 *
 * {@link getLaunchRoleEvidence} is what this server knows about the process it
 * started: the generation and what it injected, in memory. After a server restart
 * there is none, and the state reads as unknown rather than as whatever the last
 * record said. The `launched` record is written only on the evidence §14 lists per
 * adapter; with none (Command Code, Antigravity) it stays unknown.
 *
 * @module lib/session/role-launch
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import { getOrInitGlobal } from '@/lib/global-state';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { getInstanceRoleState, getLatestRoleLaunchRecords, hasAnyRoleSetting, recordRoleLaunch } from '@/lib/db/agent-roles-db';
import { renderAgentLaunchCommand } from '@/lib/hooks/sources/launch-command';
import type { AgentLaunchContext, AgentLaunchPlan } from '@/lib/hooks/sources/types';
import { computeFingerprint } from '@/lib/agent-roles/fingerprint';
import {
  buildRoleLaunchArguments,
  computeRoleInjection,
  renderRoleFlags,
  renderSecretEnvAssignment,
  splitRoleEnv,
  type RoleComposition,
  type RoleInjection,
  type RoleLaunchArguments,
} from '@/lib/agent-roles/adapters';
import {
  buildArtifactName,
  deriveServerNamespace,
  inspectRoleArtifact,
  RoleArtifactError,
  writeLaunchEnvFile,
  removeLaunchEnvFile,
  writeRoleArtifact,
  type WrittenRoleArtifact,
} from '@/lib/agent-roles/artifacts';
import {
  assertLaunchCwdIsWorktree,
  fixedEnvReader,
  loadRoleComposition,
  RoleCompositionError,
  type RoleEnv,
  type RoleEnvReader,
  type RoleLaunchCwdReader,
} from '@/lib/agent-roles/composition';
import { RoleLaunchRefusedError, type RoleLaunchRefusalReason } from '@/lib/agent-roles/launch-errors';
import {
  describeAntigravityRoleRefusal,
  type AntigravityRoleCause,
  type AntigravityRoleRefusalDetail,
} from '@/lib/agent-roles/antigravity';
import {
  AgentRoleTargetNotFoundError,
  resolveDefaultsForTool,
  withSettledWorktreeMembership,
  type RoleRepositoryMembership,
  type RoleResolverDeps,
} from '@/lib/agent-roles/resolve';
import { UatIsolationLaunchRefusedError } from '@/config/uat-isolation';
import type { HeadlessRoleArguments } from '@/lib/session/claude-executor';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { isUnderTest } from '@/lib/test-run-detection';
import {
  isAgentRoleAdapterEnabled,
  isAgentRoleCliTool,
  type AgentRoleCliTool,
  type RoleLaunchPhase,
  type RoleResolution,
  type StoredRoleState,
} from '@/types/agent-roles';

const logger = createLogger('session/role-launch');

export interface LaunchRoleTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
}

/** One launch's answer, taken once and never re-read. */
export interface LaunchRoleSnapshot {
  readonly target: LaunchRoleTarget;
  readonly db: Database.Database;
  readonly resolution: RoleResolution | null;
  readonly membership: RoleRepositoryMembership | null;
  readonly composition: RoleComposition | null;
  /** Set when a role goes in. */
  readonly injection: RoleInjection | null;
  /** Null: this launch injects nothing. Compared by everything that compares roles. */
  readonly injectionFingerprint: string | null;
  /** Set when this launch may not happen. */
  readonly refusal: RoleLaunchRefusedError | null;
}

/** What this server knows about the process it started. Holds no body and no secret. */
export interface LaunchRoleEvidence {
  sessionGeneration: string;
  injectionFingerprint: string | null;
}

/**
 * Whether the role was seen applied to this generation (Issue #4385, Antigravity
 * only). The positive record is `confirmed`; every other state, and no record at
 * all, is "not confirmed" and the send gate refuses on it.
 */
export type RoleApplicationState = 'starting' | 'unknown' | 'confirmed' | 'refused';

interface RoleApplication {
  state: RoleApplicationState;
  /** Moves on every change, so an observation begun before a change changes nothing (D6). */
  version: number;
  refusal: { reason: 'not-applied' | 'not-confirmed'; cause: AntigravityRoleCause; toolName: string | null } | null;
  /** When the first send of this generation reached the gate; the grace counts from here. */
  graceStartedAt: number | null;
}

/** With what the launch composed from, which may hold the user's values and stays in here. */
interface StoredLaunchRoleEvidence extends LaunchRoleEvidence {
  composition: RoleComposition | null;
  /** OpenCode V1: this process continued a conversation that had another role (§6.4). */
  resumedAcrossRole: boolean;
  /** Whether a send's answer has said so already. */
  resumeNoticeTaken: boolean;
  /** Issue #4385: Antigravity with a role only; null for everything else. */
  application: RoleApplication | null;
  /** The agent's name and file this generation was launched with (Antigravity). */
  artifactName: string | null;
  artifactPath: string | null;
  /** The launch that opened this generation, so a late confirmation records `launched` for it (C10). */
  launch: LaunchRoleStore | null;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __launchRoleEvidence: Map<string, StoredLaunchRoleEvidence> | undefined;
  // eslint-disable-next-line no-var
  var __launchRoleScope: AsyncLocalStorage<LaunchRoleStore> | undefined;
  // eslint-disable-next-line no-var
  var __launchRoleEpochs: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __launchRoleTestDb: Database.Database | null | undefined;
}

/**
 * The database a launch resolves through, or null when there is none. In a test run
 * that is none unless the test hands one in: `getDbInstance()` creates a file when
 * there is none, and hundreds of suites drive `startSession` with tmux mocked
 * (the same rule as `resolveSessionArchiveDatabase`).
 */
function launchRoleDatabase(): Database.Database | null {
  if (isUnderTest()) return globalThis.__launchRoleTestDb ?? null;
  return getDbInstance();
}

/** Point the launch path at a database. Test-only. */
export function setLaunchRoleDatabaseForTest(db: Database.Database | null): void {
  globalThis.__launchRoleTestDb = db;
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

function refused(
  db: Database.Database,
  target: LaunchRoleTarget,
  reason: RoleLaunchRefusalReason,
  message: string,
  resolution: RoleResolution | null = null
): LaunchRoleSnapshot {
  return Object.freeze({
    target,
    db,
    resolution,
    membership: null,
    composition: null,
    injection: null,
    injectionFingerprint: null,
    refusal: new RoleLaunchRefusedError(reason, message),
  });
}

function noRoleFastPath(db: Database.Database, target: LaunchRoleTarget): LaunchRoleSnapshot {
  const resolution: RoleResolution = {
    cliToolId: target.cliToolId,
    repositoryId: null,
    repositoryIds: [],
    kind: 'none',
    source: 'fallback',
    reason: 'no-default',
  };
  return Object.freeze({
    target,
    db,
    resolution,
    membership: null,
    composition: null,
    injection: null,
    injectionFingerprint: null,
    refusal: null,
  });
}

export interface ResolveLaunchRoleInput extends LaunchRoleTarget {
  worktreePath: string;
  /** Where the user's env is read from. Not read when {@link composition} is given. */
  readEnv: RoleEnvReader;
  /**
   * A reused pane's cwd (Issue #4233), for a relative `XDG_CONFIG_HOME` / `HOME`.
   * None means the agent starts in `worktreePath` (a new pane, a Schedule).
   */
  readLaunchCwd?: RoleLaunchCwdReader;
  /** Use these instead of reading them again. */
  composition?: RoleComposition;
  /** Schedule's `agent`. */
  explicitAgent?: string | null;
  /** Schedule: the defaults only. A primary's own setting is not inherited. */
  defaultsOnly?: boolean;
}

/** Git failing once should not stop a launch, so an undetermined answer is asked once more. */
const MEMBERSHIP_ATTEMPTS = 2;

/**
 * Resolve the role and everything it takes to compute what would be injected. Never
 * throws: a problem is a snapshot with a refusal, so a caller has one thing to read.
 */
export async function resolveLaunchRole(
  db: Database.Database,
  input: ResolveLaunchRoleInput,
  deps: RoleResolverDeps = {}
): Promise<LaunchRoleSnapshot> {
  const target: LaunchRoleTarget = {
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId,
  };
  const instanceId = input.instanceId ?? input.cliToolId;
  let answer: { resolution: RoleResolution; membership: RoleRepositoryMembership } | null = null;
  try {
    for (let attempt = 0; attempt < MEMBERSHIP_ATTEMPTS; attempt += 1) {
      answer = await withSettledWorktreeMembership(db, input.worktreeId, deps, (worktree, membership) => {
        const stored: StoredRoleState = input.defaultsOnly
          ? { state: 'inherit' }
          : getInstanceRoleState(db, worktree.id, instanceId);
        return { resolution: resolveDefaultsForTool(db, input.cliToolId, membership, stored), membership };
      });
      const { resolution } = answer;
      if (resolution.kind !== 'ambiguous' || resolution.reason !== 'membership-undetermined') break;
    }
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError) {
      return refused(db, target, 'resolve-failed', error.message);
    }
    logger.warn('role-resolve-failed', { error: error instanceof Error ? error.message : String(error) });
    return refused(db, target, 'resolve-failed', 'The role could not be resolved');
  }
  const { resolution, membership } = answer as NonNullable<typeof answer>;

  if (resolution.kind === 'ambiguous') {
    const roots = resolution.roots.map((root) => root.path).join(', ');
    return refused(
      db,
      target,
      resolution.reason,
      resolution.reason === 'root-settings-differ'
        ? `The registered roots of this repository hold different role settings for ${input.cliToolId} (${roots}); make them agree or disable one`
        : `Git could not say whether these registered roots belong to this repository (${roots}), and they would change the role of ${input.cliToolId}; retry, or fix or disable the root`,
      resolution
    );
  }
  if (resolution.kind === 'none') {
    return Object.freeze({
      target,
      db,
      resolution,
      membership,
      composition: null,
      injection: null,
      injectionFingerprint: null,
      refusal: null,
    });
  }

  const adapter = input.cliToolId as AgentRoleCliTool;
  if (!isAgentRoleAdapterEnabled(adapter)) {
    return refused(
      db,
      target,
      'adapter-disabled',
      `Roles are not enabled for ${adapter} yet; it has a role "${resolution.role.name}", so it was not started without it`,
      resolution
    );
  }

  let composition: RoleComposition;
  try {
    composition = input.composition ?? await loadRoleComposition(adapter, {
      worktreePath: input.worktreePath,
      readEnv: input.readEnv,
      explicitAgent: input.explicitAgent,
      readLaunchCwd: input.readLaunchCwd,
    });
  } catch (error) {
    const message = error instanceof RoleCompositionError ? error.message : 'The settings to compose with could not be read';
    return refused(db, target, 'composition-failed', message, resolution);
  }
  const injection = computeRoleInjection(adapter, resolution.role, composition);
  return Object.freeze({
    target,
    db,
    resolution,
    membership,
    composition,
    injection,
    injectionFingerprint: injection.injectionFingerprint,
    refusal: null,
  });
}

/**
 * The entry a start goes through.
 *
 * @returns Null when the role layer does not apply (a tool outside D3, or no
 *   database). A snapshot synchronously when no role is configured anywhere, so
 *   such a start registers its flight in the same tick as it always did (R4 of
 *   `session-launch-flight`) and runs no git. Otherwise a promise, rejected only
 *   with a {@link RoleLaunchRefusedError} when the database cannot be read at all.
 */
export function requestLaunchRole(
  target: LaunchRoleTarget,
  worktreePath: string,
  readEnv: RoleEnvReader,
  readLaunchCwd?: RoleLaunchCwdReader
): LaunchRoleSnapshot | null | Promise<LaunchRoleSnapshot> {
  if (!isAgentRoleCliTool(target.cliToolId)) return null;
  let db: Database.Database | null;
  try {
    db = launchRoleDatabase();
    if (db === null) return null;
    if (!hasAnyRoleSetting(db)) return noRoleFastPath(db, target);
  } catch (error) {
    logger.warn('role-database-unavailable', { error: error instanceof Error ? error.message : String(error) });
    return Promise.reject(new RoleLaunchRefusedError('resolve-failed', 'The database could not be read to resolve the role'));
  }
  return resolveLaunchRole(db, { ...target, worktreePath, readEnv, readLaunchCwd });
}

// ---------------------------------------------------------------------------
// Preparing the file
// ---------------------------------------------------------------------------

export interface PreparedRoleLaunch {
  artifact: WrittenRoleArtifact;
  args: RoleLaunchArguments;
}

/**
 * Write and inspect the file (§5) and work out how it reaches the CLI.
 *
 * @throws {RoleLaunchRefusedError} It cannot be used; nothing about it reaches a CLI
 */
export function prepareRoleLaunch(snapshot: LaunchRoleSnapshot): PreparedRoleLaunch | null {
  const { injection, resolution, composition, db } = snapshot;
  if (injection === null) return null;
  if (resolution?.kind !== 'role') throw new RoleLaunchRefusedError('resolve-failed', 'The role was not resolved');
  try {
    const name = buildArtifactName({
      namespace: deriveServerNamespace(db.name),
      roleId: resolution.role.id,
      injectionFingerprint: injection.injectionFingerprint,
    });
    const artifact = writeRoleArtifact({ adapter: injection.adapter, name, instructions: injection.instructions });
    inspectRoleArtifact({
      adapter: injection.adapter,
      name,
      path: artifact.path,
      expectedFingerprint: artifact.artifactFingerprint,
    });
    return { artifact, args: buildRoleLaunchArguments(injection, artifact, composition ?? {}) };
  } catch (error) {
    if (error instanceof RoleArtifactError || error instanceof UatIsolationLaunchRefusedError) {
      throw new RoleLaunchRefusedError('artifact-failed', error.message);
    }
    throw new RoleLaunchRefusedError('artifact-failed', `The role's file could not be prepared: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// The launch in progress
// ---------------------------------------------------------------------------

interface LaunchRoleStore {
  snapshot: LaunchRoleSnapshot;
  prepared: PreparedRoleLaunch | null;
  /** The per-launch file holding a composed env. Holds the user's values; removed afterwards. */
  envFile: string | null;
  /** Set once a launch line was really built. Still null at the end means a reused process. */
  generation: string | null;
  /** The session's kill count when this launch began. See {@link isStale}. */
  epoch: number;
  /** What the launch before this one injected, read before this one's record. OpenCode V1's notice. */
  previousFingerprint: string | null;
}

function scope(): AsyncLocalStorage<LaunchRoleStore> {
  return getOrInitGlobal('__launchRoleScope', () => new AsyncLocalStorage<LaunchRoleStore>());
}

function evidenceMap(): Map<string, StoredLaunchRoleEvidence> {
  return getOrInitGlobal('__launchRoleEvidence', () => new Map<string, StoredLaunchRoleEvidence>());
}

function evidenceKey(target: LaunchRoleTarget): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

function epochMap(): Map<string, number> {
  return getOrInitGlobal('__launchRoleEpochs', () => new Map<string, number>());
}

/**
 * Whether this launch no longer speaks for the session. A launch killed midway keeps
 * running until its readiness wait ends, and that wait can be satisfied by the screen
 * of the launch started after it (`forgetSessionLaunch`, #3195). Such a launch writes
 * nothing, stops nothing and moves nothing: the session is its successor's.
 *
 * A kill moves the epoch, which catches a launch that has not opened a generation yet.
 * A generation that is no longer the current one catches the rest.
 */
function isStale(store: LaunchRoleStore): boolean {
  const key = evidenceKey(store.snapshot.target);
  if ((epochMap().get(key) ?? 0) !== store.epoch) return true;
  return store.generation !== null && evidenceMap().get(key)?.sessionGeneration !== store.generation;
}

/** Run one launch with its snapshot, removing the composed env file however it ends. */
export async function runWithLaunchRole<T>(snapshot: LaunchRoleSnapshot, fn: () => Promise<T>): Promise<T> {
  const store: LaunchRoleStore = {
    snapshot,
    prepared: null,
    envFile: null,
    generation: null,
    epoch: epochMap().get(evidenceKey(snapshot.target)) ?? 0,
    previousFingerprint: null,
  };
  try {
    return await scope().run(store, fn);
  } finally {
    if (store.envFile !== null) removeLaunchEnvFile(store.envFile);
  }
}

/**
 * The check a launch runs right before it types its line, in the same input-lock
 * turn (Issue #4233), or null when this launch's role did not depend on the cwd.
 *
 * The composition resolved a relative `XDG_CONFIG_HOME` / `HOME` against the
 * worktree after checking the pane was there; the launch then awaits the
 * executable, the pane's geometry and the server's port, and the pane's terminal
 * can `cd` meanwhile. The line itself is left as it is (no `cd` added to it), so
 * the launch is refused instead when the pane is no longer in the worktree.
 *
 * The step awaits, so it also refuses when the session was stopped meanwhile
 * (its epoch moved), and `typeLaunchLines` checks the input ticket after it: a
 * restart in between revokes this launch's turn, and its line is not typed.
 *
 * @param readLaunchCwd - The pane's cwd reader; none (a test run) checks nothing
 * @returns A step that rejects with a {@link RoleLaunchRefusedError}, or null
 */
export function launchCwdRecheck(readLaunchCwd: RoleLaunchCwdReader | undefined): (() => Promise<void>) | null {
  const store = scope().getStore();
  const pinned = store?.snapshot.composition?.opencodeV2LaunchCwd;
  if (store === undefined || pinned === undefined || !readLaunchCwd) return null;
  return async () => {
    try {
      await assertLaunchCwdIsWorktree(pinned, readLaunchCwd);
    } catch (error) {
      if (!(error instanceof RoleCompositionError)) throw error;
      throw new RoleLaunchRefusedError('composition-failed', `${error.message} (it changed after the role was composed)`);
    }
    // The session stopped while the cwd was read: this launch no longer speaks
    // for it (`typeLaunchLines` checks the input ticket as well).
    if (isStale(store)) {
      throw new RoleLaunchRefusedError('session-stopped', 'The session was stopped while the launch checked its cwd');
    }
  };
}

/**
 * Prepare before any pane exists, so a refusal leaves no empty pane that a later
 * send would read as a running agent.
 *
 * @returns The refusal, or null when the launch may go on
 */
export function gateLaunchRole(): RoleLaunchRefusedError | null {
  const store = scope().getStore();
  if (!store) return null;
  if (store.snapshot.refusal) return store.snapshot.refusal;
  try {
    store.prepared = prepareRoleLaunch(store.snapshot);
    return null;
  } catch (error) {
    if (error instanceof RoleLaunchRefusedError) return error;
    throw error;
  }
}

function sameTarget(a: LaunchRoleTarget, b: LaunchRoleTarget): boolean {
  return a.worktreeId === b.worktreeId && a.cliToolId === b.cliToolId && (a.instanceId ?? a.cliToolId) === (b.instanceId ?? b.cliToolId);
}

function recordPhase(store: LaunchRoleStore, phase: RoleLaunchPhase): void {
  const { snapshot, prepared, generation } = store;
  const { resolution, injection, target, db } = snapshot;
  // Every await between a piece of evidence and this write ends here: `launched` is
  // only ever written for the generation that is current in the same step.
  if (generation === null || resolution === null || resolution.kind === 'ambiguous' || isStale(store)) return;
  const role = resolution.kind === 'role' ? resolution.role : null;
  try {
    recordRoleLaunch(db, {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      cliToolId: target.cliToolId,
      phase,
      sessionGeneration: generation,
      source: resolution.source,
      repositoryId: resolution.repositoryId,
      roleId: role?.id ?? null,
      roleName: role?.name ?? null,
      bodyVersion: role?.bodyVersion ?? null,
      bodyFingerprint: role?.bodyFingerprint ?? null,
      injectionFingerprint: injection?.injectionFingerprint ?? null,
      artifactFingerprint: prepared?.artifact.artifactFingerprint ?? null,
      adapterId: injection?.adapter ?? null,
      adapterVersion: injection?.adapterVersion ?? null,
      wrapperVersion: injection?.wrapperVersion ?? null,
      artifactPath: prepared?.artifact.path ?? null,
      effectiveAgent: injection?.effectiveAgent ?? null,
      compositionSourceFingerprint: injection?.compositionSourceFingerprint ?? null,
      noRoleReason: resolution.kind === 'none' ? resolution.reason : null,
    });
  } catch (error) {
    // A record that could not be written leaves the state unknown. It is not a reason to refuse the launch.
    logger.warn('role-launch-record-failed', { phase, error: error instanceof Error ? error.message : String(error) });
  }
}

function openGeneration(store: LaunchRoleStore): void {
  if (isStale(store)) {
    // The line is still built for whatever the driver does with it; nothing says it is the session's.
    store.generation ??= randomUUID();
    return;
  }
  const { target, db } = store.snapshot;
  if (store.generation === null && target.cliToolId === 'opencode') {
    const instanceId = target.instanceId ?? target.cliToolId;
    store.previousFingerprint = getLatestRoleLaunchRecords(db, target.worktreeId, instanceId).requested?.injectionFingerprint ?? null;
  }
  store.generation = randomUUID();
  const antigravity = store.snapshot.injection?.adapter === 'antigravity';
  evidenceMap().set(evidenceKey(store.snapshot.target), {
    sessionGeneration: store.generation,
    injectionFingerprint: store.snapshot.injectionFingerprint,
    composition: store.snapshot.composition,
    resumedAcrossRole: false,
    resumeNoticeTaken: false,
    // Issue #4385: a new generation starts unconfirmed. Opening it is not a confirmation.
    application: antigravity ? { state: 'starting', version: 0, refusal: null, graceStartedAt: null } : null,
    artifactName: antigravity ? store.prepared?.artifact.name ?? null : null,
    artifactPath: antigravity ? store.prepared?.artifact.path ?? null : null,
    launch: antigravity ? store : null,
  });
  recordPhase(store, 'requested');
}

/**
 * A launch replaced its own process in the same pane (Codex's relaunch after its
 * update). The snapshot stays; the generation moves on. Called from
 * `beginAgentSession`, which is what says a new process is starting.
 */
export function noteLaunchProcessReplaced(target: LaunchRoleTarget): void {
  const store = scope().getStore();
  if (store && store.generation !== null && sameTarget(store.snapshot.target, target)) openGeneration(store);
}

/**
 * This launch is about to continue a remembered conversation (OpenCode V1, §6.4). If
 * the role is not the one that conversation last ran under, the role changes for all
 * of it with the old role's replies still in its history, and someone has to be told.
 * Here, in the launch, so that a change by inheritance and a driver's own relaunch
 * are told as well as a send that named a role.
 */
export function noteLaunchResumedConversation(target: LaunchRoleTarget): void {
  const store = scope().getStore();
  if (!store || store.generation === null || !sameTarget(store.snapshot.target, target) || isStale(store)) return;
  if (store.previousFingerprint === store.snapshot.injectionFingerprint) return;
  const stored = evidenceMap().get(evidenceKey(target));
  if (stored) stored.resumedAcrossRole = true;
}

/**
 * The line for a pane, with the role in it. Used by `buildAgentLaunchCommandLine`,
 * the one function every driver gets its launch line from. Outside a launch, or with
 * no role, this is `renderAgentLaunchCommand(plan)` byte for byte.
 *
 * @throws {RoleLaunchRefusedError} Reaching a launch line with a refused snapshot
 */
export function renderLaunchCommandWithRole(context: AgentLaunchContext, plan: AgentLaunchPlan): string {
  const store = scope().getStore();
  if (!store || !sameTarget(store.snapshot.target, context.target)) return renderAgentLaunchCommand(plan);
  if (store.snapshot.refusal) throw store.snapshot.refusal;
  if (store.snapshot.injection !== null && store.prepared === null) store.prepared = prepareRoleLaunch(store.snapshot);

  const { prepared } = store;
  let line: string;
  if (prepared === null) {
    line = renderAgentLaunchCommand(plan);
  } else {
    const { args } = prepared.args;
    const { plain, secret } = splitRoleEnv(prepared.args);
    let prefix = '';
    if (secret !== null) {
      // The user's values may be secrets and a pane shows what is typed into it,
      // so they go through a private file for the length of this launch (§7.1).
      if (store.envFile === null) {
        try {
          store.envFile = writeLaunchEnvFile(prepared.artifact.adapter, secret);
        } catch (error) {
          throw new RoleLaunchRefusedError('artifact-failed', `The composed environment could not be written: ${(error as Error).message}`);
        }
      }
      prefix = renderSecretEnvAssignment(store.envFile);
    }
    const finalPlan = { ...plan, env: { ...plan.env, ...plain } };
    const flags = args.length > 0 ? ` ${renderRoleFlags(args)}` : '';
    line = `${prefix}${renderAgentLaunchCommand(finalPlan)}${flags}`;
  }
  if (store.generation === null) openGeneration(store);
  return line;
}

/** What {@link settleLaunchRole} needs from the driver, so this module reaches no tmux itself. */
export interface LaunchRoleChecks {
  /** The tool still holds the pane. */
  isAlive: () => Promise<boolean>;
  /** Recent lines of the pane. */
  capture: () => Promise<string>;
  /** Stop what was started. */
  kill: () => Promise<void>;
  /** The config the tool's own server answers, or null when it has none or did not answer. */
  readServerConfig: () => Promise<unknown>;
}

/** Copilot carries on with its default agent after these (§6.7). */
const COPILOT_ROLE_NOT_TAKEN = /✗ (?:Custom agent|Failed to select agent)/;

function serverConfigConfirms(store: LaunchRoleStore, config: unknown): boolean {
  const { injection } = store.snapshot;
  const { prepared } = store;
  if (typeof config !== 'object' || config === null || !injection || !prepared) return false;
  if (injection.adapter === 'opencode') {
    const { instructions } = config as { instructions?: unknown };
    return Array.isArray(instructions) && instructions.includes(prepared.artifact.path);
  }
  // OpenCode V2 2.0.18 answers its config sources, weakest first, and not one merged
  // object: `[{ type, path, info }, { type, path }, { type, info }]`, with the env's last
  // (measured, #4115). So the answer is the last source that says anything for this agent.
  if (!Array.isArray(config)) return false;
  const agent = injection.effectiveAgent ?? 'build';
  const systems = config
    .map((source: { info?: { agents?: Record<string, { system?: unknown } | undefined> } } | null) => source?.info?.agents?.[agent]?.system)
    .filter((system) => system !== undefined);
  const system = systems[systems.length - 1];
  // Compared by hash so nothing here holds on to the body.
  return typeof system === 'string' && computeFingerprint(Buffer.from(system, 'utf8')) === prepared.artifact.artifactFingerprint;
}

/**
 * After the driver's launch returned: write `launched` if there is evidence for it
 * (§14), and stop the session if the CLI said it did not take the role. A reused
 * process opened no generation and nothing happens.
 *
 * @throws {RoleLaunchRefusedError} The CLI refused the role; the session was stopped
 */
export async function settleLaunchRole(checks: LaunchRoleChecks): Promise<void> {
  const store = scope().getStore();
  if (!store || store.generation === null || isStale(store)) return;
  const { injection } = store.snapshot;
  const alive = async (): Promise<boolean> => checks.isAlive().catch(() => false);

  if (injection === null) {
    if (await alive()) recordPhase(store, 'launched');
    return;
  }
  switch (injection.adapter) {
    case 'claude':
    case 'codex':
      // Both exit on an unreadable or broken file, and the file was inspected
      // before the launch. Still there is the only evidence these two offer.
      if (await alive()) recordPhase(store, 'launched');
      return;
    case 'copilot': {
      const screen = await checks.capture().catch(() => null);
      // What it read may be the screen of a launch started after this one was killed.
      if (isStale(store)) return;
      if (screen !== null && COPILOT_ROLE_NOT_TAKEN.test(screen)) {
        forgetLaunchRoleEvidence(store.snapshot.target);
        await checks.kill().catch((error: unknown) => {
          logger.warn('role-not-applied-stop-failed', { error: error instanceof Error ? error.message : String(error) });
        });
        throw new RoleLaunchRefusedError('not-applied', 'Copilot did not take the role, and would have gone on without it; the session was stopped');
      }
      if (screen !== null && (await alive())) recordPhase(store, 'launched');
      return;
    }
    case 'opencode':
    case 'opencode-v2': {
      const config = await checks.readServerConfig().catch(() => null);
      if (serverConfigConfirms(store, config)) recordPhase(store, 'launched');
      return;
    }
    case 'command-code':
      // No way to confirm yet (§14), so `launched` stays unknown.
      return;
    case 'antigravity':
      // Issue #4385: the driver reads its own screen at the end of its launch
      // ({@link observeLaunchRoleApplication}) and a send's gate keeps reading
      // it; `launched` is written when one of them sees the role.
      return;
  }
}

// ---------------------------------------------------------------------------
// Antigravity: the positive record and the send gate (Issue #4385)
// ---------------------------------------------------------------------------

/** What one read of the screen says about the role. */
export type RoleApplicationObservation =
  | { kind: 'confirmed' }
  | { kind: 'not-applied'; cause: AntigravityRoleCause; toolName?: string | null }
  /** The screen could not be read. */
  | { kind: 'unreadable' }
  /** Read, and it proves nothing yet. */
  | { kind: 'undetermined' };

/** A copy of one generation's application, to compare against later. */
export interface RoleApplicationView {
  generation: string;
  injectionFingerprint: string | null;
  state: RoleApplicationState;
  version: number;
  refusal: RoleApplication['refusal'];
  graceStartedAt: number | null;
  artifactName: string | null;
  artifactPath: string | null;
}

function viewOf(stored: StoredLaunchRoleEvidence): RoleApplicationView | null {
  const { application } = stored;
  if (application === null) return null;
  return {
    generation: stored.sessionGeneration,
    injectionFingerprint: stored.injectionFingerprint,
    state: application.state,
    version: application.version,
    refusal: application.refusal === null ? null : { ...application.refusal },
    graceStartedAt: application.graceStartedAt,
    artifactName: stored.artifactName,
    artifactPath: stored.artifactPath,
  };
}

/**
 * The application of the process now known for `target`, or null when there is
 * none: no evidence (a stop, a server restart) or a generation launched without
 * the role. Null is never a permission.
 */
export function readRoleApplication(target: LaunchRoleTarget): RoleApplicationView | null {
  const stored = evidenceMap().get(evidenceKey(target));
  return stored ? viewOf(stored) : null;
}

/**
 * Change one generation's application from what an observation saw, only when
 * the generation and the version are still those the observation began with
 * (compare-and-set). `confirmed` and `refused` are final for a generation: a
 * late positive reading never turns a refusal back into a confirmation.
 *
 * @returns The application after the call (the current one when nothing changed), or null
 */
export function applyRoleApplicationObservation(
  target: LaunchRoleTarget,
  seen: { generation: string; version: number },
  observation: RoleApplicationObservation
): RoleApplicationView | null {
  const stored = evidenceMap().get(evidenceKey(target));
  if (!stored) return null;
  const application = stored.application;
  if (
    application === null ||
    stored.sessionGeneration !== seen.generation ||
    application.version !== seen.version ||
    (application.state !== 'starting' && application.state !== 'unknown')
  ) {
    return viewOf(stored);
  }
  switch (observation.kind) {
    case 'confirmed':
      application.state = 'confirmed';
      application.version += 1;
      // What the launch resolved and wrote, and never the latest settings (C10).
      // A record that cannot be written changes nothing about the permission.
      if (stored.launch !== null && stored.launch.generation === seen.generation) recordPhase(stored.launch, 'launched');
      break;
    case 'not-applied':
      application.state = 'refused';
      application.version += 1;
      application.refusal = { reason: 'not-applied', cause: observation.cause, toolName: observation.toolName ?? null };
      break;
    case 'unreadable':
      if (application.state !== 'unknown') {
        application.state = 'unknown';
        application.version += 1;
      }
      break;
    case 'undetermined':
      break;
  }
  return viewOf(stored);
}

/**
 * Start this generation's grace with the first send that reaches the gate.
 *
 * @returns When it started, or null when `generation` is not the current one
 */
export function startRoleApplicationGrace(target: LaunchRoleTarget, generation: string, now: number): number | null {
  const stored = evidenceMap().get(evidenceKey(target));
  if (!stored?.application || stored.sessionGeneration !== generation) return null;
  stored.application.graceStartedAt ??= now;
  return stored.application.graceStartedAt;
}

/** The grace ran out: `refused(not-confirmed)`, by the same compare-and-set. */
export function expireRoleApplication(
  target: LaunchRoleTarget,
  seen: { generation: string; version: number }
): RoleApplicationView | null {
  const stored = evidenceMap().get(evidenceKey(target));
  if (!stored) return null;
  const application = stored.application;
  if (
    application !== null &&
    stored.sessionGeneration === seen.generation &&
    application.version === seen.version &&
    (application.state === 'starting' || application.state === 'unknown')
  ) {
    application.state = 'refused';
    application.version += 1;
    application.refusal = { reason: 'not-confirmed', cause: 'grace-expired', toolName: null };
  }
  return viewOf(stored);
}

/**
 * Read the screen once at the end of an Antigravity launch, in its scope, and
 * keep what it proves (D2 "起動の中"). Does nothing for a reused process, a stale
 * launch or a launch without the role. Never throws and never stops anything:
 * a screen that proves nothing leaves the generation `starting` / `unknown` for
 * the next send's gate.
 *
 * @param observe - Reads the pane and judges it against the agent's name
 */
export async function observeLaunchRoleApplication(
  observe: (artifactName: string) => Promise<RoleApplicationObservation>
): Promise<void> {
  const store = scope().getStore();
  if (!store || store.generation === null || isStale(store)) return;
  const target = store.snapshot.target;
  const view = readRoleApplication(target);
  if (view === null || view.generation !== store.generation || view.artifactName === null) return;
  let observation: RoleApplicationObservation;
  try {
    observation = await observe(view.artifactName);
  } catch {
    observation = { kind: 'unreadable' };
  }
  if (isStale(store)) return;
  applyRoleApplicationObservation(target, view, observation);
}

/** Which of the refusal's two reasons a cause is. */
function reasonOf(cause: AntigravityRoleCause): 'not-applied' | 'not-confirmed' {
  return cause === 'unknown-tool' || cause === 'not-started' || cause === 'role-not-selected' ? 'not-applied' : 'not-confirmed';
}

/** The refusal of an Antigravity send for `cause`; nothing was typed. */
export function antigravityRoleRefusal(detail: AntigravityRoleRefusalDetail): RoleLaunchRefusedError {
  return new RoleLaunchRefusedError(reasonOf(detail.cause), describeAntigravityRoleRefusal(detail));
}

/** Whether the send gate covers a target, from the persistent role settings (D2). */
export type RoleSendTarget =
  /** The settings give it a role: a body goes only on a confirmed generation. */
  | { kind: 'role' }
  /** The settings could not be read: refused. */
  | { kind: 'unreadable' }
  /**
   * No role, so the gate does not apply. `stillNone` reads the settings again,
   * synchronously, right before the body (R4): a role set meanwhile refuses that
   * body, and the next send is gated.
   */
  | { kind: 'none'; stillNone: () => boolean };

const ALWAYS_NONE: RoleSendTarget = { kind: 'none', stillNone: () => true };

/**
 * Whether the send gate covers `target`, from the persistent role settings and
 * never from what is remembered about the process (evidence, a refusal): those
 * go away on a stop, a failed stop or a server restart, and their absence must
 * not take the target out of the gate (§0.1).
 *
 * PR1: only while Antigravity's switch is on. With it off a role cannot be
 * launched at all, and sends stay as they were.
 */
export async function resolveRoleSendTarget(target: LaunchRoleTarget): Promise<RoleSendTarget> {
  if (!isAgentRoleCliTool(target.cliToolId)) return ALWAYS_NONE;
  const adapter = target.cliToolId;
  const enabled = (): boolean => isAgentRoleAdapterEnabled(adapter);
  if (!enabled()) return { kind: 'none', stillNone: () => !enabled() };
  let db: Database.Database | null;
  try {
    db = launchRoleDatabase();
    if (db === null) return ALWAYS_NONE;
    if (!hasAnyRoleSetting(db)) {
      const settled = db;
      return { kind: 'none', stillNone: () => resolvesToNoRoleNow(settled, target, null) };
    }
  } catch (error) {
    logger.warn('role-send-target-unreadable', { error: error instanceof Error ? error.message : String(error) });
    return { kind: 'unreadable' };
  }
  const unread: RoleEnvReader = async () => undefined;
  // The worktree is looked up by id; the path is read only to compose, and nothing is composed here.
  const snapshot = await resolveLaunchRole(db, { ...target, worktreePath: '', readEnv: unread, composition: {} });
  if (snapshot.resolution?.kind === 'role') return { kind: 'role' };
  if (snapshot.refusal === null && snapshot.resolution?.kind === 'none') {
    return { kind: 'none', stillNone: () => !enabled() || resolvesToNoRoleNow(snapshot.db, target, snapshot.membership) };
  }
  return { kind: 'unreadable' };
}

/**
 * The settings still give `target` no role: one synchronous read, for the moment
 * right before the body. A membership not read (no setting existed anywhere) is
 * not guessed: any setting appearing counts as a change.
 */
function resolvesToNoRoleNow(
  db: Database.Database,
  target: LaunchRoleTarget,
  membership: RoleRepositoryMembership | null
): boolean {
  try {
    if (!hasAnyRoleSetting(db)) return true;
    if (membership === null) return false;
    const instanceId = target.instanceId ?? target.cliToolId;
    return resolveDefaultsForTool(db, target.cliToolId, membership, getInstanceRoleState(db, target.worktreeId, instanceId)).kind === 'none';
  } catch {
    return false;
  }
}

/**
 * The check right before the body of a gated send (D2 門の置き場所 3): the
 * generation the gate decided on is still the current one, is `confirmed`, and
 * injected what the gate saw. Synchronous, so nothing can change in between.
 * The absence of a refusal is never a condition here.
 *
 * @throws {RoleLaunchRefusedError} Anything else; the body is not typed
 */
export function assertRoleSendBoundary(
  target: LaunchRoleTarget,
  expected: { generation: string; injectionFingerprint: string | null }
): void {
  const view = readRoleApplication(target);
  if (view === null) throw antigravityRoleRefusal({ cause: 'no-record' });
  const named = { artifactName: view.artifactName, artifactPath: view.artifactPath };
  if (view.generation !== expected.generation) throw antigravityRoleRefusal({ cause: 'replaced', ...named });
  if (view.state !== 'confirmed') {
    throw antigravityRoleRefusal({
      cause: view.refusal?.cause ?? 'grace-expired',
      toolName: view.refusal?.toolName ?? null,
      ...named,
    });
  }
  if (view.injectionFingerprint !== expected.injectionFingerprint) throw antigravityRoleRefusal({ cause: 'replaced', ...named });
}

// ---------------------------------------------------------------------------
// What this server knows
// ---------------------------------------------------------------------------

export function getLaunchRoleEvidence(target: LaunchRoleTarget): LaunchRoleEvidence | null {
  const stored = evidenceMap().get(evidenceKey(target));
  return stored ? { sessionGeneration: stored.sessionGeneration, injectionFingerprint: stored.injectionFingerprint } : null;
}

/**
 * Why the running process no longer has the role the settings say it should, or null
 * when it has it or this server did not start it.
 *
 * For a contract, whose process was fixed earlier (`launch-worker`'s starting
 * message): the settings have to answer the same as they did then. It uses what that
 * launch composed from, so it reads no pane; a role that appeared where the launch
 * had none cannot equal "none" whatever it would compose with.
 */
export async function runningRoleProblem(
  db: Database.Database,
  target: LaunchRoleTarget,
  worktreePath: string,
  deps: RoleResolverDeps = {}
): Promise<string | null> {
  const stored = evidenceMap().get(evidenceKey(target));
  if (!stored) return null;
  const unread: RoleEnvReader = async () => undefined;
  const snapshot = await resolveLaunchRole(
    db,
    { ...target, worktreePath, readEnv: unread, composition: stored.composition ?? {} },
    deps
  );
  if (snapshot.refusal) return `The role for this contract cannot be applied: ${snapshot.refusal.message}`;
  if (snapshot.injectionFingerprint === stored.injectionFingerprint) return null;
  return 'The role settings changed after this session was started, so the contract was not sent. Stop the session and send again.';
}

/** Whether the settings give this target a role, whatever it would compose with. */
export async function settingsGiveRole(
  db: Database.Database,
  target: LaunchRoleTarget,
  worktreePath: string,
  deps: RoleResolverDeps = {}
): Promise<boolean> {
  const unread: RoleEnvReader = async () => undefined;
  const snapshot = await resolveLaunchRole(db, { ...target, worktreePath, readEnv: unread, composition: {} }, deps);
  return snapshot.resolution?.kind === 'role';
}

/** The session is gone, or its id is. What was known about it no longer applies. */
export function forgetLaunchRoleEvidence(target: LaunchRoleTarget): void {
  const key = evidenceKey(target);
  evidenceMap().delete(key);
  epochMap().set(key, (epochMap().get(key) ?? 0) + 1);
}

/**
 * How many times this session has been stopped. A start reads this before it waits to
 * resolve its role: see {@link assertNotStoppedWhileResolving}.
 */
export function readLaunchRoleEpoch(target: LaunchRoleTarget): number {
  return epochMap().get(evidenceKey(target)) ?? 0;
}

/**
 * A start with roles configured waits for git before it registers its flight, so a
 * stop in that wait finds no flight to forget and no launch to mark. Left to go on,
 * this start would bring back the session that was just stopped, under an epoch it
 * only read afterwards, and a later start would join it. It was asked for before
 * the stop, so the stop wins.
 *
 * @throws {RoleLaunchRefusedError} The session was stopped since `epoch` was read
 */
export function assertNotStoppedWhileResolving(target: LaunchRoleTarget, epoch: number): void {
  if (readLaunchRoleEpoch(target) !== epoch) {
    throw new RoleLaunchRefusedError('session-stopped', 'The session was stopped while it was being started; nothing was typed');
  }
}

/** Whether this process continued a conversation that had another role (§6.4). */
export function wasResumedAcrossRole(target: LaunchRoleTarget): boolean {
  return evidenceMap().get(evidenceKey(target))?.resumedAcrossRole === true;
}

/** The same, once per process, for the answer of a send. */
export function takeResumedAcrossRoleNotice(target: LaunchRoleTarget): boolean {
  const stored = evidenceMap().get(evidenceKey(target));
  if (!stored?.resumedAcrossRole || stored.resumeNoticeTaken) return false;
  stored.resumeNoticeTaken = true;
  return true;
}

/**
 * A worktree id changed and its tmux sessions were renamed: the processes are the
 * same, and the records moved with the row (`getWorktreeChildTables`).
 */
export function moveLaunchRoleEvidence(renames: ReadonlyArray<{ oldId: string; newId: string }>): void {
  const map = evidenceMap();
  const moved = new Map<string, StoredLaunchRoleEvidence>();
  for (const [key, evidence] of map) {
    const rename = renames.find(({ oldId }) => key.startsWith(`${oldId}${COMPOSITE_KEY_SEPARATOR}`));
    if (!rename) continue;
    map.delete(key);
    moved.set(`${rename.newId}${key.slice(rename.oldId.length)}`, evidence);
  }
  for (const [key, evidence] of moved) map.set(key, evidence);
  const epochs = epochMap();
  for (const [key, epoch] of [...epochs]) {
    const rename = renames.find(({ oldId }) => key.startsWith(`${oldId}${COMPOSITE_KEY_SEPARATOR}`));
    if (!rename) continue;
    epochs.delete(key);
    epochs.set(`${rename.newId}${key.slice(rename.oldId.length)}`, epoch);
  }
}

/** A Schedule's role, or why it may not run. */
export type ScheduleRole =
  | { kind: 'none' }
  | { kind: 'role'; role: HeadlessRoleArguments; injectionFingerprint: string; roleName: string }
  | { kind: 'refused'; refusal: RoleLaunchRefusedError };

/**
 * The role a Schedule runs with: the defaults for its worktree and tool (a primary's
 * own setting belongs to that instance and is not inherited), composed with what its
 * child process will be given. An explicit `agent` is never dropped for it: V1 and
 * Claude take both, and V2 overrides that agent's `system` (§7.1).
 *
 * Called by `job-executor`, and not inside `executeClaudeCommand`, because that one
 * also runs the daily summary, which opens no database and has no role (D2).
 */
export async function resolveScheduleRole(
  db: Database.Database,
  input: { worktreeId: string; cliToolId: string; worktreePath: string; explicitAgent?: string; env: RoleEnv },
  deps: RoleResolverDeps = {}
): Promise<ScheduleRole> {
  const { cliToolId } = input;
  if (!isAgentRoleCliTool(cliToolId)) return { kind: 'none' };
  let any: boolean;
  try {
    any = hasAnyRoleSetting(db);
  } catch {
    return { kind: 'refused', refusal: new RoleLaunchRefusedError('resolve-failed', 'The database could not be read to resolve the role') };
  }
  if (!any) return { kind: 'none' };
  const snapshot = await resolveLaunchRole(
    db,
    {
      worktreeId: input.worktreeId,
      cliToolId,
      worktreePath: input.worktreePath,
      readEnv: fixedEnvReader(input.env),
      explicitAgent: input.explicitAgent ?? null,
      defaultsOnly: true,
    },
    deps
  );
  if (snapshot.refusal) return { kind: 'refused', refusal: snapshot.refusal };
  try {
    const prepared = prepareRoleLaunch(snapshot);
    if (prepared === null || snapshot.resolution?.kind !== 'role') return { kind: 'none' };
    return {
      kind: 'role',
      role: { args: prepared.args.args, headlessPosition: prepared.args.headlessPosition, env: prepared.args.env },
      injectionFingerprint: snapshot.injectionFingerprint as string,
      roleName: snapshot.resolution.role.name,
    };
  } catch (error) {
    if (error instanceof RoleLaunchRefusedError) return { kind: 'refused', refusal: error };
    throw error;
  }
}

/** Forget everything in memory. Test-only. */
export function resetLaunchRoleStateForTest(): void {
  evidenceMap().clear();
  epochMap().clear();
  globalThis.__launchRoleTestDb = null;
}

/**
 * What the current settings would inject now, from a membership already read: one
 * synchronous stretch, for the moment right before the body, where no await is left.
 *
 * @throws {RoleLaunchRefusedError} The settings no longer resolve to one answer
 */
export function recomputeInjectionFingerprint(snapshot: LaunchRoleSnapshot): string | null {
  const { db, target, membership, composition } = snapshot;
  const instanceId = target.instanceId ?? target.cliToolId;
  const settled = membership ?? { members: [], undetermined: [] };
  const resolution = resolveDefaultsForTool(db, target.cliToolId, settled, getInstanceRoleState(db, target.worktreeId, instanceId));
  if (resolution.kind === 'ambiguous') {
    throw new RoleLaunchRefusedError(resolution.reason, 'The role settings no longer resolve to one answer');
  }
  if (resolution.kind === 'none') return null;
  const adapter = target.cliToolId as AgentRoleCliTool;
  // A role appeared where none was resolved: no composition was read, so it cannot be computed here.
  if (composition === null) throw new RoleLaunchRefusedError('composition-failed', 'A role was set while this send was on its way');
  return computeRoleInjection(adapter, resolution.role, composition).injectionFingerprint;
}
