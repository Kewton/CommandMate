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
 * @module lib/hooks/agent-session-telemetry
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
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

/** Drop one instance's record. Called when its subscription closes. */
export function forgetAgentSessionTelemetry(target: AgentInstanceRef): void {
  records.delete(buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId));
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
