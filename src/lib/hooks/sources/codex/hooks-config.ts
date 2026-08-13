/**
 * codex's `hooks.json`, and the command line that gives one session its
 * correlation keys (Issue #1760, seams S3/S4/S5 for codex).
 *
 * Claude's equivalent is `lib/hooks/hook-settings-generator`, and the two look
 * nothing alike because codex's hook system differs from Claude's in four ways
 * that were all measured on codex-cli **0.147.0** rather than read out of a
 * document. Each one removes an option Claude has:
 *
 *  1. **There is no `--settings`.** codex reads `$CODEX_HOME/hooks.json` and
 *     `<cwd>/.codex/hooks.json` and nothing else — no per-launch file, no
 *     `--config` pointing at one (#1757 §5.1.2; `hooks.managed_dir` exists as a
 *     key and fired zero times). So the file cannot carry a worktree id or an
 *     instance id the way Claude's does: whatever is written is shared by every
 *     codex session on the machine.
 *  2. **`type: "http"` destroys the file.** One `http` handler and codex
 *     discards the whole of `hooks.json` — every `command` hook with it — after
 *     printing one line to stderr that the TUI never shows (#1757 §5.1.4). The
 *     only delivery mechanism is `type: "command"`.
 *  3. **A hook command runs through a shell.** Measured directly for this Issue
 *     against 0.147.0: `$VAR` expands, `"…"` and `'…'` group, `${VAR:+…}`
 *     works, `&` inside quotes is literal, and a `#` comment is ignored. The
 *     hook process also inherits the environment of the shell that started
 *     codex. **That is what makes point 1 survivable**: the file stays static
 *     and the per-session keys travel in environment variables set on the
 *     launch line, so `codex` and `codex-2` in one worktree report as
 *     themselves. Verified live — a session launched with
 *     `CM_AGENT_INSTANCE_ID=codex-2` posted `instanceId: "codex-2"`.
 *  4. **Hooks do not run until a human trusts them.** Trust is recorded in the
 *     user's own `~/.codex/config.toml` as
 *     `[hooks.state."<file>:<event>:0:0"] trusted_hash`, and an untrusted hook
 *     is skipped in complete silence (#1757 P4). CommandMate does not write
 *     that file — see {@link isCodexHookTrustBypassEnabled} for the whole of
 *     the reasoning, and `docs/design/agent-event-source-interface.md`.
 *
 * ## Why `$CODEX_HOME/hooks.json` and not `<worktree>/.codex/hooks.json`
 *
 * Both fire. The worktree-local file was rejected for two reasons: it is inside
 * a git checkout, so every worktree grows an untracked `.codex/` that shows up
 * in the Changes view and that an agent running `git add -A` can commit; and
 * trust is keyed by absolute path, so a per-worktree file means the human
 * re-answers the review dialog once per worktree, forever. The single file is
 * byte-identical for every worktree and every instance, which makes trust a
 * one-time act and makes a rewrite a no-op — {@link writeCodexHookSettings}
 * leaves the file untouched when the content already matches.
 *
 * The cost is that the file is shared with codex sessions CommandMate did not
 * start. Those post too, with the environment variables unset; the relay omits
 * the correlation keys it does not have and the receiver falls back to
 * resolving the worktree from `cwd`, which is exactly the hand-configured
 * behaviour of Issue #1549. `CM_AGENT_HOOKS_INJECT=0` turns the whole thing off.
 *
 * @module lib/hooks/sources/codex/hooks-config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { getServerPort } from '@/lib/env';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  AGENT_EVENT_PATH,
  AUTH_TOKEN_ENV_VAR,
  HOOK_TIMEOUT_SECONDS,
  isAuthTokenExpected,
  isHookInjectionEnabled,
  PERMISSION_REQUEST_PATH,
  PERMISSION_REQUEST_TIMEOUT_SECONDS,
  resolveRelayScriptPath,
  shellQuote,
} from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { isPlainObject } from '../event-mapper';
import type { AgentInstanceRef } from '../types';
import { CODEX_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/codex/hooks-config');

/** Loopback: the agent runs on the machine the server runs on. */
const CODEX_HOOK_HOST = '127.0.0.1';

