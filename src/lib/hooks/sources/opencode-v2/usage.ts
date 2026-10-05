/**
 * What an OpenCode V2 session has spent, and how full its context is
 * (Issue #2981, Epic #2370).
 *
 * v1 publishes both through `lib/hooks/agent-session-telemetry`: the session
 * record off `session.updated`, and the context occupancy from two further
 * requests to v1's server. This module fills the same two records for
 * `opencode-v2`, so every reader (`current-output`, `capture --json`, the pane
 * header, the cost sampler) shows v2 without knowing it is v2.
 *
 * ## What was measured (2.0.18, `tests/fixtures/opencode-v2-usage-2981`)
 *
 * | quantity | where | after turn 1 | after turn 2 |
 * |---|---|---|---|
 * | session, cumulative | `session.usage.updated` `data.tokens` = `GET /api/session/{id}` `tokens` | 2857 / 12 / 64 / 3840 | 5925 / 34 / 128 / 13312 |
 * | context, last turn | newest assistant message's `tokens` (= its `session.step.ended`) | 6,208 | 6,341 |
 * | TUI | footer / sidebar | `6.2K (1%)` / `6,208 tokens` | `6.3K (1%)` / `6,341 tokens` |
 *
 * (input / output / reasoning / cache.read.) The session total also counts the
 * title-generation call (the first `session.usage.updated` of a session, 565
 * tokens, belongs to no assistant message), so the two are different quantities
 * and v1's rule holds unchanged: the record is the cumulative figure, the
 * context is the newest assistant message's sum, and the percentage is
 * `round(tokens / limit.context * 100)` with `limit.context` from
 * `GET /api/model` (1,000,000 for the measured model).
 *
 * ## Pull on the frame, not the frame
 *
 * `session.usage.updated` carries `sessionID`, `cost` and `tokens` and nothing
 * else — no title, agent, model or `parentID`. So the frame is a trigger, as
 * the end of a turn is: both make this module read `GET /api/session/{id}`
 * (the record, and `parentID` so a sub-agent's session is refused exactly as
 * v1 refuses it), the newest messages (the context) and `GET /api/model` (the
 * limit), with the instance's own port and password. Refreshes are coalesced
 * per instance: one in flight, at most one queued behind it.
 *
 * ## Lifetime
 *
 * The subscription drops both records when it closes or ends
 * (`forgetAgentSessionTelemetry`, the call v1 makes in the same place), and a
 * refresh that finishes after that writes nothing ({@link refreshOpencodeV2SessionUsage}'s
 * `isCurrent`).
 *
 * @module lib/hooks/sources/opencode-v2/usage
 */

import {
  agentSessionContextPercent,
  readOpencodeSessionInfo,
  recordAgentSessionContextUsage,
  recordAgentSessionTelemetry,
  type AgentSessionRecord,
} from '@/lib/hooks/agent-session-telemetry';
import { createLogger } from '@/lib/logger';
import { isPlainObject, readStringField } from '../event-mapper';
import type { AgentInstanceRef } from '../types';
import {
  fetchOpencodeV2Models,
  fetchOpencodeV2RecentMessages,
  fetchOpencodeV2Session,
} from './client';
import { isOpencodeV2TurnEndEventType } from './history';
import { opencodeV2KeyOf, readOpencodeV2Password } from './secrets';
import { getOrInitGlobal } from '../../../global-state';

const logger = createLogger('lib/hooks/sources/opencode-v2/usage');

/** The frame that says a session's running total moved. */
export const OPENCODE_V2_USAGE_EVENT_TYPE = 'session.usage.updated';

/** Whether a frame `type` should refresh the usage records. */
export function isOpencodeV2UsageTriggerType(type: string | null): boolean {
  return type === OPENCODE_V2_USAGE_EVENT_TYPE || isOpencodeV2TurnEndEventType(type);
}

