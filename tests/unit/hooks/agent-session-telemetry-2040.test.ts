/**
 * Reading a session's cost, model and title off the stream (Issue #2040).
 *
 * The frame shape here is **measured**, not guessed: opencode 1.18.22 serves its
 * own OpenAPI document at `GET /doc`, and `EventSessionUpdated` declares
 * `properties: { sessionID, info: Session }` while `Session` declares `title`,
 * `agent`, `model: { id, providerID, variant? }`, `cost: number` and
 * `tokens: { input, output, reasoning, cache: { read, write } }` — `total` is
 * declared on an assistant *message* and not on a session, which is why the
 * record publishes it as null.
 *
 * A captured fixture would be better and is not available: `session.updated` is
 * not among the frames `tests/fixtures/hooks/opencode` holds, and that directory
 * is outside this Issue's scope. The frames below are built from the schema
 * instead, and the two facts that matter — the nesting of `tokens.cache` and the
 * `parentID` sub-agent marker — are exactly the ones the schema pins.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetAgentSessionTelemetry,
  getAgentSessionTelemetry,
  MAX_AGENT_SESSION_TITLE_LENGTH,
  readOpencodeSessionFrame,
  recordAgentSessionTelemetry,
  resetAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';

const AT = 1_700_000_000_000;

/** A `session.updated` frame, as 1.18.22's schema declares it. */
function sessionUpdated(info: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_0000000000000000000000000',
    type: 'session.updated',
    properties: {
      sessionID: 'ses_0000000000000000000000000',
      info: {
        id: 'ses_0000000000000000000000000',
        slug: 'fix-the-flaky-test',
        projectID: 'global',
        directory: '/tmp/wt-1',
        title: 'Fix the flaky test',
        agent: 'build',
        model: { id: 'claude-sonnet-4.6', providerID: 'github-copilot' },
        cost: 0.4213,
        tokens: {
          input: 120,
          output: 30,
          reasoning: 0,
          cache: { read: 4096, write: 512 },
        },
        version: '1.18.22',
        time: { created: AT - 1000, updated: AT },
        ...info,
      },
    },
  };
}

beforeEach(() => {
  resetAgentSessionTelemetry();
});

describe('readOpencodeSessionFrame', () => {
  it('reads every field the Session schema declares', () => {
    expect(readOpencodeSessionFrame(sessionUpdated(), AT)).toEqual({
      id: 'ses_0000000000000000000000000',
      title: 'Fix the flaky test',
      agent: 'build',
      model: 'claude-sonnet-4.6',
      provider: 'github-copilot',
      cost: 0.4213,
      tokens: {
        input: 120,
        output: 30,
        reasoning: 0,
        // `tokens.cache.read` / `.write`, flattened — one optional level in a
        // CLI contract instead of two.
        cacheRead: 4096,
        cacheWrite: 512,
        // Declared on an assistant message, not on a session. Published as null
        // rather than as this server's own sum of the other five.
        total: null,
      },
      at: AT,
    });
  });

  it('refuses a sub-agent session', () => {
    // `parentID` is present only on a session opencode opened inside another
    // one, and its cost is the sub-agent's rather than the pane's. Recording it
    // would make the field flip between the conversation the operator is having
    // and a background job about to end.
    expect(readOpencodeSessionFrame(sessionUpdated({ parentID: 'ses_parent' }), AT)).toBeNull();
  });

  it('answers null for a frame with no session in it', () => {
    expect(readOpencodeSessionFrame({ type: 'session.updated' }, AT)).toBeNull();
    expect(readOpencodeSessionFrame({ type: 'session.updated', properties: {} }, AT)).toBeNull();
  });

  it('reports absent counts as null, never as zero', () => {
    // A session that has not run a turn publishes no counts at all, and `0`
    // there would be this server inventing a measurement.
    const record = readOpencodeSessionFrame(
      sessionUpdated({ cost: undefined, tokens: undefined, model: undefined, agent: undefined }),
      AT,
    );

    expect(record).toMatchObject({
      agent: null,
      model: null,
      provider: null,
      cost: null,
      tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
    });
  });

  it('discards a non-finite number rather than publishing it', () => {
    // `JSON.stringify(NaN)` is `null`, so admitting these would publish a null
    // meaning "the agent said NaN" beside one meaning "the agent said nothing".
    const record = readOpencodeSessionFrame(
      sessionUpdated({ cost: Number.NaN, tokens: { input: Number.POSITIVE_INFINITY, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
      AT,
    );

    expect(record?.cost).toBeNull();
    expect(record?.tokens.input).toBeNull();
    expect(record?.tokens.output).toBe(3);
  });

  it('truncates a title rather than refusing it', () => {
    // The opposite of the rule for an id (#1932 DR4-001): nothing matches on a
    // title, so a shortened one misinforms visibly instead of colliding.
    const record = readOpencodeSessionFrame(sessionUpdated({ title: 'x'.repeat(5000) }), AT);

    expect(record?.title).toHaveLength(MAX_AGENT_SESSION_TITLE_LENGTH);
  });
});

describe('the store', () => {
  const target = { worktreeId: 'wt-1', cliToolId: 'opencode', instanceId: 'opencode-2' } as const;

  it('keys on the instance, not the worktree', () => {
    const record = readOpencodeSessionFrame(sessionUpdated(), AT);
    recordAgentSessionTelemetry(target, record!);

    expect(getAgentSessionTelemetry('wt-1', 'opencode', 'opencode-2')?.cost).toBe(0.4213);
    expect(getAgentSessionTelemetry('wt-1', 'opencode', 'opencode')).toBeNull();
    expect(getAgentSessionTelemetry('wt-2', 'opencode', 'opencode-2')).toBeNull();
  });

  it('drops the record when the instance is forgotten', () => {
    recordAgentSessionTelemetry(target, readOpencodeSessionFrame(sessionUpdated(), AT)!);

    forgetAgentSessionTelemetry(target);

    expect(getAgentSessionTelemetry('wt-1', 'opencode', 'opencode-2')).toBeNull();
  });
});