/**
 * Marks a handler as this server's, so a rewrite replaces CommandMate's entries
 * and leaves the operator's alone.
 *
 * Spelled as a trailing shell comment rather than as an extra JSON field
 * because codex's config parser rejects what it does not know — an unknown
 * `type` takes the entire file down (#1757 §5.1.4), and an unknown key is not
 * worth finding out about the same way. Measured: a hook whose command ends
 * `… # commandmate:agent-hooks` runs and receives its arguments unchanged.
 */
export const CODEX_HOOK_MARKER = 'commandmate:agent-hooks';

/** `$CODEX_HOME` — codex's own override, honoured so a sandboxed codex stays sandboxed. */
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME';

/** Relay defaults to this tool when the hook does not pass `--tool`. */
export const CODEX_TOOL_ENV_VAR = 'CM_AGENT_TOOL';

/** Correlation key: which worktree this codex process belongs to. */
export const CODEX_WORKTREE_ID_ENV_VAR = 'CM_AGENT_WORKTREE_ID';

/**
 * Correlation key: which instance.
 *
 * The whole of the answer to "`codex` and `codex-2` run in the same directory".
 * `cwd` cannot tell them apart and neither can `session_id`; the environment of
 * the process can, because CommandMate is the one that starts it.
 */
export const CODEX_INSTANCE_ID_ENV_VAR = 'CM_AGENT_INSTANCE_ID';

/** Event receiver URL. Already the relay script's own environment override. */
export const CODEX_EVENT_URL_ENV_VAR = 'CM_HOOK_URL';

/** Auto-Yes v2 receiver URL, with the correlation keys already in its query. */
export const CODEX_PERMISSION_URL_ENV_VAR = 'CM_PERMISSION_HOOK_URL';

/** Opt-in switch for {@link CODEX_HOOK_TRUST_BYPASS_FLAG}; `bypass` is the only value that acts. */
export const CODEX_HOOK_TRUST_ENV_VAR = 'CM_CODEX_HOOK_TRUST';

/** codex's own flag for running unreviewed hooks, for one invocation. */
export const CODEX_HOOK_TRUST_BYPASS_FLAG = '--dangerously-bypass-hook-trust';

/**
 * `SessionEnd`'s budget, in seconds.
 *
 * Not a preference: codex clamps this hook to 3 s and says so in the TUI
 * (`⚠ clamping SessionEnd hook timeout to 3s in …/hooks.json`), measured on
 * 0.147.0. Writing {@link HOOK_TIMEOUT_SECONDS} here would put a warning banner
 * above every session for a value codex was going to ignore.
 */
export const CODEX_SESSION_END_TIMEOUT_SECONDS = 3;

/**
 * The events CommandMate registers, and the word each maps to.
 *
 * Four of codex's eleven. What is deliberately absent matters more than what is
 * here:
 *
 *  - **`Notification` does not exist on codex** (#1757 §5.1.1: the review screen
 *    enumerates eleven events and it is not among them). Writing one is
 *    discarded in silence.
 *  - **`PreToolUse` / `PostToolUse` are not registered**, though they do fire.
 *    Claude registers them for the single matcher `AskUserQuestion` (#1726)
 *    because that tool's arguments *are* the question a human has to answer.
 *    codex has no such tool, so the only thing registering them would buy is
 *    two POSTs per tool call — on a session that greps in a loop, two requests
 *    per `Read`, each of which the agent waits for. `capabilities.supportedEvents`
 *    says so, so nothing above waits for a word that cannot arrive.
 *  - **`PermissionRequest` is not here** because it is not an observation: its
 *    response body is a decision codex obeys, so it goes to its own receiver
 *    through {@link buildCodexPermissionHookCommand}.
 */
