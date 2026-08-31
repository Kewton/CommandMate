/**
 * Selected Agents Validator
 * Issue #368: Validation and parsing for worktree selected_agents field
 *
 * Provides:
 * - validateAgentsPair(): Core validation logic (R1-001)
 * - resolveSelectedAgents(): the ONE place the fallback order lives (Issue #2065)
 * - parseSelectedAgents(): DB read with fallback + console.warn (R4-005 log sanitization)
 * - validateSelectedAgentsInput(): API input validation
 */

import { CLI_TOOL_IDS, type CLIToolType } from './cli-tools/types';

/** Minimum number of selected agents */
export const MIN_SELECTED_AGENTS = 2;

/** Maximum number of selected agents (PC can select up to 6, Issue #989) */
export const MAX_SELECTED_AGENTS = 6;

/**
 * Compiled-in last resort for a worktree's agent list.
 * Issue #1516: narrowed to the 3 agents in routine use (claude/codex/antigravity).
 * The others stay selectable via CLI_TOOL_IDS — they are just not preselected.
 *
 * Issue #2065: this is no longer the only answer. It is the LOWEST layer of
 * `resolveSelectedAgents()` — the value a fresh install with no `app_settings`
 * row still gets, which is why the acceptance criterion "an environment with no
 * setting behaves exactly as before" reduces to "this constant is unchanged".
 */
export const DEFAULT_SELECTED_AGENTS: CLIToolType[] = ['claude', 'codex', 'antigravity'];

/**
 * Core validation function for CLI tool ID arrays (R1-001)
 * Accepts 2-6 unique valid CLI tool IDs (Issue #836 raised it to 5, #989 to 6).
 * Shared between parseSelectedAgents() and validateSelectedAgentsInput()
 *
 * @param input - Array of values to validate
 * @returns Validation result with optional typed value or error message
 */
export function validateAgentsPair(input: unknown[]): {
  valid: boolean;
  value?: CLIToolType[];
  error?: string;
} {
  if (input.length < MIN_SELECTED_AGENTS || input.length > MAX_SELECTED_AGENTS) {
    return { valid: false, error: `Must be ${MIN_SELECTED_AGENTS}-${MAX_SELECTED_AGENTS} elements` };
  }
  if (!input.every(id => typeof id === 'string' && (CLI_TOOL_IDS as readonly string[]).includes(id))) {
    return { valid: false, error: 'Invalid CLI tool ID' };
  }
  if (new Set(input).size !== input.length) {
    return { valid: false, error: 'Duplicate tool IDs not allowed' };
  }
  return { valid: true, value: input as CLIToolType[] };
}

/**
 * The layers that can answer "which agents does this worktree show", highest
 * priority first (Issue #2065).
 *
 * This array IS the priority order — `resolveSelectedAgents()` walks it in
 * sequence and nothing else encodes it. The final shape the Epic is heading for
 * is `worktree -> repo file -> app_settings -> constant`; #2065 populated the
 * `worktree` and `appSettings` layers and declared `repo` without ever passing
 * it a value.
 *
 * Issue #2066 filled `repo` in, exactly as that comment foresaw: by supplying a
 * value at the call sites (`getWorktrees` / `getWorktreeById` /
 * `resolveAgentInstances`, each from `getRepoDefaultSelectedAgents()` in
 * `@/lib/repo-config/agents-config`), and NOT by re-deriving an order. This
 * array is still the only place the order is written down, and the function
 * below is unchanged.
 *
 * A layer whose value is absent, malformed, or fails `validateAgentsPair()` is
 * skipped rather than fatal: a hand-edited `app_settings` row must not be able
 * to make every worktree in the sidebar render an empty tab strip.
 */
export const SELECTED_AGENTS_LAYERS = ['worktree', 'repo', 'appSettings'] as const;

/** One of the layers in {@link SELECTED_AGENTS_LAYERS}. */
export type SelectedAgentsLayer = (typeof SELECTED_AGENTS_LAYERS)[number];

