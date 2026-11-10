/**
 * The hand-off dialog's one rule for going away, as a table (Issue #4227 G-PR2 pr2d, design
 * `mem-ui-4227.md` §4.1.1, the PM's decision in `pm-return-4227-pr2c-codex.md`):
 *
 *   a decide being sent or whose result is unknown is never dropped by any path that makes the
 *   dialog go away without the person's choice (send it again / drop it); while there is one the
 *   dialog stays; once a cancel has started no new decide is sent.
 *
 * The page is the real one: the worktree detail hook (`useWorktreeDetailController`) and the
 * dialog wired as the pages wire them (`onClose={closeHandoff}`, `onStop={stopForHandoff}`).
 *
 * Rows: path (the person's / the cancel's answer / the plain stop's end / a switch of worktree /
 * the page's other "end") × state (being sent / unknown / the cancel waiting) × worktree (the
 * dialog's own page / another worktree's page, after a switch kept it). Rows that cannot arise
 * are tested as such (e.g. the cancel's answer while a decide is sent: no decide is sent after
 * the cancel starts). Each row with a refusal has its negative control (nothing held: it goes).
 *
 * Positive controls: `rule.off` takes the rule out (`askHandoffClose` answers null, as if no
 * path asked) and the rows of codex review-4227-pr2b P2 1–3 and PM Claude pr2c P3-1・P3-2 go
 * back to what they were: the unit is lost, the dialog closes or is replaced.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

const rule = vi.hoisted(() => ({ off: false, perInstance: false, tokenless: false }));
vi.mock('@/lib/handoff/close-rule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/close-rule')>();
  return {
    ...actual,
    askHandoffClose: (...args: Parameters<typeof actual.askHandoffClose>) => (rule.off ? null : actual.askHandoffClose(...args)),
    // pr2e: the page and the dialog close through `closeHandoffOpening` (it asks the rule inside
    // the module, which the mock above does not reach): off, it closes without asking.
    // pr2f: the opening named by the caller; `rule.tokenless` (positive control) names the current
    // one instead — the code before pr2f, whose closes and patches did not carry their opening.
    closeHandoffOpening: (...[token, path]: Parameters<typeof actual.closeHandoffOpening>) => {
      const of = rule.tokenless ? (actual.handoffStoreSnapshot().opening?.token ?? token) : token;
      if (!rule.off) return actual.closeHandoffOpening(of, path);
      actual.noteHandoffHidden(of);
      return null;
    },
    patchHandoffOpening: (...[token, patch]: Parameters<typeof actual.patchHandoffOpening>) =>
      actual.patchHandoffOpening(rule.tokenless ? (actual.handoffStoreSnapshot().opening?.token ?? token) : token, patch),
    isLiveHandoffOpening: (token: Parameters<typeof actual.isLiveHandoffOpening>[0]) => {
      if (!rule.tokenless) return actual.isLiveHandoffOpening(token);
      const opening = actual.handoffStoreSnapshot().opening;
      return token !== null && opening !== null && !opening.closed;
    },
    // `rule.tokenless`: a settle reaches whatever is in flight for the worktree (before pr2f).
    settleHandoffDecide: (...[sending, outcome]: Parameters<typeof actual.settleHandoffDecide>) =>
      actual.settleHandoffDecide(rule.tokenless ? (actual.handoffUnitsOf(sending.worktreeId).inflight ?? sending) : sending, outcome),
    // pr2e positive control: `rule.perInstance` puts the units back in the component's life — the
    // store is emptied when the dialog that read it is taken out (as its state was, before pr2e).
    subscribeHandoffStore: (listener: () => void) => {
      const unsubscribe = actual.subscribeHandoffStore(listener);
      return () => {
        unsubscribe();
        if (rule.perInstance) actual.resetHandoffStoreForTests();
      };
    },
  };
});
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { memWriteLockOfOthers, publishMemWriteLock } from '@/components/mem/mem-write-lock';
import { handoffStoreSnapshot, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const OTHER: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex', label: 'Codex' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

type Post = { worktree: string; path: string; body: Record<string, unknown> };
let posts: Post[];
let kills: string[];
let modeReads: string[];
let modeAnswer: { status: number; body: unknown };
let request: HandoffRequestView;
let proposals: HandoffProposalView[];
let decideMode: 'ok' | 'lose' | 'hold' | 'error500';
let readMode: 'ok' | 'hold';
let releaseRead: (() => void) | null;
let releaseDecide: (() => void) | null;
let cancelMode: 'ok' | 'hold';
let releaseCancel: (() => void) | null;
let endAnswer: 'ok' | 'session_changed';
let killMode: 'ok' | 'hold' | 'refused' | 'errored';
let releaseKill: (() => void) | null;
let runningAnswer: 'none' | 'running' | 'broken';
let createMode: 'ok' | 'hold';
let releaseCreate: (() => void) | null;

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });

beforeEach(() => {
  rule.off = false;
  rule.perInstance = false;
  rule.tokenless = false;
  readMode = 'ok';
  releaseRead = null;
  killMode = 'ok';
  releaseKill = null;
  runningAnswer = 'none';
  createMode = 'ok';
  releaseCreate = null;
  posts = [];
  kills = [];
  modeReads = [];
  modeAnswer = { status: 200, body: ATTENDED };
  request = {
    id: 'r1',
    worktreeId: A,
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
  proposals = [
    {
      id: 'p1',
      op: 'add',
      itemId: null,
      kind: 'note',
      baseVersion: null,
      revision: 1,
      fingerprint: 'fp-p1',
      state: 'proposed',
      stateReason: null,
      payload: { text: 'text of p1' },
      current: null,
      appliedItemId: null,
      appliedVersion: null,
    },
  ];
  decideMode = 'ok';
  releaseDecide = null;
  cancelMode = 'ok';
  releaseCancel = null;
  endAnswer = 'ok';
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const worktree = match ? decodeURIComponent(match[1]) : '';
    const rest = match ? match[2] : url;
    if (method === 'POST') posts.push({ worktree, path: rest, body });
    if (rest.startsWith('/mem/mode')) {
      modeReads.push(worktree);
      return reply(modeAnswer.status, modeAnswer.body);
    }
    if (rest.startsWith('/kill-session')) {
      kills.push(url);
      if (killMode === 'hold') await new Promise<void>((resolve) => (releaseKill = resolve));
      if (killMode === 'refused') return reply(409, { error: 'refused' });
      if (killMode === 'errored') return reply(500, { error: 'boom' });
      return reply(200, { success: true, message: 'ok' });
    }
    if (rest === '/send') return reply(201, { id: 'm1' });
    if (rest === '/mem/handoff/requests' && method === 'POST') {
      if (worktree !== A) return reply(409, { ok: false, code: 'session_unknown' });
      if (createMode === 'hold') await new Promise<void>((resolve) => (releaseCreate = resolve));
      return reply(201, { ...view(), text: 'the request text' });
    }
    const step = /^\/mem\/handoff\/requests\/r1(\/.*)?$/.exec(rest);
    if (step && worktree === A) {
      switch (step[1]) {
        case undefined:
          if (readMode === 'hold') await new Promise<void>((resolve) => (releaseRead = resolve));
          return reply(200, view());
        case '/sent':
        case '/send-failed':
          return reply(200, view());
        case '/decide': {
          if (decideMode === 'error500') return reply(500, { error: 'boom' });
          if (body.ifVersion !== request.version) return reply(409, { ...view(), ok: false, code: 'version_conflict' });
          proposals = proposals.map((p) => ({ ...p, state: 'applied' as const }));
          request = { ...request, version: request.version + 2 };
          if (decideMode === 'lose') throw new TypeError('Failed to fetch');
          if (decideMode === 'hold') {
            await new Promise<void>((resolve) => (releaseDecide = resolve));
            throw new TypeError('Failed to fetch');
          }
          return reply(200, { ...view(), results: [{ proposalId: 'p1', result: 'applied' }] });
        }
        case '/cancel':
          if (cancelMode === 'hold') await new Promise<void>((resolve) => (releaseCancel = resolve));
          request = { ...request, state: 'cancelled' };
          return reply(200, view());
        case '/end':
          if (endAnswer === 'session_changed') return reply(409, { ok: false, code: 'session_changed' });
          request = { ...request, state: 'ending', endToken: 'tok-1', version: request.version + 1 };
          return reply(200, { ...view(), endToken: 'tok-1' });
        case '/end/observe':
          request = { ...request, state: 'ended', outcome: 'confirmed' };
          return reply(200, view());
        default:
          return reply(404, { ok: false, code: 'not_found' });
      }
    }
    if (rest.startsWith('/current-output')) return reply(200, { isRunning: false });
    if (rest.startsWith('/messages')) return reply(200, []);
    if (rest.startsWith('/auto-yes')) return reply(200, { instances: {} });
    if (match && rest === '') {
      if (runningAnswer === 'broken') return reply(500, { error: 'boom' });
      const sessionStatusByInstance = runningAnswer === 'running' ? { claude: { isRunning: true } } : {};
      return reply(200, { id: worktree, name: worktree, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance });
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  releaseRead?.();
  releaseDecide?.();
  releaseCancel?.();
  releaseKill?.();
  releaseCreate?.();
  publishMemWriteLock('mem-items', null);
  resetHandoffStoreForTests();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

let page: ReturnType<typeof useWorktreeDetailController>;
type Drawing = { layout?: 'pc' | 'phone'; drawn?: boolean };
/**
 * The page as `WorktreeDetailRefactored` wires it (the phone's dialog; the PC's is the same props).
 * pr2e: `layout` draws the dialog under another parent (PC ↔ phone: the real page draws it in
 * `WorktreeDetailDesktop` or in its phone branch, so it is a new instance), and `drawn: false`
 * takes it out while the page stays (the real page's Loading between two worktrees).
 */