export const CODEX_REGISTERED_EVENTS: Readonly<Record<string, AgentEventType>> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  SessionEnd: 'session_end',
};

/** codex's spelling of the event whose reply is a verdict (#1757 §5.1.6). */
export const CODEX_PERMISSION_REQUEST_EVENT = 'PermissionRequest';

/** The four words a codex session can actually produce, given the config above. */
export const CODEX_SUPPORTED_EVENTS: readonly AgentEventType[] = Object.values(
  CODEX_REGISTERED_EVENTS
);

/** A single handler in a codex hook matcher group. Only `command` is representable. */
export interface CodexHookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

export interface CodexHookMatcherGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}

export interface CodexHookSettings {
  hooks: Record<string, CodexHookMatcherGroup[]>;
}

export interface CodexHookOptions {
  /** Defaults to {@link getServerPort}. */
  port?: number;
  /** Defaults to `$CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
  /** Defaults to the shipped relay, or an inline `curl` when it is missing. */
  relayScriptPath?: string | null;
  /** Defaults to {@link isAuthTokenExpected}. */
  withAuthHeader?: boolean;
}

/**
 * Whether to launch codex with {@link CODEX_HOOK_TRUST_BYPASS_FLAG}.
 *
 * **Off by default, and the default is the security decision.** The flag
 * disables review for *every* hook the invocation can see, which includes
 * `<cwd>/.codex/hooks.json` — a file that lives inside the repository being
 * worked on. Turning it on by default would mean that cloning a hostile
 * repository and opening it in CommandMate runs whatever that repository put in
 * `.codex/hooks.json`, with no dialog, defeating the exact mechanism codex
 * built to prevent it. A structured `Stop` event is not worth that.
 *
 * So the default posture is: CommandMate writes the config and never grants the
 * trust. The human grants it once, through codex's own review screen, which is
 * also the only thing that may write `~/.codex/config.toml` — a file this
 * server never touches (it holds, among other things, the `notify` entry a
 * user's Computer Use integration depends on). Until then the hooks are inert,
 * the screen scraper keeps doing what it did before this Issue, and
 * `cli-tools/codex` dismisses the review dialog so a session still starts.
 *
 * `CM_CODEX_HOOK_TRUST=bypass` exists for headless and CI operators who have
 * weighed that trade for themselves.
 */
export function isCodexHookTrustBypassEnabled(): boolean {
  return process.env[CODEX_HOOK_TRUST_ENV_VAR] === 'bypass';
}

/** `$CODEX_HOME`, or `~/.codex`. */
export function getCodexHome(options: CodexHookOptions = {}): string {
  if (options.codexHome) return options.codexHome;
  return process.env[CODEX_HOME_ENV_VAR] || join(homedir(), '.codex');
}

/** Absolute path of the hooks file codex reads. */
export function getCodexHooksPath(options: CodexHookOptions = {}): string {
  return join(getCodexHome(options), 'hooks.json');
}

/**
 * Receiver URL for a manually launched codex, as a shell expansion.
 *
 * Every session CommandMate starts has the variable set, so this default is
 * only reached by a codex the operator ran themselves. It mirrors the relay
 * script's own default (`CM_PORT`, else 3000) rather than baking in the port of
 * whichever server happened to write the file — the file is machine-wide and
 * this repository is routinely run as several servers at once.
 */
function fallbackUrlExpression(path: string, query: string): string {
  return `http://${CODEX_HOOK_HOST}:\${CM_PORT:-3000}${path}${query}`;
}

/**
 * The command for one lifecycle event.
 *
 * Prefers the shipped relay, which already reads codex's payload from stdin,
 * omits correlation keys it was handed empty, and exits 0 when the POST fails.
 * The inline fallback posts codex's payload verbatim to the same receiver —
 * which reads it, because the source's mappers know `hook_event_name`.
 */
