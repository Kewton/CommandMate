/**
 * Pure expectations for the opencode canary scenarios (Issue #2050).
 *
 * Same contract as `expectations.ts`: every export here is a predicate over an
 * {@link Observation}, so `npm run test:unit` can replay them against the
 * committed frames with no tmux, no opencode and no provider spend
 * (`tests/unit/canary/canary-opencode-2050.test.ts`), while `npm run canary
 * -- --tool opencode` supplies the same predicates with LIVE frames.
 *
 * ## Each expectation makes TWO independent statements
 *
 * 1. **the production verdict** — what `detectSessionStatus(frame, 'opencode')`
 *    concluded, including `evidence`. The evidence check is not decoration: it
 *    is design rule D1 (`docs/design/multi-agent-state-architecture.md` §4 D1)
 *    written as an assertion. A detector that lost branch A0/A/C/D/E and fell
 *    through to a heuristic would still answer `running` or `ready` for some of
 *    these frames — but with `evidence: 'none'`, which is exactly the
 *    "vocabulary changed, so `ready` came back" failure #1894 documents.
 * 2. **a structural fact about the frame**, spelled out HERE rather than
 *    imported from `cli-patterns.ts`. That is deliberate: if the frame-side
 *    check reused the detector's own constant, breaking that constant would
 *    move both halves of the assertion at once and the scenario could not say
 *    whether it had reached the state at all. Each anchor below is therefore a
 *    row the status branches do NOT read — the dialog's `△ Permission required`
 *    heading (the branch reads the button strip), the picker's
 *    `Connect provider ctrl+a` hint row (the branch reads the `Select model`
 *    header), the busy footer's spinner cell (the branch reads `esc interrupt`).
 *
 * `hasTaskPanel` in `expectations.ts` is the same idea for claude's #1708 shape.
 */

import { STATUS_REASON } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/ansi';
import type { Expectation, Observation, StartupOverlay } from './types';

/**
 * opencode's permission dialog HEADING — `┃  △ Permission required`.
 *
 * Measured on 1.18.22 at 80x200. `OPENCODE_PERMISSION_PATTERN` deliberately does
 * NOT anchor on this row (its docblock: a heading is not an affordance, and it
 * survives into the `ctrl+f` fullscreen view whose key handling was never
 * measured), which is what makes it usable here as an independent witness that
 * the dialog was really on screen.
 */
export const OPENCODE_PERMISSION_HEADING_PATTERN = /△\s*Permission required/;

/**
 * The hint row opencode draws under the `/models` picker:
 * `Connect provider ctrl+a  Favorite ctrl+f`.
 *
 * A different row from the `Select model … esc` header
 * `OPENCODE_SELECTION_LIST_PATTERN` matches, and — note the missing `a` —
 * distinct from the `Connect a provider` overlay header that means the throwaway
 * HOME has no credential at all.
 */
export const OPENCODE_PICKER_HINT_PATTERN = /Connect provider\s+ctrl\+a\s+Favorite\s+ctrl\+f/;

/**
 * The 8-cell spinner opencode paints to the left of its busy footer.
 *
 * Measured in both footer spellings: `⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt` and
 * `⬝■■■■■■⬝  esc again to interrupt` (#1894). The status branch reads the
 * `esc interrupt` words, never these glyphs.
 */
export const OPENCODE_BUSY_SPINNER_PATTERN = /[⬝■]{4,}/;

/**
 * The finished-turn marker as a frame-content claim: a `▣` row that carries a
 * duration.
 *
 * Intentionally looser than `OPENCODE_TURN_COMPLETE_PATTERN` (which pins the
 * action word and the model segment): this says "a completed step is on the
 * screen", the verdict half says "and the detector read it".
 */
export const OPENCODE_TURN_MARKER_PATTERN = /▣[^\n]*·[^\n]*\b\d+(?:\.\d+)?s\b/;

/** The busy footer's words, as a frame-content claim. */
const OPENCODE_BUSY_FOOTER_PATTERN = /esc (?:again to )?interrupt/;

function clean(observation: Observation): string {
  return stripAnsi(observation.frame);
}

/** True when the frame shows opencode's permission dialog heading. */
export function hasOpenCodePermissionHeading(observation: Observation): boolean {
  return OPENCODE_PERMISSION_HEADING_PATTERN.test(clean(observation));
}

/** True when the frame shows the `/models` picker's own hint row. */
export function hasOpenCodePickerHint(observation: Observation): boolean {
  return OPENCODE_PICKER_HINT_PATTERN.test(clean(observation));
}

/** True when the frame shows a busy footer (either spelling) with its spinner. */
export function hasOpenCodeBusyFooter(observation: Observation): boolean {
  const text = clean(observation);
  return OPENCODE_BUSY_FOOTER_PATTERN.test(text) && OPENCODE_BUSY_SPINNER_PATTERN.test(text);
}

/** True when the frame shows a `▣ … · <duration>` finished-step row. */
export function hasOpenCodeTurnMarker(observation: Observation): boolean {
  return OPENCODE_TURN_MARKER_PATTERN.test(clean(observation));
}

/**
 * Scenario 1 — the idle composer on the boot screen (branch E, Issue #1883).
 *
 * `Ask anything...` behind the input box's gutter is POSITIVE evidence that the
 * buffer is empty, which is why `evidence` is asserted: reading `ready` off the
 * mere absence of a busy marker is the inference D1 forbids, and it would still
 * produce `status: 'ready'` here.
 */
