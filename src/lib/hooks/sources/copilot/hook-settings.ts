/**
 * The hook configuration CommandMate injects for GitHub Copilot CLI, and the
 * command that starts a copilot session with it (Issue #1761, Epic #1720 Phase
 * 4-3).
 *
 * Copilot's payloads are the closest of the four new tools to Claude Code's —
 * same CamelCase event names, same snake_case fields, same
 * `hookSpecificOutput` verdict envelope — so `copilot/source.ts` is short. The
 * *delivery* side is not close at all, and everything unusual about this tool
 * lives in this file.
 *
 * ## Five measurements this file is built on
 *
 * The first three come from the Issue #1757 spike
 * (`docs/design/agent-hooks-phase4-live-verification.md` §5.2); the last two
 * were taken for this Issue against copilot 1.0.79 and are written up in
 * `docs/design/copilot-agent-hooks-injection.md`.
 *
 *  1. **The file is `~/.copilot/settings.json`, not `config.json`.**
 *     `copilot help config` documents `hooks` as a `config.json` key and it
 *     does fire from there — once. Copilot then rewrites `config.json` in its
 *     own machine-managed form (`// This file is managed automatically.`) and
 *     moves `hooks` into `settings.json`, so a config CommandMate wrote there
 *     would vanish at the next launch with nothing to show for it (P2).
 *  2. **`type: "http"` does not work.** Not a single request arrived from an
 *     `http` handler and no error was printed (§5.2.5). `type: "command"` is
 *     the only delivery mechanism, which is why `scripts/hooks/cmate-agent-event.sh`
 *     is on the critical path here and is not for Claude.
 *  3. **The decision budget is ≈10 s, not Claude's 600 s** (§5.2.3), and it is
 *     fail-open: a late verdict is discarded and the tool runs. Every command
 *     below therefore bounds its own `curl` at {@link COPILOT_HOOK_CURL_TIMEOUT_SECONDS},
 *     comfortably inside the window, instead of trusting the agent's timer.
 *  4. **Hook commands run through a shell.** `;`, `$(…)`, `[ … ]`, redirection
 *     and `printf` all behave, which is what makes a self-bounding, self-gating
 *     one-liner possible at all.
 *  5. **The copilot process's environment reaches its hooks.** A variable set
 *     on the launch command line is visible to every hook it spawns. This is
 *     load-bearing — see below.
 *
 * ## Why correlation travels in the environment
 *
 * Claude bakes `worktreeId` and `instanceId` into the hook URL, because
 * `--settings <file>` is per launch: `claude` and `claude-2` get different
 * files. Copilot has no `--settings`. Its only configuration is one file for
 * the whole machine (`configScope: 'global-singleton'`), so a URL fixed at
 * write time could only ever name one instance, and the *second* copilot
 * session in a worktree would post under the first one's identity.
 *
 * Measurement 5 is the way out: the launch command sets
 * {@link COPILOT_WORKTREE_ID_ENV} and {@link COPILOT_INSTANCE_ID_ENV}, the hook
 * reads them at fire time, and one global file serves every worktree and every
 * instance correctly.
 *
 * It also makes the file **inert for sessions CommandMate did not start**. A
 * machine-global hook otherwise fires for a copilot the operator ran in their
 * own terminal, and if that terminal happened to sit in a registered worktree
 * its `Stop` would resolve by `cwd` and release a `commandmate wait` that
 * nobody's agent had finished. Every command below opens with a guard on the
 * worktree variable and exits quietly when it is unset.
 *
 * ## What is written into somebody else's file
 *
 * `~/.copilot/settings.json` belongs to the user. This module **merges**: it
 * strips out entries carrying {@link COPILOT_HOOK_MARKER} (its own, from a
 * previous launch), appends the current ones, and copies every other key and
 * every other handler through untouched. An existing file it cannot parse is
 * left alone entirely and the session starts without hooks — losing events is
 * recoverable, overwriting a user's settings is not.
 *
 * Since Issue #1904 the write is a temp file plus `rename` under a lock file in
 * the same directory, because `commandmate start --issue N --auto-port` makes
 * several servers writing this one file a supported workflow and
 * `writeFileSync` truncates before it writes. A lock this process cannot take
 * means starting without hooks, same as every other failure here.
 *
 * ## What one machine-global file is *not* allowed to fix (Issue #1904)
 *
 * Measurement 5 solves correlation. Issue #1904 found the same argument applies
 * to two more values that were being fixed at write time, and one that was not
 * a value at all:
 *
 *  - **The port.** A development server on 3011 rewrote the file and every
 *    copilot session on the machine — including the one on 3000 — started
 *    posting to 3011. It now travels in {@link COPILOT_HOOK_PORT_ENV}, behind a
 *    numeric guard, with no default to fall back to.
 *  - **The relay script's path** stays an absolute literal, because it names
 *    the program the hook executes and that is not a decision to delegate to
 *    the environment (設計方針書 §10.8 決定 2). What changed is *when* it is
 *    checked: `[ -x … ]` at fire time, falling back to the inline `curl` that
 *    was already written for a package layout without the script. A removed
 *    checkout no longer takes every session's events with it.
 *  - **`config.json`.** Copilot 1.0.80 migrates a `hooks` key out of it and
 *    **over** `settings.json` at startup, so an operator following
 *    `copilot help config` silently loses everything written here.
 *    {@link inspectCopilotConfigHooks} finds that key first and the launch goes
 *    ahead without hooks rather than writing a file that is about to be erased.
 *
 * Scheme and host stay module constants. {@link curlArgumentPreamble} attaches
 * the bearer header without looking at where it is going, so a constant
 * destination is what keeps the token on loopback (設計方針書 §10.7).
 *
 * @module lib/hooks/sources/copilot/hook-settings
 */

