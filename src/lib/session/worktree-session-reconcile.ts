/**
 * Make everything that is keyed on a worktree ID *outside* the database follow
 * that ID when it moves (Issue #1621, Phase 3).
 *
 * `migrateWorktreeIdPreservingChildren` already moves the rows. What it cannot
 * touch is the state that lives beyond SQLite and is derived from the ID rather
 * than stored:
 *
 * - tmux session names — `mcbd-{cli}-{worktreeId}[-{suffix}]` is a *derived*
 *   value (`cli-tools/base.ts`), so the running agent keeps its process but
 *   vanishes from the UI, and the app will happily start a **second** agent in
 *   the same directory (Issue #1621 (a));
 * - Auto-Yes state, response pollers, control-mode attaches and WebSocket rooms
 *   — all keyed by worktree ID in process memory (Issue #1621 (f)).
 *
 * Dropping any one of those produces the same hard-to-diagnose failure: the
 * session is alive, the UI looks fine, and instructions silently stop arriving.
 * So every mover here **transfers** its key rather than invalidating it.
 *
 * Written for the bulk renumbering in Phase 4, but deliberately not specific to
 * it: it takes (oldId, newId) pairs and is equally the right call for a future
 * directory move.
 *
 * ## Why the operation is batched and two-staged
 *
 * A renumbering moves every ID at once, so one worktree's NEW name can be
 * another worktree's OLD name — the design's own example is that
 * `commandmate-main` is the new ID of the directory currently registered as
 * `mycodebranchdesk-main`. Renaming pairwise in any order eventually hits
 * "duplicate session: …" and, worse, an A→B / B→A swap has no valid order at
 * all. Every rename therefore goes through a temporary name first, and the
 * in-memory movers each detach the whole batch before writing any of it.
 *
 * ## Why targets come from the roster, never from `tmux ls | grep`
 *
 * `mcbd-claude-<wt>` is a prefix of `mcbd-claude-<wt>-2`, so anything
 * prefix-based sweeps up a different instance's session (Issue #1156). Targets
 * are built from `agent_instances` × the CLI tool registry and matched by exact
 * string equality against the live session list; the tmux operations themselves
 * go through `exactTarget()`.
 *
 * ## …and why prediction alone is not enough (Issue #1661)
 *
 * Predicting names can only find sessions whose name the prediction happens to
 * reproduce. Anything else is not "skipped" — it is never enumerated, so it
 * cannot be counted, and a pass that left two live sessions stranded reported
 * `skipped: 0, errors: 0`. Two shapes escape prediction, and both are ordinary
 * in a database that has been through a renumbering:
 *
 * - an additional instance (`mcbd-claude-<wt>-2`) whose `agent_instances` row
 *   was never written or has since been removed — 45 of 70 worktrees in the
 *   production database carry no roster rows at all;
 * - a session whose name embeds an ID *generation* older than the one the
 *   rename pair names, because it missed an earlier move.
 *
 * So the live session list is also read the other way round: each live name is
 * attributed to a worktree ID by matching against the **exact set of IDs the
 * database knows** (`worktrees` ∪ `worktree_aliases.old_id` ∪ this pass's
 * pairs), longest ID first. That is set membership, not a prefix sweep: when
 * `<wt>-2` is itself a registered worktree, `mcbd-claude-<wt>-2` resolves to
 * *it* and a rename of `<wt>` leaves it alone — the #1156 misfire, still
 * refused. When `<wt>-2` is not a worktree, the same name resolves to `<wt>`'s
 * second instance and follows the move to `mcbd-claude-<new>-2`, never onto
 * `mcbd-claude-<new>`.
 *
 * Live `mcbd-*` sessions that resolve to nothing at all are reported in
 * `unaccountedSessions` and logged as a warning, because "I could not see it"
 * must never again be rendered as "there was nothing to see".
 */

