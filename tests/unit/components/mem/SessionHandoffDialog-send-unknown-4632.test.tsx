/**
 * Issue #4632 INV-H3: a 2xx of the text send that does not say whether it arrived is kept as
 * unknown, and a second send asks first.
 *
 * D4 (`201 {}`): the server records `send-failed` once, the notice is `sendUnknown`, the first press
 * of "send the request again" sends nothing and shows the confirmation row, "I checked — send again"
 * sends once, and "Cancel" sends nothing. A plain failure (500) still sends at once on the first
 * press (the old behaviour).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import type { HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

type SendAnswer = 'unknown' | 'failure';

let answer: SendAnswer;
let request: HandoffRequestView;
let sends: number;
let sentRecords: number;
let failedRecords: number;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: [], direct: [] });

function baseRequest(): HandoffRequestView {
  return {
    id: 'r1', worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'unsent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  };
}

beforeEach(() => {
  resetHandoffStoreForTests();
  answer = 'unknown';
  request = baseRequest();
  sends = 0;
  sentRecords = 0;
  failedRecords = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/^\/api\/worktrees\/wt-1/, '');
    if (path === '/send') {
      sends += 1;
      if (answer === 'unknown') return json(201, {});
      return json(500, { error: 'boom' });
    }
    if (path === '/mem/handoff/requests' && method === 'POST') {
      return json(201, { ...view(), text: 'the request text' });
    }
    if (path === '/mem/handoff/requests/r1/send-failed') {
      failedRecords += 1;
      request = { ...request, sendState: 'failed' };
      return json(200, view());
    }
    if (path === '/mem/handoff/requests/r1/sent') {
      sentRecords += 1;
      request = { ...request, sendState: 'sent' };
      return json(200, view());
    }
    if (path.startsWith('/mem/handoff/requests/r1')) return json(200, view());
    return json(404, {});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  resetHandoffStoreForTests();
  vi.restoreAllMocks();
});

function renderDialog() {
  return render(
    <SessionHandoffDialog
      isOpen
      worktreeId="wt-1"
      target={{ cliToolId: 'claude', instanceId: 'claude', label: 'Claude' }}
      onClose={vi.fn()}
      onStop={vi.fn(async () => 'stopped' as const)}
    />
  );
}

const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));

describe('[#4632 INV-H3] a 2xx whose outcome is unknown asks before sending the text again', () => {
  it('D4 201 {}: send-failed once, sendUnknown, first press 0 + confirmation, yes 1, no 0', async () => {
    renderDialog();
    // The request's text is sent by itself after the create; the answer is D4.
    await waitFor(() => expect(sends).toBe(1));
    await waitFor(() => expect(failedRecords).toBe(1));
    expect(sentRecords).toBe(0);
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('届いたか分かりません'));

    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    expect(sends).toBe(1);

    press('handoff-resend-unknown-no');
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull());
    expect(sends).toBe(1);

    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    press('handoff-resend-unknown-yes');
    await waitFor(() => expect(sends).toBe(2));
    await waitFor(() => expect(failedRecords).toBe(2));
    expect(sentRecords).toBe(0);
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull());
  });

  it('a plain failure (500) still sends at once on the first press, with sendFailed', async () => {
    answer = 'failure';
    renderDialog();
    await waitFor(() => expect(sends).toBe(1));
    await waitFor(() => expect(failedRecords).toBe(1));
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('送れませんでした'));

    press('handoff-resend-text');
    await waitFor(() => expect(sends).toBe(2));
    expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull();
  });
});
