/**
 * Issue #2937: the verdicts behind opencode-v2's server checks — the SSE
 * events of the running turn, the launch line, and what outlived the session.
 */

import { describe, expect, it } from 'vitest';
import {
  distinctEventTypes,
  evaluateOpencodeV2LaunchLine,
  evaluateServerEvents,
  evaluateServerLeftovers,
  type ReceivedServerEvent,
} from '@/lib/agent-health/server-events';

const at = (type: string | null, receivedAt: number): ReceivedServerEvent => ({ type, receivedAt });

describe('evaluateServerEvents', () => {
  it('passes when started and succeeded arrive inside the running window', () => {
    const events = [at('server.connected', 1), at('session.execution.started', 10), at('session.execution.succeeded', 20)];
    const verdict = evaluateServerEvents(events, { window: { from: 5, to: 25 } });
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toContain('受け取った type: server.connected, session.execution.started, session.execution.succeeded');
  });

  it('fails when succeeded arrives only after the running turn', () => {
    const events = [at('session.execution.started', 10), at('session.execution.succeeded', 40)];
    const verdict = evaluateServerEvents(events, { window: { from: 5, to: 25 } });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('session.execution.succeeded が未着');
  });

  it('fails with the received types when the names changed', () => {
    const verdict = evaluateServerEvents([at('session.run.started', 1), at('session.run.done', 2), at(null, 3)]);
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence).toBe('受け取った type: session.run.started, session.run.done, (type なし)');
  });

  it('fails on a stream error', () => {
    const verdict = evaluateServerEvents([], { streamError: 'refused' });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('refused');
  });

  it('distinctEventTypes keeps first-arrival order', () => {
    expect(distinctEventTypes([at('a', 1), at('b', 2), at('a', 3)])).toEqual(['a', 'b']);
  });
});

describe('evaluateOpencodeV2LaunchLine', () => {
  it('accepts the wrapper line', () => {
    expect(
      evaluateOpencodeV2LaunchLine("CM_PORT='1' bash '/r/scripts/opencode-v2/launch.sh' --port 4347 --password-file '/s/k.pw' --directory '/w'")
    ).toEqual({ ok: true });
  });

  it('rejects the --standalone fallback and says so', () => {
    const verdict = evaluateOpencodeV2LaunchLine("'opencode2' --standalone '/w'");
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok ? '' : verdict.reason).toContain('--standalone');
  });
});

describe('evaluateServerLeftovers', () => {
  it('is null when nothing is left', () => {
    expect(evaluateServerLeftovers({ port: 4347, portBound: false, pids: [] })).toBeNull();
  });

  it('fails on a bound port or a live serve', () => {
    const verdict = evaluateServerLeftovers({ port: 4347, portBound: true, pids: [123] });
    expect(verdict?.status).toBe('fail');
    expect(verdict?.summary).toContain('ポート 4347');
    expect(verdict?.summary).toContain('pid 123');
  });
});
