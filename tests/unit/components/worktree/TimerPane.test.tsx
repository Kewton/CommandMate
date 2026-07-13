/**
 * Unit tests for TimerPane (Issue #945)
 *
 * Focus: the inline form was replaced by a "+ Create Timer" / "+ New Timer"
 * button that opens TimerEditDialog. Verifies the empty-state CTA, the
 * existing-list button, the at-capacity disable, and the fetch-on-mount.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { TimerPane } from '@/components/worktree/TimerPane';
import { MAX_TIMERS_PER_WORKTREE } from '@/config/timer-constants';

interface FakeTimer {
  id: string;
  cliToolId: string;
  instanceId: string;
  message: string;
  delayMs: number;
  scheduledSendTime: number;
  status: string;
  createdAt: number;
  sentAt: number | null;
  error: string | null;
}

function makeTimer(overrides: Partial<FakeTimer> = {}): FakeTimer {
  return {
    id: 't1',
    cliToolId: 'claude',
    instanceId: 'claude',
    message: 'hello',
    delayMs: 300000,
    scheduledSendTime: 9_999_999_999_999,
    status: 'pending',
    createdAt: 1_700_000_000_000,
    sentAt: null,
    error: null,
    ...overrides,
  };
}

/** Stub fetch so the GET /timers poll returns the given list. */
function stubTimers(timers: FakeTimer[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ timers, hasMore: false }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TimerPane (Issue #945)', () => {
  it('fetches timers on mount', async () => {
    const fetchMock = stubTimers([]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt-1/timers'));
  });

  it('shows the empty-state CTA when there are no timers', async () => {
    stubTimers([]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-empty-cta')).toBeDefined());
    expect(screen.queryByTestId('timer-new-button')).toBeNull();
    // No dialog field is visible until the CTA is clicked.
    expect(screen.queryByTestId('timer-message-input')).toBeNull();
  });

  it('opens the dialog when the empty-state CTA is clicked', async () => {
    stubTimers([]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-empty-cta')).toBeDefined());
    fireEvent.click(screen.getByTestId('timer-empty-cta'));
    expect(screen.getByTestId('timer-message-input')).toBeDefined();
  });

  it('shows the "+ New Timer" button (enabled) when timers exist below capacity', async () => {
    stubTimers([makeTimer()]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-new-button')).toBeDefined());
    expect((screen.getByTestId('timer-new-button') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('timer-empty-cta')).toBeNull();
  });

  it('opens the dialog when the "+ New Timer" button is clicked', async () => {
    stubTimers([makeTimer()]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-new-button')).toBeDefined());
    fireEvent.click(screen.getByTestId('timer-new-button'));
    expect(screen.getByTestId('timer-message-input')).toBeDefined();
  });

  it('disables the opener and shows maxReached at capacity', async () => {
    const full = Array.from({ length: MAX_TIMERS_PER_WORKTREE }, (_, i) =>
      makeTimer({ id: `t${i}`, status: 'pending' }),
    );
    stubTimers(full);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-new-button')).toBeDefined());
    expect((screen.getByTestId('timer-new-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('schedule.timer.maxReached')).toBeDefined();
  });
});

describe('TimerPane detail modal (Issue #1107)', () => {
  const longMessage = 'x'.repeat(80); // > 60 chars so the list row truncates

  it('opens the detail modal with the full message when a row is clicked', async () => {
    stubTimers([makeTimer({ status: 'sent', sentAt: 1_700_000_100_000, message: longMessage })]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-row')).toBeDefined());

    // Modal is closed initially.
    expect(screen.queryByTestId('timer-detail-message')).toBeNull();

    fireEvent.click(screen.getByTestId('timer-row'));

    const detail = screen.getByTestId('timer-detail-message');
    expect(detail.textContent).toBe(longMessage); // full, not truncated
  });

  it('shows the failure reason for a failed timer', async () => {
    stubTimers([
      makeTimer({ status: 'failed', error: '[send] tmux session not found' }),
    ]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-row')).toBeDefined());

    fireEvent.click(screen.getByTestId('timer-row'));

    expect(screen.getByText('schedule.timer.failureReason')).toBeDefined();
    expect(screen.getByTestId('timer-detail-error').textContent).toBe('[send] tmux session not found');
  });

  it('does not show a failure reason section for non-failed timers', async () => {
    stubTimers([makeTimer({ status: 'sent', sentAt: 1_700_000_100_000 })]);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-row')).toBeDefined());

    fireEvent.click(screen.getByTestId('timer-row'));

    expect(screen.queryByTestId('timer-detail-error')).toBeNull();
  });

  it('does not open the modal when the pending cancel button is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ timers: [makeTimer({ status: 'pending' })], hasMore: false }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TimerPane worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByTestId('timer-row')).toBeDefined());

    // Click the cancel button nested inside the clickable row.
    fireEvent.click(screen.getByText('schedule.timer.cancel'));

    // stopPropagation prevents the row's onClick → modal stays closed.
    expect(screen.queryByTestId('timer-detail-message')).toBeNull();
  });
});