function Page({ worktreeId, layout = 'pc', drawn = true }: { worktreeId: string } & Drawing) {
  page = useWorktreeDetailController({ worktreeId });
  if (!drawn) return null;
  const dialog = (
    <SessionHandoffDialog
      isOpen={page.handoffTarget !== null}
      worktreeId={worktreeId}
      target={page.handoffTarget}
      onClose={page.closeHandoff}
      onStop={page.stopForHandoff}
    />
  );
  return layout === 'pc' ? <div data-testid="page-pc">{dialog}</div> : <section data-testid="page-phone">{dialog}</section>;
}

const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const button = (testId: string) => screen.queryByTestId(testId) as HTMLButtonElement | null;
const sent = (suffix: string) => posts.filter((post) => post.path.endsWith(suffix));
const esc = () => fireEvent.keyDown(document, { key: 'Escape' });
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** Opens the page on A and the hand-off for TARGET, at the proposals. */
async function opened() {
  const view = render(<Page worktreeId={A} />);
  await waitFor(() => expect(page.loading).toBe(false));
  await act(async () => {
    await page.openEnd(TARGET);
  });
  await screen.findByTestId('handoff-approve-p1');
  const switchTo = (worktreeId: string) => view.rerender(<Page worktreeId={worktreeId} />);
  const redraw = (drawing: Drawing, worktreeId: string = A) => view.rerender(<Page worktreeId={worktreeId} {...drawing} />);
  return { switchTo, redraw };
}

