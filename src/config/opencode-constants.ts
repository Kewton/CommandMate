/**
 * opencode `run` option constants (Issue #2044)
 *
 * The CMATE.md CLI Tool column can now say more than `opencode --model x`:
 * `--agent`, `--variant`, `--continue` and `--title` all reach `opencode run`.
 * The values are user-authored text in a Markdown cell that becomes argv, so
 * each one needs a bound before it is handed to `execFile`.
 *
 * ## Why a separate pattern from Copilot's
 *
 * `MODEL_NAME_PATTERN` (`copilot-constants.ts`) allows `/` and `:` because a
 * model id is `provider/model` and can carry a tag (`ollama/qwen3:8b`). An
 * `--agent` or `--variant` value is neither: measured against opencode 1.18.22,
 * the built-in agents are `build` / `plan` and the documented variants are
 * `high` / `max` / `minimal` — bare words. Reusing the model pattern would
 * accept `plan/../../etc` and call it an agent name.
 *
 * The leading-alphanumeric requirement is the same rule and the same reason as
 * DR4-001: a value starting with `-` would be read by the CLI as another option
 * rather than as this one's argument.
 */

/**
 * Allowed shape for `--agent` and `--variant` values.
 *
 * Leading alphanumeric (DR4-001), then word characters, `.`, `_` and `-`.
 * Deliberately no `/` and no `:` — see the module comment.
 */
export const OPENCODE_RUN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-._]*$/;

/**
 * Longest `--agent` / `--variant` value accepted.
 *
 * Generous next to the measured vocabulary (`build`, `plan`, `high`, `max`,
 * `minimal`) because opencode lets a project define its own agents in
 * `opencode.json`, and this layer has no way to enumerate them.
 */
export const MAX_OPENCODE_RUN_NAME_LENGTH = 64;

/**
 * Longest `--title` value accepted.
 *
 * 200 to match what `agent-session-telemetry.ts` keeps of a session title
 * (`MAX_AGENT_SESSION_TITLE_LENGTH`), so a title CommandMate wrote survives the
 * round trip back through `structuredEvents.session` without being reported as
 * truncated. Not imported from there: that module is `lib/hooks` and this one is
 * read by the client-safe CMATE.md parser.
 */
export const MAX_OPENCODE_TITLE_LENGTH = 200;

/**
 * The event `type` values `opencode run --format json` emits on stdout.
 *
 * Measured on 1.18.22 in an isolated `HOME` (see
 * `docs/design/opencode-server-live-verification.md` §15): a plain prompt gives
 * `step_start` / `text` / `step_finish`; a prompt that uses a tool adds
 * `tool_use`; a run that fails gives a single `error` frame **on stdout** with
 * an empty stderr and exit 1.
 *
 * This list is documentation, not a filter — {@link extractOpencodeFinalText}
 * matches on `text` and `error` and ignores everything else, so an event word
 * added by a later opencode release cannot break extraction.
 */
export const OPENCODE_RUN_JSON_EVENT_TYPES = [
  'step_start',
  'text',
  'tool_use',
  'step_finish',
  'error',
] as const;
