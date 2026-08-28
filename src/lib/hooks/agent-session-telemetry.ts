/**
 * What the agent says about the conversation this instance is in (Issue #2040).
 *
 * `capture --json` could say what a session is *doing* — running, waiting, which
 * dialog is open — and nothing at all about what it has *spent*. An orchestrator
 * watching a fleet has to be able to answer "is this worker still worth its
 * budget?" and "which model is it actually on?", and neither question is
 * answerable from a terminal frame: the numbers exist only inside the agent.
 *
 * opencode publishes them. `session.updated` carries the whole `Session` object
 * on the SSE stream CommandMate already subscribes to — measured against
 * 1.18.22's own OpenAPI document (`GET /doc`): `Session` declares `title`,
 * `agent`, `model: { id, providerID, variant? }`, `cost: number` and
 * `tokens: { input, output, reasoning, cache: { read, write } }`. So this record
 * costs no request: it is read off a frame that was already arriving and that
 * mapped to none of the seven event words.
 *
 * ## Exposure only
 *
 * Nothing reads this back to decide anything — not `sessionStatus`, not
 * Auto-Yes, not `wait`. It is published as `structuredEvents.session` and that
 * is the whole contract, exactly like `./permission-decision-state` (#1898) and
 * `./tool-input-normalization-state` (#1902). A number that steered a verdict
 * would need a staleness policy this record deliberately does not have.
 *
 * ## Why the shape is not the agent's shape, in one respect
 *
 * The values are verbatim — nothing here rounds a cost, renames a model or
 * totals a token count, for the reason `CurrentOutputPayload.model` states: a
 * reader compares them against what the agent reports about itself, and any
 * tidying on the way out breaks that comparison exactly when it matters. What
 * IS changed is the nesting: `tokens.cache.read` is published as
 * `tokens.cacheRead`, so a CLI contract has one optional level rather than two.
 *
 * ## Lifetime
 *
 * One record per (worktree, tool, instance), overwritten by every frame, and
 * dropped when the subscription that fills it is closed — which is when the pane
 * is killed. That is the honest bound: the record describes a conversation a
 * process was having, so outliving the process would make it assert something
 * false, the same argument `buildCurrentOutput` makes for blanking `model` on a
 * session that is not running. {@link AgentSessionRecord.at} dates it for the
 * window in between.
 *
 * The `globalThis` indirection is load-bearing for the reason it is everywhere
 * else in this subsystem (#1736): the writer is the opencode subscription and
 * the reader is `/api/worktrees/:id/current-output`, which `next dev` bundles
 * separately and would otherwise give a private copy of this map each.
 *
 * ## What the record deliberately does not answer (Issue #2042)
 *
 * "How full is the context?" is not in here, and cannot be derived from what
 * is: `Session.tokens` is **cumulative for the session** — measured over two
 * turns it read `input 6 / output 11 / cache.read 8482 / cache.write 8500`,
 * which is exactly what `opencode stats` prints — while opencode's own footer
 * shows the **last assistant message's** footprint, 8,508. Summing the record
 * would have answered 16,999 and `2%` where the agent says 8,508 and `1%`, and
 * the gap grows with every turn. The second half of this file therefore asks the
 * agent's server two further questions and keeps the arithmetic in a record of
 * its own — see {@link AgentSessionContextUsage} and
 * `docs/design/opencode-server-live-verification.md` §14.
 *
 * @module lib/hooks/agent-session-telemetry
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  fetchOpencodeContextTokens,
  fetchOpencodeModelContextLimit,
} from './sources/opencode/client';
import { getAssignedOpencodePort } from './sources/opencode/ports';
import type { AgentInstanceRef } from './sources/types';

/**
 * Longest session title kept.
 *
 * opencode titles a session after its first prompt, so this is prose the agent
 * wrote and the payload is served over HTTP. Truncated rather than refused,
 * unlike an id (#1932 DR4-001): nothing matches on a title, it is displayed, so
 * a shortened one misinforms visibly instead of colliding silently.
 */
export const MAX_AGENT_SESSION_TITLE_LENGTH = 200;

/**
 * Longest model / agent / provider name kept.
 *
 * Same rule as the title, a tighter bound: these are identifiers a provider
 * chose (`claude-sonnet-4.6`, `github-copilot`, `build`), not sentences.
 */
export const MAX_AGENT_SESSION_NAME_LENGTH = 120;