export function buildCodexEventHookCommand(
  event: AgentEventType,
  options: CodexHookOptions = {}
): string {
  const marker = ` # ${CODEX_HOOK_MARKER}`;
  const relay =
    options.relayScriptPath === undefined ? resolveRelayScriptPath() : options.relayScriptPath;

  if (relay) {
    return (
      [
        shellQuote(relay),
        '--tool',
        CODEX_CLI_TOOL_ID,
        '--event',
        event,
        // Quoted so an unset variable is one empty argument rather than none;
        // the relay drops an empty correlation key and falls back to `cwd`.
        '--worktree-id',
        `"$${CODEX_WORKTREE_ID_ENV_VAR}"`,
        '--instance-id',
        `"$${CODEX_INSTANCE_ID_ENV_VAR}"`,
        '--stdin-json',
      ].join(' ') + marker
    );
  }

  const withAuthHeader = options.withAuthHeader ?? isAuthTokenExpected();
  const auth = withAuthHeader ? ` -H "Authorization: Bearer $${AUTH_TOKEN_ENV_VAR}"` : '';
  // `${VAR:+&k=$VAR}` so a manually launched codex posts no empty correlation
  // key at all, rather than one the receiver has to reject.
  const url =
    `"\${${CODEX_EVENT_URL_ENV_VAR}:-${fallbackUrlExpression(AGENT_EVENT_PATH, '')}}` +
    `?tool=${CODEX_CLI_TOOL_ID}` +
    `\${${CODEX_WORKTREE_ID_ENV_VAR}:+&worktreeId=$${CODEX_WORKTREE_ID_ENV_VAR}}` +
    `\${${CODEX_INSTANCE_ID_ENV_VAR}:+&instanceId=$${CODEX_INSTANCE_ID_ENV_VAR}}"`;
  return (
    `curl -sS -f -m ${HOOK_TIMEOUT_SECONDS} -X POST -H 'Content-Type: application/json'${auth} ` +
    `--data-binary @- ${url} >/dev/null 2>&1 || true${marker}`
  );
}

/**
 * The command for `PermissionRequest`, whose stdout **is** the verdict.
 *
 * Never the relay: that script discards the response body, and the body is the
 * entire point here. `curl` writes what the receiver answers straight to
 * stdout, which is where codex reads a command hook's decision from — measured
 * live for this Issue: an `{"hookSpecificOutput":{…"behavior":"allow"}}` reply
 * ran the command with no dialog, `{}` produced the ordinary approval dialog,
 * and a receiver that was not running produced the same dialog a second later.
 *
 * `-f` so an HTTP error prints nothing, `2>/dev/null` so a connection failure
 * prints nothing, `|| true` so the hook exits 0. All three land on the same
 * behaviour: no output, and codex asks the human — which is what it does with
 * no hook installed at all.
 */
export function buildCodexPermissionHookCommand(options: CodexHookOptions = {}): string {
  const withAuthHeader = options.withAuthHeader ?? isAuthTokenExpected();
  const auth = withAuthHeader ? ` -H "Authorization: Bearer $${AUTH_TOKEN_ENV_VAR}"` : '';
  const url =
    `"\${${CODEX_PERMISSION_URL_ENV_VAR}:-` +
    `${fallbackUrlExpression(PERMISSION_REQUEST_PATH, `?tool=${CODEX_CLI_TOOL_ID}`)}}"`;
  return (
    `curl -sS -f -m ${PERMISSION_REQUEST_TIMEOUT_SECONDS} -X POST ` +
    `-H 'Content-Type: application/json'${auth} --data-binary @- ${url} ` +
    `2>/dev/null || true # ${CODEX_HOOK_MARKER}`
  );
}

/**
 * The hooks CommandMate contributes.
 *
 * Deterministic and free of per-session values: the same bytes on every
 * worktree, every instance and every server on the machine. That is what makes
 * the human's one-time trust survive a restart — codex keys trust by the hash
 * of the handler, so a file that changed would have to be reviewed again.
 */
