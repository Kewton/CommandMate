/**
 * Unit tests for ReportTab component
 * Issue #618: Report template system - 3 generation modes
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock review-config
vi.mock('@/config/review-config', () => ({
  SUMMARY_ALLOWED_TOOLS: ['claude', 'codex', 'copilot'],
  MAX_USER_INSTRUCTION_LENGTH: 1000,
  MAX_TEMPLATES: 5,
  MAX_TEMPLATE_NAME_LENGTH: 100,
  MAX_TEMPLATE_CONTENT_LENGTH: 1000,
}));

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const mockTemplates = [
  {
    id: 'tmpl-1',
    name: 'Bug Report',
    content: 'Focus on bugs and fixes',
    sortOrder: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'tmpl-2',
    name: 'Sprint Summary',
    content: 'Summarize sprint progress',
    sortOrder: 0,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/templates')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ templates: mockTemplates }),
      });
    }
    if (url.includes('/api/daily-summary')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ report: null, messageCount: 5 }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
});

import ReportTab from '@/components/review/ReportTab';

describe('ReportTab', () => {
  it('should render the report tab', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('report-tab')).toBeDefined();
    });
  });

  it('should render generation mode selector with 3 options', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('mode-radio-none')).toBeDefined();
      expect(screen.getByTestId('mode-radio-template')).toBeDefined();
      expect(screen.getByTestId('mode-radio-custom')).toBeDefined();
    });
  });

  it('should default to "none" mode', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      const noneRadio = screen.getByTestId('mode-radio-none') as HTMLInputElement;
      expect(noneRadio.checked).toBe(true);
    });
  });

  it('should not show user instruction textarea in "none" mode', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('report-tab')).toBeDefined();
    });
    expect(screen.queryByTestId('user-instruction-input')).toBeNull();
  });

  it('should show user instruction textarea in "custom" mode', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('mode-radio-custom')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('mode-radio-custom'));
    await waitFor(() => {
      expect(screen.getByTestId('user-instruction-input')).toBeDefined();
    });
  });

  it('should show template selector in "template" mode', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('mode-radio-template')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('mode-radio-template'));
    await waitFor(() => {
      expect(screen.getByTestId('template-selector')).toBeDefined();
    });
  });

  it('should show user instruction as read-only in "template" mode', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('mode-radio-template')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('mode-radio-template'));
    await waitFor(() => {
      const textarea = screen.getByTestId('user-instruction-input') as HTMLTextAreaElement;
      expect(textarea.readOnly).toBe(true);
    });
  });

  it('should render generate button', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('generate-button')).toBeDefined();
    });
  });

  it('should render tool selector', async () => {
    render(React.createElement(ReportTab));
    await waitFor(() => {
      expect(screen.getByTestId('tool-selector')).toBeDefined();
    });
  });
});
