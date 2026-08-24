/**
 * Predicate-based mapping from a source's own events onto the seven words
 * (Issue #1759, constraint C4).
 *
 * The Claude-only implementation this replaces was a
 * `Record<string, AgentEventType>`: one native spelling in, one word out. That
 * shape is not general, and #1758 §5.2.3 is the proof:
 *
 *  - `message.part.updated` is `pre_tool_use` when `part.state.status` is
 *    `running` and `post_tool_use` when it is `completed` or `error` — **the
 *    same event name, two different words, chosen by a field.**
 *  - `user_prompt_submit` has no event of its own; it is `message.updated` with
 *    `info.role === "user"`.
 *  - `notification` is three unrelated events (`permission.asked`,
 *    `question.asked`, `session.error`) that differ only in `detail`.
 *
 * So a mapper is a function, and a source carries an ordered list of them:
 * the first that returns a value wins, and a list that returns nothing means
 * "this event is not one of the seven", which is a normal outcome, not an
 * error (C8).
 *
 * @module lib/hooks/sources/event-mapper
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { MAX_EVENT_DETAIL_LENGTH, type AgentEventType } from '@/lib/hooks/agent-event-types';
import type { NormalizedAgentEvent } from './types';

/** What a mapper may fill in beyond the word itself. */
export interface EventMapping {
  event: AgentEventType;
  detail?: string | null;
  conversationId?: string | null;
  toolCallId?: string | null;
}

/**
 * One rule.
 *
 * @param nativeEventName - The source's own name for the event, or null when it
 *   does not publish one. antigravity publishes none at all (#1757 R2), which
 *   is why this is nullable rather than merely optional.
 * @param payload - The event, verbatim
 * @returns The mapping, or null to defer to the next rule
 */
export type EventMapper = (
  nativeEventName: string | null,
  payload: Record<string, unknown>
) => EventMapping | null;

/**
 * The commonest rule: this native name is always that word.
 *
 * @param nativeName - e.g. `Stop`, `session.idle`
 * @param event - The word it maps to
 * @param detail - A fixed subtype, for sources that fold several events into
 *   `notification` and need `detail` to tell them apart
 */
export function whenNamed(
  nativeName: string,
  event: AgentEventType,
  detail?: string
): EventMapper {
  return (nativeEventName) =>
    nativeEventName === nativeName ? { event, detail: detail ?? null } : null;
}

/** Every entry of a name table, as rules. Order within the table is preserved. */
export function fromNameTable(table: Readonly<Record<string, AgentEventType>>): EventMapper[] {
  return Object.entries(table).map(([nativeName, event]) => whenNamed(nativeName, event));
}

/**
 * Run an ordered rule list.
 *
 * @returns The first mapping produced, or null when no rule matched
 */
export function runEventMappers(
  mappers: readonly EventMapper[],
  nativeEventName: string | null,
  payload: Record<string, unknown>
): EventMapping | null {
  for (const mapper of mappers) {
    const mapped = mapper(nativeEventName, payload);
    if (mapped) return mapped;
  }
  return null;
}

// =============================================================================
// Unknown events (C8)
// =============================================================================

/**
 * Counts of events no rule claimed, per tool.
 *
 * Reached through `globalThis` for the reason the whole of `agent-event-state`
 * is (Issue #1736): under `next dev` each route is bundled separately, so a
 * module-scoped counter is one counter per bundle and the number an operator
 * reads is not the number that was incremented.
 */
declare global {
  // eslint-disable-next-line no-var
  var __agentSourceUnknownEvents: Map<string, UnknownEventTally> | undefined;
}

/** What was seen and not understood, for one tool. */
export interface UnknownEventTally {
  /** Every unmapped event, including repeats. */
  count: number;
  /** The distinct native names, capped — a keepalive can arrive forever. */
  names: string[];
}

/** Cap on remembered distinct names, so an unbounded vocabulary cannot grow this. */
export const MAX_UNKNOWN_EVENT_NAMES = 32;

const unknownEvents = (globalThis.__agentSourceUnknownEvents ??= new Map<
  string,
  UnknownEventTally
>());

/**
 * Record an event that mapped to nothing.
 *
 * Counted rather than thrown, because "I do not recognise this" is the steady
 * state, not a fault: opencode publishes 89 event types against seven words,
 * and `server.heartbeat` — which arrives every ten seconds — is not even in the
 * server's own OpenAPI document (#1758 D3/D5). A receiver that threw would fail
 * ten times a minute on a healthy connection.
 */
export function recordUnknownEvent(cliToolId: CLIToolType, nativeEventName: string | null): void {
  const tally = unknownEvents.get(cliToolId) ?? { count: 0, names: [] };
  tally.count += 1;
  const name = nativeEventName ?? '(unnamed)';
  if (!tally.names.includes(name) && tally.names.length < MAX_UNKNOWN_EVENT_NAMES) {
    tally.names.push(name);
  }
  unknownEvents.set(cliToolId, tally);
}

