/**
 * What one opencode instance should be launched and prompted with (Issue #2048).
 *
 * Three values the operator chooses per agent instance — the persona, the model
 * and the model's variant — and the vocabulary the settings UI, the API route,
 * the database and the launcher all speak. It lives in `src/types` rather than
 * beside the launcher because the settings pane is a `'use client'` component:
 * anything it imports must not drag `fs` / `better-sqlite3` into the bundle.
 *
 * ## What each field can actually do, measured
 *
 * All three were measured against opencode **1.18.22** in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §20), and they are **not**
 * interchangeable:
 *
 * | field       | TUI launch flag        | `prompt_async` body | reported back on |
 * |-------------|------------------------|---------------------|------------------|
 * | {@link agent}    | `--agent <name>` ✅ | `agent` ✅          | `message.updated.info.agent`, `Session.agent` |
 * | provider/model   | `-m <p>/<m>` ✅     | `model` ✅          | `info.modelID` / `info.providerID` |
 * | {@link variant}  | **none** ❌        | `variant` ✅        | `info.variant`, `Session.model.variant` |
 *
 * The empty cell is the one that matters. `--variant` exists on `opencode run`
 * and **not** on the TUI: passing it to the TUI makes opencode print its usage
 * and exit, so a launch line that carried it would leave the pane with no agent
 * in it at all. `"agent": { "plan": { "variant": "high" } }` in `opencode.jsonc`
 * was measured too and did not reach the turn either (`info.variant` absent). So
 * the variant is applied where opencode does accept it — on the prompt this
 * server posts — and the launch line never carries it.
 *
 * ## Why every value is pattern-checked rather than escaped
 *
 * `agent` and `provider`/`model` are interpolated into a **shell command line**
 * by `prepareOpencodeLaunch`. The same argument `OPENCODE_SESSION_ID_PATTERN`
 * makes applies verbatim: a value that reached the pane with a space or a quote
 * in it would be a command injection into the operator's own terminal, and these
 * values arrive over HTTP. Anything that does not match is refused, because
 * there is no legitimate opencode id these patterns reject — the four providers
 * measured publish ids like `claude-sonnet-4.6`, `qwen/qwen3-coder-30b` and
 * `deepseek-v4-flash:0731`, which is where `/` and `:` come from.
 *
 * @module types/opencode-instance-settings
 */

/**
 * An opencode agent (persona) name, e.g. `build` / `plan`.
 *
 * `GET /agent` answered seven on a stock 1.18.22 install and every name was
 * lower-case alphanumeric; the class is widened to `._-` for the user-defined
 * agents an operator can add to their config, and no further.
 */
export const OPENCODE_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A provider id, e.g. `github-copilot` / `ollama-cloud` / `opencode`. */
export const OPENCODE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A model id, e.g. `claude-sonnet-4.6` / `qwen/qwen3-coder-30b` /
 * `deepseek-v4-flash:0731`.
 *
 * `/` and `:` are in the class because measured ids contain them — LMStudio
 * publishes `org/model` and Ollama Cloud publishes `model:tag`. Neither is a
 * shell metacharacter, so widening the class here does not widen what can reach
 * the command line.
 */
export const OPENCODE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * A model variant, e.g. `low` / `medium` / `high` / `max` / `minimal` / `none` /
 * `xhigh`.
 *
 * Not an enum: the names come from each model's own `variants` map in
 * `GET /config/providers`, and the seven above are simply the ones the measured
 * catalogue happened to contain. opencode does not validate the value either —
 * a variant of `totally-not-a-variant` was accepted with `204` and echoed back
 * verbatim on `message.updated.info.variant` (§20.6) — so this pattern is a
 * bound on what this server will store and send, not a claim about what is real.
 */
export const OPENCODE_VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * One instance's opencode launch settings. `null` everywhere means "unset",
 * which is the state every instance is in until somebody opens the pane — and
 * an all-null settings object must produce a launch line and a prompt body that
 * are byte-identical to the pre-#2048 ones.
 */
export interface OpencodeInstanceSettings {
  /** The persona to start in (`--agent`), or null for opencode's own default. */
  agent: string | null;
  /** The provider half of `-m <provider>/<model>`, or null. */
  providerId: string | null;
  /** The model half of `-m <provider>/<model>`, or null. */
  modelId: string | null;
  /**
   * The model variant, or null.
   *
   * Applied on the prompt this server posts, never on the launch line — see the
   * module comment for the measurement that forces the split.
   */
  variant: string | null;
}

