/**
 * Tests for ExecutionLogsView (Issue #826)
 *
 * Focus: empty message, log rendering, and on-demand detail expansion.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import {
  ExecutionLogsView,
  type ExecutionLog,
} from '@/components/worktree/schedules/ExecutionLogsView';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeLog(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'log-1',
    schedule_id: 'sch-1',
    worktree_id: 'wt-1',
    message: 'do work',
    exit_code: 0,
    status: 'completed',
    started_at: 1_700_000_000_000,
    completed_at: 1_700_000_010_000,
    created_at: 1_700_000_000_000,
    schedule_name: 'daily-review',
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

describe('ExecutionLogsView', () => {
  it('shows the empty message when there are no logs', () => {
    render(<ExecutionLogsView worktreeId="wt-1" logs={[]} />);
    expect(screen.getByText('schedule.noLogs')).toBeDefined();
    expect(screen.queryByTestId('execution-logs-view')).toBeNull();
  });

  it('renders a row per log with its schedule name and status', () => {
    render(<ExecutionLogsView worktreeId="wt-1" logs={[makeLog()]} />);
    expect(screen.getByTestId('execution-logs-view')).toBeDefined();
    expect(screen.getByText('daily-review')).toBeDefined();
    expect(screen.getByText('schedule.status.completed')).toBeDefined();
  });

  it('fetches and shows detail when a log row is expanded', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ log: { ...makeLog(), result: 'the output' } }),
    });
    render(<ExecutionLogsView worktreeId="wt-1" logs={[makeLog()]} />);

    fireEvent.click(screen.getByText('daily-review'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt-1/execution-logs/log-1');
      expect(screen.getByText('the output')).toBeDefined();
    });
  });

  it('falls back to the deleted-schedule label when schedule_name is null', () => {
    render(<ExecutionLogsView worktreeId="wt-1" logs={[makeLog({ schedule_name: null })]} />);
    expect(screen.getByText('schedule.unknownSchedule')).toBeDefined();
  });

  /**
   * Issue #2576: the Logs view is where the 9/12-9/14 runs showed up green, so
   * a command-code schedule left on a `--permission-mode` value is flagged
   * right above them -- read from CMATE.md, without the edit dialog opening.
   */
  describe('CMATE.md warnings (Issue #2576)', () => {
    function serveCmateWithModeRow() {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/worktrees/wt-1/files/CMATE.md') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                content: [
                  '## Schedules',
                  '',
                  '| Name | Cron | Message | CLI Tool | Enabled | Permission |',
                  '|------|------|---------|----------|---------|------------|',
                  '| githubInsights | 30 21 * * * | Collect insights | command-code | true | auto-accept |',
                  '',
                ].join('\n'),
              }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      });
    }

    it('shows the warning above the log rows', async () => {
      serveCmateWithModeRow();
      render(<ExecutionLogsView worktreeId="wt-1" logs={[makeLog({ schedule_name: 'githubInsights' })]} />);

      expect(await screen.findByTestId('schedule-config-warning-githubInsights')).toBeDefined();
      // The rows are still there: the warning does not replace or hide them.
      expect(screen.getByText('schedule.status.completed')).toBeDefined();
    });

    it('shows the warning before the schedule has run at all', async () => {
      serveCmateWithModeRow();
      render(<ExecutionLogsView worktreeId="wt-1" logs={[]} />);

      expect(await screen.findByTestId('schedule-config-warning-githubInsights')).toBeDefined();
      expect(screen.getByText('schedule.noLogs')).toBeDefined();
    });
  });
});
