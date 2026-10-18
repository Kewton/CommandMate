/**
 * The screen kinds a prompt observation publishes (Issue #3755, #3746 A-3).
 *
 * ## Why a vocabulary of its own
 *
 * `promptData.type` (`yes_no` / `multiple_choice` / `unclassified`) says how a
 * parsed prompt is answered, and agy's status detector
 * (`detection/tools/antigravity/detect.ts`) publishes the folder-trust screen,
 * the `/model` picker and the slash popup under ONE reason
 * (`antigravity_selection_list`). Neither can say "this is the trust screen and
 * not the picker", which is exactly what a caller about to answer one of them
 * has to be sure of (#3746 P4-1). So the values a caller may branch on — and
 * that the strict `respond` (#3756) may make a send condition — live here, and
 * are never mixed into `promptData.type` or read back from the detector's
 * reason.
 *
 * A kind is added only for a screen whose reading is pinned to a measured
 * frame. Everything else that waits on a human is `unknown`: an unmeasured
 * screen must not borrow a measured screen's name.
 *
 * ## No imports, on purpose
 *
 * The CLI (`tsconfig.cli.json`) compiles with `"paths": {}` and reaches a
 * module under `src/lib` only by a relative path whose graph uses no `@/`
 * alias (the arrangement `lib/session/prompt-view` documents). `prompt` and
 * `wait` import these values from here rather than restating them.
 *
 * @module lib/prompt-observation/kinds
 */

/** `schemaVersion` of the observation payload. Bumped when a field changes meaning. */
export const PROMPT_OBSERVATION_SCHEMA_VERSION = 1;

/**
 * Every kind an observation can publish.
 *
 * - `antigravity-trust` — agy's first-run folder trust screen (`Do you trust
 *   the contents of this project?` over `> Yes, I trust this folder` /
 *   `No, exit`). Unnumbered; Enter confirms the highlighted row.
 * - `antigravity-model-picker` — agy's `/model` picker (`Switch Model`).
 * - `antigravity-permission` — agy's numbered permission dialog (command
 *   execution, file creation; `tests/fixtures/antigravity-live-2364/dialog-*`).
 * - `antigravity-slash-menu` — agy's slash-command popup.
 * - `composer` — no confirmation: the agent sits at its input box.
 * - `none` — no confirmation, and not at the input box either (working).
 * - `unknown` — something waits on a human and no measured reading names it.
 */
export const PROMPT_OBSERVATION_KINDS = [
  'antigravity-trust',
  'antigravity-model-picker',
  'antigravity-permission',
  'antigravity-slash-menu',
  'composer',
  'none',
  'unknown',
] as const;

export type PromptObservationKind = (typeof PROMPT_OBSERVATION_KINDS)[number];

/** The two kinds that mean "nothing on screen is asking for a decision". */
export const NO_PROMPT_OBSERVATION_KINDS: readonly PromptObservationKind[] = ['composer', 'none'];

/** Whether `value` is one of {@link PROMPT_OBSERVATION_KINDS}. */
export function isPromptObservationKind(value: unknown): value is PromptObservationKind {
  return typeof value === 'string' && (PROMPT_OBSERVATION_KINDS as readonly string[]).includes(value);
}

/** Whether `kind` is a screen that asks for a decision (neither `composer` nor `none`). */
export function isDecisionKind(kind: PromptObservationKind): boolean {
  return !NO_PROMPT_OBSERVATION_KINDS.includes(kind);
}

/**
 * The kinds the strict `respond` (Issue #3756) answers. Every other kind is
 * refused before a key: the `/model` picker's effort slider is not read, the
 * slash popup is a menu of the composer, and `unknown` is never answered.
 */
export const STRICT_RESPOND_KINDS = ['antigravity-trust', 'antigravity-permission'] as const;

export type StrictRespondKind = (typeof STRICT_RESPOND_KINDS)[number];

/** Whether `kind` is one of {@link STRICT_RESPOND_KINDS}. */
export function isStrictRespondKind(kind: unknown): kind is StrictRespondKind {
  return typeof kind === 'string' && (STRICT_RESPOND_KINDS as readonly string[]).includes(kind);
}

/**
 * Strict kinds whose rows carry no number: answered only by a label, which is
 * sent as ↑/↓ and Enter. An option number or `--default` is refused there.
 */
export const UNNUMBERED_STRICT_RESPOND_KINDS: readonly StrictRespondKind[] = ['antigravity-trust'];

/**
 * Per strict kind, the answer whose consequence is the agent exiting (Issue
 * #3788): its 1-based position, valid only on a screen that shows exactly
 * `optionCount` options. agy's trust screen offers `Yes, I trust this folder`
 * then `No, exit` (measured: `tests/fixtures/prompt-observation-3755/antigravity-trust.txt`,
 * `antigravity-live-2364/trust-dialog.txt`), and agy exits on the second.
 *
 * Only after such an answer may a shell back in front of the pane be read as
 * the session having ended: after any other answer it is the agent falling
 * over (a crash, a failed start), which the answer did not ask for. A kind
 * absent here has no exiting answer.
 */
export const EXITING_STRICT_ANSWERS: Readonly<
  Partial<Record<StrictRespondKind, { readonly position: number; readonly optionCount: number }>>
> = {
  'antigravity-trust': { position: 2, optionCount: 2 },
};

/** Whether answering option `position` (1-based) of a `kind` screen showing `optionCount` options exits the agent. */
export function isExitingStrictAnswer(kind: StrictRespondKind, position: number, optionCount: number): boolean {
  const exiting = EXITING_STRICT_ANSWERS[kind];
  return exiting !== undefined && exiting.position === position && exiting.optionCount === optionCount;
}
