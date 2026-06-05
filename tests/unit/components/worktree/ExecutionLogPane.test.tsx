/**
 * Tests for ExecutionLogPane (Issue #826 — UX Phase 3)
 *
 * Focus: empty-state CTA + collapsible manual steps, Schedules/Logs tab
 * separation, and inline row actions (toggle / edit / delete).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

interface RouteData {
  schedules?: unknown[];
  logs?: unknown[];
  active?: unknown[];
}

/** Route the three mount-time GETs by URL; PATCH/DELETE resolve ok. */
function setupFetch({ schedules = [], logs = [], active = [] }: RouteData = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/schedules/active')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedules: active }) });
    }
    if (url.endsWith('/schedules')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedules }) });
    }
    if (url.endsWith('/execution-logs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    worktree_id: 'wt-1',
    name: 'daily-review',
    message: 'Summarize README',
    cron_expression: '0 9 * * *',
    cli_tool_id: 'claude',
    enabled: 1,
    last_executed_at: 1_700_000_000_000,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionLogPane (Issue #826)', () => {
  describe('empty state', () => {
    it('shows a centered create CTA and hides manual steps by default', async () => {
      setupFetch({ schedules: [] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const cta = await screen.findByTestId('schedule-empty-cta');
      expect(cta).toBeDefined();
      expect(screen.queryByTestId('schedule-manual-steps')).toBeNull();
    });

    it('reveals the legacy 4-step manual instructions when the toggle is clicked', async () => {
      setupFetch({ schedules: [] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const toggle = await screen.findByTestId('schedule-manual-toggle');
      fireEvent.click(toggle);

      const steps = screen.getByTestId('schedule-manual-steps');
      expect(steps.querySelectorAll('li')).toHaveLength(4);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens the create dialog when the CTA is clicked', async () => {
      setupFetch({ schedules: [] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const cta = await screen.findByTestId('schedule-empty-cta');
      fireEvent.click(cta);

      // ScheduleEditDialog renders its name input only when open.
      expect(await screen.findByTestId('schedule-name-input')).toBeDefined();
    });
  });

  describe('tabs', () => {
    it('defaults to the Schedules tab and switches to Logs on click', async () => {
      setupFetch({ schedules: [makeSchedule()], logs: [] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      // Schedules tab content (the row) is visible first.
      expect(await screen.findByTestId('schedule-edit-daily-review')).toBeDefined();

      fireEvent.click(screen.getByTestId('schedule-tab-logs'));

      // Logs tab: no logs message; schedule row no longer rendered.
      expect(screen.queryByTestId('schedule-edit-daily-review')).toBeNull();
      expect(screen.getByText('schedule.noLogs')).toBeDefined();
    });
  });

  describe('inline row actions', () => {
    it('renders an enabled switch plus edit and delete icon buttons', async () => {
      setupFetch({ schedules: [makeSchedule({ enabled: 1 })] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const toggle = await screen.findByTestId('schedule-toggle-daily-review');
      expect(toggle.getAttribute('role')).toBe('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId('schedule-edit-daily-review')).toBeDefined();
      expect(screen.getByTestId('schedule-delete-daily-review')).toBeDefined();
    });

    it('sends a PATCH with the flipped enabled flag when the toggle is clicked', async () => {
      setupFetch({ schedules: [makeSchedule({ enabled: 1 })] });
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const toggle = await screen.findByTestId('schedule-toggle-daily-review');
      fireEvent.click(toggle);

      await waitFor(() => {
        const patch = mockFetch.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
        );
        expect(patch).toBeDefined();
        expect(patch![0]).toContain('/cmate/schedules');
        expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
          name: 'daily-review',
          enabled: false,
        });
      });
    });

    it('sends a DELETE after confirmation when the delete icon is clicked', async () => {
      setupFetch({ schedules: [makeSchedule()] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<ExecutionLogPane worktreeId="wt-1" />);

      const del = await screen.findByTestId('schedule-delete-daily-review');
      fireEvent.click(del);

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
        );
        expect(call).toBeDefined();
        expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ name: 'daily-review' });
      });
    });
  });
});