type State = 'sending' | 'unknown' | 'cancelling' | 'none';
/** Brings the open dialog to `state`. */
async function reach(state: State): Promise<void> {
  if (state === 'sending' || state === 'unknown') {
    decideMode = state === 'sending' ? 'hold' : 'lose';
    press('handoff-approve-p1');
    press('handoff-confirm');
    if (state === 'sending') await waitFor(() => expect(releaseDecide).not.toBeNull());
    else await screen.findByTestId('handoff-pending');
  } else if (state === 'cancelling') {
    cancelMode = 'hold';
    press('handoff-cancel');
    await waitFor(() => expect(releaseCancel).not.toBeNull());
  }
}

const HELD = ['sending', 'unknown', 'cancelling'] as const;
const NOTICE = { sending: '選んでから閉じてください', unknown: '選んでから閉じてください', cancelling: '取り消しを送っています' } as const;

describe('[#4227 pr2d] path 1 — the person’s (Esc) × state × worktree', () => {
  it.each(HELD)('own page, while %s: stays, nothing (more) cancelled, the reason shown', async (state) => {
    await opened();
    await reach(state);
    const cancels = sent('/cancel').length;
    esc();
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE[state]));
    expect(page.handoffTarget).toEqual(TARGET);
    expect(sent('/cancel')).toHaveLength(cancels);
  });

  it('another worktree’s page (kept over a switch), unknown: stays; closing there never cancels A’s request', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    esc();
    press('handoff-foreign-close');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.unknown));
    expect(page.handoffTarget).toEqual(TARGET);
    expect(sent('/cancel')).toHaveLength(0);
    press('handoff-pending-drop');
    press('handoff-foreign-close');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(0);
  });

  it('(negative control) nothing held: Esc cancels the request and closes', async () => {
    await opened();
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 2 — the cancel’s answer (condition 4: no decide after the cancel starts)', () => {
  it('cancelling × being sent cannot arise: the confirm and the stop are not sent while the cancel waits (codex P2 1)', async () => {
    await opened();
    press('handoff-approve-p1');
    await reach('cancelling');
    expect(button('handoff-confirm')?.disabled).toBe(true);
    press('handoff-confirm');
    press('handoff-stop');
    await settle();
    expect(sent('/decide')).toHaveLength(0);
    expect(sent('/end')).toHaveLength(0);
    await act(async () => releaseCancel?.());
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(memWriteLockOfOthers('mem-items')).toBeNull();
  });

  it('cancelling × unknown cannot arise: with an unknown decide the cancel is not sent', async () => {
    await opened();
    await reach('unknown');
    press('handoff-cancel');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.unknown));
    expect(sent('/cancel')).toHaveLength(0);
    expect(page.handoffTarget).toEqual(TARGET);
  });

  it('cancelling: a second close waits for the answer; the answer closes once', async () => {
    await opened();
    await reach('cancelling');
    esc();
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.cancelling));
    expect(sent('/cancel')).toHaveLength(1);
    await act(async () => releaseCancel?.());
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(1);
  });

  it('(negative control) a decide answered before the cancel: the cancel is sent and closes', async () => {
    await opened();
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('確定しました'));
    press('handoff-cancel');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/decide')).toHaveLength(1);
    expect(sent('/cancel')).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 3 — the plain stop’s end (codex P2 2): the stop can be pressed, the unit stays', () => {
  /** A stop whose `end` finds the session changed shows the plain stop (with the unit, if any). */
  async function toPlain() {
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
  }

  it.each(['sending', 'unknown'] as const)('own page, %s: the plain stop runs; the dialog stays with the unit to choose', async (state) => {
    await opened();
    await reach(state);
    await toPlain();
    press('handoff-plain-stop');
    await waitFor(() => expect(kills).toHaveLength(1));
    await settle();
    if (state === 'sending') await act(async () => releaseDecide?.());
    expect(page.handoffTarget).toEqual(TARGET);
    expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
    expect(button('handoff-plain-stop')).toBeNull();
    press('handoff-pending-drop');
    press('handoff-plain-cancel');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(kills).toHaveLength(1);
  });

  it('cancelling: no stop is run while the cancel waits', async () => {
    await opened();
    await reach('cancelling');
    expect(button('handoff-stop')?.disabled).toBe(true);
    press('handoff-stop');
    await settle();
    expect(sent('/end')).toHaveLength(0);
    expect(kills).toHaveLength(0);
  });

  it('another worktree’s page: no stop is offered (the page’s stop is that worktree’s)', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(button('handoff-stop')).toBeNull();
    expect(button('handoff-stop-now')).toBeNull();
    expect(button('handoff-plain-stop')).toBeNull();
    expect(kills).toHaveLength(0);
  });

  it('(negative control) nothing held: the plain stop closes the dialog after the stop', async () => {
    await opened();
    await toPlain();
    press('handoff-plain-stop');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(kills).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 4 — a switch of worktree (codex P2 3・PM Claude pr2c P3-1)', () => {
  it.each(HELD)('while %s: the dialog stays, as another worktree’s, and makes no request on B', async (state) => {
    const { switchTo } = await opened();
    await reach(state);
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(page.handoffTarget).toEqual(TARGET);
    expect(posts.filter((post) => post.worktree === B && post.path === '/mem/handoff/requests')).toHaveLength(0);
    if (state === 'cancelling') {
      await act(async () => releaseCancel?.());
      await waitFor(() => expect(page.handoffTarget).toBeNull());
    }
    if (state === 'sending') {
      await act(async () => releaseDecide?.());
      expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
      expect(page.handoffTarget).toEqual(TARGET);
    }
  });

  it('unknown, A → B → A: on B the unit is dropped only; back on A the same decide is sent again', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    const first = sent('/decide')[0];
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(screen.getByTestId('handoff-pending-elsewhere')).toBeTruthy();
    expect(button('handoff-pending-resend')?.disabled).toBe(true);
    expect(button('handoff-pending-drop')?.disabled).toBe(false);
    press('handoff-pending-resend');
    await settle();
    expect(sent('/decide')).toHaveLength(1);
    expect(memWriteLockOfOthers('mem-items')).toBe('unknown');
    switchTo(A);
    await waitFor(() => expect(screen.queryByTestId('handoff-foreign')).toBeNull());
    expect(button('handoff-pending-resend')?.disabled).toBe(false);
    press('handoff-pending-resend');
    await waitFor(() => expect(sent('/decide')).toHaveLength(2));
    expect(sent('/decide')[1]).toEqual(first);
  });

  it('(negative control) nothing held: a switch closes the dialog', async () => {
    const { switchTo } = await opened();
    switchTo(B);
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(screen.queryByTestId('handoff-dialog')).toBeNull();
  });
});

