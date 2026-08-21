/**
 * The rule that stops one opencode turn from finishing twice (Issue #1763).
 *
 * `session.idle` is a good completion signal — #1758 §5.3.1 measured that a
 * session blocked on an approval emits none for ten minutes — but it is not a
 * countable one:
 *
 *  - an abort fires it twice, 19 ms apart, for the same turn (§5.3.2);
 *  - the payload is `{ "sessionID": … }` and carries no turn identifier, so the
 *    two are indistinguishable by inspection (§5.3.3);
 *  - and an idle can arrive for a turn this connection never watched start.
 *
 * The frames driving these tests are the captured ones, so the shapes are the
 * server's rather than this file's idea of them.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTurnGate, type TurnGate } from '@/lib/hooks/sources/opencode/turn-gate';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** Feed a captured frame, reading its type the way the subscription does. */
function feed(gate: TurnGate, name: string) {
  const payload = frame(name);
  return gate.observe(typeof payload.type === 'string' ? payload.type : null, payload);
}

let gate: TurnGate;

beforeEach(() => {
  gate = createTurnGate();
});

describe('arming', () => {
  it('completes the first idle after a busy', () => {
    expect(feed(gate, 'session-status-busy')).toEqual({
      kind: 'armed',
      sessionId: 'ses_0000000000000000000000000',
    });
    expect(feed(gate, 'session-idle')).toEqual({
      kind: 'completed',
      sessionId: 'ses_0000000000000000000000000',
    });
  });

  it('suppresses an idle for a turn it never saw start', () => {
    // A stream opened mid-session, or resubscribed after a CommandMate restart.
    // Reporting this would resolve a `wait` for work that was already over —
    // or, worse, for work that is still running.
    expect(feed(gate, 'session-idle')).toEqual({
      kind: 'suppressed',
      sessionId: 'ses_0000000000000000000000000',
      reason: 'never-armed',
    });
  });

  it('suppresses the second idle of an abnormal ending', () => {
    // The measured abort sequence: busy → error → status(idle) → idle → idle.
    // Mutation target: dropping the phase check here makes the second idle a
    // second completion, and one aborted turn resolves two waits.
    feed(gate, 'session-status-busy');
    feed(gate, 'session-error');
    expect(feed(gate, 'session-idle').kind).toBe('completed');
    expect(feed(gate, 'session-idle')).toEqual({
      kind: 'suppressed',
      sessionId: 'ses_0000000000000000000000000',
      reason: 'already-completed',
    });
  });

  it('re-arms for the next turn', () => {
    feed(gate, 'session-status-busy');
    expect(feed(gate, 'session-idle').kind).toBe('completed');
    feed(gate, 'session-status-busy');
    expect(feed(gate, 'session-idle').kind).toBe('completed');
  });

  it('treats session.status(idle) as nothing at all', () => {
    // It is emitted in the same millisecond as `session.idle` and is the same
    // signal (§5.3.2 rule 4). Honouring both would double every turn — and
    // would also disarm the gate before the real event arrived.
    feed(gate, 'session-status-busy');
    expect(feed(gate, 'session-status-idle')).toEqual({ kind: 'ignored' });
    expect(feed(gate, 'session-idle').kind).toBe('completed');
  });
});

