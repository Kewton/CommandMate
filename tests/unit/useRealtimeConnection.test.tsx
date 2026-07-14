/**
 * Unit tests for RealtimeProvider / useRealtime (Issue #1120).
 * Covers subscription ref-counting, listener fan-out, and graceful no-op
 * behavior when no provider is mounted.
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RealtimeProvider, useRealtime } from '@/hooks/useRealtimeConnection';
import { MockWebSocket, installMockWebSocket } from '@tests/helpers/mock-websocket';
import type { RealtimeEvent } from '@/lib/realtime/types';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RealtimeProvider>{children}</RealtimeProvider>
);

describe('useRealtime (no provider)', () => {
  it('returns a disconnected no-op value', () => {
    const { result } = renderHook(() => useRealtime());
    expect(result.current.status).toBe('disconnected');
    expect(result.current.connected).toBe(false);
    // No-ops must not throw.
    expect(() => {
      result.current.subscribe('wt-1');
      result.current.unsubscribe('wt-1');
      const off = result.current.addListener(() => {});
      off();
    }).not.toThrow();
  });
});

describe('RealtimeProvider', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMockWebSocket();
  });

  afterEach(() => {
    uninstall();
  });

  it('reports connected once the socket opens', () => {
    const { result } = renderHook(() => useRealtime(), { wrapper });
    expect(result.current.connected).toBe(false);
    act(() => MockWebSocket.last().mockOpen());
    expect(result.current.connected).toBe(true);
    expect(result.current.status).toBe('connected');
  });

  it('ref-counts subscriptions (one server frame per room)', () => {
    const { result } = renderHook(() => useRealtime(), { wrapper });
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());

    act(() => {
      result.current.subscribe('wt-1');
      result.current.subscribe('wt-1');
    });
    const subFrames = ws.sent.filter((s) => s.includes('"subscribe"') && s.includes('wt-1'));
    expect(subFrames).toHaveLength(1);

    // First unsubscribe only decrements the refcount.
    act(() => result.current.unsubscribe('wt-1'));
    expect(ws.sent.filter((s) => s.includes('"unsubscribe"'))).toHaveLength(0);

    // Second unsubscribe drops the room.
    act(() => result.current.unsubscribe('wt-1'));
    expect(ws.sent.filter((s) => s.includes('"unsubscribe"') && s.includes('wt-1'))).toHaveLength(1);
  });

  it('fans out parsed events to all listeners', () => {
    const { result } = renderHook(() => useRealtime(), { wrapper });
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());

    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    let offB = () => {};
    act(() => {
      result.current.addListener((e) => a.push(e));
      offB = result.current.addListener((e) => b.push(e));
    });

    act(() =>
      ws.mockMessage(
        JSON.stringify({
          type: 'broadcast',
          data: { type: 'message', worktreeId: 'wt-1', message: { id: 'm1' } },
        }),
      ),
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].type).toBe('message');

    // Removing a listener stops its delivery.
    act(() => offB());
    act(() =>
      ws.mockMessage(
        JSON.stringify({ type: 'broadcast', data: { type: 'message', worktreeId: 'wt-1', message: { id: 'm2' } } }),
      ),
    );
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });
});