describe('[#4227 pr2d] path 5 — the page’s other "end" (PM Claude pr2c P3-2)', () => {
  it.each(HELD)('while %s: another End neither replaces the hand-off nor opens the plain confirmation', async (state) => {
    await opened();
    await reach(state);
    const reads = modeReads.length;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toEqual(TARGET);
    expect(page.killTarget).toBeNull();
    expect(modeReads).toHaveLength(reads);
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE[state]));
  });

  it('another worktree’s page, unknown: B’s End is ignored as well', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toEqual(TARGET);
    expect(page.killTarget).toBeNull();
  });

  it('a kill in flight: the attended End does not open the hand-off over its confirmation (P3-2 (b))', async () => {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    let releaseKill!: () => void;
    const fetchBefore = global.fetch;
    global.fetch = vi.fn((input: unknown, init?: RequestInit) =>
      String(input).includes('/kill-session')
        ? new Promise<Response>((resolve) => (releaseKill = () => resolve(reply(200, { success: true }))))
        : fetchBefore(input as RequestInfo, init)
    ) as unknown as typeof fetch;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.killTarget).toEqual(OTHER);
    let killing!: Promise<void>;
    act(() => {
      killing = page.handleKillConfirm();
    });
    await waitFor(() => expect(page.isKillPending).toBe(true));
    modeAnswer = { status: 200, body: ATTENDED };
    await act(async () => {
      await page.openEnd(TARGET);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
    await act(async () => {
      releaseKill();
      await killing;
    });
  });

  it('(negative control) nothing held: another End closes the hand-off and opens the plain confirmation', async () => {
    await opened();
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
  });
});