export function buildCodexHookSettings(options: CodexHookOptions = {}): CodexHookSettings {
  const handler = (event: AgentEventType, timeout: number): CodexHookMatcherGroup => ({
    hooks: [{ type: 'command', command: buildCodexEventHookCommand(event, options), timeout }],
  });

  const hooks: Record<string, CodexHookMatcherGroup[]> = {};
  for (const [nativeName, event] of Object.entries(CODEX_REGISTERED_EVENTS)) {
    const timeout =
      nativeName === 'SessionEnd' ? CODEX_SESSION_END_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
    hooks[nativeName] = [handler(event, timeout)];
  }
  hooks[CODEX_PERMISSION_REQUEST_EVENT] = [
    {
      hooks: [
        {
          type: 'command',
          command: buildCodexPermissionHookCommand(options),
          timeout: PERMISSION_REQUEST_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return { hooks };
}

/** Whether a handler was written by this server. */
function isCommandMateHandler(handler: unknown): boolean {
  if (!isPlainObject(handler)) return false;
  return typeof handler.command === 'string' && handler.command.includes(CODEX_HOOK_MARKER);
}

/**
 * Drop this server's previous handlers from one event's groups, keeping
 * everything else — including groups that end up empty, which are the
 * operator's to remove.
 */
function withoutCommandMateHandlers(groups: unknown[]): unknown[] {
  return groups
    .map((group) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return group;
      const kept = group.hooks.filter((handler) => !isCommandMateHandler(handler));
      if (kept.length === group.hooks.length) return group;
      return { ...group, hooks: kept };
    })
    .filter((group) => {
      // A group that held nothing but our handler is ours to remove; one the
      // operator wrote empty is left exactly as found.
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return true;
      return group.hooks.length > 0;
    });
}

/**
 * Fold the generated hooks into whatever is already in the file.
 *
 * The file is the operator's, and on most machines it is the *only* place their
 * own codex hooks can live — there is no second file to put them in. So this
 * appends rather than replaces: unrelated events keep their handlers, unrelated
 * top-level keys are carried through untouched, and a handler this server wrote
 * earlier is replaced rather than duplicated.
 *
 * An event whose existing value is not an array is left exactly as it is and
 * gets no handler from us. Overwriting a shape this function does not
 * understand would cost the operator a config it presumably tested.
 *
 * @param existing - The parsed file, or null when there was none
 * @param generated - {@link buildCodexHookSettings}
 * @returns The object to serialise
 */
export function mergeCodexHookSettings(
  existing: unknown,
  generated: CodexHookSettings
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  const existingHooks = isPlainObject(base.hooks) ? base.hooks : {};
  const merged: Record<string, unknown> = {};

  for (const [event, groups] of Object.entries(existingHooks)) {
    merged[event] = Array.isArray(groups) ? withoutCommandMateHandlers(groups) : groups;
  }

  for (const [event, groups] of Object.entries(generated.hooks)) {
    const current = merged[event];
    if (current !== undefined && !Array.isArray(current)) continue;
    merged[event] = [...((current as unknown[]) ?? []), ...groups];
  }

  base.hooks = merged;
  return base;
}

/**
 * Write the hooks file, and answer where it is.
 *
 * Idempotent to the byte: when the merged content already matches, the file is
 * not opened for writing at all, so a machine whose hooks are trusted keeps its
 * mtime and its trust and sees no review dialog on the next launch.
 *
 * @returns The path, or null when the file could not be prepared — which the
 *   caller turns into "start codex without hooks", never into a failed launch
 */
export function writeCodexHookSettings(options: CodexHookOptions = {}): string | null {
  const settingsPath = getCodexHooksPath(options);

  let existing: unknown = null;
  let previous: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      previous = readFileSync(settingsPath, 'utf8');
      existing = JSON.parse(previous);
    } catch (error) {
      // Someone's file that this server cannot read is someone's file this
      // server must not overwrite. Injection is skipped; the session starts.
      logger.warn('codex-hooks-config-unreadable', {
        settingsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  const content = `${JSON.stringify(mergeCodexHookSettings(existing, buildCodexHookSettings(options)), null, 2)}\n`;
  if (previous === content) return settingsPath;

  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, content, { mode: 0o600 });
  return settingsPath;
}

/**
 * The command that starts codex for one instance.
 *
 * Never throws: hooks are an enhancement to a session that has to start anyway,
 * so anything that goes wrong here returns the bare executable — which is
 * byte-for-byte the pre-#1760 launch.
 *
 * The environment assignments are the per-session half of the design. The
 * hooks file cannot hold them (there is one file for the machine), the payload
 * cannot supply them (`cwd` is identical for `codex` and `codex-2`, and
 * `session_id` changes under the instance), and codex injects nothing of its
 * own (#1757 §5.1.7 found no `CLAUDE_PROJECT_DIR` equivalent). What is left is
 * the environment of the process CommandMate starts, which a hook inherits.
 *
 * @param executablePath - Resolved codex CLI path or bare command name
 * @param target - The instance being started
 * @returns `<assignments> <codex>`, or `executablePath` unchanged when
 *   injection is off, the ids are unusable, or the file could not be written
 */
export function buildCodexLaunchCommand(
  executablePath: string,
  target: AgentInstanceRef,
  options: CodexHookOptions = {}
): string {
  if (!isHookInjectionEnabled()) return executablePath;

  const instanceId = target.instanceId ?? CODEX_CLI_TOOL_ID;
  if (!isValidWorktreeId(target.worktreeId) || !isValidInstanceId(instanceId)) {
    // Both become URL parameters the receiver re-validates; a value that would
    // be rejected there is not worth injecting.
    logger.warn('codex-hooks-invalid-correlation-key', { worktreeId: target.worktreeId });
    return executablePath;
  }

  try {
    const settingsPath = writeCodexHookSettings(options);
    if (!settingsPath) return executablePath;

    const port = options.port ?? getServerPort();
    const query = new URLSearchParams({
      tool: CODEX_CLI_TOOL_ID,
      worktreeId: target.worktreeId,
      instanceId,
    });
    const assignments = [
      // Pin the home the file was just written to, rather than trusting the
      // agent to resolve the same one. Measured on 2026-08-13: a tmux session
      // inherits the environment of the *tmux server*, which was started long
      // before CommandMate and knows nothing about its environment — so a
      // server run with `CODEX_HOME=…` wrote its hooks into that directory
      // while the codex it launched read `~/.codex` and found none. No error,
      // no missing file, simply zero events. Naming it here makes "the file we
      // wrote" and "the file codex reads" the same file by construction; in the
      // ordinary case where nothing sets it, this is the default codex would
      // have picked anyway.
      `${CODEX_HOME_ENV_VAR}=${shellQuote(getCodexHome(options))}`,
      `${CODEX_TOOL_ENV_VAR}=${shellQuote(CODEX_CLI_TOOL_ID)}`,
      `${CODEX_WORKTREE_ID_ENV_VAR}=${shellQuote(target.worktreeId)}`,
      `${CODEX_INSTANCE_ID_ENV_VAR}=${shellQuote(instanceId)}`,
      `${CODEX_EVENT_URL_ENV_VAR}=${shellQuote(
        `http://${CODEX_HOOK_HOST}:${port}${AGENT_EVENT_PATH}`
      )}`,
      `${CODEX_PERMISSION_URL_ENV_VAR}=${shellQuote(
        `http://${CODEX_HOOK_HOST}:${port}${PERMISSION_REQUEST_PATH}?${query.toString()}`
      )}`,
    ];
    const trust = isCodexHookTrustBypassEnabled() ? ` ${CODEX_HOOK_TRUST_BYPASS_FLAG}` : '';
    return `${assignments.join(' ')} ${shellQuote(executablePath)}${trust}`;
  } catch (error) {
    logger.warn('codex-hooks-config-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return executablePath;
  }
}