/**
 * The tokens one session has spent, as the agent counts them.
 *
 * Every member is nullable and null means "the agent did not say", never zero:
 * a session that has not run a turn yet publishes no counts at all, and
 * reporting that as `0` would be this server inventing a measurement.
 */
export interface AgentSessionTokenUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  /** `tokens.cache.read`, flattened. See the module comment. */
  cacheRead: number | null;
  /** `tokens.cache.write`, flattened. */
  cacheWrite: number | null;
  /**
   * The agent's own total, or null.
   *
   * opencode declares `total` on an assistant *message* and not on a `Session`,
   * so this is null for every record written today. Published rather than
   * omitted because the alternative — adding the other five up here — would be
   * this server publishing a number no agent stands behind.
   */
  total: number | null;
}

/** One instance's view of the conversation it is in. */
export interface AgentSessionRecord {
  /** The agent's own session id (`ses…`), or null when it did not say. */
  id: string | null;
  /** The agent's own title for it, or null. Display only. Bounded. */
  title: string | null;
  /** Which agent persona is driving (opencode's `build` / `plan` / …), or null. */
  agent: string | null;
  /** The model id the session is on, or null. Verbatim. */
  model: string | null;
  /** The provider that model belongs to, or null. Verbatim. */
  provider: string | null;
  /** What the session has cost so far, in the agent's own unit, or null. */
  cost: number | null;
  /** See {@link AgentSessionTokenUsage}. */
  tokens: AgentSessionTokenUsage;
  /** Epoch ms this record was written, so a reader can judge its age. */
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentSessionTelemetry: Map<string, AgentSessionRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentSessionContextUsage: Map<string, AgentSessionContextUsage> | undefined;
  // eslint-disable-next-line no-var
  var __agentSessionContextRefreshes: Set<string> | undefined;
}

/** compositeKey -> the most recent session description for that instance. */
const records = globalThis.__agentSessionTelemetry ??
  (globalThis.__agentSessionTelemetry = new Map<string, AgentSessionRecord>());

/** Record what the agent last said about this instance's session. */
export function recordAgentSessionTelemetry(
  target: AgentInstanceRef,
  record: AgentSessionRecord
): void {
  records.set(
    buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId),
    record
  );
}

/**
 * @returns What the agent last said, or null — the ordinary answer for every
 *   tool that publishes none, and for an opencode pane whose stream has not
 *   reported a session yet.
 */
