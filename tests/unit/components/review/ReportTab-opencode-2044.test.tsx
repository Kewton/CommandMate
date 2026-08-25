/**
 * ReportTab: opencode in the tool selector (Issue #2044)
 *
 * Uses the **real** `SUMMARY_ALLOWED_TOOLS` rather than a mocked list — the
 * sibling suite mocks it to three ids, which is fine for testing the modes but
 * would make "opencode appears in the selector" a statement about the mock.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/templates')) {
      return Promise.resolve({ ok: true, json: async () => ({ templates: [] }) });
    }
    if (url.includes('/api/daily-summary')) {
      return Promise.resolve({ ok: true, json: async () => ({ report: null, messageCount: 5 }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

import ReportTab from '@/components/review/ReportTab';

function toolOptions(): string[] {
  const select = screen.getByTestId('tool-selector') as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
}

describe('ReportTab tool selector (Issue #2044)', () => {
  it('offers exactly the server whitelist, opencode included', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => expect(screen.getByTestId('tool-selector')).toBeDefined());
    expect(toolOptions()).toEqual([...SUMMARY_ALLOWED_TOOLS]);
    expect(toolOptions()).toContain('opencode');
  });

  it('still starts on claude, so the default is unchanged', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => expect(screen.getByTestId('tool-selector')).toBeDefined());
    expect((screen.getByTestId('tool-selector') as HTMLSelectElement).value).toBe('claude');
    expect(screen.queryByTestId('model-input')).toBeNull();
  });

  it('shows the Model box for opencode as well as copilot', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => expect(screen.getByTestId('tool-selector')).toBeDefined());

    fireEvent.change(screen.getByTestId('tool-selector'), { target: { value: 'copilot' } });
    expect(screen.getByTestId('model-input')).toBeDefined();

    fireEvent.change(screen.getByTestId('tool-selector'), { target: { value: 'opencode' } });
    const input = screen.getByTestId('model-input') as HTMLInputElement;
    expect(input).toBeDefined();
    // A provider/model hint, not copilot's bare model-name one.
    expect(input.placeholder).toBe('report.modelPlaceholderOpencode');
  });

  it('hides the Model box for a tool that takes none', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => expect(screen.getByTestId('tool-selector')).toBeDefined());
    fireEvent.change(screen.getByTestId('tool-selector'), { target: { value: 'codex' } });
    expect(screen.queryByTestId('model-input')).toBeNull();
  });

  it('sends the model when opencode is selected', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => expect(screen.getByTestId('tool-selector')).toBeDefined());

    fireEvent.change(screen.getByTestId('tool-selector'), { target: { value: 'opencode' } });
    fireEvent.change(screen.getByTestId('model-input'), {
      target: { value: 'github-copilot/claude-sonnet-4.6' },
    });
    fireEvent.click(screen.getByTestId('generate-button'));

    await waitFor(() => {
      const post = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(post![1].body);
      expect(body.tool).toBe('opencode');
      expect(body.model).toBe('github-copilot/claude-sonnet-4.6');
    });
  });
});