function readCount(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function createdAtOf(message: Record<string, unknown>): number {
  const time = isPlainObject(message.time) ? message.time : null;
  const created = time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
}

/**
 * The newest assistant message's token footprint, or null.
 *
 * v1's `fetchOpencodeContextTokens` rule on v2's message shape: the newest
 * `assistant` message (by `time.created`, the id breaking ties) that produced
 * output, `input + output + reasoning + cache.read + cache.write`. A message
 * with no output yet is a step still streaming, and would read as a context
 * that shrank. Order-agnostic, pure.
 */
export function readOpencodeV2ContextTokens(entries: readonly unknown[]): number | null {
  let newest: { at: number; id: string; total: number } | null = null;
  for (const entry of entries) {
    if (!isPlainObject(entry) || readStringField(entry, 'type') !== 'assistant') continue;
    const tokens = isPlainObject(entry.tokens) ? entry.tokens : null;
    if (!tokens) continue;
    const output = readCount(tokens, 'output');
    if (output <= 0) continue;
    const cache = isPlainObject(tokens.cache) ? tokens.cache : {};
    const total =
      readCount(tokens, 'input') +
      output +
      readCount(tokens, 'reasoning') +
      readCount(cache, 'read') +
      readCount(cache, 'write');
    const at = createdAtOf(entry);
    const id = readStringField(entry, 'id') ?? '';
    if (newest === null || at > newest.at || (at === newest.at && id > newest.id)) {
      newest = { at, id, total };
    }
  }
  return newest?.total ?? null;
}

/**
 * `limit.context` of one model out of `GET /api/model`'s `data`, or null.
 *
 * `context` only, and a non-positive value is "no percentage" — v1's
 * `readOpencodeModelContextLimit` rule. v2 lists models flat, each naming its
 * `providerID` and `id`.
 */
export function readOpencodeV2ModelContextLimit(
  models: readonly unknown[],
  providerId: string,
  modelId: string
): number | null {
  for (const model of models) {
    if (!isPlainObject(model)) continue;
    if (model.providerID !== providerId || model.id !== modelId) continue;
    const limit = isPlainObject(model.limit) ? model.limit : null;
    const context = limit?.context;
    if (typeof context !== 'number' || !Number.isFinite(context) || context <= 0) return null;
    return context;
  }
  return null;
}

/**
 * Read the session, its context and its model's limit, and store both records.
 *
 * Never throws. Answers the record it stored, or null when it stored nothing:
 * no password (the session was killed), a session the server did not answer, a
 * sub-agent's session, or `isCurrent()` false by the time the answers came in.
 *
 * @param isCurrent - Whether the subscription that asked is still the
 *   instance's; checked after the requests, right before writing
 */
export async function refreshOpencodeV2SessionUsage(
  target: AgentInstanceRef,
  port: number,
  sessionId: string,
  isCurrent: () => boolean = () => true
): Promise<AgentSessionRecord | null> {
  try {
    const password = readOpencodeV2Password(target);
    if (password === null) return null;
    const info = await fetchOpencodeV2Session(port, password, sessionId);
    const record = readOpencodeSessionInfo(info, Date.now());
    if (!record || !record.id) return null;

    const provider = record.provider;
    const model = record.model;
    const [messages, models] = await Promise.all([
      fetchOpencodeV2RecentMessages(port, password, record.id),
      provider && model ? fetchOpencodeV2Models(port, password) : Promise.resolve(null),
    ]);
    const tokens = messages ? readOpencodeV2ContextTokens(messages) : null;
    const limit =
      models && provider && model ? readOpencodeV2ModelContextLimit(models, provider, model) : null;

    if (!isCurrent()) return null;
    recordAgentSessionTelemetry(target, record);
    recordAgentSessionContextUsage(target, {
      tokens,
      limit,
      percent: agentSessionContextPercent(tokens, limit),
      sessionAt: record.at,
      at: Date.now(),
    });
    return record;
  } catch (error) {
    logger.warn('opencode-v2-usage-refresh-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface UsageRefreshSlot {
  running: Promise<void>;
  queued: { port: number; sessionId: string; isCurrent: () => boolean } | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeV2UsageRefreshes: Map<string, UsageRefreshSlot> | undefined;
}

/** One refresh in flight per instance, on `globalThis` for #1736's reason. */
const slots = getOrInitGlobal('__opencodeV2UsageRefreshes', () => new Map<string, UsageRefreshSlot>());

/** Forget in-flight markers. Test seam. */
export function resetOpencodeV2UsageRefreshes(): void {
  slots.clear();
}

/**
 * Refresh the instance's usage, coalescing a burst of frames into at most one
 * request set in flight and one queued behind it (the newest wins the queue).
 *
 * @returns A promise that settles when the instance has no refresh left to run
 */
export function scheduleOpencodeV2SessionUsageRefresh(
  target: AgentInstanceRef,
  port: number,
  sessionId: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const key = opencodeV2KeyOf(target);
  const existing = slots.get(key);
  if (existing) {
    existing.queued = { port, sessionId, isCurrent };
    return existing.running;
  }
  const slot: UsageRefreshSlot = { running: Promise.resolve(), queued: null };
  slot.running = (async (): Promise<void> => {
    let next: UsageRefreshSlot['queued'] = { port, sessionId, isCurrent };
    while (next !== null) {
      const current: NonNullable<UsageRefreshSlot['queued']> = next;
      slot.queued = null;
      await refreshOpencodeV2SessionUsage(target, current.port, current.sessionId, current.isCurrent);
      next = slot.queued;
    }
    if (slots.get(key) === slot) slots.delete(key);
  })();
  slots.set(key, slot);
  return slot.running;
}
