/**
 * Unit tests for parseRealtimeEvent envelope handling (Issue #1120).
 */

import { describe, it, expect } from 'vitest';
import { parseRealtimeEvent } from '@/lib/realtime/types';

describe('parseRealtimeEvent', () => {
  it('unwraps the room broadcast envelope to the inner event', () => {
    const raw = JSON.stringify({
      type: 'broadcast',
      worktreeId: 'wt-1',
      data: { type: 'message', message: { id: 'm1' } },
    });
    expect(parseRealtimeEvent(raw)).toMatchObject({ type: 'message', worktreeId: 'wt-1' });
  });

  it('keeps an explicit inner worktreeId', () => {
    const raw = JSON.stringify({
      type: 'broadcast',
      worktreeId: 'outer',
      data: { type: 'session_status_changed', worktreeId: 'inner', isRunning: false },
    });
    expect(parseRealtimeEvent(raw)).toMatchObject({ worktreeId: 'inner', isRunning: false });
  });

  it('passes through a non-enveloped typed frame', () => {
    const raw = JSON.stringify({ type: 'terminal_snapshot', worktreeId: 'wt-1', version: 3 });
    expect(parseRealtimeEvent(raw)).toMatchObject({ type: 'terminal_snapshot', version: 3 });
  });

  it('returns null for malformed / typeless input', () => {
    expect(parseRealtimeEvent('not-json{')).toBeNull();
    expect(parseRealtimeEvent(JSON.stringify({ type: 'broadcast' }))).toBeNull();
    expect(parseRealtimeEvent(JSON.stringify({ type: 'broadcast', data: 42 }))).toBeNull();
    expect(parseRealtimeEvent(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});
