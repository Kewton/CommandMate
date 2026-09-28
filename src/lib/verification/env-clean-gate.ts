/**
 * Built-in `env-clean` gate: reconcile the machine against the snapshot taken
 * when the task was created (Issue #1740).
 *
 * Canonical spec: docs/design/task-contract.md §2.6
 *
 * `scope` closes the question "what did this delegation change inside the
 * repository". This gate closes the other half. Together they are the first
 * point at which "what did this delegation change" has a complete answer.
 *
 * Two design rules, in order of importance:
 *
 *   1. **Never fail open.** A probe that could not answer produces `unknown`,
 *      the gate reports `error`, and the run fails. Turning an unmeasured probe
 *      into "nothing changed" is how #1614 shipped a 0 that had never been
 *      counted, and it is the single failure this gate must not reproduce.
 *   2. **Additions and removals are judged asymmetrically.** Everything that
 *      existed at task start must still exist, whoever it belonged to — that is
 *      the pkill (#1739) and `kill-server` (#1624) case — with one exception: a
 *      tmux session the baseline recorded as *another CommandMate server's*
 *      (#2627), which that server may close whenever it likes. New things are a
 *      violation *unless they are attributable to another worker*, because
 *      parallel delegations legitimately start their own sessions and servers
 *      inside each other's measurement windows — or unless they are the one
 *      agent session the delegation itself started (#2472), which the baseline
 *      names and which is excused by that exact name only.
 *
 * Server-only: consumes snapshots produced by env-snapshot.
 *
 * @module lib/verification/env-clean-gate
 */

import { dirname, resolve, sep } from 'path';
import type { VerificationGateTerminalStatus } from '@/lib/db';
import {
  getActiveSessionNamespace,
  parseSessionName,
  resolveNamespacedSessionName,
  resolveSessionName,
} from '@/lib/cli-tools/session-name';
import { isCliToolType } from '@/lib/cli-tools/types';
import type { TaskContract } from '@/lib/tasks/contract-parser';
import {
  captureEnvSnapshot,
  ENV_PROBE_IDS,
  ENV_PROBE_LABELS,
  type EnvEntry,
  type EnvProbeId,
  type EnvSnapshot,
} from './env-snapshot';
import { ENV_CLEAN_GATE_ID, VERIFY_CONFIG_RELATIVE_PATH, type VerifyConfig } from './verify-config';

/** Matches `GateOutcome` in gate-runner; kept structural to avoid a cycle. */
export interface EnvCleanOutcome {
  status: VerificationGateTerminalStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number;
  logTail: string | null;
}

// =============================================================================
// Opt-in resolution
// =============================================================================

/** Named so a failing gate can say which declaration switched it on. */
export const REQUIRE_ENV_CLEAN_SOURCE_CONFIG = `options.requireEnvClean (${VERIFY_CONFIG_RELATIVE_PATH})`;
export const REQUIRE_ENV_CLEAN_SOURCE_CONTRACT = 'success.requireEnvClean (task contract)';

export interface RequireEnvCleanDecision {
  required: boolean;
  /** Empty when nothing required it; both entries when both did. */
  sources: string[];
}

/**
 * Read `success.requireEnvClean` off a contract without depending on the parser
 * having a field for it.
 *
 * `TaskContractSuccess` is a closed key set in `lib/tasks/contract-parser.ts`,
 * which is outside this delegation's `scope.allow`, so the key cannot be added
 * to the parser here — a contract that spells it today is rejected at send time
 * with `unknown key "requireEnvClean"`. Resolving it structurally means the
 * per-delegation switch starts working the moment the parser opens the key
 * (`SUCCESS_KEYS` and `TaskContractSuccess`, two lines) with no further change
 * in this module. See docs/design/task-contract.md §2.6.
 */
function contractRequiresEnvClean(contract: TaskContract | null): boolean {
  if (!contract) return false;
  const success = contract.success as Partial<Record<'requireEnvClean', unknown>>;
  return success.requireEnvClean === true;
}