import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { getServerPort } from '@/lib/env';
import {
  AGENT_EVENT_PATH,
  PERMISSION_REQUEST_PATH,
  resolveRelayScriptPath,
  shellQuote,
} from '@/lib/hooks/hook-settings-generator';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';
import { HOOK_PORT_ENV_VAR } from '../launch-command';
import type { AgentInstanceRef, AgentLaunchPlan } from '../types';
import { COPILOT_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/copilot/hook-settings');

/** Loopback: the agent runs on the machine the server runs on. */
const HOOK_HOST = '127.0.0.1';

/**
 * The launch command, unchanged from what `cli-tools/copilot.ts` has sent since
 * Issue #545.
 *
 * Copilot is started through the `gh` extension wrapper rather than by an
 * absolute path, so "executable path" is a two-word command here. It stays a
 * bare command: `gh` warns that Copilot's own flags must be preceded by `--`,
 * and this Issue adds no flags — the configuration is entirely in the settings
 * file and the environment.
 */
export const COPILOT_LAUNCH_COMMAND = 'gh copilot';

/**
 * Present verbatim in every command this module writes, and the only way it
 * recognises its own entries when merging into the user's file.
 *
 * Spelled as an argument to `:` — the shell's no-op builtin — so it is inert,
 * portable, and visible both to `grep` and to a human reading their settings.
 */
export const COPILOT_HOOK_MARKER = 'cmate-copilot-agent-hooks';

/**
 * Seconds copilot waits for a hook before giving up, measured (#1757 §5.2.3).
 *
 * Two orders of magnitude below Claude's 600 s, which is the single number a
 * Claude-shaped decision path gets wrong. Published as
 * `capabilities.decisionTimeoutSeconds` so callers can read it instead of
 * assuming.
 *
 * Left unwritten in the generated config: the measured *default* is this, and
 * an explicit `"timeout"` did not divide the window the way its value suggested
 * (`"timeout": 3` produced a 5.12 s wait). The commands bound themselves
 * instead.
 */
export const COPILOT_HOOK_TIMEOUT_SECONDS = 10;

/**
 * `curl --max-time` for the generated commands.
 *
 * Under {@link COPILOT_HOOK_TIMEOUT_SECONDS} on purpose: a wedged server should
 * cost the agent four seconds and a missing event, and should never be the
 * thing that decides whether the verdict arrived in time.
 */
export const COPILOT_HOOK_CURL_TIMEOUT_SECONDS = 4;

/** Carries the worktree id from the launch command line to the hook. */
export const COPILOT_WORKTREE_ID_ENV = 'CM_AGENT_WORKTREE_ID';

/** Carries the instance id the same way; absent means the primary instance. */
export const COPILOT_INSTANCE_ID_ENV = 'CM_AGENT_INSTANCE_ID';

/** Bearer token variable, read at fire time exactly as the relay script reads it. */
export const COPILOT_AUTH_TOKEN_ENV = 'CM_AUTH_TOKEN';

/**
 * Carries the receiving server's port, the same way (Issue #1904).
 *
 * `~/.copilot/settings.json` is one file for the whole machine, so a port fixed
 * at write time is the port of whichever server wrote last. CommandMate
 * supports several servers at once — `commandmate start --issue N --auto-port`
 * is a documented workflow — and the measured consequence was every copilot
 * session on the machine posting to a development server on port 3011.
 *
 * Only the port moves. `HOOK_HOST`, the scheme and the receiver paths stay
 * literals in the generated command: they are what decides where the bearer
 * header goes, and {@link curlArgumentPreamble} attaches that header without
 * looking at the destination. See 設計方針書 §10.8 決定 1.
 */
export const COPILOT_HOOK_PORT_ENV = HOOK_PORT_ENV_VAR;

/**
 * Copilot's name for the event that gates a tool call (#1757 §5.2.4).
 *
 * Copilot has no `PermissionRequest`. `PreToolUse` is the approval gate *and*
 * the observation point, and its response body decides whether the call runs —
 * which is why this event alone is pointed at `/api/hooks/permission-request`
 * and does not reach the event store. See `copilot/source.ts` for what that
 * costs.
 */
export const COPILOT_PERMISSION_HOOK_EVENT = 'PreToolUse';

/**
 * The events pointed at the fire-and-forget receiver, with the relay `--event`
 * word each one is sent as.
 *
 * Exactly the payloads captured in `tests/fixtures/hooks/copilot/`, minus
 * `PreToolUse`. Nothing unmeasured is registered — in particular `Notification`,
 * which was configured during the spike and never fired once (README, §5.2.6).
 * A hook that never fires is not free: it is a word `capabilities` would have
 * to promise and a caller could wait forever for.
 */
export const COPILOT_EVENT_HOOKS: ReadonlyArray<readonly [string, string]> = [
  ['SessionStart', 'session_start'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session_end'],
];

/** One `type: "command"` handler. Copilot accepts no other type (§5.2.5). */
export interface CopilotHookHandler {
  type: 'command';
  command: string;
}

/** Copilot accepts this grouped form and a flat one; the grouped one is written. */
export interface CopilotHookMatcherGroup {
  hooks: CopilotHookHandler[];
}

/** Just the `hooks` block — the rest of the user's settings is never authored here. */
export interface CopilotHookSettings {
  hooks: Record<string, CopilotHookMatcherGroup[]>;
}

export interface CopilotHookSettingsOptions {
  /**
   * The port put in the launch environment, defaulting to {@link getServerPort}.
   *
   * Since Issue #1904 it does **not** reach the generated commands: they read
   * {@link COPILOT_HOOK_PORT_ENV} when they fire, so the file one server writes
   * serves every other server's sessions too.
   */
  port?: number;
  /** Defaults to the shipped relay, or an inline `curl` when it is missing. */
  relayScriptPath?: string | null;
  /** Defaults to {@link getCopilotSettingsPath}. */
  settingsPath?: string;
  /** Defaults to {@link getCopilotConfigPath}. */
  configPath?: string;
}

/**
 * Copilot's home directory.
 *
 * `COPILOT_HOME` is copilot's own override and the only session-scoped
 * injection point it has; honouring it means an operator who isolates copilot
 * gets an isolated hook config too, and tests get a directory that is not the
 * developer's.
 *
 * Issue #1774: `writeCopilotHookSettings` creates this directory with a
 * recursive mkdir, which does not fail but *hangs* for a path inside `/proc`,
 * `/sys` or `/dev`. Such a value is refused here and `~/.copilot` is used.
 */
export function getCopilotHomeDirectory(): string {
  const fallback = join(homedir(), '.copilot');
  return resolveSafeDirectory(process.env.COPILOT_HOME, fallback, 'COPILOT_HOME');
}

/** The one file copilot reads hooks from. */
export function getCopilotSettingsPath(): string {
  return join(getCopilotHomeDirectory(), 'settings.json');
}

/**
 * The file copilot manages for itself, and the reason {@link writeCopilotHookSettings}
 * sometimes declines to write anything (Issue #1904).
 *
 * Never written here. It is read for one key — see
 * {@link inspectCopilotConfigHooks}.
 */
export function getCopilotConfigPath(): string {
  return join(getCopilotHomeDirectory(), 'config.json');
}

/**
 * The guard every generated command opens with.
 *
 * Two conditions, in this order:
 *
 *  1. **No worktree id — not a session CommandMate started.** Exit quietly.
 *  2. **No usable port.** `CM_HOOK_PORT` is what the command builds its URL
 *     from since Issue #1904, and a value that is not a run of digits is a URL
 *     this hook must not assemble. Spelled without a `${…:-…}` default on
 *     purpose: a default would send the payload — and the bearer header — to
 *     some other port in silence whenever CommandMate forgot to set the
 *     variable. Not firing is the safe answer (設計方針書 §10.8 決定 3).
 *
 * Both consume stdin before exiting rather than exiting straight away: copilot
 * writes the payload to the hook's stdin, and a hook that exits first turns
 * that write into an EPIPE on the agent's side.
 *
 * @param onSkip - Extra shell to run before exiting, e.g. printing a body
 */
function guardPrelude(onSkip: string = ''): string {
  return (
    `: ${COPILOT_HOOK_MARKER}; ` +
    `if [ -z "\${${COPILOT_WORKTREE_ID_ENV}:-}" ]; then cat >/dev/null; ${onSkip}exit 0; fi; ` +
    `case "$${COPILOT_HOOK_PORT_ENV}" in ''|*[!0-9]*) cat >/dev/null; ${onSkip}exit 0;; esac; `
  );
}

/** `"$CM_AGENT_INSTANCE_ID"`, defaulting to the primary instance. */
const INSTANCE_EXPANSION = `"\${${COPILOT_INSTANCE_ID_ENV}:-${COPILOT_CLI_TOOL_ID}}"`;

/** `"$CM_AGENT_WORKTREE_ID"`, only reached once the guard has proved it non-empty. */
const WORKTREE_EXPANSION = `"$${COPILOT_WORKTREE_ID_ENV}"`;

/**
 * `set --` preamble that assembles curl's arguments, with the bearer header
 * added only when the token is in the environment.
 *
 * Written this way rather than as `${TOKEN:+-H "…"}` because that expansion
 * word-splits into four arguments and sends a header of `Authorization:`
 * alone. The relay script solves it identically.
 *
 * `-f` since Issue #1904, and it is not cosmetic on the `PreToolUse` path:
 * without it a 400 body such as `{"error":"cwd rejected: …"}` is printed to
 * stdout and copilot reads **the receiver's error message as its verdict**.
 * With `-f` curl prints nothing and exits 22, which the callers turn into an
 * explicit no-opinion `{}` plus one line on stderr. The relay script has always
 * used `-fsS` for the same reason.
 */
function curlArgumentPreamble(): string {
  return (
    `set -- -fsS -m ${COPILOT_HOOK_CURL_TIMEOUT_SECONDS} -X POST ` +
    `-H 'Content-Type: application/json'; ` +
    `if [ -n "\${${COPILOT_AUTH_TOKEN_ENV}:-}" ]; then ` +
    `set -- "$@" -H "Authorization: Bearer $${COPILOT_AUTH_TOKEN_ENV}"; fi; `
  );
}

/**
 * `http://127.0.0.1:` + `"$CM_HOOK_PORT"` + the rest, as one shell word.
 *
 * Everything except the port is a single-quoted literal, so the only thing the
 * environment can move is the port number the {@link guardPrelude} has already
 * proved to be digits. Host and scheme staying constant is what keeps the
 * bearer header pointed at loopback (設計方針書 §10.7 / §10.8).
 */
function runtimeUrl(tail: string): string {
  return (
    `${shellQuote(`http://${HOOK_HOST}:`)}"$${COPILOT_HOOK_PORT_ENV}"${shellQuote(tail)}`
  );
}

/**
 * A receiver URL with the correlation keys appended at fire time.
 *
 * The static halves are single-quoted and the variables are double-quoted next
 * to them, so the shell concatenates the lot into one word without
 * re-splitting. Both ids are validated before injection
 * ({@link buildCopilotLaunchCommand}) and draw from `[A-Za-z0-9_-]`, so no
 * percent-encoding is required.
 */
function runtimeCorrelatedUrl(base: string): string {
  return (
    `${runtimeUrl(`${base}?tool=${COPILOT_CLI_TOOL_ID}&worktreeId=`)}${WORKTREE_EXPANSION}` +
    `'&instanceId='${INSTANCE_EXPANSION}`
  );
}

/**
 * One line on stderr naming why a POST produced nothing, and curl's exit code.
 *
 * A hook whose delivery fails in complete silence is a `commandmate wait` that
 * never returns and an operator with nothing to read. The relay script prints
 * its own equivalent line; these are the inline paths, which used to end in
 * `|| true` and `2>/dev/null`.
 *
 * The marker leads so `grep` finds CommandMate's lines in a transcript the same
 * way it finds CommandMate's entries in the settings file.
 */
function reportFailure(reasonCode: string): string {
  return (
    `rc=$?; printf '%s\\n' "${COPILOT_HOOK_MARKER}: ${reasonCode} rc=$rc" >&2`
  );
}

/**
 * The command for one observation event.
 *
 * Prefers the shipped relay: it already reads copilot's payload from stdin,
 * knows its CamelCase spellings, extracts the subtype and exits 0 when the POST
 * fails. When the package layout puts it out of reach, an inline `curl` posts
 * the agent's payload verbatim to the same receiver — which reads it, because
 * `normalizeEvent` is what turns `hook_event_name` into a word (S1/S2).
 */
export function buildCopilotEventCommand(
  event: string,
  options: CopilotHookSettingsOptions = {}
): string {
  const relay =
    options.relayScriptPath === undefined ? resolveRelayScriptPath() : options.relayScriptPath;

  const inline =
    curlArgumentPreamble() +
    `curl "$@" --data-binary @- ${runtimeCorrelatedUrl(AGENT_EVENT_PATH)} >/dev/null 2>&1 || ` +
    `{ ${reportFailure('agent_event_post_failed')}; }`;

  if (!relay) return guardPrelude() + inline;

  // The `[ -x … ]` is Issue #1904. `~/.copilot/settings.json` is one file for
  // the whole machine, so the absolute path in it is whichever checkout's
  // server wrote last — and when that checkout is a worktree that has since
  // been removed, every copilot session on the machine loses every event with
  // nothing to read. Deciding at fire time costs one `test` and falls back to
  // the branch that was already written for a package layout with no relay.
  // The path stays a literal rather than moving into the environment: it names
  // the program the hook executes, and that is not a decision to hand to
  // whoever can set a variable (設計方針書 §10.8 決定 2).
  return (
    guardPrelude() +
    `if [ -x ${shellQuote(relay)} ]; then ` +
    [
      shellQuote(relay),
      '--tool',
      shellQuote(COPILOT_CLI_TOOL_ID),
      '--event',
      shellQuote(event),
      '--worktree-id',
      WORKTREE_EXPANSION,
      '--instance-id',
      INSTANCE_EXPANSION,
      '--url',
      runtimeUrl(AGENT_EVENT_PATH),
      '--stdin-json',
    ].join(' ') +
    `; exit 0; fi; ` +
    inline
  );
}

/**
 * The command for `PreToolUse`, whose stdout copilot obeys.
 *
 * There is no relay for this direction — `cmate-agent-event.sh` discards the
 * response body, which is the whole payload here — so it is always an inline
 * `curl` that pipes the receiver's answer straight to stdout. Measured end to
 * end against copilot 1.0.79: a body of `{"hookSpecificOutput":{…
 * "permissionDecision":"deny"}}` prints `Denied by preToolUse hook: …` and the
 * command does not run; `"allow"` runs it with no prompt; `{}` falls through to
 * copilot's ordinary flow.
 *
 * Every failure path prints `{}`: an unreachable server, a timeout and a
 * session CommandMate did not start all have to look like "no opinion", which
 * is the measured fail-safe.
 */
export function buildCopilotPermissionCommand(
  // Unused since Issue #1904 moved the port into the environment: nothing this
  // command says depends on the writing server any more. Kept so the two
  // builders stay callable the same way from {@link buildCopilotHookSettings}.
  _options: CopilotHookSettingsOptions = {}
): string {
  return (
    guardPrelude(`printf '{}'; `) +
    curlArgumentPreamble() +
    `out=$(curl "$@" --data-binary @- ${runtimeCorrelatedUrl(PERMISSION_REQUEST_PATH)} ` +
    `2>/dev/null) || { ${reportFailure('permission_request_failed')}; out=''; }; ` +
    `[ -n "$out" ] || out='{}'; printf '%s' "$out"`
  );
}

/**
 * The `hooks` block CommandMate owns.
 *
 * Deterministic for a given port and relay path, so re-launching rewrites the
 * same bytes rather than accumulating entries.
 */
export function buildCopilotHookSettings(
  options: CopilotHookSettingsOptions = {}
): CopilotHookSettings {
  const hooks: Record<string, CopilotHookMatcherGroup[]> = {};
  for (const [hookEventName, relayEvent] of COPILOT_EVENT_HOOKS) {
    hooks[hookEventName] = [
      { hooks: [{ type: 'command', command: buildCopilotEventCommand(relayEvent, options) }] },
    ];
  }
  hooks[COPILOT_PERMISSION_HOOK_EVENT] = [
    { hooks: [{ type: 'command', command: buildCopilotPermissionCommand(options) }] },
  ];
  return { hooks };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether this handler is one this module wrote. */
function isOwnedHandler(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.command === 'string' &&
    value.command.includes(COPILOT_HOOK_MARKER)
  );
}

/**
 * Drop this module's previous entries from one event's array, keeping the
 * user's.
 *
 * Both shapes copilot accepts are handled: a grouped `{hooks: [...]}` has its
 * handler list filtered and is dropped only when nothing of the user's is left
 * in it, and a flat handler is dropped on its own. Anything unrecognised is
 * passed through — a merge that cannot identify an entry has no business
 * deleting it.
 */
function stripOwnedEntries(entries: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (isOwnedHandler(entry)) continue;
    if (isPlainObject(entry) && Array.isArray(entry.hooks)) {
      const handlers = entry.hooks.filter((handler) => !isOwnedHandler(handler));
      if (handlers.length === 0 && entry.hooks.length > 0) continue;
      kept.push({ ...entry, hooks: handlers });
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * Fold the generated block into whatever is already in the user's file.
 *
 * @param existing - The parsed contents of `settings.json`, or `{}`
 * @param generated - {@link buildCopilotHookSettings}'s output
 * @returns A new object; `existing` is not mutated
 * @throws When `existing.hooks` is present but not an object, which means this
 *   file is not shaped the way copilot documents and merging into it would be
 *   guessing
 */
export function mergeCopilotHookSettings(
  existing: Record<string, unknown>,
  generated: CopilotHookSettings
): Record<string, unknown> {
  const priorHooks = existing.hooks;
  if (priorHooks !== undefined && !isPlainObject(priorHooks)) {
    throw new Error('copilot settings.json has a non-object "hooks" key');
  }

  const merged: Record<string, unknown> = { ...(priorHooks ?? {}) };
  for (const [event, groups] of Object.entries(generated.hooks)) {
    const prior = merged[event];
    if (prior !== undefined && !Array.isArray(prior)) {
      // Not ours to reshape. Skipping this one event costs its structured
      // signal; rewriting it would cost the operator whatever they meant by it.
      logger.warn('copilot-hook-event-not-an-array', { event });
      continue;
    }
    merged[event] = [...stripOwnedEntries(prior ?? []), ...groups];
  }

  return { ...existing, hooks: merged };
}

/** `''` when the file is not there; anything else throws. */
function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Read the user's `settings.json`.
 *
 * @returns The parsed object, or `{}` when the file does not exist
 * @throws When the file exists but cannot be read or is not a JSON object —
 *   the caller turns that into "start without hooks", never into a rewrite
 */
export function readCopilotSettings(settingsPath: string): Record<string, unknown> {
  return parseCopilotSettings(readFileOrEmpty(settingsPath));
}

function parseCopilotSettings(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error('copilot settings.json is not a JSON object');
  }
  return parsed;
}

/**
 * Strip `//` and block comments from JSONC, leaving string literals alone.
 *
 * `~/.copilot/config.json` is not JSON. Copilot writes two comment lines at the
 * top of the file it manages — measured verbatim on 1.0.80:
 *
 * ```text
 * // User settings belong in settings.json.
 * // This file is managed automatically.
 * ```
 *
 * so `JSON.parse` on the real file throws at character 0. A detector that
 * treated that as "unreadable" would never see the `hooks` key it exists to
 * find, which is the whole of {@link inspectCopilotConfigHooks}.
 */
function stripJsonComments(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Whether copilot's own `config.json` carries a `hooks` key.
 *
 * - `absent` — nothing there, or an empty block. Safe to write settings.json.
 * - `present` — copilot will **migrate that key into settings.json and
 *   overwrite whatever is there** at its next start.
 * - `unreadable` — the file exists and could not be parsed even with comments
 *   stripped. Treated as `absent` by the caller, because refusing to inject on
 *   a file this module does not understand would disable hooks permanently for
 *   a shape nobody has measured.
 */
export type CopilotConfigHooksState = 'absent' | 'present' | 'unreadable';

/**
 * Look for the key that silently erases everything this module writes
 * (Issue #1904).
 *
 * Measured on copilot 1.0.80: with a marker hook in **both** files, only the
 * `config.json` one fired, and the `settings.json` read back immediately
 * afterwards held six `config.json` entries and none of the settings ones.
 * `copilot help config` still documents `hooks` as a `config.json` key, so an
 * operator who follows the published documentation loses CommandMate's hooks —
 * events and Auto-Yes both — with no error anywhere.
 */
export function inspectCopilotConfigHooks(configPath: string): CopilotConfigHooksState {
  const raw = readFileOrEmpty(configPath);
  if (raw.trim() === '') return 'absent';

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return 'unreadable';
  }
  if (!isPlainObject(parsed)) return 'unreadable';

  const hooks = parsed.hooks;
  if (hooks === undefined || hooks === null) return 'absent';
  if (isPlainObject(hooks) && Object.keys(hooks).length === 0) return 'absent';
  if (Array.isArray(hooks) && hooks.length === 0) return 'absent';
  return 'present';
}

/**
 * Thrown instead of writing a settings file copilot is about to overwrite.
 *
 * A distinct type so {@link buildCopilotLaunchCommand} can log this as its own
 * reason code: "your config.json shadows the file we write" is a thing an
 * operator can act on, and `copilot-hook-settings-write-failed` is not.
 */
export class CopilotConfigHooksShadowError extends Error {
  constructor(readonly configPath: string) {
    super(
      `copilot config.json still has a "hooks" key (${configPath}); ` +
        'copilot migrates it over settings.json at startup, so CommandMate is not writing hooks this launch'
    );
    this.name = 'CopilotConfigHooksShadowError';
  }
}

/** Where the cross-process lock lives, next to the file it guards. */
export const COPILOT_SETTINGS_LOCK_BASENAME = '.cmate.lock';

/**
 * How old a lock has to be before it is treated as a crashed process's leftover.
 *
 * The critical section is a read, a merge and a rename of a file measured in
 * kilobytes, so a lock that has been held for this long is not a slow write; it
 * is a server that died between `openSync` and `unlinkSync`. Without a ceiling
 * that leftover would disable copilot hooks on the machine until somebody
 * deleted the file by hand.
 */
export const COPILOT_SETTINGS_LOCK_STALE_MS = 10_000;

/** Suffix of the one generation of the user's file kept before a rewrite. */
export const COPILOT_SETTINGS_BACKUP_SUFFIX = '.cmate-backup';

/**
 * Run `write` with `~/.copilot` held against other CommandMate servers.
 *
 * `commandmate start --issue N --auto-port` makes several servers on one
 * machine a supported workflow, and every one of them writes this same file.
 * Within a process the writes are already serialised — everything here is
 * synchronous — so the lock exists for the cross-process case (設計方針書
 * §10.9 決定 2).
 *
 * @throws When the lock is held and fresh. The caller turns that into "start
 *   without hooks", which is the same fail-open every other failure here takes.
 */
function withCopilotSettingsLock<T>(directory: string, write: () => T): T {
  const lockPath = join(directory, COPILOT_SETTINGS_LOCK_BASENAME);

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const heldForMs = Date.now() - statSync(lockPath).mtimeMs;
    if (heldForMs < COPILOT_SETTINGS_LOCK_STALE_MS) {
      throw new Error(`copilot settings.json is locked by another CommandMate server (${lockPath})`);
    }
    logger.warn('copilot-hook-settings-lock-stale', { lockPath, heldForMs });
    unlinkSync(lockPath);
    fd = openSync(lockPath, 'wx', 0o600);
  }

  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }

  try {
    return write();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone: another server judged this lock stale. Nothing to undo.
    }
  }
}