describe('[#4227 pr2d] (positive controls) without the rule the rows above go back to the reviews’ findings', () => {
  it('codex P2 3 / P3-1: a switch while unknown closes the dialog (the unit is no longer offered on A)', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    rule.off = true;
    switchTo(B);
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });

  it('codex P2 2: the plain stop’s end closes the dialog with the unit unchosen', async () => {
    await opened();
    await reach('unknown');
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
    rule.off = true;
    press('handoff-plain-stop');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });

  it('P3-2: another End replaces a hand-off that holds an unknown decide', async () => {
    await opened();
    await reach('unknown');
    rule.off = true;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
  });

  it('the person’s Esc while unknown closes (the rule of pr2c taken out)', async () => {
    await opened();
    await reach('unknown');
    rule.off = true;
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });
});

/**
 * pr2e (PM Claude pr2d P2-1, codex review-4227-pr2c P2-1): the units live in the store, keyed by
 * the worktree id, not in the dialog. Drawn again — PC ↔ phone (a turn of the device, a change of
 * width), or taken out and drawn again (a remount: the page's Loading) — the dialog keeps the
 * unit, makes no second request, and the rule still holds it. Positive control: `rule.perInstance`
 * empties the store when the dialog is taken out (the units back in the component's life).
 */
type Held = 'sending' | 'unknown' | 'cancelling' | 'stopping';
const HELD_ALL: Held[] = ['sending', 'unknown', 'cancelling', 'stopping'];
const NOTICE_ALL = { ...NOTICE, stopping: '停止の途中です' } as const;
const REDRAWS = {
  layout: (redraw: (d: Drawing) => void) => redraw({ layout: 'phone' }),
  remount: (redraw: (d: Drawing) => void) => {
    redraw({ drawn: false });
    redraw({ drawn: true });
  },
} as const;

