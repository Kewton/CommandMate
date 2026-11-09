/**
 * The prompts to update mem (Issue #4226, design `docs/design/mem-prompt-4226.md` §3).
 *
 * Shared by the server (`src/lib/mem-suggest/**`, the route) and the CLI
 * (`commandmate mem check --suggest`). Holds no runtime besides constants, so the CLI
 * build can import it.
 *
 * @module types/mem-suggest
 */

import type { MemMode } from './mem';

/**
 * Every rule, in the order the quiet line lists them (§3.2). One table: the text,
 * `--json`, `--quiet` and the tests read it.
 */
export const MEM_SUGGEST_CODES = [
  'now_missing',
  'now_stale',
  'now_condition_met',
  'decision_unreflected',
  'manual_stale',
  'open_count',
  'ref_unknown',
  'evidence_missing',
  'decision_no_destination',
] as const;
export type MemSuggestCode = (typeof MEM_SUGGEST_CODES)[number];

/** The rules `--quiet` applies: those that need no query of the conditions (§3.2, the column "quiet"). */
export const MEM_SUGGEST_QUIET_CODES: readonly MemSuggestCode[] = [
  'now_missing',
  'now_stale',
  'decision_unreflected',
  'manual_stale',
  'open_count',
  'evidence_missing',
  'decision_no_destination',
];

/** The point a quiet call was made at (`--hook <event>`). Logged and echoed; it changes no rule (§3.1). */
export const MEM_SUGGEST_HOOK_EVENTS = ['session_start', 'pre_compact', 'turn_end', 'manual'] as const;
export type MemSuggestHookEvent = (typeof MEM_SUGGEST_HOOK_EVENTS)[number];

export function isMemSuggestHookEvent(value: unknown): value is MemSuggestHookEvent {
  return typeof value === 'string' && (MEM_SUGGEST_HOOK_EVENTS as readonly string[]).includes(value);
}

/** Why a rule was not applied (it is no prompt: `--json` only, exit unchanged). */
export const MEM_SUGGEST_SKIP_REASONS = [
  'no_instance',
  'quiet_no_query',
  'record_gone',
  'withheld',
  'version_changed',
  'branches_unknown',
] as const;
export type MemSuggestSkipReason = (typeof MEM_SUGGEST_SKIP_REASONS)[number];

/** Why a request answered nothing because the state moved under it (§3.5・§3.6). */
export const MEM_SUGGEST_DISCARD_REASONS = [
  'mode',
  'prompt_off',
  'instance_lifetime',
  'worktree_lifetime',
  'branch',
  'membership',
  'registration',
  'boundary',
  'deadline',
] as const;
export type MemSuggestDiscardReason = (typeof MEM_SUGGEST_DISCARD_REASONS)[number];

export interface MemSuggestion {
  code: MemSuggestCode;
  itemIds: string[];
  versions: number[];
  fingerprint: string;
  /** Recorded as shown to this instance (quiet's record). `--suggest` shows it either way. */
  shown: boolean;
  /** Fixed wording per code: never an item's text, a branch name or free input. */
  message: string;
  command: string | null;
}

export interface MemSuggestSkipped {
  /** `all`: nothing was judged (the branch listing failed). */
  code: MemSuggestCode | 'all';
  reason: MemSuggestSkipReason;
  itemId?: string;
}

/** `POST /api/worktrees/:id/mem/suggest`. */
export interface MemSuggestResponse {
  ok: true;
  /** null: answered before the mode was read (no identity on a quiet call). */
  mode: MemMode | null;
  /** The branch as the brief's exit shows it (`sanitizeBranch`); null when detached or replaced. */
  branch: string | null;
  instanceId: string | null;
  full: boolean;
  hook: MemSuggestHookEvent | null;
  suggestions: MemSuggestion[];
  skipped: MemSuggestSkipped[];
  discarded: MemSuggestDiscardReason | null;
  /** Set when `promptOnEvents` is off: nothing is prompted, explicit or quiet (§3.1). */
  disabledBy?: 'promptOnEvents';
  /** quiet: the one line for the new prompts, or null when there are none. */
  quietLine?: string | null;
}
