/**
 * What CommandMate answers when codex offers to update itself (Issue #2068).
 *
 * codex checks for a new release before its TUI opens and, once
 * `$CODEX_HOME/version.json` has a `latest_version` cached, puts a numbered
 * dialog in front of the session:
 *
 * ```
 *   ✨ Update available! 0.149.1 -> 0.151.0
 *   Release notes: https://github.com/openai/codex/releases/latest
 * › 1. Update now (runs `npm install -g @openai/codex`)
 *   2. Skip
 *   3. Skip until next version
 *   Press enter to continue
 * ```
 *
 * `CodexTool.waitForReady` has answered it with `'2'` since Issue #890, for the
 * good reason that `'1'` replaces codex with `npm install` and exits. The cost
 * was only measured for this Issue: **`'2'` persists nothing.** Measured on
 * codex-cli 0.149.1 in an isolated `CODEX_HOME` (2026-08-31) —
 *
 * | key | `version.json` after | next launch |
 * |-----|----------------------|-------------|
 * | `'2'` | `dismissed_version: null` (unchanged) | dialog again |
 * | `'3'` | `dismissed_version: "0.151.0"` | **no dialog** |
 * | `'1'` | unchanged; codex exits into `npm install -g @openai/codex` | — |
 *
 * — so every single session start met the dialog, spent a poll answering it,
 * and the operator could never choose the update because the server always
 * chose for them. Hence a policy rather than a constant.
 *
 * ## Why the default moved to `'3'` and not to `'1'`
 *
 * `skip-until-next-version` is the only one of the three that is both
 * non-destructive and *idempotent*: it writes the version the operator has
 * already been told about into `dismissed_version`, so the dialog returns when —
 * and only when — there is something new to say. `update` stays opt-in because
 * it kills the agent mid-launch (recovered here, but still a restart nobody
 * asked for) and because upgrading the operator's own global npm package is not
 * a decision a session start gets to make silently.
 *
 * @module config/codex-update-dialog-config
 */

/**
 * How a codex session start answers the update dialog.
 *
 * - `skip` — send `'2'`. The pre-#2068 behaviour, kept for operators who want
 *   codex to keep nagging (a `version.json` this server never writes to).
 * - `skip-until-next-version` — send `'3'`. The default; see the module comment.
 * - `update` — send `'1'`, let codex exit into `npm install -g @openai/codex`,
 *   and re-send the launch line into the same pane when the shell comes back.
 * - `ask` — send nothing. `waitForReady` keeps polling without answering, so
 *   the dialog stays on the pane, `detectPrompt` reports it as the
 *   multiple-choice prompt it is, and the human answers it in PromptPanel.
 */
export type CodexUpdateDialogPolicy = 'skip' | 'skip-until-next-version' | 'update' | 'ask';

/** Every accepted value, in the order the documentation lists them. */
export const CODEX_UPDATE_DIALOG_POLICIES: readonly CodexUpdateDialogPolicy[] = [
  'skip',
  'skip-until-next-version',
  'update',
  'ask',
] as const;

/**
 * The default, and the answer to "why is this not `skip`".
 *
 * See the measurement table in the module comment: `skip` is the value that
 * produced the reported bug, and it produced it on every launch.
 */
export const DEFAULT_CODEX_UPDATE_DIALOG_POLICY: CodexUpdateDialogPolicy =
  'skip-until-next-version';

/** Operator override, read from the server's own environment. */
export const CODEX_UPDATE_DIALOG_ENV_VAR = 'CM_CODEX_UPDATE_DIALOG';

/**
 * The key each policy sends, or `null` when nobody may answer for the human.
 *
 * The digits are codex's own option numbers and they are sent ALONE — codex
 * confirms a numbered selection instantly and a trailing Enter lands on the
 * next screen (Issue #890, re-measured for this Issue: `'3'` alone took the
 * pane straight to `› Ask Codex to do anything`).
 */
export const CODEX_UPDATE_DIALOG_KEYS: Readonly<
  Record<CodexUpdateDialogPolicy, '1' | '2' | '3' | null>
> = Object.freeze({
  update: '1',
  skip: '2',
  'skip-until-next-version': '3',
  ask: null,
});

/**
 * Whether a value names a policy.
 *
 * @param value - Candidate, from anywhere
 * @returns True when `value` is one of {@link CODEX_UPDATE_DIALOG_POLICIES}
 */
export function isCodexUpdateDialogPolicy(value: unknown): value is CodexUpdateDialogPolicy {
  return (
    typeof value === 'string' &&
    (CODEX_UPDATE_DIALOG_POLICIES as readonly string[]).includes(value)
  );
}

/**
 * Coerce an untrusted value into a policy, or `null` when it names none.
 *
 * Case- and whitespace-insensitive, because the value arrives from a shell
 * export and `CM_CODEX_UPDATE_DIALOG=Update ` is what an operator types.
 * Anything unrecognised becomes `null` rather than a guess: the caller then
 * falls back to the default, which is the safe answer, instead of acting on a
 * typo that might mean `update`.
 *
 * @param value - Candidate, from the environment or a stored setting
 * @returns The policy, or null
 */
export function normalizeCodexUpdateDialogPolicy(value: unknown): CodexUpdateDialogPolicy | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isCodexUpdateDialogPolicy(normalized) ? normalized : null;
}

/**
 * The policy a codex session start acts on.
 *
 * Precedence: the instance's own setting, then the server environment, then
 * {@link DEFAULT_CODEX_UPDATE_DIALOG_POLICY}. `instanceSetting` is a parameter
 * rather than a lookup so this module stays free of `better-sqlite3` — and so
 * that the per-instance store, when it lands, has one place to plug into
 * instead of a second resolution order of its own. Nothing persists a
 * per-instance value yet (that needs an `agent_instances` column and a route,
 * neither of which is in this Issue's diff), so today the effective order is
 * environment, then default.
 *
 * @param options.instanceSetting - The instance's stored value, if any
 * @param options.env - Environment to read (defaults to `process.env`). Typed
 *   as a plain string map rather than `NodeJS.ProcessEnv` so a caller — a test,
 *   most of all — can pass a literal without having to satisfy the `NODE_ENV`
 *   that Next's own augmentation makes mandatory.
 * @returns The policy to act on; never null
 */
export function resolveCodexUpdateDialogPolicy(options?: {
  instanceSetting?: unknown;
  env?: Record<string, string | undefined>;
}): CodexUpdateDialogPolicy {
  const fromInstance = normalizeCodexUpdateDialogPolicy(options?.instanceSetting);
  if (fromInstance !== null) return fromInstance;

  const env = options?.env ?? process.env;
  const fromEnv = normalizeCodexUpdateDialogPolicy(env[CODEX_UPDATE_DIALOG_ENV_VAR]);
  if (fromEnv !== null) return fromEnv;

  return DEFAULT_CODEX_UPDATE_DIALOG_POLICY;
}

/**
 * The key {@link resolveCodexUpdateDialogPolicy}'s answer sends.
 *
 * @param policy - The resolved policy
 * @returns `'1'` / `'2'` / `'3'`, or null when the human owns the screen
 */
export function codexUpdateDialogAnswerKey(
  policy: CodexUpdateDialogPolicy
): '1' | '2' | '3' | null {
  return CODEX_UPDATE_DIALOG_KEYS[policy];
}
