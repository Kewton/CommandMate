/**
 * The `--settings` payload CommandMate injects when it starts a Claude session
 * (Issue #1722).
 *
 * Issue #1549 gave the server a receiver for structured agent events and a
 * relay script to post them, but left the wiring to the operator: the events
 * only existed on machines where somebody had edited `~/.claude/settings.json`
 * by hand. This module closes that gap by handing Claude its own hook config at
 * launch, per (worktreeId, instanceId).
 *
 * Four facts from the live verification in Issue #1721
 * (`docs/design/agent-hooks-live-verification.md`) shape everything below. They
 * are not in Claude Code's documentation, and three of the four fail *silently*
 * when ignored:
 *
 *  - **`SessionStart` silently ignores `type: "http"`** (D1). The debug log says
 *    `HTTP hooks are not supported for SessionStart`; stdout and the TUI say
 *    nothing at all. So `SessionStart` — and only `SessionStart` — goes through
 *    a `type: "command"` relay.
 *  - **`$VAR` in `headers` expands only for names listed in `allowedEnvVars`**
 *    (D7). A bearer header without the matching entry authenticates as the
 *    literal string `$CM_AUTH_TOKEN` and 401s.
 *  - **`--settings` hooks are concatenated with the user's own, not substituted
 *    for them**, and `~/.claude/settings.json` is left byte-identical. Manual
 *    Stop hooks from #1549 keep firing; see `agent-event-state`'s dedup for
 *    what happens when both arrive.
 *  - **Every hook failure is fail-open.** A refused connection or a timeout
 *    costs the event, never the session.
 *
 * Issue #1759 made this module *Claude's* config serialiser rather than *the*
 * config serialiser: it is reached through `claudeAgentEventSource.prepareLaunch`
 * (seams S3/S4/S5), and the four other hook tools each bring their own — their
 * files live in different places, nest differently, and cannot use `type:"http"`
 * at all. Nothing here changed; only who calls it did.
 *
 * The generated file is written rather than passed inline. `--settings` does
 * accept a JSON string (D2), but the launch command travels to the CLI through
 * `tmux send-keys` as a single line, and a ~1 KB argument of braces, quotes and
 * a deliberately unexpanded `$CM_AUTH_TOKEN` is a worse thing to put on that
 * line than a path.
 *
 * @module lib/hooks/hook-settings-generator
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getServerPort } from '@/lib/env';
import { isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { CLAUDE_CLI_TOOL_ID } from '@/lib/hooks/sources/claude/tool-id';
import { ASK_USER_QUESTION_TOOL } from '@/lib/hooks/permission-request-payload';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/hook-settings-generator');

/** Loopback: the agent runs on the machine the server runs on, whatever CM_BIND says. */
const HOOK_HOST = '127.0.0.1';

/** Receiver path. Mirrors `src/app/api/hooks/agent-event/route.ts`. */
export const AGENT_EVENT_PATH = '/api/hooks/agent-event';

/**
 * Auto-Yes v2 receiver (Issue #1724). Mirrors
 * `src/app/api/hooks/permission-request/route.ts`.
 *
 * Separate from {@link AGENT_EVENT_PATH} because the two have opposite
 * contracts: that one is fire-and-forget, this one blocks the agent until it
 * answers and its body is obeyed.
 */
export const PERMISSION_REQUEST_PATH = '/api/hooks/permission-request';

/**
 * Seconds a hook may block the agent.
 *
 * The receiver answers 202 without doing any work of its own, so this only ever
 * matters when the server is wedged or gone. It is well under the 30 s Claude
 * defaults to for `UserPromptSubmit`, which is the one event whose hook the
 * human is sitting and waiting for.
 */
export const HOOK_TIMEOUT_SECONDS = 5;

/**
 * Seconds `PermissionRequest` may block the agent (Issue #1724).
 *
 * Claude's default for an `http` hook is 600 s, and there is no `async` for
 * http (D4/§5.3.6), so this number is how long a wedged server delays every
 * approval dialog on the machine. The receiver decides from in-memory Auto-Yes
 * state and a TTL-cached policy, so the budget is generous by orders of
 * magnitude; it is small because the failure mode it bounds is the server being
 * gone, and a hook failure is fail-open — the dialog appears, five seconds late.
 */