/** @returns What this tool has sent that no rule claimed. */
export function getUnknownEventTally(cliToolId: CLIToolType): UnknownEventTally {
  const tally = unknownEvents.get(cliToolId);
  return { count: tally?.count ?? 0, names: [...(tally?.names ?? [])] };
}

/** Forget the tallies. For tests; nothing in production resets them. */
export function resetUnknownEventTallies(): void {
  unknownEvents.clear();
}

// =============================================================================
// Payload field helpers
// =============================================================================

/** A non-empty string field, or null. */
export function readStringField(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The first of `keys` present as a non-empty string, or null. */
export function readFirstStringField(
  payload: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = readStringField(payload, key);
    if (value !== null) return value;
  }
  return null;
}

/** Trim a subtype to the length the store accepts. */
export function boundDetail(value: string | null): string | null {
  if (value === null || value === '') return null;
  return value.slice(0, MAX_EVENT_DETAIL_LENGTH);
}

/**
 * Trim a model id to the length the store accepts (Issue #1783).
 *
 * The same bound as {@link boundDetail} and deliberately so: both are short
 * enum-ish words the agent chose, both end up rendered, and giving the model its
 * own number would only invite the two to drift. Named separately because the
 * call sites read better and because a future measurement could move one
 * without moving the other.
 */
export function boundModel(value: string | null): string | null {
  if (value === null || value === '') return null;
  return value.slice(0, MAX_EVENT_DETAIL_LENGTH);
}

/** Longest frame id accepted as a de-duplication key (Issue #1899). */
export const MAX_EVENT_IDENTITY_LENGTH = 128;

/**
 * Characters a frame id may contain.
 *
 * Every id the six sources publish is an opaque token in this alphabet —
 * opencode's `per_…` / `que_…` / `msg_…` / `toolu_…`, Claude's `toolu_…`. The
 * allowlist is not about display (nothing renders these); it is about what
 * becomes a key in a long-lived server-side map.
 */
const EVENT_IDENTITY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * A frame id fit to be a de-duplication key, or null (Issue #1899, §10 DR4-001).
 *
 * **Discarded, never truncated**, and that is the whole difference from
 * {@link boundDetail}. A detail is prose that is shown to a human, so cutting
 * it long is better than losing it. An identity is compared for equality: a
 * truncated id would collide with every other id sharing its prefix, which
 * turns an over-long value into a way of making unrelated frames look like
 * repeats of each other. Answering null instead puts the frame back on the
 * time window, which is where it was before this Issue.
 */
export function readEventIdentity(value: string | null): string | null {
  if (value === null || value.length > MAX_EVENT_IDENTITY_LENGTH) return null;
  return EVENT_IDENTITY_PATTERN.test(value) ? value : null;
}

/** Type guard for a JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a nested path, e.g. `['part', 'state', 'status']`. */
export function readNestedString(
  payload: Record<string, unknown>,
  path: readonly string[]
): string | null {
  let current: unknown = payload;
  for (const key of path) {
    if (!isPlainObject(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current !== '' ? current : null;
}

/**
 * Assemble a {@link NormalizedAgentEvent} from a mapping and the payload.
 *
 * @param mapping - What the rules decided
 * @param payload - The event, verbatim
 * @param receivedAt - Epoch ms
 * @param fallbacks - Where to look for the fields the rule left unset
 */
export function buildNormalizedEvent(
  mapping: EventMapping,
  payload: Record<string, unknown>,
  receivedAt: number,
  fallbacks: {
    detail?: (event: AgentEventType, payload: Record<string, unknown>) => string | null;
    conversationId?: readonly string[];
    toolCallId?: readonly string[];
    /** Flat keys holding the model id, first non-empty string wins (#1783). */
    modelFields?: readonly string[];
    /** For shapes a flat lookup cannot reach. Wins over `modelFields` (#1783). */
    extractModel?: (payload: Record<string, unknown>) => string | null;
  } = {}
): NormalizedAgentEvent {
  const detail =
    mapping.detail !== undefined && mapping.detail !== null
      ? boundDetail(mapping.detail)
      : boundDetail(fallbacks.detail?.(mapping.event, payload) ?? null);

  return {
    event: mapping.event,
    detail,
    conversationId:
      mapping.conversationId ??
      (fallbacks.conversationId ? readFirstStringField(payload, fallbacks.conversationId) : null),
    toolCallId:
      mapping.toolCallId ??
      (fallbacks.toolCallId ? readFirstStringField(payload, fallbacks.toolCallId) : null),
    // Issue #1783. Every source runs through here, so a tool that declares
    // neither hook simply answers null — which is the honest answer for gemini
    // and copilot, whose payloads never carry one.
    model: boundModel(
      fallbacks.extractModel?.(payload) ??
        (fallbacks.modelFields ? readFirstStringField(payload, fallbacks.modelFields) : null)
    ),
    raw: payload,
    receivedAt,
  };
}
