/**
 * ReportTab shows the reason and the two links of a tool-policy refusal (Issue #4436).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/config/review-config', () => ({
  SUMMARY_ALLOWED_TOOLS: ['claude', 'antigravity'],
  MAX_USER_INSTRUCTION_LENGTH: 1000,
  MAX_TEMPLATES: 5,
  MAX_TEMPLATE_NAME_LENGTH: 100,
  MAX_TEMPLATE_CONTENT_LENGTH: 1000,
}));
// A stable `t`: ReportTab's fetch effect depends on it, and a new function per render refetches forever.
const tStable = vi.hoisted(() => (key: string) => key);
vi.mock('next-intl', () => ({
  useTranslations: () => tStable,
}));

import ReportTab from '@/components/review/ReportTab';

const TERMS = 'https://antigravity.google/terms';
const FAQ = 'https://antigravity.google/docs/faq';
const REASON = 'Refused by default for antigravity under the Google Antigravity terms §6 (consumer plans). Nothing was typed.';

type PostAnswer = { status: number; body: unknown };
let postAnswer: PostAnswer;

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/templates')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ templates: [] }) });
    }
    if (url.includes('/api/daily-summary/status')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ generating: false }) });
    }
    if (url.includes('/api/daily-summary') && init?.method === 'POST') {
      return Promise.resolve({
        ok: postAnswer.status >= 200 && postAnswer.status < 300,
        status: postAnswer.status,
        json: async () => postAnswer.body,
      });
    }
    if (url.includes('/api/daily-summary')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ report: null, messageCount: 5 }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }) as unknown as typeof fetch;
});

async function generateWith(tool: string): Promise<void> {
  render(React.createElement(ReportTab));
  await waitFor(() => expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByTestId('tool-selector'), { target: { value: tool } });
  fireEvent.click(screen.getByTestId("generate-button"));

}

describe('ReportTab: tool-policy refusal (#4436)', () => {
  it('T1: 409 TOOL_POLICY_DENIED shows the reason and both links as the response gave them', async () => {
    postAnswer = {
      status: 409,
      body: { code: 'TOOL_POLICY_DENIED', error: REASON, reason: 'ANTIGRAVITY_CONSUMER_TERMS', links: { terms: TERMS, faq: FAQ } },
    };
    await generateWith('antigravity');
    await waitFor(() => expect(screen.getByTestId('report-error')).toBeDefined());
    expect(screen.getByTestId('report-error').textContent).toContain(REASON);
    const terms = screen.getByTestId('report-tool-policy-refusal-terms') as HTMLAnchorElement;
    const faq = screen.getByTestId('report-tool-policy-refusal-faq') as HTMLAnchorElement;
    expect(terms.getAttribute('href')).toBe(TERMS);
    expect(faq.getAttribute('href')).toBe(FAQ);
    expect(terms.getAttribute('rel')).toBe('noopener noreferrer');
    expect(faq.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('T1: the links are the response values, not a copy of the URL (a changed response changes the href)', async () => {
    postAnswer = {
      status: 409,
      body: { code: 'TOOL_POLICY_DENIED', error: REASON, links: { terms: 'https://example.test/t', faq: 'https://example.test/f' } },
    };
    await generateWith('antigravity');
    const terms = await screen.findByTestId('report-tool-policy-refusal-terms');
    expect(terms.getAttribute('href')).toBe('https://example.test/t');
    expect(screen.getByTestId('report-tool-policy-refusal-faq').getAttribute('href')).toBe('https://example.test/f');
  });

  it('T2: a successful generation shows no refusal', async () => {
    postAnswer = {
      status: 200,
      body: { report: { date: '2026-11-18', content: 'ok', generatedByTool: 'claude', model: null, createdAt: '', updatedAt: '' } },
    };
    await generateWith('claude');
    await waitFor(() => expect(screen.getByTestId('report-content')).toBeDefined());
    expect(screen.queryByTestId('report-tool-policy-refusal-terms')).toBeNull();
    expect(screen.queryByTestId('report-error')).toBeNull();
  });

  it('T2: another failure (500, and a 409 of another code) shows its error without links', async () => {
    postAnswer = { status: 500, body: { error: 'boom' } };
    await generateWith('claude');
    await waitFor(() => expect(screen.getByTestId('report-error').textContent).toContain('boom'));
    expect(screen.queryByTestId('report-tool-policy-refusal-terms')).toBeNull();
  });

  it('T2: a 409 of another code has no links', async () => {
    postAnswer = { status: 409, body: { code: 'CONCURRENT', error: 'busy', links: { terms: TERMS, faq: FAQ } } };
    await generateWith('claude');
    await waitFor(() => expect(screen.getByTestId('report-error').textContent).toContain('busy'));
    expect(screen.queryByTestId('report-tool-policy-refusal-faq')).toBeNull();
  });
});
