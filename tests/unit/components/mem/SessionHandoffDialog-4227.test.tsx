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
import type { MemItemView } from '@/types/mem';

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let order: string[];
let request: HandoffRequestView;
let proposals: HandoffProposalView[];
let createAnswer: 'ok' | 'session_unknown' | 'lost' | 'server_error' | 'disabled' | 'unattended' | 'unheard_of';
let endMode: 'ok' | 'hold';
let releaseEnd: (() => void) | null;
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
  endMode = 'ok';
  releaseEnd = null;
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
      if (createAnswer === 'lost') throw new TypeError('Failed to fetch');
      if (createAnswer === 'server_error') return json(500, { ok: false, code: 'db_error' });
      if (createAnswer === 'disabled') return json(409, { ok: false, code: 'disabled' });
      if (createAnswer === 'unattended') return json(409, { ok: false, code: 'unattended' });
      if (createAnswer === 'unheard_of') return json(409, { ok: false, code: 'something_new' });
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
        if (endMode === 'hold') await new Promise<void>((resolve) => (releaseEnd = resolve));
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
  releaseEnd?.();
  publishMemWriteLock('mem-items', null);
  vi.restoreAllMocks();
});

function renderDialog(options: { stopHeld?: Promise<void> } = {}) {
  const onStop = vi.fn(async () => {
    order.push('kill');
    if (options.stopHeld) await options.stopHeld;
  });
  const onClose = vi.fn();
  const tree = (isOpen: boolean) => (
    <SessionHandoffDialog isOpen={isOpen} worktreeId="wt-1" target={{ cliToolId: 'claude', instanceId: 'claude', label: 'Claude' }} onClose={onClose} onStop={onStop} />
  );
  const { rerender } = render(tree(true));
  /** The parent opens or closes the dialog (as `handoffTarget` set or cleared does). */
  const setOpen = (isOpen: boolean) => rerender(tree(isOpen));
  return { onStop, onClose, setOpen };
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

/**
 * Issue #4227 pr2c (review B P2-2): mode on + popup on — the dialog stands in for the plain
 * confirmation, so when no request can be made for any reason the plain stop is its stop.
 * Positive control: before, only some answers reached it and the dialog stayed on
 * "creating…" with no stop for the rest (B's M5).
 */
describe('[#4227] B P2-2: a create that fails for any reason leaves the plain stop', () => {
  it.each([
    ['no answer (status 0)', 'lost'],
    ['a 500', 'server_error'],
    ['disabled (the mode changed after it was read)', 'disabled'],
    ['unattended (popup turned off after it was read)', 'unattended'],
    ['a code the screen does not know', 'unheard_of'],
  ] as const)('%s → the plain stop; pressing it stops once and sends no end', async (_label, answer) => {
    createAnswer = answer;
    const { onStop, onClose } = renderDialog();
    await screen.findByTestId('handoff-plain');
    expect(button('handoff-loading')).toBeNull();
    press('handoff-plain-stop');
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
    expect(sent('/end')).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #4227 pr2c (codex P2-1, review B P3-3, PM amendment): one rule for every way of
 * closing the dialog (`handoffCloseBlock`, design §4.1 "closing the dialog"). While the stop
 * is in flight, or a decide is being sent or its result is unknown, no entrance closes it or
 * cancels the request; otherwise each closes it (and the ones that cancel send `cancel`).
 * Positive control: before, Esc・×・the backdrop and "cancel the end" cancelled and closed in
 * every state, and the stop went on to `onStop` after a cancel.
 */
describe('[#4227] pr2c: closing the dialog — every entrance × every state', () => {
  type Entrance = { name: string; cancels: boolean; press: () => void };
  const backdrop = () => {
    const surface = screen.getByTestId('modal-backdrop-surface');
    fireEvent.mouseDown(surface);
    fireEvent.mouseUp(surface);
    fireEvent.click(surface);
  };
  const ENTRANCES: Entrance[] = [
    { name: 'Esc', cancels: true, press: () => fireEvent.keyDown(document, { key: 'Escape' }) },
    { name: '×', cancels: true, press: () => fireEvent.click(screen.getByLabelText('閉じる')) },
    { name: 'the backdrop', cancels: true, press: backdrop },
    { name: '“cancel the end”', cancels: true, press: () => press('handoff-cancel') },
  ];

  /** Brings the open dialog to `state`; returns what to do after the entrance is checked. */
  async function reach(state: 'stopping' | 'sending' | 'unknown' | 'none'): Promise<() => Promise<void>> {
    await screen.findByTestId('handoff-approve-p1');
    if (state === 'stopping') {
      endMode = 'hold';
      press('handoff-stop');
      await waitFor(() => expect(releaseEnd).not.toBeNull());
      return async () => {
        await act(async () => releaseEnd?.());
        await waitFor(() => expect(order).toEqual(['end', 'kill', 'observe']));
      };
    }
    if (state === 'sending' || state === 'unknown') {
      decideMode = state === 'sending' ? 'hold' : 'lose';
      press('handoff-approve-p1');
      press('handoff-confirm');
      if (state === 'sending') await waitFor(() => expect(releaseDecide).not.toBeNull());
      else await screen.findByTestId('handoff-pending');
      return async () => {
        if (state === 'sending') await act(async () => releaseDecide?.());
        // Still the person's to choose: the unknown decide is kept.
        await screen.findByTestId('handoff-pending');
      };
    }
    return async () => undefined;
  }

  describe.each(ENTRANCES.map((entrance) => [entrance.name, entrance] as const))('%s', (_name, entrance) => {
    it.each([
      ['stopping', 'mem.handoff.closeWhileStopping', '停止の途中です'],
      ['sending', 'mem.handoff.closeWhileUnknown', '選んでから閉じてください'],
      ['unknown', 'mem.handoff.closeWhileUnknown', '選んでから閉じてください'],
    ] as const)('while %s: not closed, nothing cancelled, the reason shown', async (state, _key, text) => {
      const { onClose, onStop } = renderDialog();
      const after = await reach(state);
      if (entrance.name === '“cancel the end”' && state === 'stopping') {
        // Already disabled while the stop runs (as before): the press does nothing at all.
        expect(button('handoff-cancel')?.disabled).toBe(true);
        entrance.press();
      } else {
        entrance.press();
        await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(text));
      }
      expect(onClose).not.toHaveBeenCalled();
      expect(sent('/cancel')).toHaveLength(0);
      await after();
      expect(onClose).not.toHaveBeenCalled();
      expect(sent('/cancel')).toHaveLength(0);
      if (state === 'stopping') expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('(negative control) nothing in flight: it closes, and cancels the open request', async () => {
      const { onClose } = renderDialog();
      await reach('none');
      entrance.press();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(sent('/cancel')).toHaveLength(entrance.cancels ? 1 : 0);
    });
  });

  it('“close” on a request that is over: refused while a decide is unknown, closes once it is dropped', async () => {
    decideMode = 'lose';
    const { onClose } = renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    press('handoff-approve-p1');
    press('handoff-confirm');
    await screen.findByTestId('handoff-pending');
    request = { ...request, state: 'expired', outcomeReason: 'expired' };
    press('handoff-reload');
    await screen.findByTestId('handoff-close');
    press('handoff-close');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('選んでから閉じてください'));
    expect(onClose).not.toHaveBeenCalled();
    press('handoff-pending-drop');
    await waitFor(() => expect(screen.queryByTestId('handoff-pending')).toBeNull());
    press('handoff-close');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sent('/cancel')).toHaveLength(0);
  });

  it('“keep the session” (the plain stop’s cancel): refused while the plain stop runs; closes otherwise', async () => {
    createAnswer = 'session_unknown';
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => (releaseStop = resolve));
    const { onClose, onStop } = renderDialog({ stopHeld });
    await screen.findByTestId('handoff-plain');
    press('handoff-plain-stop');
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
    press('handoff-plain-cancel');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('停止の途中です'));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => releaseStop());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('(negative control) “keep the session” with no stop running closes, and sends nothing', async () => {
    createAnswer = 'session_unknown';
    const { onClose, onStop } = renderDialog();
    await screen.findByTestId('handoff-plain');
    press('handoff-plain-cancel');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onStop).not.toHaveBeenCalled();
    expect(sent('/cancel')).toHaveLength(0);
  });

  it('codex P2-1: the dialog closed by the page while `end` is answered → no stop after it', async () => {
    endMode = 'hold';
    const { onStop, setOpen } = renderDialog();
    await screen.findByTestId('handoff-stop');
    press('handoff-stop');
    await waitFor(() => expect(releaseEnd).not.toBeNull());
    setOpen(false);
    await act(async () => releaseEnd?.());
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    expect(onStop).not.toHaveBeenCalled();
    expect(order).toEqual(['end']);
  });
});

/**
 * Issue #4227 pr2c (review B P3-3, raised to P2 by the PM): a decide whose result is unknown
 * is the person's to send again or drop (G-PR1's rule). The page closing the dialog (another
 * End, a switch) and opening it again does not drop it. Positive control: before, the opening
 * cleared it (`setPending(null)`) with no choice of the person's.
 */
describe('[#4227] pr2c (10): an unknown decide is kept over a reopening', () => {
  it('closed by the page and opened again: still shown, still locking the items panel, sent again as it was', async () => {
    decideMode = 'lose';
    const { setOpen } = renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    press('handoff-approve-p1');
    press('handoff-confirm');
    await screen.findByTestId('handoff-pending');
    const first = sent('/decide')[0];
    setOpen(false);
    expect(memWriteLockOfOthers('mem-items')).toBe('unknown');
    setOpen(true);
    await waitFor(() => expect(sent('/mem/handoff/requests')).toHaveLength(2));
    expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
    expect(memWriteLockOfOthers('mem-items')).toBe('unknown');
    press('handoff-pending-resend');
    await waitFor(() => expect(sent('/decide')).toHaveLength(2));
    expect(sent('/decide')[1].body).toEqual(first.body);
  });

  it('(negative control) dropped by the person, a reopening shows none', async () => {
    decideMode = 'lose';
    const { setOpen } = renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    press('handoff-approve-p1');
    press('handoff-confirm');
    await screen.findByTestId('handoff-pending');
    press('handoff-pending-drop');
    await waitFor(() => expect(screen.queryByTestId('handoff-pending')).toBeNull());
    setOpen(false);
    setOpen(true);
    await waitFor(() => expect(sent('/mem/handoff/requests')).toHaveLength(2));
    await screen.findByTestId('handoff-state');
    expect(screen.queryByTestId('handoff-pending')).toBeNull();
    expect(memWriteLockOfOthers('mem-items')).toBeNull();
  });
});

/**
 * Issue #4227 pr2c (codex P2-2): the approval shows every field the confirmation writes
 * (`decide.ts` `writeInputOf`: text, closeWhen, evidence, close's reason, add's promoteTo)
 * against the item as stored now, and an omitted field ("unchanged") never reads like an
 * emptied one (`[]`, "cleared") — the items panel's rule (`editChanges`). Positive control:
 * before, a closeWhen-only update showed an empty line and evidence was not shown at all.
 */
describe('[#4227] codex P2-2: the approval shows every field it writes', () => {
  const current = (over: Partial<MemItemView> = {}): MemItemView => ({
    id: 'mem-1',
    kind: 'next',
    state: 'open',
    text: 'the stored text',
    closeWhen: { schema: 1, type: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 4 },
    evidence: ['a.md'],
    owner: { repositoryId: 'repo', branch: 'feat/x', worktreeId: 'wt-1', worktreeIncarnation: 'i', instanceId: 'claude' } as MemItemView['owner'],
    createdBy: 'human',
    updatedBy: 'human',
    version: 2,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen: false,
    ...over,
  });
  const field = (id: string, name: string) => screen.getByTestId(`handoff-proposal-field-${id}-${name}`).textContent;

  it('an update of the condition only: the text and evidence read “unchanged”, the condition now → proposed', async () => {
    proposals = [{ ...proposal('p1'), op: 'update', itemId: 'mem-1', baseVersion: 2, payload: { closeWhen: 'issue:#5' }, current: current() }];
    renderDialog();
    await screen.findByTestId('handoff-proposal-fields-p1');
    expect(field('p1', 'text')).toBe('今: the stored text → 変えない（今の値のまま）');
    expect(field('p1', 'closeWhen')).toBe('今: issue o/r#4 → issue:#5');
    expect(field('p1', 'evidence')).toBe('今: a.md → 変えない（今の値のまま）');
  });

  it('evidence emptied ([]) reads “cleared”, not “unchanged”; replaced evidence is listed', async () => {
    proposals = [
      { ...proposal('p1'), op: 'update', itemId: 'mem-1', baseVersion: 2, payload: { evidence: [] }, current: current() },
      { ...proposal('p2'), op: 'update', itemId: 'mem-1', baseVersion: 2, payload: { text: 'new', evidence: ['b.md', 'c.md'] }, current: current() },
    ];
    renderDialog();
    await screen.findByTestId('handoff-proposal-fields-p2');
    expect(field('p1', 'evidence')).toBe('今: a.md → 空にする');
    expect(field('p1', 'text')).toBe('今: the stored text → 変えない（今の値のまま）');
    expect(field('p2', 'evidence')).toBe('今: a.md → b.md, c.md');
    expect(field('p2', 'text')).toBe('今: the stored text → new');
  });

  it('an add shows its promoteTo, condition and evidence (and what it does not set); a close shows its reason', async () => {
    proposals = [
      { ...proposal('p1'), kind: 'decision', payload: { text: 'decided', promoteTo: 'docs/adr.md', evidence: ['x.md'] } },
      { ...proposal('p2'), op: 'close', itemId: 'mem-1', baseVersion: 2, payload: { reason: 'done in #5' }, current: current() },
    ];
    renderDialog();
    await screen.findByTestId('handoff-proposal-fields-p2');
    expect(field('p1', 'promoteTo')).toBe('docs/adr.md');
    expect(field('p1', 'evidence')).toBe('x.md');
    expect(field('p1', 'closeWhen')).toBe('指定なし');
    expect(field('p2', 'reason')).toBe('done in #5');
  });

  it('(control) a withheld proposal shows no field, and a withheld item shows none of its values', async () => {
    proposals = [
      { ...proposal('p1'), payload: undefined, withheld: { field: 'text', rule: 'aws-key' } },
      { ...proposal('p2'), op: 'update', itemId: 'mem-1', baseVersion: 2, payload: { text: 'x' }, current: current({ withheld: { field: 'text', rule: 'aws-key' } as MemItemView['withheld'], text: undefined }) },
    ];
    renderDialog();
    await screen.findByTestId('handoff-proposal-fields-p2');
    expect(screen.queryByTestId('handoff-proposal-fields-p1')).toBeNull();
    expect(field('p2', 'text')).toBe('今: （表示しません） → x');
    expect(field('p2', 'evidence')).toBe('今: （表示しません） → 変えない（今の値のまま）');
  });
});
