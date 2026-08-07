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
 *      the pkill (#1739) and `kill-server` (#1624) case. New things are a
 *      violation *unless they are attributable to another worker*, because
 *      parallel delegations legitimately start their own sessions and servers
 *      inside each other's measurement windows.
 *
 * Server-only: consumes snapshots produced by env-snapshot.
 *
 * @module lib/verification/env-clean-gate
 */

import { dirname, resolve, sep } from 'path';
import type { VerificationGateTerminalStatus } from '@/lib/db';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { TaskContract } from '@/lib/tasks/contract-parser';
import {
  captureEnvSnapshot,
  ENV_PROBE_IDS,
  ENV_PROBE_LABELS,
  MCBD_SESSION_PREFIX,
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

/** CLI tool ids, longest first: `vibe-local` must not be stripped as `vibe`. */
const CLI_PREFIXES = [...CLI_TOOL_IDS].sort((a, b) => b.length - a.length);

/**
 * Attribute an `mcbd-<cli>-<worktreeId>[-suffix]` session name to a worktree.
 *
 * Ambiguity resolves towards `self` on purpose. Worktree ids may contain
 * hyphens, so `mcbd-claude-foo-bar` is genuinely ambiguous between worktree
 * `foo` with suffix `bar` and worktree `foo-bar`; calling it `self` makes an
 * addition a violation, and being wrong in that direction costs a false report
 * rather than a missed leak.
 */
export function attributeSessionName(name: string, worktreeId: string): EnvEntryOwner {
  if (!name.startsWith(MCBD_SESSION_PREFIX)) return 'unattributed';
  const rest = name.slice(MCBD_SESSION_PREFIX.length);
  const cli = CLI_PREFIXES.find((id) => rest.startsWith(`${id}-`));
  if (!cli) return 'unattributed';
  const tail = rest.slice(cli.length + 1);
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
  /** Entries that existed at task start and are gone. Always violations. */
  removed: EnvChange[];
}

export interface EnvCleanDiff {
  status: EnvDiffStatus;
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
  context: EnvAttributionContext
): EnvCleanDiff {
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
        removed: [],
      };
    }
    if (!after || after.status !== 'ok') {
      return {
        probeId,
        status: 'unknown' as const,
        reason: `current probe unavailable: ${after?.reason ?? 'not recorded'}`,
        added: [],
        ignoredAdded: [],
        removed: [],
      };
    }

    const beforeKeys = new Set(before.entries.map((entry) => entry.key));
    const afterKeys = new Set(after.entries.map((entry) => entry.key));

    const added: EnvChange[] = [];
    const ignoredAdded: EnvChange[] = [];
    for (const entry of after.entries) {
      if (beforeKeys.has(entry.key)) continue;
      const owner = attributeEntry(probeId, entry, context);
      (owner === 'other' ? ignoredAdded : added).push(toChange(entry, owner));
    }

    const removed = before.entries
      .filter((entry) => !afterKeys.has(entry.key))
      .map((entry) => toChange(entry, attributeEntry(probeId, entry, context)));

    return {
      probeId,
      status: added.length + removed.length > 0 ? ('violated' as const) : ('clean' as const),
      reason: null,
      added,
      ignoredAdded,
      removed,
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

  return { status, probes };
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
  'stop it by PID and remove it. Anything under "-" existed when the task started and is ' +
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
      continue;
    }
    lines.push(
      `  ${probe.probeId} VIOLATED (${label}): +${probe.added.length} -${probe.removed.length}`
    );
    lines.push(...formatChanges('+', probe.added));
    lines.push(...formatChanges('-', probe.removed));
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

  const diff = diffEnvSnapshots(input.baseline, final, input);
  const header =
    `${ENV_CLEAN_GATE_ID}: baseline=${new Date(input.baseline.capturedAt).toISOString()} ` +
    `status=${diff.status}`;
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