export const PERMISSION_REQUEST_TIMEOUT_SECONDS = 5;

/**
 * Environment variable carrying the bearer token, per
 * `docs/user-guide/agent-event-hooks.md`. Must appear in `allowedEnvVars` for
 * the `$`-reference in `headers` to expand at all (D7).
 */
export const AUTH_TOKEN_ENV_VAR = 'CM_AUTH_TOKEN';

/**
 * `Notification` matcher.
 *
 * Matched against the payload's `notification_type`, not its human-facing
 * `message` (D3). A matcher that names nothing is not an error — it simply
 * fires zero times — so a typo here is another silent failure.
 */
export const NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt';

/**
 * `PreToolUse` / `PostToolUse` matcher (Issue #1726).
 *
 * Matched against `tool_name`. Deliberately the single tool whose input this
 * server has a use for: `AskUserQuestion` is the only call whose arguments *are*
 * the thing the human has to answer, and a matcher covering every tool would
 * post two payloads per tool call for nothing — on a hot loop that is two
 * requests per `Read`, each of which blocks the agent for as long as the
 * receiver takes.
 */
export const TOOL_USE_MATCHER = ASK_USER_QUESTION_TOOL;

/**
 * Bash spellings this server refuses to let an agent run (Issue #1739).
 *
 * On 2026-08-06 a delegated worker restarted its own isolated server with
 * `pkill -f "node dist/server/server.js"`. `-f` matches the whole command line,
 * so it also hit the operator's production server on port 3000 and the global
 * instance on 60301 — two processes the worker did not know existed and could
 * not see. Nothing was recovered until a human rebuilt and restarted by hand.
 *
 * Three earlier layers were in place and none of them stopped it:
 *
 *  - The delegation contract said "do not touch port 3000". That is a rule about
 *    the *target*, and the worker's subjective target was its own server; the
 *    blast radius is exactly what a pattern kill hides from its caller.
 *  - A permission dialog did appear — and Auto-Yes approved it. Auto-Yes v2
 *    answers the `PermissionRequest` hook (#1724), so anything that reaches a
 *    dialog reaches its verdict.
 *  - The contract's `autoYes.denyPatterns` would have escalated to a human, but
 *    escalation is only as good as the pattern somebody remembered to write.
 *
 * `permissions.deny` sits *underneath* all three: a denied rule is refused
 * before a dialog exists, so there is no `PermissionRequest` for Auto-Yes to
 * answer and no wording in a contract for a worker to reinterpret. Verified
 * live in `docs/design/agent-hooks-permission-deny-verification.md`.
 *
 * The list is deliberately about the *means*, not the target: every entry names
 * a way of selecting processes by pattern rather than by identity. Stopping a
 * process you started yourself stays available through its pid — `kill
 * "$(cat pidfile)"` matches nothing here — which is the idiom
 * `docs/user-guide/agent-event-hooks.md` §0.7 tells operators to use.
 *
 * `kill -9` is on the list even though it takes a pid, because `kill -9 -1`
 * signals every process the user owns and `kill -9 -<pgid>` a whole group; the
 * default `kill` (SIGTERM) is untouched, so the graceful spelling of the same
 * intent is the one that survives.
 */
export const PERMISSION_DENY_RULES: readonly string[] = [
  'Bash(pkill:*)',
  'Bash(killall:*)',
  'Bash(kill -9:*)',
];

/** Relay script shipped with the package (`files: ["scripts/hooks/"]`). */
const RELAY_SCRIPT_RELATIVE_PATH = join('scripts', 'hooks', 'cmate-agent-event.sh');

export interface HookSettingsTarget {
  worktreeId: string;
  /** Defaults to the primary instance (`instanceId === cliToolId`). */
  instanceId?: string;
  /** Defaults to {@link CLAUDE_CLI_TOOL_ID}; this generator writes Claude's file. */
  cliToolId?: CLIToolType;
}

