/**
 * OpenCode V2's own words for the three approval verdicts (Issue #2945 D1).
 *
 * The shared list (`STRUCTURED_DECISION_OPTIONS` in `lib/session/structured-prompt`)
 * is v1's: `Allow once` / `Allow always` / `Reject`. OpenCode V2's TUI draws
 * `Allow once   Always allow   Reject` (measured on 2.0.18, #2370 Phase 0) — the
 * middle words the other way round — and a card that says one thing while the
 * pane beside it says another makes the operator stop and check which is right.
 * So the surfaces show v2's words for a v2 approval, keyed by the wire reply
 * (`once` / `always` / `reject`), which is what the number still sends.
 *
 * A pure module with no imports, so the browser bundle can read it.
 *
 * @module lib/hooks/sources/opencode-v2/decision-labels
 */

/** Label per wire reply, in the order v2's TUI draws them. Untranslated, as v1's are. */
export const OPENCODE_V2_DECISION_LABELS: Readonly<Record<string, string>> = {
  once: 'Allow once',
  always: 'Always allow',
  reject: 'Reject',
};