/**
 * Replace a file's contents without ever leaving it half-written.
 *
 * `writeFileSync` truncates first, so a process that dies mid-write leaves the
 * operator with a truncated `settings.json` — and this module's own docstring
 * says overwriting a user's settings is the unrecoverable failure. A temp file
 * in the same directory plus `rename` is atomic on every filesystem CommandMate
 * runs on (設計方針書 §10.9 決定 1).
 */
function writeFileAtomic(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file never got created, or is already gone.
    }
    throw error;
  }
}

/**
 * Merge the generated hooks into copilot's settings file and return its path.
 *
 * @throws {CopilotConfigHooksShadowError} When copilot's `config.json` still
 *   has a `hooks` key, which it migrates over this file at startup
 * @throws Anything the read, the merge or the write throws, plus a lock the
 *   file's other writers are holding. Callers must treat a throw as "launch
 *   without hooks" (fail-open).
 */
export function writeCopilotHookSettings(options: CopilotHookSettingsOptions = {}): string {
  const settingsPath = options.settingsPath ?? getCopilotSettingsPath();
  // Next to the settings file rather than via `getCopilotConfigPath()`: the
  // config.json that can erase a settings.json is the one copilot reads from
  // the same directory, and an overridden `settingsPath` must not be checked
  // against a different home's config.
  const configPath = options.configPath ?? join(dirname(settingsPath), 'config.json');

  const configHooks = inspectCopilotConfigHooks(configPath);
  if (configHooks === 'present') throw new CopilotConfigHooksShadowError(configPath);
  if (configHooks === 'unreadable') {
    // Not fatal: proceeding is what this module did before #1904, and a shape
    // nobody has measured is not evidence that a migration is coming.
    logger.warn('copilot-config-json-unreadable', { configPath });
  }

  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });

  return withCopilotSettingsLock(dirname(settingsPath), () => {
    const raw = readFileOrEmpty(settingsPath);
    const merged = mergeCopilotHookSettings(
      parseCopilotSettings(raw),
      buildCopilotHookSettings(options)
    );
    const next = `${JSON.stringify(merged, null, 2)}\n`;

    // Since #1904 the generated commands carry no port and no per-launch value,
    // so the common re-launch produces the bytes already on disk. Returning
    // early keeps the user's file — and its mtime — untouched, and skips the
    // backup that would otherwise be rewritten on every session start.
    if (raw === next) return settingsPath;

    if (raw !== '') copyFileSync(settingsPath, `${settingsPath}${COPILOT_SETTINGS_BACKUP_SUFFIX}`);
    writeFileAtomic(settingsPath, next);
    return settingsPath;
  });
}