/**
 * Combine the repository-wide and per-delegation switches.
 *
 * ORed, never overridden, for the reason `resolveRequireCommit` is: a contract
 * may tighten a rule the repository left off, but must not be able to switch off
 * one the repository declared. Both default to false, so a contract that says
 * nothing leaves every existing verdict exactly as it was.
 */
export function resolveRequireEnvClean(
  contract: TaskContract | null,
  config: VerifyConfig | null
): RequireEnvCleanDecision {
  const sources: string[] = [];
  if (config?.options.requireEnvClean) sources.push(REQUIRE_ENV_CLEAN_SOURCE_CONFIG);
  if (contractRequiresEnvClean(contract)) sources.push(REQUIRE_ENV_CLEAN_SOURCE_CONTRACT);
  return { required: sources.length > 0, sources };
}

// =============================================================================
// Ownership attribution
// =============================================================================

/**
 * Who a newly-appeared entity belongs to.
 *
 * `unattributed` is not "probably nobody" — it is "cannot be shown to belong to
 * someone else", and it is judged as a violation. Only positive evidence of
 * another owner excuses an addition.
 */
export type EnvEntryOwner = 'self' | 'other' | 'unattributed';

export interface EnvAttributionContext {
  worktreeId: string;
  worktreePath: string;
}

/**
 * Attribute an `mcbd-[<ns>-]<cli>-<worktreeId>[-suffix]` session name to a
 * worktree.
 *
 * The namespace (Issue #2866) is not consulted: the worktree ID is what ties a
 * session to this task, and a session this task's agent started in any
 * server's namespace is still this task's addition.
 *
 * Ambiguity resolves towards `self` on purpose. Worktree ids may contain
 * hyphens, so `mcbd-claude-foo-bar` is genuinely ambiguous between worktree
 * `foo` with suffix `bar` and worktree `foo-bar`; calling it `self` makes an
 * addition a violation, and being wrong in that direction costs a false report
 * rather than a missed leak.
 */
export function attributeSessionName(name: string, worktreeId: string): EnvEntryOwner {
  const parsed = parseSessionName(name);
  if (!parsed) return 'unattributed';
  const tail = parsed.rest;
  if (tail === worktreeId || tail.startsWith(`${worktreeId}-`)) return 'self';
  return 'other';
}

/**
 * Attribute a listening process by the directory it runs in.
 *
 * Inside this worktree is this task. A *sibling* of this worktree is another
 * worker — linked worktrees are created side by side, and the primary checkout
 * the user's production server runs from sits there too, which is what keeps a
 * parallel delegation and the user's own server from being reported as this
 * task's leak. Anything else, including a process with no readable cwd, stays
 * unattributed and is judged.
 */
export function attributeAnchor(anchor: string | null, worktreePath: string): EnvEntryOwner {
  if (!anchor) return 'unattributed';
  const worktree = resolve(worktreePath);
  const path = resolve(anchor);
  if (path === worktree || path.startsWith(worktree + sep)) return 'self';
  const parent = dirname(worktree);
  // The parent directory itself is not a sibling; a process running there is as
  // unattributable as one running in `/`.
  if (path !== parent && path.startsWith(parent + sep)) return 'other';
  return 'unattributed';
}

function attributeEntry(
  probeId: EnvProbeId,
  entry: EnvEntry,
  context: EnvAttributionContext
): EnvEntryOwner {
  switch (probeId) {
    case 'tmux-sessions':
      return attributeSessionName(entry.key, context.worktreeId);
    case 'listeners':
      return attributeAnchor(entry.anchor, context.worktreePath);
    default:
      // A file has no owner. `$HOME` and `~/.commandmate` are shared, so an
      // entry appearing there is a violation for whoever is being judged — the
      // rule the Issue's incident list is made of.
      return 'unattributed';
  }
}

