/**
 * The reason vocabulary a status verdict can carry.
 *
 * Split out of `status-detector.ts` by Issue #1927 for a mechanical reason: the
 * facade now imports the per-tool detectors, and every tool module needs these
 * constants, so leaving them in the facade made the graph
 * `status-detector -> tools/* -> status-detector` — a cycle that resolves to
 * `undefined` at module-evaluation time rather than to a value. A leaf module
 * with no imports of its own cannot participate in one.
 *
 * Re-exported from `status-detector.ts`, which is where every existing importer
 * reads it from.
 */

/**
 * Reason string constants for StatusDetectionResult.reason.
 * Shared between status-detector.ts and current-output/route.ts to prevent typos (DR2-003).
 */
export const STATUS_REASON = {
  PROMPT_DETECTED: 'prompt_detected',
  THINKING_INDICATOR: 'thinking_indicator',
  OPENCODE_PROCESSING_INDICATOR: 'opencode_processing_indicator',
  OPENCODE_SELECTION_LIST: 'opencode_selection_list',
  /** Issue #1893: opencode's permission dialog — an arrow-key button strip. */
  OPENCODE_PERMISSION_PROMPT: 'opencode_permission_prompt',
  CLAUDE_SELECTION_LIST: 'claude_selection_list',
  COPILOT_SELECTION_LIST: 'copilot_selection_list',
  CODEX_SELECTION_LIST: 'codex_selection_list',
  /** Issue #1017: Codex pager / edit-previous (transcript) mode. */
  CODEX_PAGER: 'codex_pager',
  /** Issue #1829: Codex's hooks review screens, which only `t`/`esc` leave. */
  CODEX_HOOKS_REVIEW: 'codex_hooks_review',
  ANTIGRAVITY_SELECTION_LIST: 'antigravity_selection_list',
  OPENCODE_RESPONSE_COMPLETE: 'opencode_response_complete',
  INPUT_PROMPT: 'input_prompt',
  NO_RECENT_OUTPUT: 'no_recent_output',
  /**
   * A tool's own detector looked at this frame and recognised nothing
   * (Issue #1927, §6.1).
   *
   * Distinct from {@link STATUS_REASON.DEFAULT} on purpose, and the distinction
   * is operational rather than cosmetic. `default` is the generic floor: no
   * pattern matched anywhere, including the shared composer check, so nothing
   * in particular is missing. `unknown_frame` is what a tool that OPTS OUT of
   * the shared composer check reports — copilot and opencode, whose own rules
   * are the only rules that run for them. Seeing it means "this tool's measured
   * rules could not read this frame", which names an action: capture the frame
   * and add it to that tool's fixtures.
   *
   * Both are `running` on the wire with `evidence: 'none'`, so a consumer that
   * does not care about the difference sees no change.
   */
  UNKNOWN_FRAME: 'unknown_frame',
  DEFAULT: 'default',
} as const;