describe('announcing a prompt', () => {
  it('announces a user message once', () => {
    expect(feed(gate, 'message-updated-user')).toEqual({
      kind: 'announced',
      sessionId: 'ses_0000000000000000000000000',
      messageId: 'msg_0000000000000000000000000',
    });
  });

  it('suppresses the repeat opencode emits after the turn ends', () => {
    // Measured live on 1.18.3 (2026-08-13):
    //   13:53:14.251  session.idle
    //   13:53:14.297  message.updated  role=user  id=msg_ffb668eec001WToZ7VW0lQgmoa
    // Both copies are byte-identical. Delivered, the second one makes
    // `user_prompt_submit` the newest event of a finished turn, which
    // `status-mapping` reads as `running` — so `commandmate wait` would hang on
    // every completed opencode turn until the 30-minute staleness bound.
    feed(gate, 'session-status-busy');
    expect(feed(gate, 'message-updated-user').kind).toBe('announced');
    expect(feed(gate, 'session-idle').kind).toBe('completed');
    expect(feed(gate, 'message-updated-user')).toEqual({
      kind: 'suppressed',
      sessionId: 'ses_0000000000000000000000000',
      reason: 'already-announced',
    });
  });

  it('announces the next turn, which carries a new message id', () => {
    feed(gate, 'message-updated-user');
    expect(
      gate.observe('message.updated', {
        properties: { sessionID: 'ses_a', info: { role: 'user', id: 'msg_second' } },
      })
    ).toMatchObject({ kind: 'announced', messageId: 'msg_second' });
  });

  it('ignores the assistant half of the conversation', () => {
    // `message.updated` for the assistant carries the reply, not a prompt.
    expect(
      gate.observe('message.updated', {
        properties: { sessionID: 'ses_a', info: { role: 'assistant', id: 'msg_a' } },
      })
    ).toEqual({ kind: 'ignored' });
  });

  it('keeps announced ids across a reconnect', () => {
    // The arming state must not survive — an idle without a busy is not this
    // connection's completion — but the announced ids must, or a reconnect
    // landing between a turn's end and its trailing repeat re-announces it.
    feed(gate, 'message-updated-user');
    gate.reset();
    expect(feed(gate, 'message-updated-user').kind).toBe('suppressed');
  });

  it('bounds how many message ids it remembers', () => {
    const small = createTurnGate(64, 2);
    for (const id of ['m1', 'm2', 'm3']) {
      small.observe('message.updated', {
        properties: { sessionID: 'ses_a', info: { role: 'user', id } },
      });
    }
    const seenAgain = (id: string) =>
      small.observe('message.updated', {
        properties: { sessionID: 'ses_a', info: { role: 'user', id } },
      }).kind;
    expect(seenAgain('m1')).toBe('announced'); // evicted, so re-announced
    expect(seenAgain('m3')).toBe('suppressed');
  });
});

describe('errors', () => {
  it('reports a session error without ending the turn', () => {
    // `session.idle` alone cannot tell "finished" from "gave up"; the error
    // frame carries the name that can (§5.3.3 requirement 3).
    feed(gate, 'session-status-busy');
    expect(feed(gate, 'session-error')).toEqual({
      kind: 'failed',
      sessionId: 'ses_0000000000000000000000000',
      errorName: 'APIError',
    });
    // Still armed: the completion is the idle that follows.
    expect(gate.isArmed('ses_0000000000000000000000000')).toBe(true);
  });
});

describe('bookkeeping', () => {
  it('keeps sessions apart', () => {
    gate.observe('session.status', {
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
    });
    // `ses_b`'s idle is not `ses_a`'s completion. Issue #1900 renamed the
    // reason: while `ses_a` — the primary — is still busy, the frame is
    // rejected for belonging to another session before it is ever asked
    // whether *this* connection watched it start. Suppressed either way.
    expect(gate.observe('session.idle', { properties: { sessionID: 'ses_b' } })).toEqual({
      kind: 'suppressed',
      sessionId: 'ses_b',
      reason: 'foreign-session',
    });
    expect(gate.observe('session.idle', { properties: { sessionID: 'ses_a' } }).kind).toBe(
      'completed'
    );
  });

  it('ignores frames with no session id', () => {
    expect(gate.observe('session.idle', { properties: {} })).toEqual({ kind: 'ignored' });
    expect(gate.observe('server.heartbeat', frame('server-heartbeat'))).toEqual({
      kind: 'ignored',
    });
    expect(gate.observe(null, {})).toEqual({ kind: 'ignored' });
  });

  it('bounds how many sessions it remembers', () => {
    const small = createTurnGate(2);
    for (const id of ['ses_1', 'ses_2', 'ses_3']) {
      small.observe('session.status', { properties: { sessionID: id, status: { type: 'busy' } } });
    }
    // Forgetting costs a suppressed idle, which is the safe direction: the
    // failure mode of a full map is never a spurious completion.
    expect(small.isArmed('ses_1')).toBe(false);
    expect(small.isArmed('ses_3')).toBe(true);
  });

  it('forgets everything on reset, so a reconnect re-arms', () => {
    feed(gate, 'session-status-busy');
    gate.reset();
    expect(feed(gate, 'session-idle').kind).toBe('suppressed');
  });
});