async function reachAll(state: Held): Promise<void> {
  if (state !== 'stopping') return reach(state);
  killMode = 'hold';
  press('handoff-stop');
  await waitFor(() => expect(releaseKill).not.toBeNull());
}

describe('[#4227 pr2e] path 6 — the dialog drawn again (layout switch / remount) × state', () => {
  for (const route of ['layout', 'remount'] as const) {
    it.each(HELD_ALL)(`${route}, while %s: the unit stays, no second request, the rule still holds it`, async (state) => {
      const { redraw } = await opened();
      await reachAll(state);
      const before = screen.getByTestId('handoff-dialog');
      REDRAWS[route](redraw);
      const after = await screen.findByTestId('handoff-dialog');
      expect(after).not.toBe(before);
      expect(page.handoffTarget).toEqual(TARGET);
      if (state === 'unknown') expect(screen.getByTestId('handoff-pending')).toBeTruthy();
      esc();
      await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE_ALL[state]));
      expect(page.handoffTarget).toEqual(TARGET);
      if (state === 'sending') {
        await act(async () => releaseDecide?.());
        expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
      }
      if (state === 'cancelling') {
        await act(async () => releaseCancel?.());
        await waitFor(() => expect(page.handoffTarget).toBeNull());
        expect(sent('/cancel')).toHaveLength(1);
      }
      if (state === 'stopping') {
        await act(async () => releaseKill?.());
        await screen.findByTestId('handoff-outcome');
        expect(kills).toHaveLength(1);
        expect(sent('/end/observe')).toHaveLength(1);
      }
      expect(sent('/mem/handoff/requests')).toHaveLength(1);
    });
  }

  it('(negative control) nothing held, drawn again: the same request is shown, none is made again', async () => {
    const { redraw } = await opened();
    redraw({ layout: 'phone' });
    await screen.findByTestId('handoff-approve-p1');
    redraw({ drawn: false });
    redraw({ drawn: true });
    await screen.findByTestId('handoff-approve-p1');
    expect(sent('/mem/handoff/requests')).toHaveLength(1);
    expect(sent('/send')).toHaveLength(1);
  });

  it.each(['layout', 'remount'] as const)('(positive control) the units in the component’s life: %s while unknown loses the unit and makes a second request', async (route) => {
    const { redraw } = await opened();
    await reach('unknown');
    rule.perInstance = true;
    REDRAWS[route](redraw);
    await waitFor(() => expect(sent('/mem/handoff/requests')).toHaveLength(2));
    await settle();
    expect(screen.queryByTestId('handoff-pending')).toBeNull();
  });
});

/**
 * pr2e (codex review-4227-pr2c P2-2): the plain stop says "stopped" only when the existing stop
 * stopped. Refused, failed or not known: it says so, the stop stays, and pressing it again runs
 * the existing stop again — from the same screen. Negative control: stopped (path 3 above).
 */
describe('[#4227 pr2e] the plain stop’s answer: stopped / refused / failed / unknown', () => {
  async function toPlain() {
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
  }
  const CASES = [
    ['refused', () => (killMode = 'refused'), '停止できませんでした'],
    ['failed', () => ((killMode = 'errored'), (runningAnswer = 'running')), '停止できませんでした'],
    ['unknown', () => ((killMode = 'errored'), (runningAnswer = 'broken')), '停止できたかどうか分かりません'],
  ] as const;

  it.each(CASES)('%s: not called stopped; the stop stays and runs again from here', async (_name, arrange, wording) => {
    await opened();
    await toPlain();
    arrange();
    press('handoff-plain-stop');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(wording));
    expect(kills).toHaveLength(1);
    expect(page.handoffTarget).toEqual(TARGET);
    expect(screen.getByTestId('handoff-plain').textContent).not.toContain('停止しました');
    expect(button('handoff-plain-stop')?.disabled).toBe(false);
    killMode = 'ok';
    runningAnswer = 'none';
    press('handoff-plain-stop');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(kills).toHaveLength(2);
  });

  it.each(CASES)('%s with an unknown decide: not “stopped” either; the unit and the stop both stay', async (_name, arrange) => {
    await opened();
    await reach('unknown');
    await toPlain();
    arrange();
    press('handoff-plain-stop');
    await waitFor(() => expect(kills).toHaveLength(1));
    await settle();
    expect(screen.getByTestId('handoff-plain').textContent).not.toContain('停止しました');
    expect(button('handoff-plain-stop')).not.toBeNull();
    expect(screen.getByTestId('handoff-pending')).toBeTruthy();
  });

  it('(negative control) stopped with an unknown decide: “stopped”, the stop gone, the unit to choose', async () => {
    await opened();
    await reach('unknown');
    await toPlain();
    press('handoff-plain-stop');
    await waitFor(() => expect(screen.getByTestId('handoff-plain').textContent).toContain('停止しました'));
    expect(button('handoff-plain-stop')).toBeNull();
  });
});

