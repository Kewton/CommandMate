/**
 * Terminal split configuration (Issue #728)
 *
 * Defines constants, storage key helpers, and a stale-state validation guard
 * for the PC-only 1-3 horizontal terminal split feature.
 *
 * Persistence is worktree-scoped (one entry per worktreeId). The mobile path
 * does not consume this config — only the WorktreeDetailRefactored PC branch.
 */

import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

/** Minimum number of splits in the PC terminal area. */
export const MIN_SPLITS = 1;

/** Maximum number of splits in the PC terminal area. */
export const MAX_SPLITS = 3;

/** localStorage key prefix; full key is `${prefix}${worktreeId}`. */
export const TERMINAL_SPLITS_STORAGE_KEY_PREFIX = 'commandmate:terminalSplits:';

/** Single split entry: which CLI tool is rendered in this slot. */
export interface TerminalSplitEntry {
  cliToolId: CLIToolType;
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
  splits: [{ cliToolId: 'claude' }],
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
  }

  for (const w of widths) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return false;
  }

  return true;
}