// =============================================================================
// The task's own agent session (Issue #2472)
// =============================================================================

/**
 * A baseline, plus the one tmux session the task's own delegation starts.
 *
 * Recorded rather than observed, because it cannot be observed: `send
 * --contract` creates the task — and with it this baseline — *before* it sends
 * the message, and that send is what starts the agent's session when none is
 * running. A delegation into a worktree with no live session therefore always
 * gained exactly one `self` session between the two snapshots and failed this
 * gate however clean its work was, while the same delegation re-sent after a
 * failed first attempt passed, because by then the session was in the baseline.
 *
 * Carried on the snapshot object rather than declared in `EnvSnapshot`: the
 * file is a JSON round trip and `isEnvSnapshot` ignores keys it does not know,
 * so a baseline with the field loads wherever one without it did.
 *
 * `taskSession` has three states, read by {@link readTaskSession}:
 *   - a name — exactly that key is excused among `tmux-sessions` additions;
 *   - `null` — the task row could not name a session (see
 *     {@link resolveTaskSessionName}); nothing is excused;
 *   - absent — a baseline written before #2472. Nothing is excused, which is
 *     the verdict that baseline was always going to get. Recovering the name
 *     from the task row at verification time would put the database in this
 *     module for files that age out with `ENV_SNAPSHOT_RETENTION_MS` anyway.
 */
export interface EnvBaseline extends EnvSnapshot {
  taskSession?: string | null;
  /**
   * Baseline `mcbd-*` sessions that belonged to another CommandMate server when
   * the task was created (#2627); see {@link recordOtherServerSessions}.
   * `null` when this server's identity was unknown (no namespace), absent in a
   * baseline written before #2627. Only a list excuses anything.
   */
  otherServerSessions?: string[] | null;
}

/** The task-row fields that name the session a delegation runs in. */
export interface TaskSessionOwner {
  worktreeId: string;
  cliToolId: string;
  /** Null (or the tool id itself) for the primary instance. */
  instanceId: string | null;
}

/**
 * The tmux session a task's delegation runs in.
 *
 * `resolveSessionName` is the function that names the session when it is
 * started, so the naming rule stays in one place: a second copy here would be
 * free to drift, and the drift would read as a leak.
 *
 * @returns null when the row cannot name a session — a CLI tool id this build
 *          does not know, or a name `validateSessionName` refuses
 */
export function resolveTaskSessionName(task: TaskSessionOwner): string | null {
  if (!isCliToolType(task.cliToolId)) return null;
  try {
    return resolveSessionName(task.cliToolId, task.worktreeId, task.instanceId ?? undefined);
  } catch {
    return null;
  }
}

/** A freshly captured baseline, stamped with its task's own agent session. */
export function recordTaskSession(
  snapshot: EnvSnapshot,
  task: TaskSessionOwner,
  server: SessionServerIdentity = currentSessionServer()
): EnvBaseline {
  return {
    ...snapshot,
    taskSession: resolveTaskSessionName(task),
    otherServerSessions: recordOtherServerSessions(snapshot, server),
  };
}

/**
 * The session a baseline excuses: its name, `null` when it was recorded as
 * unresolvable, or `undefined` when the baseline predates the field. Only a
 * non-empty string excuses anything.
 */
export function readTaskSession(baseline: EnvSnapshot): string | null | undefined {
  if (!('taskSession' in baseline)) return undefined;
  const recorded = baseline.taskSession;
  return typeof recorded === 'string' && recorded !== '' ? recorded : null;
}

// =============================================================================
// Other CommandMate servers' sessions (Issue #2627)
// =============================================================================

/**
 * What this server knows about which session names are its own.
 *
 * Two CommandMate servers on one machine share the default tmux server. Since
 * #2866 each names its sessions `mcbd-{ns}-…` with its own namespace, and keeps
 * a pre-namespace `mcbd-{cli}-{worktreeId}` session only by adopting it under
 * an alias. So, given this server's namespace, a name is this server's exactly
 * when it carries that namespace or is one of its adopted legacy names.
 */