/**
 * pr2e (PM Claude pr2d P3-2): condition 4 widened — once a cancel has started (or the dialog
 * closed), the request's text is not sent either: neither "send the request again" nor the text
 * that follows the opening's create. Negative controls: no cancel, the text goes.
 */
describe('[#4227 pr2e] condition 4: no text after the cancel starts', () => {
  beforeEach(() => {
    request = { ...request, state: 'awaiting_agent', sendState: 'failed' };
    proposals = [];
  });

  async function openedAwaiting() {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-resend-text');
  }

  it('cancelling: “send the request again” is not sent (disabled, and its handler sends nothing)', async () => {
    await openedAwaiting();
    const texts = sent('/send').length;
    await reach('cancelling');
    expect(button('handoff-resend-text')?.disabled).toBe(true);
    press('handoff-resend-text');
    await settle();
    expect(sent('/send')).toHaveLength(texts);
  });

  it('(negative control) no cancel: “send the request again” sends the text once more', async () => {
    await openedAwaiting();
    const texts = sent('/send').length;
    press('handoff-resend-text');
    await waitFor(() => expect(sent('/send')).toHaveLength(texts + 1));
  });

  it('closed while the create is answered: the text that follows it is not sent', async () => {
    createMode = 'hold';
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-loading');
    await waitFor(() => expect(releaseCreate).not.toBeNull());
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    await act(async () => releaseCreate?.());
    await settle();
    expect(sent('/send')).toHaveLength(0);
  });

  it('(negative control) the create answered with the dialog open: the text is sent once', async () => {
    await openedAwaiting();
    expect(sent('/send')).toHaveLength(1);
  });
});

/**
 * pr2f (PM decision in `pm-return-4227-pr2e-codex.md`; codex review-4227-pr2d P2-1・P2-2, PM
 * Claude pr2e P3-1): an old continuation — a decide's `finally`, the cancel's answer, the plain
 * stop's end, the create's answer — × a new sending / a new opening changes nothing. Each row runs
 * twice: as the code is (nothing changes), and with `rule.tokenless` (the store's settle, close and
 * patch reach the current sending / opening instead of their own: the code before pr2f), which
 * brings back the review's finding. Negative controls: the same continuations on their own
 * sending / opening (path 2・3 above, the create's row of condition 4, and the row below).
 */
