/**
 * What one answer of `POST /api/worktrees/:id/send` proves about the message:
 * `sent`, `not_sent` or `unknown` (Issue #4535, design
 * `docs/design/send-outcome-4535.md` §2.2).
 *
 * `not_sent` only on proof that nothing was typed or dispatched — a typed
 * refusal from the server (its `sendOutcome`, or a code the route answers only
 * before the send service) or a connection that was never made. Anything else
 * a failure can be (a bare 4xx/5xx page, a body that is not ours, an empty 2xx,
 * a dropped socket) is `unknown`: the message may be in, so nothing is withdrawn
 * and nothing is resent.
 *
 * Pure: no I/O, no exit codes, no wording. The CLI's `postMessage`
 * (`src/cli/commands/message-dispatch.ts`) reads `/send` with it. No `@/` import:
 * the CLI build has no path aliases.
 */

/** The three outcomes of a send (design §2.1). */
export type SendFact = 'sent' | 'not_sent' | 'unknown';

/** The row of design §2.2 an answer fell into. */
export type SendAnswerRow =
  | 'S1' | 'S2' | 'S3' | 'S4'
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7' | 'N8'
  | 'U1' | 'U2' | 'U3';

/** This request's answer, as it came off the wire. */
export type SendAnswerInput =
  | {
    kind: 'response';
    status: number;
    /** The `content-type` header, or null without one. */
    contentType: string | null;
    /** The body as text (empty for none). */
    bodyText: string;
  }
  | {
    /** No answer: what the request threw (the CLI's wrapper, `fetch`'s own, anything). */
    kind: 'error';
    error: unknown;
  };

export interface SendAnswerClassification {
  fact: SendFact;
  row: SendAnswerRow;
  /**
   * Whether the relay bound to this send is this send's to clean up (design §3.1).
   * False only for `RELAY_BIND_CONFLICT`: another copy of the request holds it.
   */
  relayOwned: boolean;
  /** Whether a bound relay's `sendState` should be asked (`GET /api/relays/:id`) to settle an `unknown`. */
  consultRelay: boolean;
}

/** The code of the route's 409 when the relay is already reserved, closed or expired. */
export const RELAY_BIND_CONFLICT_CODE = 'RELAY_BIND_CONFLICT';

const SEND_TARGET_CHANGED_CODE = 'SEND_TARGET_CHANGED';
const TOOL_POLICY_DENIED_CODE = 'TOOL_POLICY_DENIED';

/**
 * N5: codes the send route answers only before the send service, so a server
 * older than the route's `sendOutcome: 'not_sent'` rule (design §2.4) still
 * proves nothing was typed with them. Not `RELAY_BIND_CONFLICT` (N4), and not a
 * bare 400/404 without a code.
 */
const PRE_SEND_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ASK_ID_CONFLICT',
  'RELAY_BIND_INVALID',
  'RELAY_BIND_FAILED',
  'model_refused',
  'INVALID_PATH',
  'PROMPT_WAITING',
  'session_owned_by_other_server',
  'ROSTER_CHANGED',
]);

/** N5: the role refusals (`ROLE_CONDITION_UNMET` and its neighbours) are told by prefix. */
const PRE_SEND_REFUSAL_PREFIX = 'ROLE_';

/** N6: the middleware's own refusals, before any route (design C12). */
const MIDDLEWARE_REFUSAL_CODES: Readonly<Record<string, number>> = {
  AUTH_REQUIRED: 401,
  IP_DENIED: 403,
};

