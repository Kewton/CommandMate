/**
 * The tool policy's refusals as exit 33 (Issue #4437), the way `role-failure.ts` maps
 * the role API's refusals.
 *
 * The server answers 409 `TOOL_POLICY_DENIED` (send / ask / respond, strict included)
 * or `RELAY_TOOL_POLICY_DENIED` (`POST /api/relays`) when antigravity may not be
 * driven from where this CLI runs (see `send-origin.ts`). Nothing was typed and no
 * relay was opened, and sending again gets the same answer: a usage declaration on
 * the server, or a person on the web UI or in a terminal, is what changes it.
 *
 * {@link ToolPolicyDeniedError} is deliberately NOT an `ApiError`. `ApiClient` throws
 * it for those two codes on the routes that type into a session and on relay
 * creation, so every catch written for HTTP failures lets it through: the strict
 * respond's 409 → exit 40 (`session_conflict`), `postMessage`'s "safe to send it
 * again" note and `registerRelay`'s exit 2 never see it. The commands catch it
 * and call {@link reportToolPolicyDenial}.
 *
 * Free of the file system, of child processes and of `api-client` (which imports this
 * module, and which `lib/brief` / `lib/handoff` reach: guards keep tmux out of that graph).
 *
 * @module cli/utils/tool-policy-failure
 */

import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_CHECKED_AT,
  ANTIGRAVITY_TERMS_URL,
  RELAY_TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED,
  formatToolPolicyDenial,
  type ToolPolicyDecision,
} from '../../lib/tool-policy/policy';
import { ToolPolicyExitCode } from '../types';
import type { ToolPolicyDeniedResponse, ToolPolicyDetailResponse } from '../types/tool-policy-responses';

/**
 * The routes that type into a session, whose body takes `origin` (PR1 of #4437):
 * `/send`, `/respond`, `/prompt-response` and `/prompt-response/strict`.
 */