/**
 * The environment that tells a hook which instance fired it.
 *
 * Applied to the launched process rather than through `tmux set-environment`:
 * the pane is created before the agent starts and the assignment then travels
 * with the one process that matters, out of reach of
 * `sanitizeSessionEnvironment` and of anything else that edits the session's
 * environment later.
 *
 * Returned as a map since Issue #1846. It used to be a pre-quoted
 * `NAME=value NAME=value` string that the caller concatenated in front of the
 * command — the same workaround codex, gemini and antigravity had each written
 * separately, all four assuming a shell nobody had declared. The rendering now
 * happens once, in `../launch-command`, and the bytes are identical.
 */
export function buildCopilotHookEnvironment(
  worktreeId: string,
  instanceId: string,
  options: CopilotHookSettingsOptions = {}
): Record<string, string> {
  return {
    [COPILOT_WORKTREE_ID_ENV]: worktreeId,
    [COPILOT_INSTANCE_ID_ENV]: instanceId,
    // Issue #1904. Not a secret — the launch line is typed into the pane and
    // shows up in `capture --json` (設計方針書 §10.7 / 受入条件 S18) — and the
    // one value that has to be *this* server's rather than the last one to
    // write the machine-global settings file.
    [COPILOT_HOOK_PORT_ENV]: String(options.port ?? getServerPort()),
  };
}