export interface HookSettingsOptions {
  /** Defaults to {@link getServerPort}. */
  port?: number;
  /** Defaults to the shipped relay, or an inline `curl` when it is missing. */
  relayScriptPath?: string | null;
  /**
   * Whether to send `Authorization: Bearer $CM_AUTH_TOKEN`. Defaults to
   * {@link isAuthTokenExpected}.
   */
  withAuthHeader?: boolean;
  /** Defaults to `~/.commandmate/hooks`; overridable with `CM_AGENT_HOOKS_DIR`. */
  directory?: string;
}

/** A single entry in a Claude Code hook matcher group. */
export type ClaudeHookHandler =
  | {
      type: 'http';
      url: string;
      headers: Record<string, string>;
      allowedEnvVars?: string[];
      timeout: number;
    }
  | { type: 'command'; command: string; timeout: number };

export interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookHandler[];
}

/**
 * The `permissions` block of the injected settings.
 *
 * Only `deny` is written. `allow` is deliberately absent: this file is handed to
 * every Claude session CommandMate starts, and pre-approving anything from here
 * would widen what an agent may do without a human having said so. `deny` only
 * ever narrows, which is why it is safe to inject unconditionally.
 */
export interface ClaudePermissionSettings {
  deny: string[];
}

export interface ClaudeHookSettings {
  hooks: Record<string, ClaudeHookMatcherGroup[]>;
  permissions: ClaudePermissionSettings;
}

/**
 * Whether to inject at all. `CM_AGENT_HOOKS_INJECT=0` is the rollback switch:
 * sessions start exactly as they did before this Issue.
 */
export function isHookInjectionEnabled(): boolean {
  return process.env.CM_AGENT_HOOKS_INJECT !== '0';
}

/**
 * Whether the agent's environment is expected to carry a bearer token.
 *
 * The server only ever sees `CM_AUTH_TOKEN_HASH`, so it cannot read the token
 * itself — but a configured hash means every request to this receiver needs one,
 * and the agent inherits the server's environment through tmux.
 */
export function isAuthTokenExpected(): boolean {
  return Boolean(process.env[AUTH_TOKEN_ENV_VAR] || process.env.CM_AUTH_TOKEN_HASH);
}

/** Directory the generated settings files live in. */
export function getHookSettingsDirectory(options: HookSettingsOptions = {}): string {
  if (options.directory) return options.directory;
  const override = process.env.CM_AGENT_HOOKS_DIR;
  if (override) return override;
  return join(homedir(), '.commandmate', 'hooks');
}

/** The instance this settings file speaks for; primary when unspecified. */
export function resolveTargetInstanceId(target: HookSettingsTarget): string {
  const cliToolId = target.cliToolId ?? CLAUDE_CLI_TOOL_ID;
  const instanceId = target.instanceId ?? cliToolId;
  return instanceId;
}

/**
 * Absolute path of the settings file for one (worktreeId, instanceId).
 *
 * The readable part is sanitised because it becomes a filename; the hash of the
 * raw pair is appended so sanitisation cannot collapse two distinct instances
 * onto one file. Deterministic: the same pair always names the same file, so a
 * restart overwrites rather than accumulates.
 */
