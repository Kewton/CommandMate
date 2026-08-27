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
  /**
   * Issue #2112: a background-painted rectangle with an `esc` hatch was drawn
   * over the transcript — opencode's session list, agent list, timeline,
   * command palette or picker.
   *
   * Distinct from {@link STATUS_REASON.OPENCODE_SELECTION_LIST} because the two
   * are different READINGS of the same screen: that one is the allowlisted
   * heading (`Select model` / `Select provider` / `Connect a provider`, #1896)
   * found as text and survives ANSI stripping; this one is the layout and needs
   * the SGR the capture was taken with. An operator reading `capture --json`
   * can tell which one answered, which is the difference between "the heading is
   * one we know" and "something modal is on the pane".
   *
   * The literal is restated from `OPENCODE_MODAL_OVERLAY_ID`
   * (`lib/detection/opencode-modal-overlay.ts`) rather than imported, so this
   * module keeps the no-imports property its docblock above depends on;
   * `tests/unit/detection-opencode-modal-overlay-2112.test.ts` pins the two
   * equal so the restatement cannot drift.
   */
  OPENCODE_MODAL_OVERLAY: 'opencode_modal_overlay',
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
