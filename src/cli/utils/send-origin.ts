/**
 * Who is sending, as this CLI reads it from its own environment (Issue #4437).
 *
 * `send`, `ask` and `respond` (the strict one too) put the answer on their request as
 * `origin`, with a short `originEvidence` for the server's log — every request that may
 * reach a tool the policy restricts; one naming any other tool is left as it was
 * ({@link withSendOrigin}, set on `ApiClient.post` by {@link installSendOrigin}). The server asks the
 * tool policy (`lib/tool-policy/policy`) with it: under a personal-plan declaration,
 * antigravity takes a send only from a person (the web UI, which names no origin, or
 * `terminal`). Everything else is refused before a key is typed, with exit 33.
 *
 * In this order, the first match wins (design §1.2):
 *
 *  1. `CM_RUN_ORIGIN` — `schedule` (CommandMate's unattended runs set it); any other
 *     value is a launcher this CLI does not know: `unknown`
 *  2. a CommandMate session's identity in the environment (`CM_WORKTREE_ID`, `CM_AGENT_*`, …) — `session`
 *  3. `$TMUX`, and the session's name is one CommandMate gave (`mcbd-…`, `parseSessionName`) — `session`
 *  4. `$TMUX`, and the name cannot be read (tmux failed or said nothing) — `unknown`
 *  5. an AI agent's own marker (`CLAUDECODE`, the only one confirmed so far) — `agent`
 *  6. stdin is not a terminal (cron, a pipe, most agents' shells) — `unknown`
 *  7. otherwise, a person typing in a terminal — `terminal`
 *
 * Not knowing is `unknown`, which antigravity refuses: a gap in what can be read must
 * not let an agent's send through. A person's own tmux with a name of their own is not
 * a CommandMate session and reads on from step 5.
 *
 * Only the environment and the tmux session name are read: no file (no credentials, no
 * `~/.gemini`), no server. There is deliberately no flag to override it — an agent
 * could pass it. The server cannot verify the claim; this is a guard against
 * accidental use, not a guarantee of compliance with the Google Antigravity terms.
 *
 * @module cli/utils/send-origin
 */

import { spawnSync } from 'child_process';
import { RUN_ORIGIN_ENV, TOOL_POLICY_TABLE } from '../../lib/tool-policy/policy';
import { parseSessionName } from '../../lib/cli-tools/session-name';
import { setPostBodyStamp } from './api-client';
import { isSendFamilyRoute } from './tool-policy-failure';

/** The origins this CLI claims (`legacy`, `relay` and `timer` are never claimed by a request). */
export type CliSendOrigin = 'terminal' | 'session' | 'agent' | 'schedule' | 'unknown';

/** What {@link resolveSendOrigin} decided, and the one fact it decided on. */
export interface ResolvedSendOrigin {
  origin: CliSendOrigin;
  /** e.g. `env:CM_AGENT_TOOL`, `tmux:mcbd-…`, `no-tty`. For the server's log only. */
  evidence: string;
}

/** What {@link resolveSendOrigin} reads; each part replaceable in tests. */
export interface SendOriginInputs {
  env: Readonly<Record<string, string | undefined>>;
  /** `process.stdin.isTTY`. */
  stdinIsTTY: boolean | undefined;
  /** The tmux session this process runs in, or null. Called only when `$TMUX` is set. */
  readTmuxSessionName: () => string | null;
}

/** The value of {@link RUN_ORIGIN_ENV} that marks a Schedule / daily-summary child. */
export const RUN_ORIGIN_SCHEDULE = 'schedule';

/**
 * A CommandMate session's identity variables (whoami's, and the `CM_AGENT_*`
 * correlation variables of the launch line). Any one of them is a session.
 */
export const SESSION_ENV_VARS: readonly string[] = Object.freeze([
  'CM_WORKTREE_ID',
  'CM_AGENT_WORKTREE_ID',
  'CM_INSTANCE_ID',
  'CM_AGENT_INSTANCE_ID',
  'CM_CLI_TOOL',
  'CM_AGENT_TOOL',
]);

/**
 * Markers an AI agent puts on its own child shells. Only `CLAUDECODE` was observed
 * (2026-11-16); the others' markers are not confirmed, and step 6 (no terminal) still
 * catches most of them.
 */
export const AGENT_ENV_MARKERS: readonly string[] = Object.freeze(['CLAUDECODE']);

/** The longest evidence sent (the server cuts at 128 as well). */
const MAX_EVIDENCE_CHARS = 128;

