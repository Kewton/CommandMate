/**
 * The execution-log list shows the blocked-tool-call warning (Issue #2577).
 *
 * The list API adds `warning` to a row whose command-code run had tool calls
 * refused by a pre-tool hook. The row must not read as a plain success: the
 * warning is shown in the row itself — not only after expanding it — and the
 * status chip leaves the success tint.
 *
 * Driven through `ExecutionLogPane` so the path from the list API response to
 * the Logs tab is covered, not just the row component.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import React from 'react';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const WARNING =
  'Warning: command-code blocked 1 tool call(s) (tool_hook_blocked): write_file (1); 0 tool call(s) ran';

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    schedule_id: 'sch-1',
    worktree_id: 'wt-1',
    message: 'run the report',
    exit_code: 0,
    status: 'completed',
    started_at: 1_700_000_000_000,
    completed_at: 1_700_000_010_000,
    created_at: 1_700_000_000_000,
    schedule_name: 'githubInsights',
    warning: null,
    ...overrides,
  };
}

function setupFetch(logs: unknown[]) {
  mockFetch.mockImplementation((url: string) => {
    if (url.endsWith('/execution-logs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs }) });
    }
    if (url.endsWith('/schedules/active')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedules: [] }) });
    }
    if (url.endsWith('/schedules')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ schedules: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function openLogsTab(logs: unknown[]) {
  setupFetch(logs);
  render(
    <ConfirmProvider>
      <ExecutionLogPane worktreeId="wt-1" />
    </ConfirmProvider>
  );
  await waitFor(() => {
    expect(screen.getByTestId('schedule-tab-logs').textContent).toContain(`(${logs.length})`);
  });
  fireEvent.click(screen.getByTestId('schedule-tab-logs'));
  return screen.findAllByTestId('execution-log-row');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionLogPane — blocked tool call warning (Issue #2577)', () => {
  it('shows the warning in the row without expanding it', async () => {
    const [row] = await openLogsTab([makeLog({ warning: WARNING })]);

    expect(row.getAttribute('data-warning')).toBe('true');
    expect(within(row).getByTestId('execution-log-warning').textContent).toContain(WARNING);
    // Nothing was fetched for the detail: the list alone says it.
    expect(mockFetch).not.toHaveBeenCalledWith('/api/worktrees/wt-1/execution-logs/log-1');
  });

  it('does not tint a completed run with a warning as a success', async () => {
    const [warned, plain] = await openLogsTab([
      makeLog({ id: 'log-warned', warning: WARNING }),
      makeLog({ id: 'log-plain' }),
    ]);

    const warnedStatus = within(warned).getByTestId('execution-log-status');
    expect(warnedStatus.textContent).toContain('schedule.status.completed');
    expect(warnedStatus.className).toContain('bg-warning-subtle');
    expect(warnedStatus.className).not.toContain('bg-success-subtle');

    const plainStatus = within(plain).getByTestId('execution-log-status');
    expect(plainStatus.className).toContain('bg-success-subtle');
    expect(plain.getAttribute('data-warning')).toBeNull();
    expect(within(plain).queryByTestId('execution-log-warning')).toBeNull();
  });

  it('keeps a failed run red and still shows its warning', async () => {
    const [row] = await openLogsTab([makeLog({ status: 'failed', exit_code: 8, warning: WARNING })]);

    const status = within(row).getByTestId('execution-log-status');
    expect(status.textContent).toContain('schedule.status.failed');
    expect(status.className).toContain('bg-danger-subtle');
    expect(within(row).getByTestId('execution-log-warning').textContent).toContain(WARNING);
  });

  it('treats a row from a server without the field as having no warning', async () => {
    const { warning: _omitted, ...legacy } = makeLog();
    const [row] = await openLogsTab([legacy]);

    expect(row.getAttribute('data-warning')).toBeNull();
    expect(within(row).getByTestId('execution-log-status').className).toContain('bg-success-subtle');
  });
});