/** The all-unset settings object. Frozen so a caller cannot mutate the default. */
export const EMPTY_OPENCODE_INSTANCE_SETTINGS: Readonly<OpencodeInstanceSettings> =
  Object.freeze({ agent: null, providerId: null, modelId: null, variant: null });

/** Whether anything at all is configured. */
export function hasOpencodeInstanceSettings(
  settings: OpencodeInstanceSettings | null | undefined
): boolean {
  if (!settings) return false;
  return Boolean(settings.agent || settings.providerId || settings.modelId || settings.variant);
}

/** One value, checked against its pattern; anything else becomes null. */
function acceptToken(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return pattern.test(trimmed) ? trimmed : null;
}

/**
 * Coerce an untrusted value into settings, dropping anything unusable.
 *
 * Field-by-field rather than all-or-nothing: a stored row written by a newer
 * build, or a request body with one bad field, still yields the settings that
 * *are* valid instead of silently reverting the instance to opencode's defaults.
 *
 * `providerId` and `modelId` are the one pair that stands or falls together —
 * `-m` takes `provider/model` and half of that is not a model reference — so a
 * lone half of the pair is dropped.
 */
export function normalizeOpencodeInstanceSettings(input: unknown): OpencodeInstanceSettings {
  if (typeof input !== 'object' || input === null) {
    return { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
  }
  const raw = input as Record<string, unknown>;
  const providerId = acceptToken(raw.providerId, OPENCODE_PROVIDER_ID_PATTERN);
  const modelId = acceptToken(raw.modelId, OPENCODE_MODEL_ID_PATTERN);
  const paired = providerId !== null && modelId !== null;
  return {
    agent: acceptToken(raw.agent, OPENCODE_AGENT_NAME_PATTERN),
    providerId: paired ? providerId : null,
    modelId: paired ? modelId : null,
    variant: acceptToken(raw.variant, OPENCODE_VARIANT_PATTERN),
  };
}

/**
 * `provider/model`, or null when the pair is not set.
 *
 * The spelling `-m` takes and the spelling `opencode models` prints, in one
 * place so the launch line and the settings pane cannot disagree about it.
 */
export function opencodeModelReference(
  settings: OpencodeInstanceSettings | null | undefined
): string | null {
  if (!settings?.providerId || !settings.modelId) return null;
  return `${settings.providerId}/${settings.modelId}`;
}

// ============================================================================
// The candidate lists the settings pane offers (Issue #2048)
// ============================================================================

/** One model, as `GET /config/providers` describes it. */
export interface OpencodeModelChoice {
  /** `Model.id`, the half `-m` takes after the slash. */
  id: string;
  /** `Model.name`, the display string opencode's own footer shows. */
  name: string;
  /**
   * The keys of `Model.variants`, sorted.
   *
   * Empty for a model with no variants at all (`kimi-k2.7-code` was measured
   * with `variants: {}`), which is how the pane knows to offer no variant.
   */
  variants: string[];
}

/** One provider and its models. */
export interface OpencodeProviderChoice {
  /** `Provider.id`, the half `-m` takes before the slash. */
  id: string;
  /** `Provider.name`, e.g. `GitHub Copilot`. */
  name: string;
  models: OpencodeModelChoice[];
}

/** One agent (persona), as `GET /agent` describes it. */
export interface OpencodeAgentChoice {
  name: string;
  /** `primary` or `subagent`. Only `primary` can start a session. */
  mode: string;
  description: string | null;
}

/**
 * What the settings pane was able to learn from a live server.
 *
 * `connected: false` is the ordinary state, not an error: the catalogue can only
 * be read from an opencode that is *running with a port*, and the operator is
 * usually editing the roster of a worktree whose panes are stopped. The pane
 * falls back to free text in that case, which is exactly what Issue #2048 asks
 * for ("port 未接続時は自由入力").
 */
export interface OpencodeLaunchCatalog {
  connected: boolean;
  providers: OpencodeProviderChoice[];
  agents: OpencodeAgentChoice[];
}

/** The empty catalogue — what a disconnected worktree answers. */
export const EMPTY_OPENCODE_LAUNCH_CATALOG: OpencodeLaunchCatalog = {
  connected: false,
  providers: [],
  agents: [],
};

/** `GET /api/worktrees/[id]/instances/opencode`'s body. */
export interface OpencodeInstanceSettingsResponse {
  /** instanceId -> settings, for every opencode-backed instance in the roster. */
  settings: Record<string, OpencodeInstanceSettings>;
  catalog: OpencodeLaunchCatalog;
}
