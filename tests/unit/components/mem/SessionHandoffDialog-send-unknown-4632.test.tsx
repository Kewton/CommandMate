/**
 * Issue #4632 INV-H3: a 2xx of the text send that does not say whether it arrived is kept as
 * unknown, and a second send asks first.
 *
 * D4 (`201 {}`): the server records `send-failed` once, the notice is `sendUnknown`, the first press
 * of "send the request again" sends nothing and shows the confirmation row, "I checked — send again"
 * sends once, and "Cancel" sends nothing. A plain failure (500) still sends at once on the first
 * press (the old behaviour).
 *
 * Review s13 P2-1 / P3-3 / P3-5: the flag is the page's memory per request id (not the opening's),
 * so another opening started in between does not lose it; it is cleared only once a send actually
 * leaves (a refused send keeps it); and it survives a remount of the dialog.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { beginHandoffOpening, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { handoffApi } from '@/lib/handoff/screen-client';
import { HandoffPageOperationRefusedError } from '@/lib/handoff/page-registration';
import type { HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

type SendAnswer = 'unknown' | 'failure' | 'sent';

let answer: SendAnswer;
/** The answers of the sends after the first (the last one repeats). */
let nextAnswers: SendAnswer[];
let createAnswer: 'ok' | 'request_open';
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
  nextAnswers = [];
  createAnswer = 'ok';
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
      const given = sends === 1 ? answer : (nextAnswers[sends - 2] ?? answer);
      if (given === 'unknown') return json(201, {});
      if (given === 'failure') return json(500, { error: 'boom' });
      return json(201, { id: 'm1', role: 'user', content: 'the request text', timestamp: '2026-11-10T00:00:00.000Z' });
    }
    if (path === '/mem/handoff/requests' && method === 'POST') {
      if (createAnswer === 'request_open') {
        return json(409, { ...view(), ok: false, code: 'request_open', text: 'the request text' });
      }
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

  // Note (review s13 P3-1, out of #4632's scope): a 500 is still a plain failure here (POST 1 on the
  // first press), while the CLI reads a 5xx as U2 unknown. This pins today's behaviour; changing it
  // is another Issue (S14's "not known" state).
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

describe('[#4632 INV-H3 / review P3-5] the flag the page keeps per request id', () => {
  /** The request's text was sent (D4); the notice says its outcome is unknown. */
  async function sentUnknown() {
    renderDialog();
    await waitFor(() => expect(sends).toBe(1));
    await waitFor(() => expect(failedRecords).toBe(1));
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('届いたか分かりません'));
  }

  it('a second unknown send still asks on the next press (the confirmation row is back)', async () => {
    await sentUnknown();
    // First resend: asks, and the second answer is unknown too.
    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    press('handoff-resend-unknown-yes');
    await waitFor(() => expect(sends).toBe(2));
    await waitFor(() => expect(failedRecords).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull());

    // The second answer being unknown too, the next press asks again (no send).
    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    expect(sends).toBe(2);
  });

  it('an S1 answer clears the flag: the next failure (500) sends at once on the first press', async () => {
    nextAnswers = ['sent', 'failure'];
    await sentUnknown();
    // The first resend is answered S1 (sent): the mark goes, and the request is `sent`.
    press('handoff-resend-text');
    press('handoff-resend-unknown-yes');
    await waitFor(() => expect(sends).toBe(2));
    await waitFor(() => expect(sentRecords).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-text')).toBeNull());

    // The server records a new failure (another send's record): read again, the button is back — and
    // the flag, cleared by S1, is not.
    request = { ...request, sendState: 'failed' };
    press('handoff-reload');
    await waitFor(() => expect(screen.getByTestId('handoff-resend-text')).toBeInTheDocument());

    // A plain failure is not unknown: the first press sends at once.
    press('handoff-resend-text');
    await waitFor(() => expect(sends).toBe(3));
    expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull();
  });

  it('a remount (PC ↔ phone) keeps the flag: the first press asks again', async () => {
    await sentUnknown();
    // Drawn again: the store still holds the same opening, so nothing is created nor sent again.
    cleanup();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('handoff-resend-text')).toBeInTheDocument());
    expect(sends).toBe(1);
    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    expect(sends).toBe(1);
  });

  it('P2-1: another opening in between does not lose the flag — the same request picked up with 409 asks', async () => {
    // A's send is unknown (D4).
    await sentUnknown();
    const firstFailed = failedRecords;
    // Another opening begins (another instance) and ends without closing A's request.
    cleanup();
    act(() => {
      beginHandoffOpening('wt-1', { cliToolId: 'codex', instanceId: 'codex', label: 'Codex' });
    });
    // Back on A: the create finds the same request open (409 `request_open`, `sendState: failed`).
    createAnswer = 'request_open';
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('handoff-resend-text')).toBeInTheDocument());
    expect(failedRecords).toBe(firstFailed);
    expect(sends).toBe(1);

    // The same request id picked up keeps its "unknown": the first press asks, sends nothing.
    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    expect(sends).toBe(1);
  });

  it("P3-3: a refused resend (the gate) keeps the flag — the next press asks again", async () => {
    await sentUnknown();
    // "I checked — send again" goes out refused by the gate: nothing is sent.
    const refused = vi
      .spyOn(handoffApi, 'sendText')
      .mockResolvedValueOnce({ ok: false, refused: new HandoffPageOperationRefusedError() });
    press('handoff-resend-text');
    press('handoff-resend-unknown-yes');
    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-unknown-confirm')).toBeNull());
    expect(sends).toBe(1);
    refused.mockRestore();

    // Not cleared by a send that never left: the next press asks again.
    press('handoff-resend-text');
    expect(screen.getByTestId('handoff-resend-unknown-confirm')).toBeInTheDocument();
    expect(sends).toBe(1);
  });
});