export function getAgentSessionTelemetry(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentSessionRecord | null {
  return records.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Drop one instance's record. Called when its subscription closes.
 *
 * Issue #2042 hangs the derived context measurement off the same call rather
 * than off a second one at the call site: the measurement describes the record,
 * so a lifetime it did not share would leave a pane reporting "87% full" about a
 * conversation that ended.
 */
export function forgetAgentSessionTelemetry(target: AgentInstanceRef): void {
  records.delete(buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId));
  forgetAgentSessionContextUsage(target);
}

/** Drop every record. Test seam. */
export function resetAgentSessionTelemetry(): void {
  records.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bounded string, or null when the field is absent or not a string. */
function readBoundedString(
  source: Record<string, unknown>,
  key: string,
  max: number
): string | null {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, max);
}

/**
 * A finite number, or null.
 *
 * `Number.isFinite` rather than `typeof === 'number'`: `NaN` and `Infinity` are
 * numbers that survive `JSON.parse` and would reach `capture --json` as `null`
 * anyway (`JSON.stringify(NaN)` is `null`), so admitting them would publish a
 * null that means "the agent said NaN" next to a null that means "the agent said
 * nothing", with no way to tell them apart.
 */
function readFiniteNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The empty usage, for a session that has reported no counts. */
function noTokenUsage(): AgentSessionTokenUsage {
  return { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
}

function readTokenUsage(info: Record<string, unknown>): AgentSessionTokenUsage {
  const tokens = isPlainObject(info.tokens) ? info.tokens : null;
  if (!tokens) return noTokenUsage();
  const cache = isPlainObject(tokens.cache) ? tokens.cache : {};
  return {
    input: readFiniteNumber(tokens, 'input'),
    output: readFiniteNumber(tokens, 'output'),
    reasoning: readFiniteNumber(tokens, 'reasoning'),
    cacheRead: readFiniteNumber(cache, 'read'),
    cacheWrite: readFiniteNumber(cache, 'write'),
    total: readFiniteNumber(tokens, 'total'),
  };
}

/**
 * Read a `session.updated` frame, or answer null (Issue #2040).
 *
 * ## Why a sub-agent's session is refused
 *
 * `Session.parentID` is present only on a session opencode opened *inside*
 * another one (a `task` tool call), and its cost is the sub-agent's rather than
 * the pane's. Recording it would make `structuredEvents.session` flip between
 * the conversation the operator is having and a background job that is about to
 * end, on a field whose whole purpose is to be compared over time. The gate is
 * frame-local on purpose — `./sources/opencode/turn-gate` learns parentage from
 * the same field, and a second reader of one fact is cheaper than a dependency
 * between the two.
 *
 * @param frame - The raw `{ type, properties }` frame off the stream
 * @param at - Epoch ms the frame was received
 * @returns The record to store, or null when this frame is not one to store
 */
export function readOpencodeSessionFrame(
  frame: Record<string, unknown>,
  at: number
): AgentSessionRecord | null {
  const properties = isPlainObject(frame.properties) ? frame.properties : null;
  if (!properties) return null;
  const info = isPlainObject(properties.info) ? properties.info : null;
  if (!info) return null;
  if (typeof info.parentID === 'string' && info.parentID.length > 0) return null;

  const model = isPlainObject(info.model) ? info.model : {};
  return {
    id: readBoundedString(info, 'id', MAX_AGENT_SESSION_NAME_LENGTH),
    title: readBoundedString(info, 'title', MAX_AGENT_SESSION_TITLE_LENGTH),
    agent: readBoundedString(info, 'agent', MAX_AGENT_SESSION_NAME_LENGTH),
    model: readBoundedString(model, 'id', MAX_AGENT_SESSION_NAME_LENGTH),
    provider: readBoundedString(model, 'providerID', MAX_AGENT_SESSION_NAME_LENGTH),
    cost: readFiniteNumber(info, 'cost'),
    tokens: readTokenUsage(info),
    at,
  };
}

// ============================================================================
// How full the context is (Issue #2042)
// ============================================================================

/**
 * How full one instance's context window is, and against what.
 *
 * Derived rather than reported, and kept in its own record rather than folded
 * into {@link AgentSessionRecord} for exactly that reason: everything in the
 * record above is a value the agent published on a frame, and everything here
 * is this server asking the agent two further questions and doing arithmetic on
 * the answers. Merging them would make `structuredEvents.session` a mixture of
 * quoted and computed values with no way to tell which was which — the thing
 * Issue #2040's "verbatim" rule exists to prevent.
 */
export interface AgentSessionContextUsage {
  /**
   * The last finished assistant turn's token footprint, or null.
   *
   * **Not the sum of {@link AgentSessionTokenUsage}.** Those are cumulative for
   * the whole session — the number `opencode stats` prints — while this is what
   * the next request has to fit into the window. See
   * `fetchOpencodeContextTokens`, which carries the measurement.
   */
  tokens: number | null;
  /** The model's declared context window, or null when nothing knows. */
  limit: number | null;
  /** `round(tokens / limit * 100)`, or null when either input is null. */
  percent: number | null;
  /**
   * The {@link AgentSessionRecord.at} this was measured against.
   *
   * The cache key for freshness: a record with a newer `at` means the agent has
   * spoken since, so these numbers describe a turn that is over.
   */
  sessionAt: number;
  /** Epoch ms this record was written. */
  at: number;
}

/** compositeKey -> the last context occupancy measured for that instance. */
const contextUsages = globalThis.__agentSessionContextUsage ??
  (globalThis.__agentSessionContextUsage = new Map<string, AgentSessionContextUsage>());

/** compositeKeys with a refresh in flight, so a poll storm makes one request. */
const contextRefreshes = globalThis.__agentSessionContextRefreshes ??
  (globalThis.__agentSessionContextRefreshes = new Set<string>());

/**
 * The percentage opencode's own footer shows, by opencode's own rule.
 *
 * `Math.round(tokens / limit * 100)`, transcribed from the 1.18.22 bundle
 * (`docs/design/opencode-server-live-verification.md` §14.2) rather than
 * guessed, because the alternatives are all plausible and all wrong: the
 * denominator is `limit.context` and not `limit.input` (1,000,000 not 936,000 on
 * the measured model), and the rounding is `round` and not `ceil`, so a session
 * holding less than half a percent reads `0%` rather than `1%`.
 *
 * @returns The whole-number percentage, or null when either input is unknown
 */
export function agentSessionContextPercent(
  tokens: number | null,
  limit: number | null
): number | null {
  if (tokens === null || limit === null) return null;
  if (!Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.round((tokens / limit) * 100);
}

/** What this instance's context last measured, or null. Synchronous. */
export function getAgentSessionContextUsage(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentSessionContextUsage | null {
  return contextUsages.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/** Store one measurement. Exported for the suites that stand in for the fetch. */
export function recordAgentSessionContextUsage(
  target: AgentInstanceRef,
  usage: AgentSessionContextUsage
): void {
  contextUsages.set(
    buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId),
    usage
  );
}

/** Drop one instance's measurement. */
export function forgetAgentSessionContextUsage(target: AgentInstanceRef): void {
  contextUsages.delete(buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId));
}

/** Drop every measurement and every in-flight marker. Test seam. */
export function resetAgentSessionContextUsage(): void {
  contextUsages.clear();
  contextRefreshes.clear();
}

/**
 * Answer with what is cached, and start a refresh when it is stale (#2042).
 *
 * **Never awaits and never throws**, which is the whole shape of it. The caller
 * is `buildCurrentOutput`, on the path `commandmate capture` and every terminal
 * pane poll take several times a second, and the two numbers here need two HTTP
 * round trips to an agent's own server. Awaiting them would put a foreign
 * process's latency in front of a payload that is mostly a terminal frame; so
 * the poll that notices the record moved answers `null` (or the previous turn's
 * numbers) and the next one, a second or two later, answers the new ones.
 *
 * Staleness is `record.at`, not a clock: `session.updated` fires a handful of
 * times per turn, so a refresh happens per *turn* rather than per poll, and a
 * session nobody is talking to makes no requests at all.
 *
 * @param target - The instance whose context is being described
 * @param record - Its current telemetry, or null when the agent has said nothing
 * @returns The cached measurement, or null when there is none yet
 */
export function ensureAgentSessionContextUsage(
  target: AgentInstanceRef,
  record: AgentSessionRecord | null
): AgentSessionContextUsage | null {
  const key = buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
  const cached = contextUsages.get(key) ?? null;
  // No session, or one the agent has not named: nothing to ask about. The
  // cached value is left in place rather than cleared — the subscription's
  // close is what retires it, the same lifetime the record itself has.
  if (!record || !record.id) return cached;
  if (cached && cached.sessionAt === record.at) return cached;
  if (contextRefreshes.has(key)) return cached;
  contextRefreshes.add(key);
  void refreshAgentSessionContextUsage(target, record).finally(() => {
    contextRefreshes.delete(key);
  });
  return cached;
}

/**
 * Ask the instance's own server the two questions and store the answer.
 *
 * Exported so a caller that *can* wait — a test, or a future CLI path — can,
 * and so the fire-and-forget above has a name to point at. Resolves to the
 * measurement it stored, or null when the instance has no reachable server:
 * `getAssignedOpencodePort` answers null for every tool but opencode and for an
 * opencode pane whose port was never written down.
 */
export async function refreshAgentSessionContextUsage(
  target: AgentInstanceRef,
  record: AgentSessionRecord
): Promise<AgentSessionContextUsage | null> {
  const sessionId = record.id;
  if (!sessionId) return null;
  const port = getAssignedOpencodePort(target);
  if (port === null) return null;

  const [tokens, limit] = await Promise.all([
    fetchOpencodeContextTokens(port, sessionId),
    record.provider && record.model
      ? fetchOpencodeModelContextLimit(port, record.provider, record.model)
      : Promise.resolve(null),
  ]);
  // Both null means the two calls found nothing to say — a fresh session and an
  // unrecognised model. Stored anyway, with `sessionAt` set: the point of the
  // record is to stop this pair of requests repeating every poll, and a null
  // that is dated is what says "asked, and the answer was nothing".
  const usage: AgentSessionContextUsage = {
    tokens,
    limit,
    percent: agentSessionContextPercent(tokens, limit),
    sessionAt: record.at,
    at: Date.now(),
  };
  recordAgentSessionContextUsage(target, usage);
  return usage;
}
