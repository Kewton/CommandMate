/**
 * `agent-event-record`, the type module split out of `agent-event-state`
 * (Issue #3375).
 *
 * The module holds one type and no runtime code. This suite pins that the
 * type `agent-event-state` re-exports is the same one, and that the record's
 * shape — required and optional fields — is what it was before the split.
 *
 * @vitest-environment node
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import type { AgentEventRecord as ReExported } from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';

describe('agent-event-record (#3375)', () => {
  it('is the type agent-event-state re-exports', () => {
    expectTypeOf<ReExported>().toEqualTypeOf<AgentEventRecord>();
  });

  it('requires the four identifying fields and leaves the rest optional', () => {
    expectTypeOf<AgentEventRecord['event']>().toEqualTypeOf<AgentEventType>();
    expectTypeOf<AgentEventRecord['at']>().toEqualTypeOf<number>();
    expectTypeOf<AgentEventRecord['detail']>().toEqualTypeOf<string | null>();
    expectTypeOf<AgentEventRecord['sessionId']>().toEqualTypeOf<string | null>();

    const minimal: AgentEventRecord = { event: 'stop', at: 1, detail: null, sessionId: null };
    expect(minimal).toEqual({ event: 'stop', at: 1, detail: null, sessionId: null });
  });

  it('carries the optional source statements', () => {
    expectTypeOf<AgentEventRecord['message']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AgentEventRecord['model']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AgentEventRecord['decisionId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AgentEventRecord['toolName']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AgentEventRecord['decisionPatterns']>().toEqualTypeOf<
      readonly unknown[] | null | undefined
    >();
    expectTypeOf<AgentEventRecord['promptSettled']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<AgentEventRecord['joinsOpenTurn']>().toEqualTypeOf<boolean | undefined>();
  });
});
