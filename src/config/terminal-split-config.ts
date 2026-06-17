/**
 * Terminal split configuration (Issue #728)
 *
 * Defines constants, storage key helpers, and a stale-state validation guard
 * for the PC-only 1-3 horizontal terminal split feature.
 *
 * Persistence is worktree-scoped (one entry per worktreeId). The mobile path
 * does not consume this config — only the WorktreeDetailRefactored PC branch.
 */

import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';

/** Minimum number of splits in the PC terminal area. */
export const MIN_SPLITS = 1;

/** Maximum number of splits in the PC terminal area. */
export const MAX_SPLITS = 3;

/** localStorage key prefix; full key is `${prefix}${worktreeId}`. */
export const TERMINAL_SPLITS_STORAGE_KEY_PREFIX = 'commandmate:terminalSplits:';

/**
 * Single split entry: which agent instance is rendered in this slot.
 *
 * Issue #869: a slot is now identified by an `instanceId` (the tab/split
 * identity) in addition to the backing `cliToolId` (which still drives
 * cliTool-keyed concerns such as auto-yes and status). For the primary instance
 * `instanceId === cliToolId`, so pre-#869 single-instance behavior is unchanged.
 */
export interface TerminalSplitEntry {
  cliToolId: CLIToolType;
  instanceId: string;
}

/**
 * Persisted terminal-split configuration.
 *
 * Invariants enforced by `isValidSplitConfig`:
 * - `splits.length` in `[MIN_SPLITS, MAX_SPLITS]`
 * - `widths.length === splits.length`
 * - each `widths[i]` is a finite number > 0
 */
export interface TerminalSplitConfig {
  splits: TerminalSplitEntry[];
  widths: number[];
}

/** Default config used both as initial state and stale-state fallback. */
export const DEFAULT_SPLIT_CONFIG: TerminalSplitConfig = {
  splits: [{ cliToolId: 'claude', instanceId: 'claude' }],
  widths: [1],
};

const KNOWN_CLI_IDS = new Set<string>(CLI_TOOL_IDS);

/** Build the worktree-scoped localStorage key for a given worktreeId. */
export function getTerminalSplitsStorageKey(worktreeId: string): string {
  return `${TERMINAL_SPLITS_STORAGE_KEY_PREFIX}${worktreeId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Defensive type guard. Rejects any input that does not exactly match the
 * `TerminalSplitConfig` invariants. Used by `useTerminalSplits` to discard
 * stale or externally-edited localStorage payloads.
 */
export function isValidSplitConfig(value: unknown): value is TerminalSplitConfig {
  if (!isRecord(value)) return false;

  const { splits, widths } = value;

  if (!Array.isArray(splits) || !Array.isArray(widths)) return false;
  if (splits.length < MIN_SPLITS || splits.length > MAX_SPLITS) return false;
  if (widths.length !== splits.length) return false;

  for (const entry of splits) {
    if (!isRecord(entry)) return false;
    const cli = entry.cliToolId;
    if (typeof cli !== 'string' || !KNOWN_CLI_IDS.has(cli)) return false;
    const instanceId = entry.instanceId;
    if (typeof instanceId !== 'string' || !isValidInstanceId(instanceId)) return false;
  }

  for (const w of widths) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return false;
  }

  return true;
}

/**
 * Normalize a persisted split payload to the current shape (Issue #869).
 *
 * Migrates pre-#869 entries (which only carried `cliToolId`) by deriving
 * `instanceId = cliToolId` (the primary instance). Returns a fully-formed,
 * validated `TerminalSplitConfig`, or `null` when the payload cannot be
 * salvaged. Roster cross-checks (does the instanceId still exist?) happen in
 * `useTerminalSplits`, which owns the live roster.
 */
export function normalizeSplitConfig(value: unknown): TerminalSplitConfig | null {
  if (!isRecord(value)) return null;

  const { splits, widths } = value;
  if (!Array.isArray(splits) || !Array.isArray(widths)) return null;
  if (splits.length < MIN_SPLITS || splits.length > MAX_SPLITS) return null;
  if (widths.length !== splits.length) return null;

  const normalizedSplits: TerminalSplitEntry[] = [];
  for (const entry of splits) {
    if (!isRecord(entry)) return null;
    const cli = entry.cliToolId;
    if (typeof cli !== 'string' || !KNOWN_CLI_IDS.has(cli)) return null;
    const rawInstanceId = entry.instanceId;
    const instanceId =
      typeof rawInstanceId === 'string' && isValidInstanceId(rawInstanceId)
        ? rawInstanceId
        : cli; // legacy migration: primary instance (instanceId === cliToolId)
    normalizedSplits.push({ cliToolId: cli as CLIToolType, instanceId });
  }

  for (const w of widths) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return null;
  }

  return { splits: normalizedSplits, widths: widths as number[] };
}
