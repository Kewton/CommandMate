/**
 * What the management routes share: which instances may hold a setting, and the
 * payloads that show a setting beside its result. The routes stay thin, and the
 * CLI and the screen read these rather than working it out again.
 *
 * ## Decisions
 *
 * - **Only a target that exists may hold a setting**: an instance in the roster
 *   the session authority shows (`resolveAgentInstances`, which includes derived
 *   primaries). An unknown or ad-hoc id is refused. An ad-hoc id can still be sent
 *   to; it resolves from the defaults, and `send --register` starts it clean.
 * - **A derived primary's setting is written without saving a roster**, because
 *   one roster row would stop the derivation (`agent-instances-resolver.ts`).
 * - **A primary hidden by a display change keeps its setting.** `selectedAgents`,
 *   the app default and `.commandmate/agents.yaml` can each drop a primary from
 *   the derived list, and two of the three involve no write about this worktree,
 *   so no one rule could discard it reliably. The tab is hidden; the instance can
 *   still be sent to, with its setting; and showing it again finds it. Saving a
 *   roster that leaves it out is what ends it (`setAgentInstances`).
 * - **Create keeps the current list.** The first explicit row stops the
 *   derivation, so the derived primaries are written alongside the new one, as the
 *   roster PATCH clients already do.
 * - **Racing the roster PATCH.** That route replaces the list from what its client
 *   read earlier. Clients take `rosterRevision` from the responses here and hand it
 *   back as `expectedRosterRevision`; a stale one is refused before anything is
 *   written. The PATCH route itself does not check it (it is out of #4114's scope).
 *
 * @module lib/agent-roles/management
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { validateAgentInstancesInput } from '@/lib/agent-instances-validator';
import {
  AgentInstanceLimitError,
  getAgentInstances,
  InvalidAgentInstanceError,
  setAgentInstances,
} from '@/lib/db/agent-instances-db';
import {
  getInstanceRoleState,
  getLatestRoleLaunchRecords,
  getRepositoryRoleStates,
  getSystemRoleDefaults,
  setInstanceRoleState,
} from '@/lib/db/agent-roles-db';
import type { Repository } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { MAX_AGENT_INSTANCES, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import {
  AGENT_ROLE_CLI_TOOLS,
  agentRoleReplacesDefaultInstructions,
  isAgentRoleAdapterEnabled,
  isAgentRoleCliTool,
  type EffectiveRole,
  type InstanceRoleEntry,
  type RoleLaunchRecord,
  type RoleResolution,
  type InstanceRoleSettingsResponse,
  type RepositoryRoleDefaultEntry,
  type RoleAssignmentInput,
  type SystemRoleDefaultEntry,
  type WorktreeToolRoleDefault,
} from '@/types/agent-roles';
import type { Worktree } from '@/types/models';
import { computeRoleInjection, type RoleComposition } from './adapters';
import {
  attributeToRepository,
  resolveDefaultsForTool,
  withSettledRepositoryMembership,
  withSettledWorktreeMembership,
  toEffectiveRole,
  type RoleResolverDeps,
} from './resolve';

/** The refusals a route turns into a status. */
export class InstanceRoleRequestError extends Error {
  constructor(
    public readonly code: 'not_found' | 'tool_not_supported' | 'invalid_request' | 'instance_exists' | 'roster_changed',
    message: string
  ) {
    super(message);
    this.name = 'InstanceRoleRequestError';
  }
}

function currentRoster(db: Database.Database, worktree: Worktree): AgentInstance[] {
  return resolveAgentInstances(db, worktree.id, worktree.selectedAgents);
}

