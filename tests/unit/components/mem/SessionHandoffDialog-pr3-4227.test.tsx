/**
 * G-4 follow-ups taken into G-PR3 (Issue #4227, PM Claude pr2e P3-2・P3-3):
 *
 * - P3-3: closed while `create` was answered, a request stays `unsent` (its text never went).
 *   Opened again, `create` answers 409 `request_open` with that request — and its text — and the
 *   dialog offers to send the text again (not only when the send `failed`).
 * - P3-2: after the page itself was made again, another worktree's unknown unit still locks the
 *   writes (the lock reads every worktree) — the dialog shows it as "another worktree's unknown
 *   result" with the drop only (never sent from here); dropping it lifts the lock.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { dropMemItemsUnit, resetHandoffStoreForTests, settleHandoffDecide, settleMemItemsWrite, startHandoffDecide, startMemItemsWrite } from '@/lib/handoff/close-rule';
import type { HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let request: HandoffRequestView;
let createAnswer: 'ok' | 'request_open';

const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: [], direct: [] });
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

function baseRequest(): HandoffRequestView {
  return {
    id: 'r1',
    worktreeId: 'wt-1',
    instanceId: 'claude',
    cliToolId: 'claude',
    branch: 'feat/x',
    detached: false,
    state: 'awaiting_agent',
    sendState: 'unsent',
    endForced: false,
    endToken: null,
    outcome: null,
    outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z',
    extensions: 0,
    expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null,
    endedAt: null,
    agentTimedOut: false,
    version: 1,
  };
}

beforeEach(() => {
  resetHandoffStoreForTests();
  calls = [];
  request = baseRequest();
  createAnswer = 'request_open';
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.replace(/^\/api\/worktrees\/wt-1/, '');
    calls.push({ method, path, body });
    if (path === '/send') return json(201, { id: 'm1' });
    if (path === '/mem/handoff/requests' && method === 'POST') {
      if (createAnswer === 'request_open') return json(409, { ...view(), ok: false, code: 'request_open', text: 'the picked-up text' });
      request = { ...request, sendState: 'unsent' };
      return json(201, { ...view(), text: 'the request text' });
    }
    if (path === '/mem/handoff/requests/r1/sent') {
      request = { ...request, sendState: 'sent' };
      return json(200, view());
    }
    if (path.startsWith('/mem/handoff/requests/r1')) return json(200, view());
    return json(404, { ok: false, code: 'not_found' });
  }) as typeof fetch;
});
afterEach(() => resetHandoffStoreForTests());

const target = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };

function renderDialog() {
  return render(<SessionHandoffDialog isOpen worktreeId="wt-1" target={target} onClose={vi.fn()} onStop={vi.fn(async () => 'stopped' as const)} />);
}

describe('pr2e P3-3: a picked-up request whose text never went is offered again', () => {
  it('request_open with sendState unsent: the resend button sends the picked-up text with brief skip', async () => {
    renderDialog();
    const resend = await screen.findByTestId('handoff-resend-text');
    expect(calls.filter((call) => call.path === '/send')).toHaveLength(0);
    fireEvent.click(resend);
    await waitFor(() => expect(calls.filter((call) => call.path === '/send')).toHaveLength(1));
    expect(calls.find((call) => call.path === '/send')!.body).toMatchObject({ content: 'the picked-up text', brief: 'skip', instanceId: 'claude' });
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-text')).toBeNull());
  });

  it('negative: a picked-up request already sent offers no resend', async () => {
    request = { ...request, sendState: 'sent' };
    renderDialog();
    await screen.findByTestId('handoff-dialog');
    await waitFor(() => expect(calls.some((call) => call.path === '/mem/handoff/requests')).toBe(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('handoff-resend-text')).toBeNull();
  });

  it('negative: a request this dialog made sends its text once, by itself (no button while it goes)', async () => {
    createAnswer = 'ok';
    renderDialog();
    await waitFor(() => expect(calls.filter((call) => call.path === '/send')).toHaveLength(1));
    expect(calls.find((call) => call.path === '/send')!.body).toMatchObject({ content: 'the request text', brief: 'skip' });
    await waitFor(() => expect(screen.queryByTestId('handoff-resend-text')).toBeNull());
  });
});

describe('pr2e P3-2: another worktree’s unknown unit, left by a page made again', () => {
  function leaveUnknownUnitOn(worktreeId: string) {
    const sending = startHandoffDecide({ worktreeId, requestId: 'r-old', ifVersion: 2, decisions: [{ proposalId: 'p', fingerprint: 'f', action: 'approve' }] });
    expect(sending).not.toBeNull();
    settleHandoffDecide(sending!, 'unknown');
  }

  it('shown as another worktree’s unknown result: drop only (no resend), and dropping lifts the lock', async () => {
    leaveUnknownUnitOn('wt-2');
    renderDialog();
    const other = await screen.findByTestId('handoff-pending-other-worktree');
    expect(other.textContent).toContain('wt-2');
    expect(screen.getByTestId('handoff-write-locked')).toBeInTheDocument();
    expect(screen.getByTestId('handoff-pending-resend')).toBeDisabled();
    fireEvent.click(screen.getByTestId('handoff-pending-drop'));
    await waitFor(() => expect(screen.queryByTestId('handoff-pending-other-worktree')).toBeNull());
    expect(screen.queryByTestId('handoff-write-locked')).toBeNull();
    // Nothing of the other worktree was sent from here.
    expect(calls.some((call) => call.path.includes('/decide'))).toBe(false);
  });

  it('negative: no other worktree holds anything → no such row, no lock', async () => {
    renderDialog();
    await screen.findByTestId('handoff-dialog');
    expect(screen.queryByTestId('handoff-pending-other-worktree')).toBeNull();
    expect(screen.queryByTestId('handoff-write-locked')).toBeNull();
  });

  it('negative: this worktree’s own unknown unit keeps its own row (sendable), not the other-worktree one', async () => {
    leaveUnknownUnitOn('wt-1');
    renderDialog();
    await screen.findByTestId('handoff-pending');
    expect(screen.queryByTestId('handoff-pending-other-worktree')).toBeNull();
    expect(screen.queryByTestId('handoff-pending-elsewhere')).toBeNull();
  });
});

/**
 * pr3c (review A P3-4, G7): an items write whose result is unknown, with no items panel drawn,
 * locks the dialog's writes — read from the store (`memItemsUnitsLock`), not only from the panel's
 * published lock. Positive control: without the store's lock the row is not shown.
 */
describe('[#4227 pr3c] the items panel’s unknown unit in the store locks the dialog', () => {
  it('shown as locked with no panel drawn; dropped, the lock is gone', async () => {
    const write = startMemItemsWrite({ worktreeId: 'wt-1', slot: 'add', request: {} })!;
    settleMemItemsWrite(write, 'unknown');
    renderDialog();
    await screen.findByTestId('handoff-dialog');
    expect(screen.getByTestId('handoff-write-locked')).toBeInTheDocument();
    act(() => dropMemItemsUnit(write));
    await waitFor(() => expect(screen.queryByTestId('handoff-write-locked')).toBeNull());
  });
});