/** The first of `names` set to something other than blanks. */
function firstSet(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): string | undefined {
  return names.find((name) => (env[name] ?? '').trim() !== '');
}

/**
 * The tmux session name, the way `whoami` reads it (`readTmuxSessionName` there).
 * Restated rather than imported from `commands/whoami`, so this utility does not
 * reach into a command module.
 */
export function readTmuxSessionNameForOrigin(): string | null {
  const result = spawnSync('tmux', ['display-message', '-p', '#{session_name}'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const name = (result.stdout ?? '').trim();
  return name === '' ? null : name;
}

function defaultInputs(): SendOriginInputs {
  return {
    env: process.env,
    stdinIsTTY: process.stdin?.isTTY,
    readTmuxSessionName: readTmuxSessionNameForOrigin,
  };
}

function evidence(text: string): string {
  return text.slice(0, MAX_EVIDENCE_CHARS);
}

/** Who is sending, from the environment and the tmux session name only. */
export function resolveSendOrigin(inputs: Partial<SendOriginInputs> = {}): ResolvedSendOrigin {
  const { env, stdinIsTTY, readTmuxSessionName } = { ...defaultInputs(), ...inputs };

  const runOrigin = (env[RUN_ORIGIN_ENV] ?? '').trim();
  if (runOrigin === RUN_ORIGIN_SCHEDULE) return { origin: 'schedule', evidence: `env:${RUN_ORIGIN_ENV}` };
  if (runOrigin !== '') return { origin: 'unknown', evidence: `env:${RUN_ORIGIN_ENV}` };

  const sessionVar = firstSet(env, SESSION_ENV_VARS);
  if (sessionVar) return { origin: 'session', evidence: `env:${sessionVar}` };

  if ((env.TMUX ?? '') !== '') {
    const name = readTmuxSessionName();
    if (name === null) return { origin: 'unknown', evidence: 'tmux:unreadable' };
    if (parseSessionName(name) !== null) return { origin: 'session', evidence: evidence(`tmux:${name}`) };
  }

  const agentMarker = firstSet(env, AGENT_ENV_MARKERS);
  if (agentMarker) return { origin: 'agent', evidence: `env:${agentMarker}` };

  if (stdinIsTTY !== true) return { origin: 'unknown', evidence: 'no-tty' };
  return { origin: 'terminal', evidence: 'tty' };
}

/** Whether a POST to `path` is one that types into a session. */
export function isSendOriginPath(path: string): boolean {
  return isSendFamilyRoute(path);
}

/**
 * Whether the body names a tool the policy table never restricts (`claude`, `codex`,
 * …). Such a request is refused from no origin, so it is left byte for byte as it was
 * (an older server, and everything that reads these bodies, see no change). A body
 * naming antigravity, a tool this CLI does not know, or no tool at all (the server
 * picks the worktree's default, which may be antigravity) carries the origin.
 * `/send` names the tool `cliToolId`; `/respond`, `/prompt-response` and strict `cliTool`.
 */
function namesUnrestrictedTool(body: Record<string, unknown>): boolean {
  const tool = body.cliToolId ?? body.cliTool;
  if (typeof tool !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_POLICY_TABLE, tool)) return false;
  return TOOL_POLICY_TABLE[tool as keyof typeof TOOL_POLICY_TABLE] === null;
}

/**
 * The body of a POST to `path` with `origin` / `originEvidence` on it, when `path` is
 * one of the routes that type into a session, the body names no origin of its own,
 * and it may reach a tool the policy restricts ({@link namesUnrestrictedTool});
 * otherwise `body` itself. Resolved per request (an environment is cheap to read, and
 * tmux is asked only inside tmux).
 */
export function withSendOrigin(
  path: string,
  body: unknown,
  resolve: () => ResolvedSendOrigin = () => resolveSendOrigin(),
): unknown {
  if (!isSendOriginPath(path)) return body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if ('origin' in record || namesUnrestrictedTool(record)) return body;
  const { origin, evidence: originEvidence } = resolve();
  return { ...record, origin, originEvidence };
}

/**
 * Make every `ApiClient.post` of this process put who is sending on the requests that
 * type into a session (`send`, `ask` and `respond` call it first; the strict respond's
 * own client is covered too). Not done by `api-client` itself: reading the origin runs
 * tmux, which the guards keep out of what `lib/brief` / `lib/handoff` reach.
 */
export function installSendOrigin(): void {
  setPostBodyStamp((path, body) => withSendOrigin(path, body));
}