export interface SessionServerIdentity {
  /** This server's session namespace; null when unset (CLI, tests, failed init). */
  namespace: string | null;
  /** The legacy session this server adopted for a new-format name, if any. */
  legacyAliasOf(newName: string): string | undefined;
}

/**
 * The identity of the server process this module runs in.
 *
 * The adoption table is read through `resolveSessionName`, which returns the
 * adopted legacy name in place of the new-format one — this module may not
 * reach into `lib/tmux` (#1922).
 */
export function currentSessionServer(): SessionServerIdentity {
  return {
    namespace: getActiveSessionNamespace(),
    legacyAliasOf: (newName) => {
      const parsed = parseSessionName(newName);
      if (!parsed) return undefined;
      try {
        const resolved = resolveSessionName(parsed.cliToolId, parsed.rest);
        return resolved !== newName ? resolved : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Whether a session name positively belongs to a CommandMate server other than
 * `server`.
 *
 * False whenever that cannot be shown: this server has no namespace (then every
 * name could be its own), or the name is not a CommandMate session name at all.
 */
export function isOtherServerSession(name: string, server: SessionServerIdentity): boolean {
  if (server.namespace === null) return false;
  const parsed = parseSessionName(name);
  if (!parsed) return false;
  if (parsed.namespace !== null) return parsed.namespace !== server.namespace;
  let ownName: string;
  try {
    ownName = resolveNamespacedSessionName(server.namespace, parsed.cliToolId, parsed.rest);
  } catch {
    // A name this server could never have built is not one of its adoptions.
    return true;
  }
  return server.legacyAliasOf(ownName) !== name;
}

/**
 * The baseline's `mcbd-*` sessions that belonged to another CommandMate server
 * at task creation.
 *
 * Recorded then, because only then is it knowable: this server's legacy
 * adoptions are dropped when their session goes away, so by verification time
 * a vanished adopted session would look like a stranger's.
 *
 * Why this is the line removals are excused on — the design note for #2627:
 *
 *   - A removal is a violation because a worker may have killed someone else's
 *     session (#1624) or server (#1739). A session *of this server* — the
 *     sibling worktree in #1624, whose name carries this server's namespace —
 *     stays guarded exactly as before.
 *   - A session of *another server* is closed by that server's own lifecycle:
 *     the incident of 2026-09-17 was a global-install server's orchestrate
 *     finishing issue-107 and moving on to issue-108, with no kill of any kind
 *     in the three workers' transcripts. This task has no way to tell that
 *     from a worker's kill, and that server — not this gate — owns the fact.
 *   - The namespace is the designed marker of "which server" (#2866); nothing
 *     else here needs this server's database or a guess at the other
 *     repository's paths.
 *
 * Rejected: counting (`one other session gone is fine`) — that is the #1624
 * shape, a sibling session disappearing while this worktree's stays; ignoring
 * every `other` removal — that drops #1624 outright; the database's worktree
 * table — the other server has a different database and the same worktree ids
 * can exist in both, which is why #2866 exists; timing — the two snapshots do
 * not say *when* inside the window something went away; the worker's command
 * log — not recorded in a form the gate reads, and a kill run through a script
 * would not name the session anyway.
 *
 * @returns the names, or null when `server` has no namespace to judge by
 */
export function recordOtherServerSessions(
  snapshot: EnvSnapshot,
  server: SessionServerIdentity
): string[] | null {
  if (server.namespace === null) return null;
  const sessions = snapshot.probes['tmux-sessions'];
  if (!sessions || sessions.status !== 'ok') return [];
  return sessions.entries
    .map((entry) => entry.key)
    .filter((name) => isOtherServerSession(name, server));
}

/** The recorded other-server sessions of a baseline; empty when none was recorded. */
export function readOtherServerSessions(baseline: EnvSnapshot): ReadonlySet<string> {
  const recorded = (baseline as EnvBaseline).otherServerSessions;
  if (!Array.isArray(recorded)) return new Set();
  return new Set(recorded.filter((name): name is string => typeof name === 'string'));
}

// =============================================================================
// Diff
// =============================================================================

export type EnvDiffStatus = 'clean' | 'violated' | 'unknown';

export interface EnvChange {
  key: string;
  detail: string | null;
  owner: EnvEntryOwner;
}

export interface EnvProbeDiff {
  probeId: EnvProbeId;
  status: EnvDiffStatus;
  /** Why the probe could not be compared; non-null exactly when `unknown`. */
  reason: string | null;
  /** Entries that appeared and are not another worker's. */
  added: EnvChange[];
  /** Entries that appeared and were excused by attribution. */
  ignoredAdded: EnvChange[];
  /**
   * The task's own agent session, when it appeared during the task (#2472).
   * Only ever filled for `tmux-sessions`, and only by an exact match on the name
   * the baseline recorded — never by a pattern, so a second session of the same
   * worktree stays in `added`.
   */
  taskSessionAdded: EnvChange[];
  /** Entries that existed at task start and are gone. Always violations. */
  removed: EnvChange[];
  /**
   * `tmux-sessions` removals excused because the baseline recorded the session
   * as another CommandMate server's (#2627). Listed in the report, never
   * dropped. Always empty when the tmux server itself looks killed.
   */
  removedByOtherServer: EnvChange[];
  /**
   * `home-entries` additions and removals dropped because their name is in
   * `options.envCleanIgnoreHomeEntries` (#2890). Kept, not discarded: the
   * report names them, so an excused entry is never a silent one.
   */
  ignoredByConfig: EnvChange[];
}

/** What {@link diffEnvSnapshots} may be told beyond the two snapshots. */
export interface EnvDiffOptions {
  /**
   * `$HOME` entry names not to count (`options.envCleanIgnoreHomeEntries`).
   * Exact match against the entry's name; applied to the `home-entries` probe
   * only, in both directions. The baseline itself is never edited.
   */
  ignoreHomeEntries?: readonly string[];
}

export interface EnvCleanDiff {
  status: EnvDiffStatus;
  /** What the baseline excused as the task's own session; see {@link readTaskSession}. */
  taskSession: string | null | undefined;
  probes: EnvProbeDiff[];
}

function toChange(entry: EnvEntry, owner: EnvEntryOwner): EnvChange {
  return { key: entry.key, detail: entry.detail, owner };
}

/**
 * Compare two snapshots probe by probe.
 *
 * A probe is compared only when *both* snapshots answered it. One unavailable
 * side makes that probe `unknown`: the alternative — treating the missing side
 * as an empty set — would report every entry as added or removed, which is worse
 * than useless, and treating it as equal would be the fail-open.
 */
export function diffEnvSnapshots(
  baseline: EnvSnapshot,
  final: EnvSnapshot,
  context: EnvAttributionContext,
  options: EnvDiffOptions = {}
): EnvCleanDiff {
  const taskSession = readTaskSession(baseline);
  const otherServerSessions = readOtherServerSessions(baseline);
  const ignoredHomeEntries = new Set(options.ignoreHomeEntries ?? []);
  const probes: EnvProbeDiff[] = ENV_PROBE_IDS.map((probeId) => {
    const before = baseline.probes[probeId];
    const after = final.probes[probeId];

    if (!before || before.status !== 'ok') {
      return {
        probeId,
        status: 'unknown' as const,
        reason: `baseline probe unavailable: ${before?.reason ?? 'not recorded'}`,
        added: [],
        ignoredAdded: [],
        taskSessionAdded: [],
        removed: [],
        removedByOtherServer: [],
        ignoredByConfig: [],
      };
    }
    if (!after || after.status !== 'ok') {
      return {
        probeId,
        status: 'unknown' as const,
        reason: `current probe unavailable: ${after?.reason ?? 'not recorded'}`,
        added: [],
        ignoredAdded: [],
        taskSessionAdded: [],
        removed: [],
        removedByOtherServer: [],
        ignoredByConfig: [],
      };
    }

    const beforeKeys = new Set(before.entries.map((entry) => entry.key));
    const afterKeys = new Set(after.entries.map((entry) => entry.key));

    // Only `home-entries`, and only by the whole name: the same string under
    // `~/.commandmate` is a different directory and stays counted.
    const isIgnoredByConfig = (entry: EnvEntry): boolean =>
      probeId === 'home-entries' && ignoredHomeEntries.has(entry.key);

    const added: EnvChange[] = [];
    const ignoredAdded: EnvChange[] = [];
    const taskSessionAdded: EnvChange[] = [];
    const ignoredByConfig: EnvChange[] = [];
    for (const entry of after.entries) {
      if (beforeKeys.has(entry.key)) continue;
      const owner = attributeEntry(probeId, entry, context);
      if (isIgnoredByConfig(entry)) {
        ignoredByConfig.push(toChange(entry, owner));
        continue;
      }
      if (probeId === 'tmux-sessions' && taskSession && entry.key === taskSession) {
        // Additions only: a task session that existed at task start and is gone
        // falls through to `removed` below like everything else (#1624).
        taskSessionAdded.push(toChange(entry, owner));
        continue;
      }
      (owner === 'other' ? ignoredAdded : added).push(toChange(entry, owner));
    }

    // An excuse for another server's session presumes the tmux server lived
    // through the task. When nothing from the baseline survived and the task's
    // own session is gone too, the likeliest story is `kill-server` (#1624), and
    // every removal is counted.
    const tmuxServerSurvived =
      probeId === 'tmux-sessions' &&
      after.entries.some(
        (entry) => beforeKeys.has(entry.key) || (taskSession !== null && entry.key === taskSession)
      );

    const removed: EnvChange[] = [];
    const removedByOtherServer: EnvChange[] = [];
    for (const entry of before.entries) {
      if (afterKeys.has(entry.key)) continue;
      const change = toChange(entry, attributeEntry(probeId, entry, context));
      if (isIgnoredByConfig(entry)) {
        ignoredByConfig.push(change);
      } else if (
        tmuxServerSurvived &&
        change.owner !== 'self' &&
        otherServerSessions.has(entry.key)
      ) {
        removedByOtherServer.push(change);
      } else {
        removed.push(change);
      }
    }

    return {
      probeId,
      status: added.length + removed.length > 0 ? ('violated' as const) : ('clean' as const),
      reason: null,
      added,
      ignoredAdded,
      taskSessionAdded,
      removed,
      removedByOtherServer,
      ignoredByConfig,
    };
  });

  // A measured violation is a verdict and outranks an unmeasured probe; an
  // unmeasured probe outranks clean. `clean` requires every probe to have been
  // compared and to have matched.
  const status: EnvDiffStatus = probes.some((probe) => probe.status === 'violated')
    ? 'violated'
    : probes.some((probe) => probe.status === 'unknown')
      ? 'unknown'
      : 'clean';

  return { status, taskSession, probes };
}

// =============================================================================
// Reporting
// =============================================================================

/** Violating entries listed per probe before the rest becomes a count. */
export const MAX_REPORTED_ENV_CHANGES = 25;

/**
 * Actionable coda, in the same spirit as SCOPE_ALLOW_GUIDANCE: the change list
 * says what moved but not what to do, and the two directions are genuinely
 * different actions.
 */
export const ENV_CLEAN_GUIDANCE =
  'Anything listed under "+" was started or created during this task and left behind — ' +
  'stop it by PID and remove it. The one exception is a "+" line marked "task session, ' +
  'excused": that is the agent session this delegation itself started, it is not counted, ' +
  'and it must be left running. Anything under "-" existed when the task started and is ' +
  'now gone — it was killed or deleted; restart or restore it. Never stop a process by ' +
  'pattern (`pkill -f`): it takes every process whose command line matches, which is how ' +
  'the production server was stopped in #1739.';

function formatChanges(sign: string, changes: EnvChange[]): string[] {
  const listed = changes.slice(0, MAX_REPORTED_ENV_CHANGES);
  const remainder = changes.length - listed.length;
  const lines = listed.map((change) => {
    const detail = change.detail ? ` ${change.detail}` : '';
    return `    ${sign} ${change.key}${detail} [${change.owner}]`;
  });
  if (remainder > 0) lines.push(`    ... and ${remainder} more`);
  return lines;
}

/**
 * The excused task session, listed rather than dropped (#2472): a verdict that
 * silently discounted a session would read exactly like one that never saw it.
 */
function formatTaskSessionChanges(changes: EnvChange[]): string[] {
  return changes.map((change) => {
    const detail = change.detail ? ` ${change.detail}` : '';
    return `    + ${change.key}${detail} [task session, excused]`;
  });
}

/**
 * `home-entries` changes dropped by `options.envCleanIgnoreHomeEntries`, on one
 * line (#2890). Listed rather than dropped for the reason the excused task
 * session is: a verdict that silently discounted an entry would read exactly
 * like one that never saw it.
 */
/** Removals excused as another CommandMate server's sessions (#2627), one line each. */
function formatRemovedByOtherServer(changes: EnvChange[]): string[] {
  return changes.map(
    (change) =>
      `    · - ${change.key} (ignored: another CommandMate server's session, recorded at task start)`
  );
}

function formatIgnoredByConfig(changes: EnvChange[]): string[] {
  if (changes.length === 0) return [];
  const names = changes.map((change) => change.key).join(', ');
  return [`    ignored (options.envCleanIgnoreHomeEntries): ${names}`];
}

/**
 * The header's account of what could be excused, so a report judged against a
 * baseline written before #2472 says why the task's own session was not.
 */
function describeTaskSession(taskSession: string | null | undefined): string {
  if (taskSession === undefined) return 'unrecorded (baseline predates #2472; nothing excused)';
  if (taskSession === null) return 'unresolved (nothing excused)';
  return taskSession;
}

/** Render a diff for `log_tail`. */
export function formatEnvCleanReport(diff: EnvCleanDiff): string {
  const lines: string[] = [];
  for (const probe of diff.probes) {
    const label = ENV_PROBE_LABELS[probe.probeId];
    if (probe.status === 'unknown') {
      lines.push(`  ${probe.probeId} UNKNOWN (${label}): ${probe.reason ?? 'no reason recorded'}`);
      continue;
    }
    if (probe.status === 'clean') {
      const excused =
        probe.ignoredAdded.length > 0
          ? ` (${probe.ignoredAdded.length} addition(s) attributed to another worktree)`
          : '';
      lines.push(`  ${probe.probeId} clean (${label})${excused}`);
      lines.push(...formatTaskSessionChanges(probe.taskSessionAdded));
      lines.push(...formatRemovedByOtherServer(probe.removedByOtherServer));
      lines.push(...formatIgnoredByConfig(probe.ignoredByConfig));
      continue;
    }
    lines.push(
      `  ${probe.probeId} VIOLATED (${label}): +${probe.added.length} -${probe.removed.length}`
    );
    lines.push(...formatChanges('+', probe.added));
    lines.push(...formatChanges('-', probe.removed));
    lines.push(...formatTaskSessionChanges(probe.taskSessionAdded));
    lines.push(...formatRemovedByOtherServer(probe.removedByOtherServer));
    lines.push(...formatIgnoredByConfig(probe.ignoredByConfig));
    for (const excused of probe.ignoredAdded) {
      lines.push(`    · ${excused.key} (ignored: belongs to another worktree)`);
    }
  }
  return lines.join('\n');
}

// =============================================================================
// Gate evaluation
// =============================================================================

/**
 * Why the gate could not reach a verdict at all, phrased for `log_tail`.
 *
 * Spelled out rather than reduced to "no baseline" because the reader's next
 * question is always "so how do I get one", and the answer — the baseline is
 * recorded when the task is created, and only when the gate is switched on — is
 * not guessable from the failure.
 */
export function envCleanNoBaseline(taskId: string | null, sources: string[]): string {
  const who = taskId ? `task ${taskId}` : 'this run';
  const how = sources.length > 0 ? sources.join(' and ') : 'nothing';
  return (
    `${ENV_CLEAN_GATE_ID}: UNKNOWN — no baseline snapshot exists for ${who}, so nothing can be ` +
    'compared. This is NOT "the environment is unchanged": no measurement was taken. ' +
    'A baseline is recorded when the task is created (`send --contract`) and only while the ' +
    `gate is switched on (currently: ${how}). Switch it on, then re-send the task.`
  );
}

export interface EvaluateEnvCleanInput extends EnvAttributionContext {
  /** Task the baseline belongs to; null when the run has no task at all. */
  taskId: string | null;
  /** Baseline recorded at task creation, or null when there is none. */
  baseline: EnvSnapshot | null;
  /** Declarations that switched the gate on, for the no-baseline message. */
  sources: string[];
  /**
   * `options.envCleanIgnoreHomeEntries` from verify.yaml (#2890): `$HOME` entry
   * names the comparison does not count. Passed through to
   * {@link diffEnvSnapshots}; omitted means nothing is ignored.
   */
  ignoreHomeEntries?: readonly string[];
  /** Injected by tests; defaults to probing the real machine. */
  capture?: () => Promise<EnvSnapshot>;
}

/**
 * Judge the machine against the task's baseline.
 *
 * `passed` requires every probe to have been compared and matched. `failed`
 * means a violation was measured. `error` means no verdict could be reached —
 * either there is no baseline or a probe would not answer — and it is
 * deliberately not `skipped`: a skip reads as "there was nothing to judge",
 * which is the sentence this gate must never say about an unmeasured machine.
 */
export async function evaluateEnvClean(input: EvaluateEnvCleanInput): Promise<EnvCleanOutcome> {
  const startedAt = Date.now();
  const done = (
    status: VerificationGateTerminalStatus,
    logTail: string,
    exitCode: number | null
  ): EnvCleanOutcome => ({
    status,
    exitCode,
    startedAt,
    durationMs: Date.now() - startedAt,
    logTail,
  });

  if (!input.baseline) {
    return done('error', envCleanNoBaseline(input.taskId, input.sources), null);
  }

  const capture =
    input.capture ?? (() => captureEnvSnapshot({ worktreeId: input.worktreeId }));

  let final: EnvSnapshot;
  try {
    final = await capture();
  } catch (error) {
    return done(
      'error',
      `${ENV_CLEAN_GATE_ID}: UNKNOWN — the current snapshot could not be taken: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      null
    );
  }

  const diff = diffEnvSnapshots(input.baseline, final, input, {
    ignoreHomeEntries: input.ignoreHomeEntries,
  });
  const header =
    `${ENV_CLEAN_GATE_ID}: baseline=${new Date(input.baseline.capturedAt).toISOString()} ` +
    `status=${diff.status} task-session=${describeTaskSession(diff.taskSession)}`;
  const report = `${header}\n${formatEnvCleanReport(diff)}`;

  if (diff.status === 'clean') return done('passed', report, 0);
  if (diff.status === 'unknown') {
    return done(
      'error',
      `${report}\nUNKNOWN is not a pass: at least one probe could not be compared, so the ` +
        'environment was not measured.',
      null
    );
  }
  return done('failed', `${report}\n${ENV_CLEAN_GUIDANCE}`, 1);
}