/** How deep a `cause` chain is followed: the CLI wraps `fetch`'s error, which wraps the socket's. */
const MAX_CAUSE_DEPTH = 6;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/** The body as a JSON object — only when it was served as JSON and parses to one. */
function readJsonObject(input: Extract<SendAnswerInput, { kind: 'response' }>): JsonRecord | null {
  if (!isJsonType(input.contentType) || input.bodyText.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(input.bodyText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asFact(value: unknown): SendFact | null {
  return value === 'sent' || value === 'not_sent' || value === 'unknown' ? value : null;
}

/** An ask's `sendState` (`reserved | sent | not_sent | send_unknown`) as a fact; null without one. */
function askFact(body: JsonRecord): SendFact | null {
  const ask = body.ask;
  if (!isRecord(ask) || !('sendState' in ask)) return null;
  if (ask.sendState === 'sent') return 'sent';
  if (ask.sendState === 'not_sent') return 'not_sent';
  return 'unknown';
}

/** Two readings of one send: they agree, or it is not known (the weaker one wins). */
function weaker(a: SendFact, b: SendFact | null): SendFact {
  if (b === null || a === b) return a;
  return 'unknown';
}

function isChatMessage(body: JsonRecord): boolean {
  return typeof body.id === 'string' && body.id.length > 0 && body.role === 'user';
}

function result(fact: SendFact, row: SendAnswerRow, consultRelay = false): SendAnswerClassification {
  return { fact, row, relayOwned: true, consultRelay };
}

function classifySuccess(body: JsonRecord | null): SendAnswerClassification {
  if (body === null) return result('unknown', 'S4', true);
  const fromAsk = askFact(body);
  if (isChatMessage(body)) {
    const reported = body.sendOutcome;
    if (reported === undefined || reported === 'sent') {
      const fact = weaker('sent', fromAsk);
      return result(fact, 'S1', fact === 'unknown');
    }
    // The text went in; only the bound relay could not place it (no input boundary).
    if (reported === 'unknown') {
      const fact = weaker('sent', fromAsk);
      return result(fact, 'S2', fact === 'unknown');
    }
    return result('unknown', 'S4', true);
  }
  // Issue #4344: the ask replay answer — the first copy's own send state.
  if (fromAsk !== null) return result(fromAsk, 'S3', fromAsk === 'unknown');
  return result('unknown', 'S4', true);
}

function classifyRefusal(status: number, body: JsonRecord | null): SendAnswerClassification {
  if (body === null) return result('unknown', 'U2', true);
  const code = typeof body.code === 'string' ? body.code : null;

  // N4 first, by its code: another copy of this request reserved the relay, so this
  // answer proves nothing about the message whatever `sendOutcome` it carries.
  if (code === RELAY_BIND_CONFLICT_CODE) {
    return { fact: 'unknown', row: 'N4', relayOwned: false, consultRelay: true };
  }

  const fromAsk = askFact(body);
  if ('sendOutcome' in body) {
    const reported = asFact(body.sendOutcome);
    if (reported === null) return result('unknown', 'U2', true);
    if (reported !== 'not_sent') return result('unknown', 'U1');
    const fact = weaker('not_sent', fromAsk);
    if (fact !== 'not_sent') return result('unknown', 'U1');
    if (code === SEND_TARGET_CHANGED_CODE) return result('not_sent', 'N2');
    if (code === TOOL_POLICY_DENIED_CODE) return result('not_sent', 'N3');
    return result('not_sent', 'N1');
  }

  if (fromAsk === 'not_sent') return result('not_sent', 'N8');
  if (fromAsk !== null) return result('unknown', 'U1');

  if (code !== null && MIDDLEWARE_REFUSAL_CODES[code] === status) return result('not_sent', 'N6');
  if (code !== null && status >= 400 && status < 600
    && (PRE_SEND_REFUSAL_CODES.has(code) || code.startsWith(PRE_SEND_REFUSAL_PREFIX))) {
    return result('not_sent', 'N5');
  }
  return result('unknown', 'U2', true);
}

/**
 * Whether an error is a refused TCP connection: nothing reached the far end (N7).
 *
 * Follows the `cause` chain (the CLI's error → `fetch failed` → the socket's).
 * An `AggregateError` (IPv4 and IPv6 both tried) counts only when every error
 * in it was refused. Anything not recognised is not a refusal.
 */
export function isConnectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const node = current as { code?: unknown; errors?: unknown; cause?: unknown };
    if (node.code === 'ECONNREFUSED') return true;
    if (Array.isArray(node.errors)) {
      return node.errors.length > 0 && node.errors.every((inner) => isConnectionRefused(inner));
    }
    current = node.cause;
  }
  return false;
}

/** Classify this request's answer by design §2.2. */
export function classifySendAnswer(input: SendAnswerInput): SendAnswerClassification {
  if (input.kind === 'error') {
    return isConnectionRefused(input.error) ? result('not_sent', 'N7') : result('unknown', 'U3', true);
  }
  const body = readJsonObject(input);
  if (input.status >= 200 && input.status < 300) return classifySuccess(body);
  return classifyRefusal(input.status, body);
}

/** A bound relay's `sendState` as `GET /api/relays/:id` reads it (null when the lookup failed). */
export type RelayLookupState = 'awaiting' | 'input_started' | 'sent' | 'unknown' | 'failed' | null;

/**
 * Settle an `unknown` answer with the bound relay's own record (design §2.2):
 * `sent` is sent, `failed` is not sent (only this attempt's settle writes it),
 * anything else stays unknown. Answers with proof are left as they are.
 *
 * Design Q13 (b): `failed` also makes the relay this send's again, N4 included.
 * The one attempt bound to it typed nothing, so its relay, note and Auto-Yes are
 * cleaned up like any `not_sent`'s. `sent` and anything else leave the owner as
 * it was (N4 stays not ours: a copy may have arrived).
 */
export function applyRelayLookup(
  classified: SendAnswerClassification,
  sendState: RelayLookupState
): SendAnswerClassification {
  if (!classified.consultRelay || classified.fact !== 'unknown') return classified;
  if (sendState === 'sent') return { ...classified, fact: 'sent' };
  if (sendState === 'failed') return { ...classified, fact: 'not_sent', relayOwned: true };
  return classified;
}