export const expectOpenCodeIdleComposer: Expectation = {
  label:
    'opencode idle composer: status=ready reason=input_prompt evidence=positive, no busy footer, Auto-Yes silent',
  matches: (o: Observation): boolean =>
    o.status.status === 'ready' &&
    o.status.reason === STATUS_REASON.INPUT_PROMPT &&
    o.status.hasActivePrompt === false &&
    o.status.evidence === 'positive' &&
    o.autoYes.isPrompt === false &&
    !hasOpenCodeBusyFooter(o),
};

/**
 * Scenario 2 — actively generating (branch A).
 *
 * Misreading this as `ready` makes `wait` return immediately; #1894 measured the
 * five-second `esc again to interrupt` window in which that used to happen.
 */
export const expectOpenCodeGenerating: Expectation = {
  label:
    'opencode generating: status=running reason=opencode_processing_indicator evidence=positive with the busy footer on screen',
  matches: (o: Observation): boolean =>
    o.status.status === 'running' &&
    o.status.reason === STATUS_REASON.OPENCODE_PROCESSING_INDICATOR &&
    o.status.hasActivePrompt === false &&
    o.status.evidence === 'positive' &&
    o.autoYes.isPrompt === false &&
    hasOpenCodeBusyFooter(o),
};

/**
 * Scenario 3 — the permission dialog's button strip (branch A0, Issue #1893).
 *
 * Three things are asserted together because #1893 is about all three:
 * - `waiting` / `opencode_permission_prompt`, i.e. the strip won over the
 *   duration-less `▣ Build · <model>` row branch D would otherwise have matched
 *   (that row IS in this frame — it is the step blocked on this very dialog);
 * - `hasActivePrompt === false`, the `menu` half of the #1786 taxonomy: the
 *   strip takes ←/→ + Enter and swallows a typed digit;
 * - **Auto-Yes sees nothing.** If it did, `sendPromptAnswer` would type the
 *   digit — swallowed — and the Enter after it would confirm whatever is
 *   HIGHLIGHTED, so asking to Reject would Approve.
 */
export const expectOpenCodePermissionDialog: Expectation = {
  label:
    'opencode permission dialog: status=waiting reason=opencode_permission_prompt hasActivePrompt=false, Auto-Yes blind, heading on screen',
  matches: (o: Observation): boolean =>
    o.status.status === 'waiting' &&
    o.status.reason === STATUS_REASON.OPENCODE_PERMISSION_PROMPT &&
    o.status.hasActivePrompt === false &&
    o.status.evidence === 'positive' &&
    o.autoYes.isPrompt === false &&
    hasOpenCodePermissionHeading(o),
};

/**
 * Scenario 4 — the `/models` picker (branch C, Issue #1896).
 *
 * opencode's picker is the same trap as claude's `/model` overlay (#1495): it
 * WRITES the default model when confirmed. So, as there, the assertion has two
 * halves — the status path must classify it as a selection list (the UI renders
 * NavigationButtons and `wait` stops with exit 10), and the Auto-Yes path must
 * stay blind, or it would Enter-confirm whatever model is highlighted.
 */
export const expectOpenCodePicker: Expectation = {
  label:
    'opencode /models picker: status=waiting reason=opencode_selection_list AND Auto-Yes sees no prompt',
  matches: (o: Observation): boolean =>
    o.status.status === 'waiting' &&
    o.status.reason === STATUS_REASON.OPENCODE_SELECTION_LIST &&
    o.status.hasActivePrompt === false &&
    o.status.evidence === 'positive' &&
    o.autoYes.isPrompt === false &&
    hasOpenCodePickerHint(o),
};

/**
 * Scenario 5 — the finished-turn marker (branch D, Issue #1893).
 *
 * opencode is the one tool D1 credits with a completion marker of its own, and
 * the DURATION is the whole of what makes it evidence: the same row without one
 * is drawn for a step that is still open. The busy footer must also be gone, so
 * a frame that carries both a stale marker and a live `esc interrupt` cannot
 * satisfy this.
 *
 * Note the reason differs from scenario 1's: after a turn has run, opencode
 * stops painting `Ask anything...` in the composer, so `ready` here comes from
 * branch D (`opencode_response_complete`) and not from branch E.
 */
export const expectOpenCodeTurnComplete: Expectation = {
  label:
    'opencode finished turn: status=ready reason=opencode_response_complete evidence=positive, marker with a duration, busy footer gone',
  matches: (o: Observation): boolean =>
    o.status.status === 'ready' &&
    o.status.reason === STATUS_REASON.OPENCODE_RESPONSE_COMPLETE &&
    o.status.hasActivePrompt === false &&
    o.status.evidence === 'positive' &&
    o.autoYes.isPrompt === false &&
    hasOpenCodeTurnMarker(o) &&
    !hasOpenCodeBusyFooter(o),
};

/**
 * opencode's startup screens.
 *
 * Only one is known, and it is fatal: with no provider credential in the
 * throwaway HOME, opencode replaces the composer with a `Connect a provider`
 * chooser — `Ask anything` occurs zero times while it is up (#1908), so a run
 * that hit it would otherwise burn its whole startup window and report a
 * timeout that reads like a detection regression.
 *
 * The `a` matters. The `/models` picker draws `Connect provider ctrl+a` as a
 * hint row (see {@link OPENCODE_PICKER_HINT_PATTERN}); matching that would abort
 * scenario 4 on the very screen it exists to capture.
 */
export const OPENCODE_STARTUP_OVERLAYS: readonly StartupOverlay[] = [
  {
    id: 'opencode-connect-provider',
    pattern: /^[^\S\n]*Connect a provider\b/m,
    dismissKey: null,
    fatalHint:
      'the throwaway HOME has no opencode provider credential. `~/.local/share/opencode/auth.json` is copied into it — run `opencode auth login` once so that file exists, or set CM_CANARY_OPENCODE_MODEL to a provider you are logged into.',
  },
];
