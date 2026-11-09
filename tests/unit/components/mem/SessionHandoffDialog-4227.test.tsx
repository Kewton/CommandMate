/**
 * G-4, the hand-off dialog (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.1・§4.6・§2.4.1):
 *
 * - H15(f): the stop (`onStop`, the existing kill-session) is reached from the stop buttons'
 *   handlers only — not when a decide succeeds, not when the request expires, not when the
 *   agent's time runs out. A press runs `end` → `onStop` → `end/observe`, once each, in that
 *   order (PC and phone).
 * - H15(g): no request can be made (no conversation known) → the plain stop and "cancel" only;
 *   the plain stop calls `onStop` once and sends no `end`.
 * - Rule (4)(e) across screens (PM P3-3): approve / discard (the decide) write items, so a
 *   decide being sent or unknown locks the items panel (the shared lock), and an items
 *   panel's unit locks the decide. A decide whose result is unknown is sent again as it was;
 *   the answer to a resend that was already applied is shown as a refusal, not read as success
 *   (rule (4)(c)). Cancel and stop stay outside the lock.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => layout.mobile }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { memWriteLockOfOthers, publishMemWriteLock } from '@/components/mem/mem-write-lock';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let order: string[];
let request: HandoffRequestView;
let proposals: HandoffProposalView[];
let createAnswer: 'ok' | 'session_unknown';
let decideMode: 'ok' | 'lose' | 'hold';
let releaseDecide: (() => void) | null;
let applied: boolean;

const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

function baseRequest(): HandoffRequestView {
  return {
    id: 'r1',
    worktreeId: 'wt-1',
    instanceId: 'claude',
    cliToolId: 'claude',
    branch: 'feat/x',
    detached: false,
    state: 'reviewing',
    sendState: 'sent',
    endForced: false,
    endToken: null,
    outcome: null,
    outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z',
    extensions: 0,
    expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z',
    endedAt: null,
    agentTimedOut: false,
    version: 3,
  };
}
const proposal = (id: string): HandoffProposalView => ({
  id,
  op: 'add',
  itemId: null,
  kind: 'note',
  baseVersion: null,
  revision: 1,
  fingerprint: `fp-${id}`,
  state: 'proposed',
  stateReason: null,
  payload: { text: `text of ${id}` },
  current: null,
  appliedItemId: null,
  appliedVersion: null,
});

beforeEach(() => {
  layout.mobile = false;
  calls = [];
  order = [];
  request = baseRequest();
  proposals = [proposal('p1')];
  createAnswer = 'ok';
  decideMode = 'ok';
  releaseDecide = null;
  applied = false;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.replace(/^\/api\/worktrees\/wt-1/, '');
    calls.push({ method, path, body });
    if (path === '/send') return json(201, { id: 'm1' });
    if (path === '/mem/handoff/requests' && method === 'POST') {
      if (createAnswer === 'session_unknown') return json(409, { ok: false, code: 'session_unknown' });
      return json(201, { ...view(), text: 'the request text' });
    }
    const step = /^\/mem\/handoff\/requests\/r1(\/.*)?$/.exec(path);
    if (!step) return json(404, { ok: false, code: 'not_found' });
    switch (step[1]) {
      case undefined:
        return json(200, view());
      case '/sent':
      case '/send-failed':
        return json(200, view());
      case '/decide': {
        order.push('decide');
        if (applied || body.ifVersion !== request.version) return json(409, { ...view(), ok: false, code: 'version_conflict' });
        proposals = proposals.map((p) => ({ ...p, state: 'applied' as const }));
        request = { ...request, version: request.version + 2 };
        applied = true;
        if (decideMode === 'lose') throw new TypeError('Failed to fetch');
        if (decideMode === 'hold') {
          await new Promise<void>((resolve) => (releaseDecide = resolve));
          throw new TypeError('Failed to fetch');
        }
        return json(200, { ...view(), results: [{ proposalId: 'p1', result: 'applied' }] });
      }
      case '/end':
        order.push('end');
        request = { ...request, state: 'ending', endToken: 'tok-1', endForced: request.endForced || body.force === true, version: request.version + 1 };
        return json(200, { ...view(), endToken: 'tok-1' });
      case '/end/observe':
        order.push('observe');
        request = { ...request, state: 'ended', outcome: request.endForced ? 'unconfirmed' : 'confirmed', outcomeReason: request.endForced ? 'forced' : null };
        return json(200, view());
      case '/cancel':
        request = { ...request, state: 'cancelled' };
        return json(200, view());
      default:
        return json(404, { ok: false, code: 'not_found' });
    }
  }) as unknown as typeof fetch;
});
afterEach(() => {
  releaseDecide?.();
  publishMemWriteLock('mem-items', null);
  vi.restoreAllMocks();
});

function renderDialog() {
  const onStop = vi.fn(async () => {
    order.push('kill');
  });
  const onClose = vi.fn();
  render(
    <SessionHandoffDialog isOpen worktreeId="wt-1" target={{ cliToolId: 'claude', instanceId: 'claude', label: 'Claude' }} onClose={onClose} onStop={onStop} />
  );
  return { onStop, onClose };
}
const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const button = (testId: string) => screen.queryByTestId(testId) as HTMLButtonElement | null;
const sent = (suffix: string) => calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));

describe.each([
  ['PC', false],
  ['phone', true],
])('[#4227] H15(f) %s: the stop is the stop button’s only', (_name, mobile) => {
  it('a decide that succeeds, an expiry and a timeout do not stop; the stop button runs end → stop → observe once each', async () => {
    layout.mobile = mobile;
    const { onStop } = renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    expect(screen.getByTestId('handoff-dialog').getAttribute('data-layout')).toBe(mobile ? 'mobile' : 'desktop');
    // The request text went to the agent with no brief.
    expect(sent('/send')[0].body).toMatchObject({ content: 'the request text', brief: 'skip', instanceId: 'claude' });
    press('handoff-approve-p1');
    press('handoff-confirm');
    await screen.findByText('確定しました。');
    expect(onStop).not.toHaveBeenCalled();
    // The agent's time out shown: still no stop.
    request = { ...request, state: 'awaiting_agent', agentTimedOut: true };
    press('handoff-reload');
    await screen.findByTestId('handoff-agent-timeout');
    expect(onStop).not.toHaveBeenCalled();
    // The request read as expired: still no stop.
    const before = request;
    request = { ...request, state: 'expired', outcomeReason: 'expired' };
    press('handoff-reload');
    await waitFor(() => expect(screen.getByTestId('handoff-state').textContent).toContain('期限切れ'));
    expect(onStop).not.toHaveBeenCalled();
    request = { ...before, state: 'reviewing', agentTimedOut: false };
    press('handoff-reload');
    await waitFor(() => expect(button('handoff-stop')).not.toBeNull());

    press('handoff-stop');
    await waitFor(() => expect(order).toContain('observe'));
    expect(order.filter((step) => step !== 'decide')).toEqual(['end', 'kill', 'observe']);
    expect(onStop).toHaveBeenCalledTimes(1);
    await screen.findByTestId('handoff-outcome');
    expect(screen.getByTestId('handoff-outcome').textContent).toContain('確かめて');
  });

  it('“stop now” before any confirmation sends end with force, then the stop, then the observation', async () => {
    layout.mobile = mobile;
    const { onStop } = renderDialog();
    await screen.findByTestId('handoff-stop-now');
    press('handoff-stop-now');
    await waitFor(() => expect(order).toEqual(['end', 'kill', 'observe']));
    expect(sent('/end')[0].body).toMatchObject({ force: true, ifVersion: 3 });
    expect(onStop).toHaveBeenCalledTimes(1);
    await screen.findByTestId('handoff-outcome');
    expect(screen.getByTestId('handoff-outcome').textContent).toContain('forced');
  });
});

describe('[#4227] H15(g): no request can be made', () => {
  it('session_unknown → the plain stop and cancel only; the plain stop calls the stop once and sends no end', async () => {
    createAnswer = 'session_unknown';
    const { onStop, onClose } = renderDialog();
    await screen.findByTestId('handoff-plain');
    expect(button('handoff-stop')).toBeNull();
    expect(button('handoff-confirm')).toBeNull();
    press('handoff-plain-stop');
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
    expect(sent('/end')).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('[#4227] rule (4)(e) across screens: the decide and the items panel share one lock (PM P3-3)', () => {
  it.each(['sending', 'unknown'] as const)('a decide %s locks the items panel (the shared lock) and the dialog’s other item writes; cancel and stop stay', async (state) => {
    decideMode = state === 'sending' ? 'hold' : 'lose';
    renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    press('handoff-approve-p1');
    press('handoff-confirm');
    if (state === 'sending') await waitFor(() => expect(releaseDecide).not.toBeNull());
    else await screen.findByTestId('handoff-pending');
    await waitFor(() => expect(memWriteLockOfOthers('mem-items')).toBe(state));
    expect(screen.getByTestId('handoff-write-locked')).toBeTruthy();
    expect(button('handoff-stop')?.disabled).toBe(false);
    expect(button('handoff-cancel')?.disabled).toBe(false);
    if (state === 'sending') {
      await act(async () => releaseDecide?.());
      await screen.findByTestId('handoff-pending');
    }
    // Unknown: the resend is the same request; the answer (already applied) is not read as success.
    const first = sent('/decide')[0];
    press('handoff-pending-resend');
    await waitFor(() => expect(sent('/decide')).toHaveLength(2));
    expect(sent('/decide')[1].body).toEqual(first.body);
    await screen.findByText('依頼が読んだときから進みました。今の状態を見て、選び直してください。');
    expect(screen.queryByText('確定しました。')).toBeNull();
    await waitFor(() => expect(memWriteLockOfOthers('mem-items')).toBeNull());
  });

  it.each(['sending', 'unknown'] as const)('an items panel’s unit %s locks approve / discard / confirm; nothing is sent until it settles', async (state) => {
    renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    act(() => publishMemWriteLock('mem-items', state));
    await screen.findByTestId('handoff-write-locked');
    expect(button('handoff-approve-p1')?.disabled).toBe(true);
    expect(button('handoff-discard-p1')?.disabled).toBe(true);
    press('handoff-approve-p1');
    press('handoff-confirm');
    expect(sent('/decide')).toHaveLength(0);
    expect(button('handoff-stop')?.disabled).toBe(false);
    act(() => publishMemWriteLock('mem-items', null));
    await waitFor(() => expect(button('handoff-approve-p1')?.disabled).toBe(false));
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(sent('/decide')).toHaveLength(1));
  });

  it('(control) with no unit anywhere nothing is locked and the decide sends the person’s choices only', async () => {
    proposals = [proposal('p1'), proposal('p2')];
    renderDialog();
    await screen.findByTestId('handoff-approve-p2');
    expect(screen.queryByTestId('handoff-write-locked')).toBeNull();
    press('handoff-discard-p2');
    press('handoff-confirm');
    await waitFor(() => expect(sent('/decide')).toHaveLength(1));
    expect(sent('/decide')[0].body).toEqual({ ifVersion: 3, decisions: [{ proposalId: 'p2', fingerprint: 'fp-p2', action: 'discard' }] });
  });
});