const SEND_FAMILY_ROUTE = /^\/api\/worktrees\/[^/?#]+\/(?:send|respond|prompt-response(?:\/strict)?)(?:[?#].*)?$/;

/** Whether a POST to `path` is one that types into a session. */
export function isSendFamilyRoute(path: string): boolean {
  return SEND_FAMILY_ROUTE.test(path);
}

/**
 * Where a 409 `TOOL_POLICY_DENIED` / `RELAY_TOOL_POLICY_DENIED` becomes a
 * {@link ToolPolicyDeniedError}: the routes that type into a session and relay
 * creation. Elsewhere (the Auto-Yes route, #4436) it stays an `ApiError`, read by that
 * command's own handling.
 */
export function isToolPolicyRoute(path: string): boolean {
  return isSendFamilyRoute(path) || path === '/api/relays';
}

// ---------------------------------------------------------------------------
// I7d: the reason is stderr's first line, whatever else the command would say
// ---------------------------------------------------------------------------

/** Construction warnings of `ApiClient` held by {@link holdClientWarnings}, or null (printed at once). */
let heldClientWarnings: string[] | null = null;
let exitFlushArmed = false;

/**
 * Where `ApiClient` puts a construction warning (`--token` in the process list, a
 * token over plain HTTP) when the caller names no `onWarning` of its own: stderr at
 * once, or held while {@link holdClientWarnings} is on. The same idea as the
 * `auto-yes` command's held warnings (#4436): a refusal's reason comes first.
 */
export function clientWarning(line: string): void {
  if (heldClientWarnings) heldClientWarnings.push(line);
  else console.error(line);
}

/**
 * Hold construction warnings from here until {@link flushClientWarnings}: `send`,
 * `ask` and `respond` call it first, so a tool-policy refusal is stderr's first line
 * and the warnings follow it. Anything left held is printed when the process exits
 * (an exit from deep inside a command keeps its warning).
 */
export function holdClientWarnings(): void {
  heldClientWarnings = [];
  if (!exitFlushArmed && typeof process.once === 'function') {
    exitFlushArmed = true;
    process.once('exit', () => flushClientWarnings());
  }
}

/** Print what was held, and print at once from now on. */
export function flushClientWarnings(): void {
  const lines = heldClientWarnings ?? [];
  heldClientWarnings = null;
  for (const line of lines) console.error(line);
}

/** The two refusal codes of the tool policy. */
export type ToolPolicyDenialCode = typeof TOOL_POLICY_DENIED | typeof RELAY_TOOL_POLICY_DENIED;

/** The codes that map to exit 33 (and nothing else does). */
export const TOOL_POLICY_DENIAL_EXITS: Readonly<Record<ToolPolicyDenialCode, number>> = Object.freeze({
  [TOOL_POLICY_DENIED]: ToolPolicyExitCode.DENIED,
  [RELAY_TOOL_POLICY_DENIED]: ToolPolicyExitCode.DENIED,
});

/** What the refused request named, for `--json` when the command had not resolved it. */
export interface RefusedRequestTarget {
  instanceId?: string;
  cliToolId?: string;
}

/** The first stderr line's sentence, from the shared module (not the server's `error`). */
function denialLines(policy: ToolPolicyDetailResponse | null): string[] {
  const decision = {
    allowed: false,
    code: TOOL_POLICY_DENIED,
    reason: (policy?.reason ?? ANTIGRAVITY_CONSUMER_TERMS) as typeof ANTIGRAVITY_CONSUMER_TERMS,
    tool: policy?.tool ?? 'antigravity',
    operation: policy?.operation ?? 'send',
    origin: policy?.origin ?? 'unknown',
    declaration: policy?.declaration ?? 'personal',
    links: { terms: policy?.links?.terms ?? ANTIGRAVITY_TERMS_URL, faq: policy?.links?.faq ?? ANTIGRAVITY_FAQ_URL },
  } as ToolPolicyDecision;
  return formatToolPolicyDenial(decision, 'en').split('\n');
}

/**
 * A request the tool policy refused: nothing typed, no relay opened (`sent: false`).
 * Carries exit 33 like {@link ApiError} carries its exit code, without being one.
 */
export class ToolPolicyDeniedError extends Error {
  readonly exitCode: number = ToolPolicyExitCode.DENIED;
  /** Nothing was typed (I8). */
  readonly sent = false as const;

  constructor(
    public readonly code: ToolPolicyDenialCode,
    /** The server's `policy`, or null when the body had none. */
    public readonly policy: ToolPolicyDetailResponse | null,
    public readonly statusCode: number,
    public readonly payload: ToolPolicyDeniedResponse,
    /** What the refused request named (its `instanceId` / `cliToolId`). */
    public readonly request: RefusedRequestTarget = {},
  ) {
    super(denialLines(policy)[0]);
    this.name = 'ToolPolicyDeniedError';
  }
}

/** Whether `error` is a tool-policy refusal (exit 33). */
export function isToolPolicyDenied(error: unknown): error is ToolPolicyDeniedError {
  return error instanceof ToolPolicyDeniedError;
}

function readPolicy(value: unknown): ToolPolicyDetailResponse | null {
  if (value === null || typeof value !== 'object') return null;
  const policy = value as Partial<ToolPolicyDetailResponse>;
  return typeof policy.tool === 'string' && typeof policy.operation === 'string'
    ? (policy as ToolPolicyDetailResponse)
    : null;
}

function readRequestTarget(body: unknown): RefusedRequestTarget {
  if (body === null || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const instanceId = typeof record.instanceId === 'string' ? record.instanceId : undefined;
  // `/send` names the tool `cliToolId`; `/prompt-response` and strict name it `cliTool`.
  const tool = record.cliToolId ?? record.cliTool;
  return { instanceId, cliToolId: typeof tool === 'string' ? tool : undefined };
}

/**
 * The refusal a failed response is, or null. Only a 409 with one of the two codes:
 * the code on another status, or another 409 (the role's 32, `PROMPT_WAITING`, a
 * relay chain), keeps its own handling.
 */
export function toolPolicyDenialFromResponse(
  status: number,
  payload: unknown,
  requestBody?: unknown,
): ToolPolicyDeniedError | null {
  if (status !== 409 || payload === null || typeof payload !== 'object') return null;
  const code = (payload as { code?: unknown }).code;
  if (code !== TOOL_POLICY_DENIED && code !== RELAY_TOOL_POLICY_DENIED) return null;
  const policy = readPolicy((payload as { policy?: unknown }).policy);
  return new ToolPolicyDeniedError(
    code,
    policy,
    status,
    payload as ToolPolicyDeniedResponse,
    readRequestTarget(requestBody),
  );
}

/**
 * The stderr lines: the reason first (`Error [<code>]: <sentence>`), the terms and the
 * FAQ second, then how to lift it and what was (not) done.
 */
export function formatToolPolicyDenialLines(error: ToolPolicyDeniedError): string[] {
  const lines = denialLines(error.policy);
  const terms = error.policy?.links?.terms ?? ANTIGRAVITY_TERMS_URL;
  const faq = error.policy?.links?.faq ?? ANTIGRAVITY_FAQ_URL;
  const unlock = typeof error.policy?.unlock === 'string' && error.policy.unlock !== '' ? error.policy.unlock : lines[1];
  const tool = error.policy?.tool ?? 'antigravity';
  const operation = error.policy?.operation ?? (error.code === RELAY_TOOL_POLICY_DENIED ? 'relay' : 'send');
  const origin = error.policy?.origin ?? 'unknown';
  const end = error.policy?.endpoint ? `its \`${error.policy.endpoint}\` end` : 'one of its ends';
  const what = error.code === RELAY_TOOL_POLICY_DENIED
    ? `The relay was not opened and nothing was sent (sent: false; ${tool} is ${end}).`
    : 'Nothing was typed (sent: false).';
  return [
    `Error [${error.code}]: ${lines[0]}`,
    `Terms: ${terms}  FAQ: ${faq}  (as of ${ANTIGRAVITY_TERMS_CHECKED_AT}; not legal advice)`,
    `To lift it: ${unlock}`,
    `${what} Refused: tool=${tool} operation=${operation} origin=${origin}. Sending it again is refused the same way. `
      + 'The sender kind is what this CLI read from its own environment: a guard against accidental use, '
      + 'not a guarantee of compliance with the terms.',
  ];
}

/** The `--json` answer of a refused `ask` / `respond` (design §3.4). */
export interface ToolPolicyRefusalJson {
  worktreeId: string;
  instanceId: string | null;
  cliToolId: string | null;
  sent: false;
  refusal: {
    code: ToolPolicyDenialCode;
    reason: string;
    operation: string;
    origin: string;
    message: string;
    links: { terms: string; faq: string };
    unlock: string;
    /** Relay only: the refused end. */
    endpoint?: 'from' | 'to';
  };
}

/** The `--json` object of a refusal. The command's own target wins over the request's. */
export function toolPolicyRefusalJson(
  error: ToolPolicyDeniedError,
  worktreeId: string,
  target: { instanceId?: string | null; cliToolId?: string | null } = {},
): ToolPolicyRefusalJson {
  const lines = denialLines(error.policy);
  const policy = error.policy;
  return {
    worktreeId,
    instanceId: target.instanceId ?? error.request.instanceId ?? null,
    cliToolId: target.cliToolId ?? error.request.cliToolId ?? policy?.tool ?? null,
    sent: false,
    refusal: {
      code: error.code,
      reason: policy?.reason ?? ANTIGRAVITY_CONSUMER_TERMS,
      operation: policy?.operation ?? (error.code === RELAY_TOOL_POLICY_DENIED ? 'relay' : 'send'),
      origin: policy?.origin ?? 'unknown',
      message: lines[0],
      links: { terms: policy?.links?.terms ?? ANTIGRAVITY_TERMS_URL, faq: policy?.links?.faq ?? ANTIGRAVITY_FAQ_URL },
      unlock: typeof policy?.unlock === 'string' && policy.unlock !== '' ? policy.unlock : lines[1],
      ...(policy?.endpoint ? { endpoint: policy.endpoint } : {}),
    },
  };
}

/**
 * Print a refusal and exit 33: the stderr lines always, and with `json` the §3.4
 * object on stdout. A mocked `process.exit` returns; callers `return` after it.
 */
export function reportToolPolicyDenial(
  error: ToolPolicyDeniedError,
  options: {
    worktreeId: string;
    json?: boolean;
    target?: { instanceId?: string | null; cliToolId?: string | null };
  },
): void {
  for (const line of formatToolPolicyDenialLines(error)) console.error(line);
  // I7d: what the client held (the --token warning) after the reason, not before it.
  flushClientWarnings();
  if (options.json) {
    console.log(JSON.stringify(toolPolicyRefusalJson(error, options.worktreeId, options.target), null, 2));
  }
  process.exit(error.exitCode);
}

/**
 * The `--help` paragraph of `send`, `ask` and `respond` (design §2.2). One text, so
 * the three cannot drift apart.
 */
export const ANTIGRAVITY_GUARD_HELP = `Antigravity (Issue #4437): without a usage declaration, sending to an antigravity
instance from inside a CommandMate session, a Schedule run, an AI agent, or a
caller with no terminal is refused before anything is typed (exit 33), and
relays with antigravity at either end are refused (exit 33). The web UI and
commands typed in a terminal are not affected. The sender kind is what this CLI
reads from its own environment and the server cannot verify it: this is a guard
against accidental use, not a guarantee of compliance with the Google
Antigravity terms (Section 6 / FAQ). A send that writes before its message
(--register --role, --contract, --auto-yes) asks the server first and writes
nothing when refused. The first stderr line is
"Error [TOOL_POLICY_DENIED]: ..." (RELAY_TOOL_POLICY_DENIED for a relay); the
next names the terms and the FAQ, then how to lift it (the server's
${'`'}CM_ANTIGRAVITY_USAGE=api-key${'`'} or ${'`'}enterprise${'`'}). Sending again is refused the same way.`;
