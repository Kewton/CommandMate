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
 * @module lib/hooks/sources/copilot/hook-settings
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
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
  /** Defaults to {@link getServerPort}. */
  port?: number;
  /** Defaults to the shipped relay, or an inline `curl` when it is missing. */
  relayScriptPath?: string | null;
  /** Defaults to {@link getCopilotSettingsPath}. */
  settingsPath?: string;
}

/**
 * Copilot's home directory.
 *
 * `COPILOT_HOME` is copilot's own override and the only session-scoped
 * injection point it has; honouring it means an operator who isolates copilot
 * gets an isolated hook config too, and tests get a directory that is not the
 * developer's.
 */
export function getCopilotHomeDirectory(): string {
  return process.env.COPILOT_HOME || join(homedir(), '.copilot');
}

/** The one file copilot reads hooks from. */
export function getCopilotSettingsPath(): string {
  return join(getCopilotHomeDirectory(), 'settings.json');
}

function receiverUrl(path: string, options: CopilotHookSettingsOptions): string {
  return `http://${HOOK_HOST}:${options.port ?? getServerPort()}${path}`;
}

/**
 * The guard every generated command opens with.
 *
 * Consumes stdin before exiting rather than exiting straight away: copilot
 * writes the payload to the hook's stdin, and a hook that exits first turns
 * that write into an EPIPE on the agent's side.
 *
 * @param onSkip - Extra shell to run before exiting, e.g. printing a body
 */
function guardPrelude(onSkip: string = ''): string {
  return (
    `: ${COPILOT_HOOK_MARKER}; ` +
    `if [ -z "\${${COPILOT_WORKTREE_ID_ENV}:-}" ]; then cat >/dev/null; ${onSkip}exit 0; fi; `
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
 */
function curlArgumentPreamble(): string {
  return (
    `set -- -sS -m ${COPILOT_HOOK_CURL_TIMEOUT_SECONDS} -X POST ` +
    `-H 'Content-Type: application/json'; ` +
    `if [ -n "\${${COPILOT_AUTH_TOKEN_ENV}:-}" ]; then ` +
    `set -- "$@" -H "Authorization: Bearer $${COPILOT_AUTH_TOKEN_ENV}"; fi; `
  );
}

/**
 * A receiver URL with the correlation keys appended at fire time.
 *
 * The static half is single-quoted and the variables are double-quoted next to
 * it, so the shell concatenates them into one word without re-splitting. Both
 * ids are validated before injection ({@link buildCopilotLaunchCommand}) and
 * draw from `[A-Za-z0-9_-]`, so no percent-encoding is required.
 */
function runtimeCorrelatedUrl(base: string): string {
  return (
    `${shellQuote(`${base}?tool=${COPILOT_CLI_TOOL_ID}&worktreeId=`)}${WORKTREE_EXPANSION}` +
    `'&instanceId='${INSTANCE_EXPANSION}`
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
  const url = receiverUrl(AGENT_EVENT_PATH, options);
  const relay =
    options.relayScriptPath === undefined ? resolveRelayScriptPath() : options.relayScriptPath;

  if (relay) {
    return (
      guardPrelude() +
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
        shellQuote(url),
        '--stdin-json',
      ].join(' ')
    );
  }

  return (
    guardPrelude() +
    curlArgumentPreamble() +
    `curl "$@" --data-binary @- ${runtimeCorrelatedUrl(url)} >/dev/null 2>&1 || true`
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
  options: CopilotHookSettingsOptions = {}
): string {
  const url = receiverUrl(PERMISSION_REQUEST_PATH, options);
  return (
    guardPrelude(`printf '{}'; `) +
    curlArgumentPreamble() +
    `out=$(curl "$@" --data-binary @- ${runtimeCorrelatedUrl(url)} 2>/dev/null); ` +
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

/**
 * Read the user's `settings.json`.
 *
 * @returns The parsed object, or `{}` when the file does not exist
 * @throws When the file exists but cannot be read or is not a JSON object —
 *   the caller turns that into "start without hooks", never into a rewrite
 */
export function readCopilotSettings(settingsPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error('copilot settings.json is not a JSON object');
  }
  return parsed;
}

/**
 * Merge the generated hooks into copilot's settings file and return its path.
 *
 * @throws Anything the read, the merge or the write throws. Callers must treat
 *   a throw as "launch without hooks" (fail-open).
 */
export function writeCopilotHookSettings(options: CopilotHookSettingsOptions = {}): string {
  const settingsPath = options.settingsPath ?? getCopilotSettingsPath();
  const merged = mergeCopilotHookSettings(
    readCopilotSettings(settingsPath),
    buildCopilotHookSettings(options)
  );
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return settingsPath;
}

/**
 * The environment assignments that tell a hook which instance fired it.
 *
 * A prefix on the command line rather than `tmux set-environment`: the pane is
 * created before the agent starts and the assignment then travels with the one
 * process that matters, out of reach of `sanitizeSessionEnvironment` and of
 * anything else that edits the session's environment later.
 */
export function buildCopilotEnvironmentPrefix(worktreeId: string, instanceId: string): string {
  return (
    `${COPILOT_WORKTREE_ID_ENV}=${shellQuote(worktreeId)} ` +
    `${COPILOT_INSTANCE_ID_ENV}=${shellQuote(instanceId)}`
  );
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
  const bare: AgentLaunchPlan = { command: executablePath, settingsPath: null };
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
      command: `${buildCopilotEnvironmentPrefix(target.worktreeId, instanceId)} ${executablePath}`,
      settingsPath,
    };
  } catch (error) {
    logger.warn('copilot-hook-settings-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return bare;
  }
}