export function getHookSettingsPath(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  const cliToolId = target.cliToolId ?? CLAUDE_CLI_TOOL_ID;
  const instanceId = resolveTargetInstanceId(target);
  const slug = `${cliToolId}-${target.worktreeId}-${instanceId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const digest = createHash('sha256')
    .update(JSON.stringify([cliToolId, target.worktreeId, instanceId]))
    .digest('hex')
    .slice(0, 12);
  return join(getHookSettingsDirectory(options), `${slug.slice(0, 80)}-${digest}.json`);
}

/**
 * Receiver URL with the correlation keys baked in.
 *
 * This is the whole of the instance correlation. `cwd` cannot do the job —
 * `claude` and `claude-2` in the same worktree report the identical directory,
 * which is why `route.ts` had to hard-code the primary instance — and
 * `session_id` cannot either, because `/clear` issues a new one mid-session
 * while the instance stays the same (D7 §1.1). The URL is fixed at injection
 * time and outlives both.
 */
export function buildAgentEventUrl(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  return buildReceiverUrl(AGENT_EVENT_PATH, target, options);
}

/**
 * Auto-Yes v2 receiver URL, with the same correlation keys baked in
 * (Issue #1724).
 *
 * They matter more here than on the event path: a verdict applied to the wrong
 * instance is an approval the operator never asked for, and `cwd` cannot tell
 * `claude` from `claude-2`.
 */
export function buildPermissionRequestUrl(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  return buildReceiverUrl(PERMISSION_REQUEST_PATH, target, options);
}

function buildReceiverUrl(
  path: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions
): string {
  const cliToolId = target.cliToolId ?? CLAUDE_CLI_TOOL_ID;
  const port = options.port ?? getServerPort();
  const params = new URLSearchParams({
    tool: cliToolId,
    worktreeId: target.worktreeId,
    instanceId: resolveTargetInstanceId(target),
  });
  return `http://${HOOK_HOST}:${port}${path}?${params.toString()}`;
}

/** Absolute path of the shipped relay script, or null when it is not on disk. */
export function resolveRelayScriptPath(): string | null {
  const candidate = resolve(process.cwd(), RELAY_SCRIPT_RELATIVE_PATH);
  return existsSync(candidate) ? candidate : null;
}

/** Wrap a value so a POSIX shell reproduces it byte-for-byte. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildHttpHandler(
  url: string,
  withAuthHeader: boolean,
  timeout: number = HOOK_TIMEOUT_SECONDS
): ClaudeHookHandler {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const handler: ClaudeHookHandler = {
    type: 'http',
    url,
    headers,
    timeout,
  };
  if (withAuthHeader) {
    headers.Authorization = `Bearer $${AUTH_TOKEN_ENV_VAR}`;
    // D7: without this the header is sent as the literal `$CM_AUTH_TOKEN`.
    handler.allowedEnvVars = [AUTH_TOKEN_ENV_VAR];
  }
  return handler;
}

/**
 * The `SessionStart` relay command (D1: http is skipped in silence there).
 *
 * Prefers the shipped script, which already knows how to read Claude's stdin
 * payload and how to fail open. When the package layout puts it out of reach,
 * an inline `curl` posts the same payload to the same URL — the receiver reads
 * Claude's native shape as well as the script's.
 */
export function buildSessionStartCommand(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  const url = buildAgentEventUrl(target, options);
  const withAuthHeader = options.withAuthHeader ?? isAuthTokenExpected();
  const relay =
    options.relayScriptPath === undefined ? resolveRelayScriptPath() : options.relayScriptPath;

  if (relay) {
    return [
      shellQuote(relay),
      '--tool',
      shellQuote(target.cliToolId ?? CLAUDE_CLI_TOOL_ID),
      '--event',
      'session_start',
      '--worktree-id',
      shellQuote(target.worktreeId),
      '--instance-id',
      shellQuote(resolveTargetInstanceId(target)),
      '--url',
      shellQuote(url),
      '--stdin-json',
    ].join(' ');
  }

  const auth = withAuthHeader ? ` -H "Authorization: Bearer $${AUTH_TOKEN_ENV_VAR}"` : '';
  return (
    `curl -sS -m ${HOOK_TIMEOUT_SECONDS} -X POST ` +
    `-H 'Content-Type: application/json'${auth} ` +
    `--data-binary @- ${shellQuote(url)} >/dev/null 2>&1 || true`
  );
}