import type Database from 'better-sqlite3';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import {
  CLI_TOOL_IDS,
  buildInstanceId,
  isCliToolType,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { validateSessionName } from '@/lib/cli-tools/validation';
import { getAgentInstances } from '@/lib/db/agent-instances-db';
import { getAllWorktreeAliases } from '@/lib/db/worktree-alias-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { listSessions, renameSession } from '@/lib/tmux/tmux';
import { getControlModeTmuxTransport } from '@/lib/tmux/control-mode-tmux-transport';
import {
  migrateAutoYesStateWorktreeIds,
  startAutoYesPolling,
  stopAutoYesPolling,
  getAutoYesPollerCompositeKeys,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import { migrateResponsePollerWorktreeIds } from '@/lib/polling/response-poller';
import { migrateWorktreeRooms } from '@/lib/ws-server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('worktree-session-reconcile');

/** One worktree ID move. */
export interface WorktreeIdRename {
  oldId: string;
  newId: string;
}

/** A tmux session that has to follow a worktree ID move. */
interface SessionRenamePlan {
  oldName: string;
  newName: string;
  rename: WorktreeIdRename;
  /**
   * `roster` — the name was predicted from `agent_instances` × the CLI tool
   * registry; `live` — it was read off the live session list and attributed
   * back to a known worktree ID (Issue #1661).
   */
  source: 'roster' | 'live';
}

/**
 * How each rename plan was arrived at (Issue #1661).
 *
 * Reported separately from the outcome counts so a log line can never again
 * imply coverage it did not have: `predicted` is what naming the targets in
 * advance found, `discovered` is what only reading the live session list found,
 * and `unaccountedSessions` is what neither could explain.
 */
export interface ReconcilePlanSources {
  /** Live sessions matched by a name predicted from the roster */
  predicted: number;
  /** Live sessions the roster never named, recovered by attributing the live name */
  discovered: number;
}

/** Outcome of one reconciliation pass. */
export interface ReconcileWorktreeSessionsResult {
  /** tmux sessions successfully renamed */
  renamedSessions: Array<{ oldName: string; newName: string }>;
  /** Candidates deliberately not touched, with the reason */
  skippedSessions: Array<{ oldName: string; newName: string; reason: string }>;
  /**
   * Live `mcbd-*` sessions that no ID the database knows can explain
   * (Issue #1661). Never a rename target — the pass cannot tell which worktree
   * they belong to — but never silent either: a non-empty list is a warning.
   */
  unaccountedSessions: string[];
  /** Where the rename plans came from (Issue #1661) */
  planSources: ReconcilePlanSources;
  /** Auto-Yes composite keys that were re-pointed */
  movedAutoYesKeys: string[];
  /** Auto-Yes pollers restarted under the new ID */
  restartedAutoYesPollers: string[];
  /** Response poller keys that were re-pointed */
  movedPollerKeys: string[];
  /** WebSocket rooms that were re-pointed */
  movedRooms: Array<{ oldId: string; newId: string; subscribers: number }>;
  /** Non-fatal failures; reconciliation never throws on a single bad pair */
  errors: string[];
}

/** tmux operations, injectable so the unit tests never touch a real server. */
export interface ReconcileTmuxDeps {
  listSessions: typeof listSessions;
  renameSession: typeof renameSession;
}

export interface ReconcileOptions {
  tmux?: Partial<ReconcileTmuxDeps>;
}

/**
 * Prefix for the intermediate session names used by the two-stage rename.
 *
 * Deliberately NOT `mcbd-`: a name under that prefix would be picked up by the
 * reading-mode key binding's `#{m:mcbd-*,#{session_name}}` guard and by any
 * human scanning `tmux ls` for CommandMate sessions. These names exist for
 * microseconds, but a crash mid-pass leaves one behind and it should read as
 * obviously transient.
 */
const TEMP_SESSION_PREFIX = 'cmate-renaming-';

function emptyResult(): ReconcileWorktreeSessionsResult {
  return {
    renamedSessions: [],
    skippedSessions: [],
    unaccountedSessions: [],
    planSources: { predicted: 0, discovered: 0 },
    movedAutoYesKeys: [],
    restartedAutoYesPollers: [],
    movedPollerKeys: [],
    movedRooms: [],
    errors: [],
  };
}

/**
 * Drop pairs that are no-ops or unsafe, keeping the last mapping for a given
 * source ID.
 */
function normalizeRenames(renames: ReadonlyArray<WorktreeIdRename>): WorktreeIdRename[] {
  const byOldId = new Map<string, string>();
  for (const { oldId, newId } of renames) {
    if (!oldId || !newId || oldId === newId) continue;
    // The new ID becomes a tmux session-name segment and a URL segment; an ID
    // that fails validation must never reach either.
    if (!isValidWorktreeId(oldId) || !isValidWorktreeId(newId)) continue;
    byOldId.set(oldId, newId);
  }
  return Array.from(byOldId, ([oldId, newId]) => ({ oldId, newId }));
}

/**
 * Every (cliToolId, instanceId) pair whose session could belong to this worktree.
 *
 * The roster is read for BOTH IDs because the caller may reconcile either side
 * of the DB move: after `migrateWorktreeIdPreservingChildren` the rows sit under
 * `newId`, but a caller reconciling ahead of the move still finds them under
 * `oldId`. The primary instance of every CLI tool is always included — a
 * worktree that predates the roster (#1000) has no `agent_instances` rows at all
 * yet can absolutely have a running `mcbd-claude-<id>` session.
 */
function collectInstanceTargets(
  db: Database.Database,
  rename: WorktreeIdRename
): Array<{ cliToolId: CLIToolType; instanceId: string }> {
  const seen = new Set<string>();
  const targets: Array<{ cliToolId: CLIToolType; instanceId: string }> = [];

  const add = (cliToolId: CLIToolType, instanceId: string): void => {
    const key = `${cliToolId}|${instanceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ cliToolId, instanceId });
  };

  for (const cliToolId of CLI_TOOL_IDS) add(cliToolId, cliToolId);

  for (const worktreeId of [rename.newId, rename.oldId]) {
    let instances;
    try {
      instances = getAgentInstances(db, worktreeId);
    } catch {
      // No agent_instances table (older database) — the primary instances above
      // already cover the pre-roster shape.
      continue;
    }
    for (const instance of instances) {
      if (isCliToolType(instance.cliTool)) add(instance.cliTool, instance.id);
    }
  }

  return targets;
}

/** Build the (old session name → new session name) plan for one ID move. */
function planSessionRenames(
  db: Database.Database,
  rename: WorktreeIdRename,
  errors: string[]
): SessionRenamePlan[] {
  const manager = CLIToolManager.getInstance();
  const plans: SessionRenamePlan[] = [];

  for (const { cliToolId, instanceId } of collectInstanceTargets(db, rename)) {
    try {
      const tool = manager.getTool(cliToolId);
      const oldName = tool.getSessionName(rename.oldId, instanceId);
      const newName = tool.getSessionName(rename.newId, instanceId);
      // getSessionName validates already; assert it explicitly so the guarantee
      // is stated where the name is about to be handed to tmux (Issue #1621).
      validateSessionName(newName);
      if (oldName !== newName) plans.push({ oldName, newName, rename, source: 'roster' });
    } catch (error) {
      errors.push(
        `session name for ${rename.oldId}/${instanceId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return plans;
}

/**
 * Every worktree ID this database can vouch for, current or historical.
 *
 * This is the set a live session name is matched against, so its completeness
 * is what keeps the matching exact: an ID that is missing here turns a name
 * that legitimately belongs to a *different* worktree into a suffix of one that
 * is moving. Both tables are read with their own try/catch because tests and
 * the CLI hand around hand-built connections where either may be absent.
 *
 * Queried directly rather than through `worktree-db` / `worktree-alias-db` on
 * purpose: four suites `vi.mock('@/lib/db/worktree-db')`, and importing it here
 * would make this module inherit those mocks (the same trap that moved
 * `renameWorktreeIdPreservingChildren` under `migrations/`).
 *
 * @param db - Database instance
 * @param renames - The pairs this pass is applying (their IDs are known by definition)
 */
function collectKnownWorktreeIds(
  db: Database.Database,
  renames: ReadonlyArray<WorktreeIdRename>
): Set<string> {
  const ids = new Set<string>();

  try {
    const rows = db.prepare('SELECT id FROM worktrees').all() as Array<{ id: string }>;
    for (const row of rows) if (row.id) ids.add(row.id);
  } catch {
    // No `worktrees` table — nothing current to attribute against.
  }

  try {
    const rows = db.prepare('SELECT old_id FROM worktree_aliases').all() as Array<{
      old_id: string;
    }>;
    for (const row of rows) if (row.old_id) ids.add(row.old_id);
  } catch {
    // Older database without `worktree_aliases` (migration v53).
  }

  for (const rename of renames) {
    ids.add(rename.oldId);
    ids.add(rename.newId);
  }

  return ids;
}

/** A live session name resolved back to the worktree it belongs to. */
interface AttributedSession {
  cliToolId: CLIToolType;
  worktreeId: string;
  /** Instance suffix, or `undefined` for the primary instance */
  suffix?: string;
}

/**
 * Resolve a live tmux session name to (CLI tool, worktree ID, instance suffix).
 *
 * `mcbd-<cli>-<id>` and `mcbd-<cli>-<id>-<suffix>` are both valid readings of
 * the same string, which is the whole of Issue #1156. The tie is broken by
 * asking the database rather than the string: candidate IDs are tried
 * **longest first**, and only an exact member of `knownIds` is accepted. So
 * `mcbd-claude-alpha-2` resolves to worktree `alpha-2` when that worktree
 * exists, and to `alpha`'s second instance when it does not — and in neither
 * reading does it resolve to plain `alpha`'s primary session.
 *
 * @param name - A live tmux session name
 * @param knownIds - Every worktree ID the database can vouch for
 * @returns The attribution, or `null` when nothing in `knownIds` explains the name
 */
function attributeSessionName(name: string, knownIds: ReadonlySet<string>): AttributedSession | null {
  for (const cliToolId of CLI_TOOL_IDS) {
    const prefix = `mcbd-${cliToolId}-`;
    if (!name.startsWith(prefix)) continue;

    // No CLI tool id is a prefix of another, so at most one branch is entered
    // and the remainder is unambiguously `<id>[-<suffix>]`.
    const rest = name.slice(prefix.length);
    let candidate = rest;
    for (;;) {
      if (knownIds.has(candidate)) {
        const suffix = candidate.length === rest.length ? undefined : rest.slice(candidate.length + 1);
        return { cliToolId, worktreeId: candidate, suffix: suffix || undefined };
      }
      const cut = candidate.lastIndexOf('-');
      if (cut <= 0) return null;
      candidate = candidate.slice(0, cut);
    }
  }

  return null;
}

/**
 * Read the live session list the other way round: attribute each name to a
 * worktree ID and plan a rename when that ID is moving (Issue #1661).
 *
 * This is what covers the sessions prediction structurally cannot see — an
 * instance with no roster row, a name left behind by an earlier move — and it
 * is also the only place that can notice a live `mcbd-*` session nothing
 * explains, which it records in `result.unaccountedSessions`.
 */
function discoverSessionRenames(
  renames: ReadonlyArray<WorktreeIdRename>,
  liveNames: ReadonlySet<string>,
  knownIds: ReadonlySet<string>,
  result: ReconcileWorktreeSessionsResult
): SessionRenamePlan[] {
  const byOldId = new Map(renames.map((rename) => [rename.oldId, rename]));
  const plans: SessionRenamePlan[] = [];

  for (const name of liveNames) {
    if (!name.startsWith('mcbd-')) continue;

    const attributed = attributeSessionName(name, knownIds);
    if (!attributed) {
      result.unaccountedSessions.push(name);
      continue;
    }

    const rename = byOldId.get(attributed.worktreeId);
    if (!rename) continue;

    try {
      const tool = CLIToolManager.getInstance().getTool(attributed.cliToolId);
      // Rebuilt through getSessionName rather than by string surgery so the
      // suffix convention stays owned by one place (`cli-tools/base.ts`).
      const instanceId = attributed.suffix
        ? buildInstanceId(attributed.cliToolId, attributed.suffix)
        : attributed.cliToolId;
      const newName = tool.getSessionName(rename.newId, instanceId);
      validateSessionName(newName);
      if (name !== newName) plans.push({ oldName: name, newName, rename, source: 'live' });
    } catch (error) {
      result.errors.push(
        `attribute session ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return plans;
}

/**
 * Merge the predicted and discovered plans, keeping one plan per live session.
 *
 * Prediction wins a tie. The two agree wherever both fire; where they disagree
 * the roster is a positive statement that the instance belongs to this worktree
 * ("`codex-3` is an instance of `alpha`"), while attribution is an inference
 * from the name, so the explicit record is the safer of the two to trust.
 */
function mergeSessionPlans(
  predicted: SessionRenamePlan[],
  discovered: SessionRenamePlan[]
): SessionRenamePlan[] {
  const byOldName = new Map<string, SessionRenamePlan>();
  for (const plan of [...predicted, ...discovered]) {
    if (!byOldName.has(plan.oldName)) byOldName.set(plan.oldName, plan);
  }
  return Array.from(byOldName.values());
}

/** Mint a session name that is free both on the server and within this pass. */
function allocateTempName(taken: Set<string>, ordinal: number): string {
  let candidate = `${TEMP_SESSION_PREFIX}${ordinal}`;
  let attempt = 0;
  while (taken.has(candidate)) {
    attempt++;
    candidate = `${TEMP_SESSION_PREFIX}${ordinal}-${attempt}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Rename the live tmux sessions in two stages so no intermediate state collides.
 */
async function renameSessionsTwoStage(
  plans: SessionRenamePlan[],
  live: ReadonlySet<string>,
  deps: ReconcileTmuxDeps,
  result: ReconcileWorktreeSessionsResult
): Promise<SessionRenamePlan[]> {
  if (plans.length === 0) return [];

  // Exact set membership, never a prefix test (Issue #1156). A predicted name
  // that is not live is not a miss — it is a name nothing was ever running
  // under — so it is dropped here rather than counted as skipped; what a pass
  // could not see at all is reported through `unaccountedSessions` instead.
  const runnable = plans.filter((plan) => live.has(plan.oldName));
  const movingNames = new Set(runnable.map((plan) => plan.oldName));

  const actionable: SessionRenamePlan[] = [];
  for (const plan of runnable) {
    // A destination that is occupied by a session this pass is NOT moving
    // belongs to somebody else. Renaming onto it would fail anyway; skipping
    // explicitly keeps the reason in the result instead of in an exception.
    if (live.has(plan.newName) && !movingNames.has(plan.newName)) {
      result.skippedSessions.push({
        oldName: plan.oldName,
        newName: plan.newName,
        reason: 'destination session already exists',
      });
      continue;
    }
    actionable.push(plan);
  }

  const taken = new Set([...live, ...actionable.map((plan) => plan.newName)]);
  const staged: Array<{ plan: SessionRenamePlan; tempName: string }> = [];

  // Stage 1: everything out of the way, into names nothing else can claim.
  for (const [index, plan] of actionable.entries()) {
    const tempName = allocateTempName(taken, index);
    try {
      const renamed = await deps.renameSession(plan.oldName, tempName);
      if (renamed) {
        staged.push({ plan, tempName });
      } else {
        // Disappeared between the listing and now (the agent exited).
        result.skippedSessions.push({
          oldName: plan.oldName,
          newName: plan.newName,
          reason: 'session no longer exists',
        });
      }
    } catch (error) {
      result.errors.push(
        `stage session ${plan.oldName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Stage 2: into the real names, now guaranteed free.
  const completed: SessionRenamePlan[] = [];
  for (const { plan, tempName } of staged) {
    try {
      await deps.renameSession(tempName, plan.newName);
      result.renamedSessions.push({ oldName: plan.oldName, newName: plan.newName });
      completed.push(plan);
      // The control-mode attach survived the rename; only the registry key is
      // stale. Re-file it so terminal input keeps reaching the session.
      try {
        getControlModeTmuxTransport().renameSession(plan.oldName, plan.newName);
      } catch (error) {
        result.errors.push(
          `control-mode rekey ${plan.oldName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`rename session ${plan.oldName} -> ${plan.newName}: ${message}`);
      // Put it back under a name a human can find rather than leaving it parked
      // on a temporary one.
      try {
        await deps.renameSession(tempName, plan.oldName);
      } catch {
        result.errors.push(`session left under temporary name ${tempName}`);
      }
    }
  }

  return completed;
}

/**
 * Move the in-process state that is keyed on a worktree ID.
 *
 * Runs for every requested pair, not only the ones that had a live tmux
 * session: a WebSocket room or an Auto-Yes state can exist without a session,
 * and leaving either behind is exactly the silent breakage this guards against.
 */
function migrateRuntimeState(
  db: Database.Database,
  renames: WorktreeIdRename[],
  result: ReconcileWorktreeSessionsResult
): void {
  // --- Auto-Yes -------------------------------------------------------------
  // Snapshot which pollers are running BEFORE the state moves: startAutoYesPolling
  // refuses to start when the state at its key is not enabled, so the state has
  // to move first, and the "was it running?" answer only exists beforehand.
  const runningAutoYesPollers = new Set(getAutoYesPollerCompositeKeys());

  const movedAutoYes = migrateAutoYesStateWorktreeIds(renames);
  result.movedAutoYesKeys = movedAutoYes.map((move) => move.newKey);

  for (const move of movedAutoYes) {
    if (!runningAutoYesPollers.has(move.oldKey)) continue;
    try {
      // The poller's timer chain captures the worktree ID, so re-keying its map
      // would leave it polling the old session. Stop and restart instead — the
      // Auto-Yes *state* (deadline, stop pattern) is what must survive, and it
      // already has.
      stopAutoYesPolling(move.oldKey);
      const started = startAutoYesPolling(move.newWorktreeId, move.cliToolId, move.instanceId);
      if (started.started) {
        result.restartedAutoYesPollers.push(move.newKey);
      } else {
        result.errors.push(`auto-yes poller ${move.newKey} not restarted: ${started.reason}`);
      }
    } catch (error) {
      result.errors.push(
        `auto-yes poller ${move.newKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // --- Response pollers -----------------------------------------------------
  // The poller key carries the instance but not the CLI tool, so the roster
  // supplies it. Both IDs are consulted for the same reason as the session plan.
  const rosterCliTool = (worktreeId: string, instanceId: string): CLIToolType | null => {
    const target = renames.find((rename) => rename.oldId === worktreeId);
    for (const candidate of [target?.newId, worktreeId]) {
      if (!candidate) continue;
      try {
        for (const instance of getAgentInstances(db, candidate)) {
          if (instance.id === instanceId && isCliToolType(instance.cliTool)) {
            return instance.cliTool;
          }
        }
      } catch {
        // No roster available; fall through to the primary-instance anchor.
      }
    }
    // The primary instance is anchored by `instanceId === cliToolId` (#868), so
    // an instance id that names a tool IS that tool.
    return isCliToolType(instanceId) ? instanceId : null;
  };

  try {
    result.movedPollerKeys = migrateResponsePollerWorktreeIds(renames, rosterCliTool).map(
      (move) => move.newKey
    );
  } catch (error) {
    result.errors.push(
      `response pollers: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // --- WebSocket rooms ------------------------------------------------------
  try {
    result.movedRooms = migrateWorktreeRooms(renames);
  } catch (error) {
    result.errors.push(`websocket rooms: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Make live tmux sessions and in-process state follow a worktree ID move.
 *
 * Never throws on a single bad pair — a reconciliation pass runs at startup and
 * must not be able to stop the server. Individual failures land in
 * `result.errors`.
 *
 * @param db - Database instance (read for the agent roster)
 * @param oldId - The worktree ID that is going away
 * @param newId - The worktree ID it becomes
 */
export async function reconcileWorktreeSessions(
  db: Database.Database,
  oldId: string,
  newId: string,
  options?: ReconcileOptions
): Promise<ReconcileWorktreeSessionsResult>;
/**
 * Batch form. Prefer this whenever more than one ID moves at once: a bulk
 * renumbering can make one worktree's new ID equal another's old ID, and only
 * the batch form can stage them so the two never collide.
 *
 * @param db - Database instance (read for the agent roster)
 * @param renames - Every (oldId, newId) pair being applied
 */
export async function reconcileWorktreeSessions(
  db: Database.Database,
  renames: ReadonlyArray<WorktreeIdRename>,
  options?: ReconcileOptions
): Promise<ReconcileWorktreeSessionsResult>;
export async function reconcileWorktreeSessions(
  db: Database.Database,
  renamesOrOldId: ReadonlyArray<WorktreeIdRename> | string,
  newIdOrOptions?: string | ReconcileOptions,
  maybeOptions?: ReconcileOptions
): Promise<ReconcileWorktreeSessionsResult> {
  const requested: ReadonlyArray<WorktreeIdRename> =
    typeof renamesOrOldId === 'string'
      ? [{ oldId: renamesOrOldId, newId: String(newIdOrOptions ?? '') }]
      : renamesOrOldId;
  const options =
    typeof renamesOrOldId === 'string'
      ? maybeOptions
      : (newIdOrOptions as ReconcileOptions | undefined);

  const result = emptyResult();
  const renames = normalizeRenames(requested);
  if (renames.length === 0) return result;

  const deps: ReconcileTmuxDeps = {
    listSessions: options?.tmux?.listSessions ?? listSessions,
    renameSession: options?.tmux?.renameSession ?? renameSession,
  };

  // Listed once, up front: both the prediction pass and the attribution pass
  // need it, and it is what makes a startup with nothing stale cost exactly one
  // `tmux list-sessions`.
  let live: Set<string> | null = null;
  try {
    live = new Set((await deps.listSessions()).map((session) => session.name));
  } catch (error) {
    result.errors.push(
      `list tmux sessions: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (live) {
    const knownIds = collectKnownWorktreeIds(db, renames);
    const predicted = renames.flatMap((rename) => planSessionRenames(db, rename, result.errors));
    const discovered = discoverSessionRenames(renames, live, knownIds, result);
    const plans = mergeSessionPlans(predicted, discovered);

    // Counted against the live list, so `predicted` means "predicted AND
    // found", not "names we guessed at".
    for (const plan of plans) {
      if (!live.has(plan.oldName)) continue;
      if (plan.source === 'roster') result.planSources.predicted++;
      else result.planSources.discovered++;
    }

    await renameSessionsTwoStage(plans, live, deps, result);
  }

  // Runtime state moves after the sessions: a poller that ticks in between
  // fails one capture against a name that is briefly gone, which is a logged
  // warning and self-heals on the next tick. The reverse order would have the
  // restarted poller address a session that does not exist yet.
  migrateRuntimeState(db, renames, result);

  // A live session nobody could account for is the failure this pass used to
  // report as success (Issue #1661), so it gets its own line at warn level
  // rather than a zero buried in the summary.
  if (result.unaccountedSessions.length > 0) {
    logger.warn('reconcile:unaccounted-sessions', {
      count: result.unaccountedSessions.length,
      sessions: result.unaccountedSessions,
    });
  }

  if (
    result.renamedSessions.length > 0 ||
    result.errors.length > 0 ||
    result.unaccountedSessions.length > 0
  ) {
    logger.info('reconcile:complete', {
      renames: renames.length,
      predicted: result.planSources.predicted,
      discovered: result.planSources.discovered,
      renamedSessions: result.renamedSessions.length,
      skipped: result.skippedSessions.length,
      unaccounted: result.unaccountedSessions.length,
      errors: result.errors.length,
    });
  }

  return result;
}

/**
 * Reconcile every worktree ID move the database still remembers.
 *
 * Called at startup, after migrations. `worktree_aliases` is the durable record
 * of "this ID used to name that worktree", so it is exactly the list of session
 * names a still-running agent may be sitting under — including the moves the
 * Phase 4 renumbering has just performed, which is what makes the bulk
 * migration safe for a server that was restarted with agents alive.
 *
 * Idempotent and cheap when there is nothing to do: it lists tmux sessions once
 * and intersects, so a startup where no old name is live performs one `tmux
 * list-sessions` and stops. Idempotence survives the attribution pass added in
 * #1661 for the same reason the prediction pass is idempotent — a session that
 * already carries the current ID resolves to the *destination* of its rename
 * pair, which is not a source, so a second run plans nothing.
 *
 * A database with no aliases at all still returns immediately without listing:
 * with no ID on the move there is no session that could be following one.
 *
 * @param db - Database instance
 */
export async function reconcileWorktreeSessionsFromAliases(
  db: Database.Database,
  options?: ReconcileOptions
): Promise<ReconcileWorktreeSessionsResult> {
  let aliases;
  try {
    aliases = getAllWorktreeAliases(db);
  } catch (error) {
    const result = emptyResult();
    result.errors.push(
      `read worktree aliases: ${error instanceof Error ? error.message : String(error)}`
    );
    return result;
  }

  return reconcileWorktreeSessions(
    db,
    aliases.map((alias) => ({ oldId: alias.oldId, newId: alias.worktreeId })),
    options
  );
}

/**
 * @internal Exported so tests can assert the temp-name convention and pin the
 * live-name attribution rules directly (Issue #1661).
 */
export const __internal = {
  TEMP_SESSION_PREFIX,
  allocateTempName,
  buildCompositeKey,
  attributeSessionName,
};