/** A hash of the roster in order. Moves on an add, a removal, a rename and a reorder. */
export function computeRosterRevision(roster: readonly AgentInstance[]): string {
  const canonical = roster.map(({ id, cliTool, alias, order }) => [id, cliTool, alias, order]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The revision of a worktree's roster now, or null when the worktree is gone. Read
 * where a request settles who it is talking to, and read again before acting on it.
 */
export function readRosterRevision(db: Database.Database, worktreeId: string): string | null {
  const worktree = getWorktreeById(db, worktreeId);
  return worktree ? computeRosterRevision(currentRoster(db, worktree)) : null;
}

/** What only a running server can say about a launch, on top of the settings. */
export interface RoleApplicationDeps extends RoleResolverDeps {
  /**
   * The user's settings as one instance's pane sees them: a session can have its own
   * env, so this is per instance and not per tool. A rejection leaves that instance's
   * fingerprint not computable. Omitted: nothing is computed, and `restartPending` is
   * `unknown`.
   */
  loadComposition?: (cliToolId: CLIToolType, instanceId: string, worktreePath: string) => Promise<RoleComposition>;
  /**
   * The generation of the process this server started for the instance. A record of
   * any other generation is about a process it cannot vouch for. Omitted: none.
   */
  currentGeneration?: (cliToolId: CLIToolType, instanceId: string) => string | null;
  /** OpenCode V1: the process continued a conversation that had another role (§6.4). */
  resumedAcrossRole?: (cliToolId: CLIToolType, instanceId: string) => boolean;
}

/**
 * The injection fingerprint of what a resolution would inject.
 *
 * @returns `computed: false` when that takes a composition that could not be read
 */
function injectionOf(
  resolution: RoleResolution,
  composition: RoleComposition | null
): { computed: boolean; fingerprint: string | null } {
  if (resolution.kind === 'none') return { computed: true, fingerprint: null };
  if (resolution.kind === 'ambiguous' || composition === null || !isAgentRoleCliTool(resolution.cliToolId)) {
    return { computed: false, fingerprint: null };
  }
  return {
    computed: true,
    fingerprint: computeRoleInjection(resolution.cliToolId, resolution.role, composition).injectionFingerprint,
  };
}

/**
 * Restart pending, by the injection fingerprint and nothing else (§5). A role's name,
 * id and the level it came from are not inputs, so none of them moves this.
 */
export function computeRestartPending(
  next: { computed: boolean; fingerprint: string | null },
  launched: RoleLaunchRecord | null
): 'yes' | 'no' | 'unknown' {
  if (!next.computed || launched === null) return 'unknown';
  return next.fingerprint === launched.injectionFingerprint ? 'no' : 'yes';
}

/**
 * The settings of a worktree, each beside what it would resolve to and what the
 * process running now was started with.
 *
 * @throws {AgentRoleTargetNotFoundError} The worktree does not exist
 */
export async function buildInstanceRoleSettings(
  db: Database.Database,
  worktreeId: string,
  deps: RoleApplicationDeps = {}
): Promise<InstanceRoleSettingsResponse> {
  // Read first and outside: these wait, and no database answer may cross an await.
  //
  // So the roster can change while they do (the PATCH on a worktree may give an id to
  // another tool). Each answer is kept under everything it was asked for, and the
  // roster read below finds only what still describes it. Anything else has none, and
  // reads as not computable: `unknown`, rather than a fingerprint of another tool's
  // settings. Not asked again, so a roster that keeps changing cannot hold this up;
  // the next read has it right.
  const compositionKey = (cliToolId: CLIToolType, instanceId: string, worktreePath: string): string =>
    JSON.stringify([cliToolId, instanceId, worktreePath]);
  const compositions = new Map<string, RoleComposition | null>();
  if (deps.loadComposition) {
    const row = getWorktreeById(db, worktreeId);
    if (row) {
      const instances = currentRoster(db, row).filter((instance) => isAgentRoleCliTool(instance.cliTool));
      await Promise.all(
        instances.map(async (instance) => {
          const composition = await deps.loadComposition?.(instance.cliTool, instance.id, row.path).catch(() => null);
          compositions.set(compositionKey(instance.cliTool, instance.id, row.path), composition ?? null);
        })
      );
    }
  }

  // Everything is read in the builder, in one stretch with the final check, so a tool
  // can never be paired with a setting made after it changed.
  return withSettledWorktreeMembership(db, worktreeId, deps, (worktree, membership) => {
    const roster = currentRoster(db, worktree);

    const instances: InstanceRoleEntry[] = roster.map((instance) => {
      const stored = getInstanceRoleState(db, worktree.id, instance.id);
      const records = getLatestRoleLaunchRecords(db, worktree.id, instance.id);
      const resolution = resolveDefaultsForTool(db, instance.cliTool, membership, stored);
      const next = injectionOf(
        resolution,
        compositions.get(compositionKey(instance.cliTool, instance.id, worktree.path)) ?? null
      );
      const generation = deps.currentGeneration?.(instance.cliTool, instance.id) ?? null;
      const launched =
        records.launched !== null && records.launched.sessionGeneration === generation ? records.launched : null;
      const effectiveNext: EffectiveRole & { injectionFingerprint: string | null } = {
        ...toEffectiveRole(resolution),
        injectionFingerprint: next.fingerprint,
      };
      return {
        instanceId: instance.id,
        cliToolId: instance.cliTool,
        alias: instance.alias,
        supported: isAgentRoleCliTool(instance.cliTool),
        adapterEnabled: isAgentRoleCliTool(instance.cliTool) && isAgentRoleAdapterEnabled(instance.cliTool),
        stored,
        application: {
          effectiveNext,
          requested: records.requested,
          launched,
          restartPending: computeRestartPending(next, launched),
          ...(agentRoleReplacesDefaultInstructions(instance.cliTool) ? { replacesDefaultInstructions: true } : {}),
          ...(deps.resumedAcrossRole?.(instance.cliTool, instance.id) ? { resumedAcrossRole: true } : {}),
        },
      };
    });

    const toolDefaults: WorktreeToolRoleDefault[] = AGENT_ROLE_CLI_TOOLS.map((cliToolId) => ({
      cliToolId,
      adapterEnabled: isAgentRoleAdapterEnabled(cliToolId),
      effective: toEffectiveRole(resolveDefaultsForTool(db, cliToolId, membership)),
    }));

    return {
      success: true,
      rosterRevision: computeRosterRevision(roster),
      rosterSaved: getAgentInstances(db, worktree.id).length > 0,
      instances,
      toolDefaults,
    };
  });
}

function assertToolTakesAssignment(cliToolId: CLIToolType, input: RoleAssignmentInput): void {
  if (!isAgentRoleCliTool(cliToolId) && input.state !== 'inherit') {
    throw new InstanceRoleRequestError('tool_not_supported', `Roles do not apply to ${cliToolId}`);
  }
}

/**
 * Set the role of an instance the roster shows.
 *
 * @throws {InstanceRoleRequestError}
 * @throws {AgentRoleNotFoundError}
 */
export function setManagedInstanceRole(
  db: Database.Database,
  worktree: Worktree,
  instanceId: string,
  input: RoleAssignmentInput
): void {
  const instance = currentRoster(db, worktree).find((entry) => entry.id === instanceId);
  if (!instance) throw new InstanceRoleRequestError('not_found', `Instance not in the roster: ${instanceId}`);
  assertToolTakesAssignment(instance.cliTool, input);
  setInstanceRoleState(db, worktree.id, instanceId, input);
}

/**
 * Add an instance and its role together, so a launch that follows sees the right
 * role from its first turn, and a failure leaves neither.
 *
 * @throws {InstanceRoleRequestError}
 * @throws {AgentRoleNotFoundError}
 */
export function createInstanceWithRole(
  db: Database.Database,
  worktreeId: string,
  input: {
    instance: { id: unknown; cliTool: unknown; alias?: unknown };
    role: RoleAssignmentInput;
    expectedRosterRevision?: string;
  }
): { instanceId: string } {
  return db.transaction(() => {
    // Inside the transaction, so the revision compared is the list being replaced.
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) throw new InstanceRoleRequestError('not_found', `Worktree not found: ${worktreeId}`);
    const current = currentRoster(db, worktree);
    if (
      input.expectedRosterRevision !== undefined &&
      input.expectedRosterRevision !== computeRosterRevision(current)
    ) {
      throw new InstanceRoleRequestError('roster_changed', 'The roster changed since it was read');
    }
    if (current.some((entry) => entry.id === input.instance.id)) {
      throw new InstanceRoleRequestError('instance_exists', `Instance already exists: ${String(input.instance.id)}`);
    }
    if (current.length >= MAX_AGENT_INSTANCES) {
      throw new InstanceRoleRequestError('invalid_request', `A worktree holds at most ${MAX_AGENT_INSTANCES} instances`);
    }

    const validation = validateAgentInstancesInput([...current, input.instance]);
    if (!validation.valid || !validation.value) {
      throw new InstanceRoleRequestError('invalid_request', validation.error ?? 'Invalid instance');
    }
    const next = validation.value;
    const created = next[next.length - 1];
    assertToolTakesAssignment(created.cliTool, input.role);

    try {
      setAgentInstances(db, worktreeId, next);
    } catch (error) {
      if (error instanceof AgentInstanceLimitError || error instanceof InvalidAgentInstanceError) {
        throw new InstanceRoleRequestError('invalid_request', error.message);
      }
      throw error;
    }
    setInstanceRoleState(db, worktreeId, created.id, input.role);
    return { instanceId: created.id };
  })();
}

/** The system level, one entry per supported tool. */
export function buildSystemRoleDefaults(db: Database.Database): SystemRoleDefaultEntry[] {
  const stored = getSystemRoleDefaults(db);
  return AGENT_ROLE_CLI_TOOLS.map((cliToolId) => {
    const entry = stored[cliToolId];
    return {
      cliToolId,
      adapterEnabled: isAgentRoleAdapterEnabled(cliToolId),
      stored: entry ? { state: 'role', roleId: entry.roleId, roleName: entry.roleName } : { state: 'unset' },
    };
  });
}

/**
 * One root, one entry per supported tool: what it holds, and what a worktree would get.
 *
 * @throws {AgentRoleTargetNotFoundError} The repository does not exist
 */
export function buildRepositoryRoleDefaults(
  db: Database.Database,
  repositoryId: string,
  deps: RoleResolverDeps = {}
): Promise<{ repository: Repository; defaults: RepositoryRoleDefaultEntry[] }> {
  return withSettledRepositoryMembership(db, repositoryId, deps, (repository, membership) => {
    const stored = getRepositoryRoleStates(db, repository.id);
    const defaults = AGENT_ROLE_CLI_TOOLS.map(
      (cliToolId): RepositoryRoleDefaultEntry => ({
        cliToolId,
        adapterEnabled: isAgentRoleAdapterEnabled(cliToolId),
        stored: stored[cliToolId] ?? { state: 'inherit' },
        effective: toEffectiveRole(
          attributeToRepository(resolveDefaultsForTool(db, cliToolId, membership), repository.id)
        ),
      })
    );
    return { repository, defaults };
  });
}
