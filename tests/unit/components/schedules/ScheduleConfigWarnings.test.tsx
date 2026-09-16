/**
 * Tests for ScheduleConfigWarnings (Issue #2576)
 *
 * Focus: a command-code schedule written straight into CMATE.md with a
 * `--permission-mode` value is flagged without the edit dialog ever opening,
 * and the banner stays out of the way when there is nothing to say.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { ScheduleConfigWarnings } from '@/components/worktree/schedules/ScheduleConfigWarnings';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', () => ({
  useLocale: () => locale.current,
  useTranslations: (namespace?: string) => (key: string) => (namespace ? `${namespace}.${key}` : key),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const HEADER = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
`;

function serveCmate(content: unknown) {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/worktrees/wt-1/files/CMATE.md') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, content }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  locale.current = 'en';
});

afterEach(() => {
  cleanup();
});

describe('ScheduleConfigWarnings', () => {
  it('flags a command-code + auto-accept schedule written directly into CMATE.md', async () => {
    serveCmate(
      `${HEADER}| githubInsights | 30 21 * * * | Collect insights | command-code | true | auto-accept |
| daily-review | 0 9 * * * | Review | claude | true | acceptEdits |
`,
    );

    render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    const banner = await screen.findByTestId('schedule-config-warnings');
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt-1/files/CMATE.md');
    const item = screen.getByTestId('schedule-config-warning-githubInsights');
    // The reason code rides along for anything reading the DOM.
    expect(item.getAttribute('data-warning-code')).toBe('command-code-direct-write-tools-denied');
    expect(item.textContent).toContain('githubInsights');
    expect(item.textContent).toContain('command-code / auto-accept');
    // Only the command-code row is listed.
    expect(screen.queryByTestId('schedule-config-warning-daily-review')).toBeNull();

    const text = banner.textContent ?? '';
    expect(text).toContain('calls directly');
    expect(text).toContain('edit_file');
    expect(text).toContain('does not stop the schedule');
    expect(text.toLowerCase()).not.toContain('read-only');
  });

  it('uses the Japanese wording for the ja locale', async () => {
    locale.current = 'ja';
    serveCmate(`${HEADER}| cc-task | 0 9 * * * | hello | command-code | true | plan |
`);

    render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    const banner = await screen.findByTestId('schedule-config-warnings');
    const text = banner.textContent ?? '';
    expect(text).toContain('エージェントが直接呼ぶ書き込み系ツール');
    expect(text).toContain('登録も実行も止めません');
    expect(text).not.toContain('読み取り専用');
  });

  it('re-reads CMATE.md on remount, so a fixed Permission cell clears the banner', async () => {
    serveCmate(`${HEADER}| cc-task | 0 9 * * * | hello | command-code | true | plan |
`);
    const first = render(<ScheduleConfigWarnings worktreeId="wt-1" />);
    expect(await screen.findByTestId('schedule-config-warning-cc-task')).toBeDefined();
    first.unmount();

    // ExecutionLogPane remounts the Logs tab body on every refetch and tab switch.
    serveCmate(`${HEADER}| cc-task | 0 9 * * * | hello | command-code | true | yolo |
`);
    const second = render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.container.innerHTML).toBe('');
  });

  it('drops warnings it already showed when the next read fails', async () => {
    serveCmate(`${HEADER}| cc-task | 0 9 * * * | hello | command-code | true | plan |
`);
    const { rerender } = render(<ScheduleConfigWarnings worktreeId="wt-1" />);
    expect(await screen.findByTestId('schedule-config-warning-cc-task')).toBeDefined();

    // A different worktree whose CMATE.md cannot be read must not inherit wt-1's banner.
    mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    rerender(<ScheduleConfigWarnings worktreeId="wt-2" />);

    await waitFor(() => expect(screen.queryByTestId('schedule-config-warnings')).toBeNull());
    expect(mockFetch).toHaveBeenLastCalledWith('/api/worktrees/wt-2/files/CMATE.md');
  });

  it('does not warn about a disabled schedule', async () => {
    serveCmate(`${HEADER}| cc-off | 0 9 * * * | hello | command-code | false | plan |
`);

    const { container } = render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when every command-code schedule is on yolo', async () => {
    serveCmate(`${HEADER}| cc-yolo | 0 9 * * * | hello | command-code | true | yolo |
| cc-empty | 0 9 * * * | hello | command-code | true | |
`);

    const { container } = render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Let the fetch chain settle before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['CMATE.md is missing', { ok: false, json: () => Promise.resolve({}) }],
    ['the payload has no string content', { ok: true, json: () => Promise.resolve({ content: 42 }) }],
  ])('renders nothing when %s', async (_label, response) => {
    mockFetch.mockResolvedValue(response);

    const { container } = render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the request throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const { container } = render(<ScheduleConfigWarnings worktreeId="wt-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });
});