/**
 * The settings object handed to `claude --settings`.
 *
 * Deterministic for a given (worktreeId, instanceId, port): callers rely on
 * regenerating it producing the same file.
 *
 * `PermissionRequest` is registered unconditionally (Issue #1724) — it is *not*
 * gated on Auto-Yes being enabled. The receiver answers no-decision whenever
 * Auto-Yes is off, and no-decision is measured to be indistinguishable from
 * having no hook at all (#1721 D5), so a toggle here would only add a second
 * place for the feature to be silently off. It also has to be: Auto-Yes is
 * enabled mid-session, and a hook registered at launch is the only kind this
 * session will have.
 *
 * `PreToolUse` / `PostToolUse` are registered for `AskUserQuestion` alone (Issue
 * #1726), and they post to the *event* receiver rather than the permission one:
 * they are observations, not verdicts. The distinction is not academic — a
 * `PreToolUse` response body can block or redirect a tool call, and answering
 * one for a question the human has not seen yet is the last thing this feature
 * wants to be able to do. The event route answers 202 with a fixed body and
 * cannot decide anything.
 *
 * `permissions.deny` rides along in the same file (Issue #1739). It is not a
 * hook and nothing here delivers it — Claude enforces it itself, before any
 * `PermissionRequest` exists — which is precisely why it belongs next to the
 * hook that Auto-Yes answers rather than in the contract layer above it.
 */
export function buildAgentHookSettings(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): ClaudeHookSettings {
  const url = buildAgentEventUrl(target, options);
  const withAuthHeader = options.withAuthHeader ?? isAuthTokenExpected();
  const http = () => buildHttpHandler(url, withAuthHeader);
  const permissionHttp = () =>
    buildHttpHandler(
      buildPermissionRequestUrl(target, options),
      withAuthHeader,
      PERMISSION_REQUEST_TIMEOUT_SECONDS
    );

  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: buildSessionStartCommand(target, options),
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [http()] }],
      Stop: [{ hooks: [http()] }],
      Notification: [{ matcher: NOTIFICATION_MATCHER, hooks: [http()] }],
      SessionEnd: [{ hooks: [http()] }],
      // Issue #1726. The event receiver, not the permission one: observation.
      PreToolUse: [{ matcher: TOOL_USE_MATCHER, hooks: [http()] }],
      PostToolUse: [{ matcher: TOOL_USE_MATCHER, hooks: [http()] }],
      // Issue #1724. Points at its own receiver, not the event one.
      PermissionRequest: [{ hooks: [permissionHttp()] }],
    },
    // Issue #1739. Enforced by Claude below the hook layer: no dialog, so no
    // PermissionRequest, so nothing for Auto-Yes to approve.
    permissions: { deny: [...PERMISSION_DENY_RULES] },
  };
}

/**
 * Write the settings file and return its absolute path.
 *
 * The directory is created 0700 and the file 0600: it names the endpoint and
 * the instance of every session on the machine, which is nobody else's business
 * even though it holds no secret.
 */
export function writeAgentHookSettings(
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  const settingsPath = getHookSettingsPath(target, options);
  mkdirSync(getHookSettingsDirectory(options), { recursive: true, mode: 0o700 });
  writeFileSync(
    settingsPath,
    `${JSON.stringify(buildAgentHookSettings(target, options), null, 2)}\n`,
    { mode: 0o600 }
  );
  return settingsPath;
}

/**
 * The command that launches Claude for this instance.
 *
 * Never throws. Injection is an enhancement to a session that has to start
 * regardless, so a directory that cannot be written costs the structured
 * events and nothing else — the same fail-open posture the hooks themselves
 * have (§1.1 of the verification report).
 *
 * @param claudePath - Resolved Claude CLI path
 * @returns `<claude> --settings <file>`, or bare `<claude>` when injection is
 *   off or could not be prepared
 */
export function buildClaudeLaunchCommand(
  claudePath: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  if (!isHookInjectionEnabled()) {
    return claudePath;
  }
  if (!isValidInstanceId(resolveTargetInstanceId(target))) {
    // The instance id is about to be a URL parameter the receiver re-validates;
    // a value that would be rejected there is not worth injecting.
    logger.warn('hook-settings-invalid-instance-id', { worktreeId: target.worktreeId });
    return claudePath;
  }

  try {
    const settingsPath = writeAgentHookSettings(target, options);
    return `${shellQuote(claudePath)} --settings ${shellQuote(settingsPath)}`;
  } catch (error) {
    logger.warn('hook-settings-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return claudePath;
  }
}