/**
 * Candidate values per layer. Every field is optional and every field is
 * `unknown[]`-typed on purpose: two of the three layers are user-editable
 * storage (a DB column, a repository file), so the values arrive untrusted and
 * are validated here rather than at each call site.
 */
export type SelectedAgentsLayerValues = Partial<
  Record<SelectedAgentsLayer, readonly unknown[] | null | undefined>
>;

/**
 * Resolve a worktree's agent list from the layers, in priority order.
 *
 * The ONE place the fallback order lives (Issue #2065). Every fallback — server
 * or client, roster seed or tab seed — goes through this function so a new layer
 * is a change to `SELECTED_AGENTS_LAYERS` plus a value at the call sites, and
 * never a second copy of the order.
 *
 * @param layers - Candidate values keyed by layer; omit a layer you cannot answer for
 * @returns The first layer that validates, else {@link DEFAULT_SELECTED_AGENTS}
 */
export function resolveSelectedAgents(
  layers: SelectedAgentsLayerValues = {},
): CLIToolType[] {
  for (const layer of SELECTED_AGENTS_LAYERS) {
    const candidate = layers[layer];
    if (candidate == null) continue;
    const result = validateAgentsPair([...candidate]);
    if (result.valid) return result.value!;
  }
  return DEFAULT_SELECTED_AGENTS;
}

/**
 * Parse selected_agents JSON from DB with safe fallback
 * Returns the resolved default for any invalid input (never throws)
 *
 * Log output is sanitized (R4-005): ANSI stripped, newlines removed, truncated.
 *
 * Issue #2065: the fallback is no longer the constant but
 * `resolveSelectedAgents()`, so a row with no `selected_agents` (every worktree
 * created by scan/sync — `upsertWorktree` never writes the column) picks up the
 * `app_settings` default. Callers that have a `db` handle pass
 * `appSettingsDefault`; callers that do not (unit fixtures, pure helpers) omit
 * it and get exactly the pre-#2065 behaviour.
 *
 * Issue #2066 adds `repoDefault`, the repository's own `.commandmate/agents.yaml`
 * declaration. It is LAST in the parameter list and SECOND in priority — the
 * order the layers resolve in lives in {@link SELECTED_AGENTS_LAYERS} and
 * nowhere else, so an argument position is free to be chosen for what it is
 * good for: every existing two-argument call keeps its meaning unchanged, which
 * is what makes "an environment with no file behaves exactly as before" a
 * property of the signature rather than of a review.
 *
 * @param raw - Raw JSON string from DB (or null)
 * @param appSettingsDefault - Server-wide default from `app_settings`, or null/undefined when unset
 * @param repoDefault - Repository declaration from `.commandmate/agents.yaml`, or null/undefined when absent/invalid
 * @returns Validated array of 2-6 CLIToolType values
 */
export function parseSelectedAgents(
  raw: string | null,
  appSettingsDefault?: CLIToolType[] | null,
  repoDefault?: CLIToolType[] | null,
): CLIToolType[] {
  let fromRow: unknown[] | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // A non-array (or a JSON parse error) is treated the same as an absent
      // column: skip the layer silently and let the lower ones answer.
      if (Array.isArray(parsed)) fromRow = parsed;
    } catch {
      // JSON parse error - fall through to the lower layers
    }
  }
  return resolveSelectedAgents({
    worktree: fromRow,
    repo: repoDefault,
    appSettings: appSettingsDefault,
  });
}

/**
 * Validate selectedAgents input from API request body
 * Returns structured error for API error responses (does not fallback)
 *
 * @param input - Raw input from request body (unknown type for safety)
 * @returns Validation result with typed value or error string
 */
export function validateSelectedAgentsInput(input: unknown): {
  valid: boolean;
  value?: CLIToolType[];
  error?: string;
} {
  if (!Array.isArray(input) || input.length < MIN_SELECTED_AGENTS || input.length > MAX_SELECTED_AGENTS) {
    return { valid: false, error: `selected_agents must be an array of ${MIN_SELECTED_AGENTS}-${MAX_SELECTED_AGENTS} elements` };
  }
  return validateAgentsPair(input);
}