describe('[#4227 pr2f] an old continuation × a new sending / a new opening', () => {
  /** codex P2-1: a refused decide's reload is answered after a second confirm was sent. */
  async function oldFinallyOverNextSending() {
    await opened();
    decideMode = 'error500';
    readMode = 'hold';
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(releaseRead).not.toBeNull());
    decideMode = 'hold';
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(releaseDecide).not.toBeNull());
    readMode = 'ok';
    await act(async () => releaseRead?.());
    await settle();
    return {
      pendingShown: screen.queryByTestId('handoff-pending') !== null,
      stillSending: screen.queryByTestId('handoff-write-locked')?.textContent?.includes('送信中') ?? false,
    };
  }

  /** The page A left while `waitFor` holds A's work; B's page opens its own hand-off. */
  async function leaveToB(first: { unmount: () => void }) {
    first.unmount();
    render(<Page worktreeId={B} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-plain');
  }
  const bStillOpen = () => ({
    plainShown: screen.queryByTestId('handoff-plain') !== null,
    open: handoffStoreSnapshot().opening?.worktreeId === B && handoffStoreSnapshot().opening?.closed === false,
    target: page.handoffTarget,
  });

  /** codex P2-2: A's cancel waits, the person goes to B's page and opens B's hand-off, A's cancel is answered. */
  async function oldCancelAnswerOverNewOpening() {
    const first = render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-approve-p1');
    await reach('cancelling');
    await leaveToB(first);
    await act(async () => releaseCancel?.());
    await settle();
    return bStillOpen();
  }

  /** codex P2-2: A's plain stop runs, the person goes to B's page and opens B's hand-off, A's stop ends. */
  async function oldPlainStopOverNewOpening() {
    const first = render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-approve-p1');
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
    killMode = 'hold';
    press('handoff-plain-stop');
    await waitFor(() => expect(releaseKill).not.toBeNull());
    await leaveToB(first);
    killMode = 'ok';
    await act(async () => releaseKill?.());
    await settle();
    return { ...bStillOpen(), stoppedShown: screen.queryByTestId('handoff-plain')?.textContent?.includes('停止しました') ?? false };
  }

  /** PM Claude pr2e P3-1: closed while the create is answered, opened again; the first create answers last. */
  async function oldCreateOverNewOpening() {
    createMode = 'hold';
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-loading');
    await waitFor(() => expect(releaseCreate).not.toBeNull());
    const firstCreate = releaseCreate!;
    releaseCreate = null;
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    createMode = 'ok';
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-approve-p1');
    // What the first create answers now differs from what the second showed.
    request = { ...request, state: 'awaiting_agent', version: 9 };
    proposals = [];
    await act(async () => firstCreate());
    await settle();
    return {
      approveShown: screen.queryByTestId('handoff-approve-p1') !== null,
      version: handoffStoreSnapshot().opening?.view?.request.version ?? null,
      texts: sent('/send').length,
    };
  }

  it('a decide’s finally (after its reload) × the next sending: the next stays in flight, nothing is unknown', async () => {
    expect(await oldFinallyOverNextSending()).toEqual({ pendingShown: false, stillSending: true });
    // The next sending's own end still says how it ended (lost: kept as unknown, to send again).
    await act(async () => releaseDecide?.());
    expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
    expect(button('handoff-pending-resend')?.disabled).toBe(false);
  });

  it('the cancel’s answer × a new opening on another page: B’s hand-off stays open as it was', async () => {
    expect(await oldCancelAnswerOverNewOpening()).toEqual({ plainShown: true, open: true, target: TARGET });
  });

  it('the plain stop’s end × a new opening on another page: B’s hand-off stays, not called stopped', async () => {
    expect(await oldPlainStopOverNewOpening()).toEqual({ plainShown: true, open: true, target: TARGET, stoppedShown: false });
    expect(kills).toHaveLength(1);
  });

  it('the create’s answer × a new opening: the new opening’s request is shown as it was, its text sent once', async () => {
    expect(await oldCreateOverNewOpening()).toEqual({ approveShown: true, version: 3, texts: 1 });
  });

  it('(negative control) a refused decide’s finally on its own sending, no next one: nothing kept as unknown', async () => {
    await opened();
    decideMode = 'error500';
    press('handoff-approve-p1');
    press('handoff-confirm');
    await screen.findByTestId('handoff-notice');
    await settle();
    expect(screen.queryByTestId('handoff-pending')).toBeNull();
    expect(screen.queryByTestId('handoff-write-locked')).toBeNull();
    expect(sent('/decide')).toHaveLength(1);
  });

  describe('(positive controls) without the opening’s token and the sending’s identity the findings come back', () => {
    beforeEach(() => {
      rule.tokenless = true;
    });

    it('codex P2-1: the old finally makes the next sending unknown while it is still in flight', async () => {
      expect((await oldFinallyOverNextSending()).pendingShown).toBe(true);
    });

    it('codex P2-2: A’s cancel answer closes B’s opening', async () => {
      const after = await oldCancelAnswerOverNewOpening();
      expect(after.open).toBe(false);
      expect(after.plainShown).toBe(false);
    });

    it('codex P2-2: A’s plain stop end closes B’s opening', async () => {
      const after = await oldPlainStopOverNewOpening();
      expect(after.open).toBe(false);
      expect(after.plainShown).toBe(false);
    });

    it('PM Claude P3-1: the old create’s answer rewrites the new opening’s request', async () => {
      expect((await oldCreateOverNewOpening()).version).toBe(9);
    });
  });
});
