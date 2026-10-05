/**
 * The request-reading stages split out of POST /api/hooks/agent-event
 * (Issue #3376). The route tests cover the whole handler; these pin the order
 * in which the first problem is reported and what a valid request reads as.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_ID_LENGTH,
  readAgentEventRequest,
  readEventDetail,
  readString,
} from '@/lib/hooks/agent-event-intake';
import type { NormalizedAgentEvent } from '@/lib/hooks/sources';

const NO_QUERY = new URLSearchParams();

function errorOf(payload: Record<string, unknown>, query = NO_QUERY): string | null {
  const result = readAgentEventRequest(payload, query);
  return 'error' in result ? result.error : null;
}

describe('readString (#3376)', () => {
  it('returns non-empty strings only', () => {
    expect(readString({ a: 'x' }, 'a')).toBe('x');
    expect(readString({ a: '' }, 'a')).toBeUndefined();
    expect(readString({ a: 1 }, 'a')).toBeUndefined();
    expect(readString({}, 'a')).toBeUndefined();
  });
});

describe('readAgentEventRequest (#3376)', () => {
  it('refuses an unknown tool before anything else', () => {
    expect(errorOf({ tool: 'nope', event: 'bogus' })).toBe('tool must be a known CLI tool id');
  });

  it('reads the tool from the query when the body has none', () => {
    const query = new URLSearchParams({ tool: 'claude', worktreeId: 'wt-1' });
    const result = readAgentEventRequest({ event: 'stop' }, query);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.tool).toBe('claude');
      expect(result.worktreeIdParam).toBe('wt-1');
    }
  });

  it('refuses an unknown event word', () => {
    expect(errorOf({ tool: 'claude', event: 'bogus' })).toMatch(/^event must be one of: /);
  });

  it('refuses an over-long sessionId before looking at the instance', () => {
    expect(
      errorOf({
        tool: 'claude',
        event: 'stop',
        sessionId: 'x'.repeat(MAX_SESSION_ID_LENGTH + 1),
        instanceId: '../bad',
      })
    ).toBe(`sessionId must be a string of at most ${MAX_SESSION_ID_LENGTH} characters`);
  });

  it('refuses an unsafe instanceId', () => {
    expect(errorOf({ tool: 'claude', event: 'stop', instanceId: '../bad' })).toBe(
      'instanceId must be a safe, bounded identifier'
    );
  });

  it('requires a cwd only when no worktreeId was sent', () => {
    expect(errorOf({ tool: 'claude', event: 'stop' })).toBe('cwd rejected: empty');
    expect(errorOf({ tool: 'claude', event: 'stop', worktreeId: 'wt-1' })).toBeNull();
  });

  it('validates a sent cwd even when a worktreeId was sent too', () => {
    expect(
      errorOf({ tool: 'claude', event: 'stop', worktreeId: 'wt-1', cwd: 'relative/path' })
    ).toBe('cwd rejected: not_absolute');
  });

  it('reads the session id from either spelling', () => {
    const result = readAgentEventRequest(
      { tool: 'claude', event: 'stop', worktreeId: 'wt-1', session_id: 'sess-1' },
      NO_QUERY
    );
    expect('error' in result ? null : result.sessionId).toBe('sess-1');
  });
});

describe('readEventDetail (#3376)', () => {
  const base = { event: 'notification' } as NormalizedAgentEvent;

  it('prefers the source-normalised detail', () => {
    expect(readEventDetail({ ...base, detail: 'from-source' }, { detail: 'relay' })).toBe(
      'from-source'
    );
  });

  it('falls back to the relay detail, then null', () => {
    expect(readEventDetail({ ...base, detail: null }, { detail: 'relay' })).toBe('relay');
    expect(readEventDetail({ ...base, detail: null }, {})).toBeNull();
  });
});
