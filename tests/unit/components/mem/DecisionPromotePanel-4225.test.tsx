/**
 * The one screen of the promote path (Issue #4225, design §4.1): the warning of a
 * decision recorded but not reflected, the diff shown before anything is written, and
 * every write carrying the screen's mark. Nothing is written until "承認して書く".
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const view = (id: string, state: string) => ({
  id,
  kind: 'decision',
  state,
  text: `決定 ${id}`,
  closeWhen: null,
  promoteTo: 'issue:#1',
  quote: null,
  quoteAt: null,
  evidence: [],
  closeNote: null,
  owner: {},
  createdBy: 'agent',
  updatedBy: 'agent',
  version: 1,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
});

const PREVIEW = {
  id: 'p1',
  operationId: 'op1',
  itemId: 'd-open',
  itemVersion: 1,
  destination: { kind: 'issue_comment', ref: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
  baseFingerprint: 'b',
  body: '<!-- commandmate-promote:op=op1; item=d-open -->\n本文の全文',
  bodySha256: 's',
  effect: 'spec',
  quoteOrigin: 'none',
  invisibleReplaced: false,
  acknowledgedOperationIds: [],
  poster: { id: 1, login: 'a' },
  createdAt: '2026-11-09T00:00:00.000Z',
  expiresAt: '2026-11-09T00:30:00.000Z',
};

let calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;

beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mode: 'on',
          branch: 'feature/x',
          decisions: [
            { item: view('d-open', 'open'), unreflected: false, operations: [] },
            { item: view('d-rec', 'recorded'), unreflected: true, operations: [] },
          ],
          worktrees: [{ id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' }],
        }),
      } as Response;
    }
    if (url.endsWith('/preview')) return { ok: true, status: 201, json: async () => ({ ok: true, preview: PREVIEW }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true, operation: { id: 'op1', state: 'succeeded' }, item: null }) } as Response;
  }) as unknown as typeof fetch;
});

describe('DecisionPromotePanel', () => {
  it('warns that a recorded decision is not reflected', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    expect(await screen.findByTestId('decision-unreflected-d-rec')).toHaveTextContent('未反映');
    expect(screen.queryByTestId('decision-unreflected-d-open')).toBeNull();
  });

  it('shows the whole body before writing; only "承認して書く" approves, with the mark and what was shown', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const card = await screen.findByTestId('decision-d-open');
    fireEvent.click(card.querySelector('button')!);
    const buttons = await waitFor(() => {
      const all = screen.getAllByRole('button', { name: '差分を作る' });
      expect(all.length).toBeGreaterThan(1);
      return all;
    });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByTestId('decision-preview-d-open')).toHaveTextContent('本文の全文');
    expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '承認して書く' }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(1));
    const approve = calls.find((call) => call.url.endsWith('/approve'))!;
    expect(approve.headers[SCREEN_CLIENT_HEADER]).toBe('screen');
    expect(approve.body).toEqual({ previewId: 'p1', itemVersion: 1, baseFingerprint: 'b', bodySha256: 's', acknowledgedOperationIds: [] });
    for (const call of calls.filter((entry) => entry.method !== 'GET')) expect(call.headers[SCREEN_CLIENT_HEADER]).toBe('screen');
  });

  it('"やめる" writes nothing', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const card = await screen.findByTestId('decision-d-open');
    fireEvent.click(card.querySelector('button')!);
    const buttons = await waitFor(() => screen.getAllByRole('button', { name: '差分を作る' }));
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByTestId('decision-preview-d-open');
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByTestId('decision-preview-d-open')).toBeNull();
    expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
  });
});