/**
 * Whether to inject at all.
 *
 * Shares `CM_AGENT_HOOKS_INJECT=0` with every other tool, so one switch rolls
 * the whole feature back. Re-read here rather than imported so that copilot's
 * rollback cannot come to depend on Claude's module loading first.
 */
export function isCopilotHookInjectionEnabled(): boolean {
  return process.env.CM_AGENT_HOOKS_INJECT !== '0';
}

/**
 * The command that launches copilot for one instance (S3 / S4 / S5).
 *
 * Never throws. Injection is an enhancement to a session that has to start
 * anyway, so every failure — the switch is off, an id would not survive the
 * receiver's own validation, the settings file is unreadable or unwritable —
 * returns the bare command and no settings path, which is byte-for-byte what
 * `cli-tools/copilot.ts` sent before this Issue.
 *
 * @param executablePath - Normally {@link COPILOT_LAUNCH_COMMAND}
 * @param target - The instance being started
 */
export function buildCopilotLaunchCommand(
  executablePath: string,
  target: AgentInstanceRef,
  options: CopilotHookSettingsOptions = {}
): AgentLaunchPlan {
  const bare: AgentLaunchPlan = { command: executablePath, settingsPath: null, env: {} };
  if (!isCopilotHookInjectionEnabled()) return bare;

  const instanceId = target.instanceId ?? COPILOT_CLI_TOOL_ID;
  if (!isValidInstanceId(instanceId) || !isValidWorktreeId(target.worktreeId)) {
    // Both become URL parameters the receivers re-validate; a value that would
    // be rejected there is not worth injecting, and a rejected event is worse
    // than no event because it is a 400 in the operator's log for every turn.
    logger.warn('copilot-hook-invalid-correlation-key', { worktreeId: target.worktreeId });
    return bare;
  }

  try {
    const settingsPath = writeCopilotHookSettings(options);
    return {
      command: executablePath,
      settingsPath,
      env: buildCopilotHookEnvironment(target.worktreeId, instanceId, options),
    };
  } catch (error) {
    if (error instanceof CopilotConfigHooksShadowError) {
      // Its own reason code because it is the one failure here an operator can
      // fix: move `hooks` out of config.json and into settings.json, or let
      // copilot's own migration do it, and the next launch injects normally.
      logger.warn('copilot-hook-config-json-shadows-settings', {
        worktreeId: target.worktreeId,
        configPath: error.configPath,
      });
      return bare;
    }
    logger.warn('copilot-hook-settings-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return bare;
  }
}
