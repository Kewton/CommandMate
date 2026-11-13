/**
 * Issue #4345 1c (review-4345-1cc P2-1): the capability to record what was sent is made from the
 * operation that actually started it. A stop resumed from `ending` (an `endToken` already held, so no
 * `end` is sent) starts the kill as its first new request: the kill carries the stop's operation token
 * to the gate, the gate's allowing it is what makes `record()` hand the capability over, and the
 * observation of that kill leaves on it — even when another entry's 401 is taken while the kill waits.
 *
 * Drawn as the app draws it: the real page (`useWorktreeDetailController`) and the one host.
 *
 * Positive control (red on 5f6ef06, where the resumed stop's token never started anything and the
 * observation was gated as a new request): ending resumed → the kill held → another entry's 401 →
 * the kill answers → the observation goes once, and the stop's result lands on the same opening.
 * Negative controls: resumed while already expired → no kill (fetch 0), no observation; the plain
 * end → kill → observation as before; an observation without the capability (forged) stays refused.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

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
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { beginHandoffOpening, handoffStoreSnapshot, patchHandoffOpening, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import {
  beginHandoffPageRequest,
  currentHandoffPage,
  handoffRegistrySnapshot,
  reportHandoffPageResponse,
  resetHandoffRegistryForTests,
} from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';

const { handoffApi } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const detailBody = { id: A, name: A, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} };

let request: Record<string, unknown>;
let calls: { end: number; kill: number; observe: number };
let killHeld: boolean;
let killRelease: Array<() => void>;
/** The detail read recovers nothing (answers 500) while set. */
let detailHeld: boolean;

const view = () => ({ ok: true, request: { ...request }, proposals: [], direct: [] });

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  calls = { end: 0, kill: 0, observe: 0 };
  killHeld = false;
  killRelease = [];
  detailHeld = false;
  request = {
    id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'ending', sendState: 'sent', endForced: false, endToken: 'tok-1', outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z', endedAt: null, agentTimedOut: false, version: 4,
  };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const rest = /^\/api\/worktrees\/[^/?]+(.*)$/.exec(url)?.[1] ?? url;
    if (rest.startsWith('/mem/mode')) return json(200, { ok: true, mode: 'on', features: { popup: true } });
    if (rest.startsWith('/kill-session')) {
      calls.kill += 1;
      if (killHeld) await new Promise<void>((resolve) => killRelease.push(resolve));
      return json(200, { success: true, message: 'ok' });
    }
    if (rest === '/mem/handoff/requests/r1/end') {
      calls.end += 1;
      request = { ...request, state: 'ending', endToken: 'tok-2', version: (request.version as number) + 1 };
      return json(200, { ...view(), endToken: 'tok-2' });
    }
    if (rest === '/mem/handoff/requests/r1/end/observe') {
      calls.observe += 1;
      request = { ...request, state: 'ended', outcome: 'confirmed' };
      return json(200, view());
    }
    if (rest.startsWith('/mem/handoff/requests/r1')) return json(200, view());
    if (rest.startsWith('/current-output')) return json(200, { isRunning: false });
    if (rest.startsWith('/messages')) return json(200, []);
    if (rest.startsWith('/auto-yes')) return json(200, { instances: {} });
    if (rest === '') {
      // Not recovered meanwhile: the detail read answers 500 (neither a recovery nor an expiry).
      if (detailHeld) return json(500, { error: 'x' });
      return json(200, detailBody);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const release of killRelease.splice(0)) release();
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

let page: ReturnType<typeof useWorktreeDetailController>;
function Page() {
  page = useWorktreeDetailController({ worktreeId: A });
  return null;
}
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));
const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');

/** A's opening, its request already `ending` (an endToken held) — or `reviewing` for the plain end. */
async function shown(): Promise<string> {
  const own = beginHandoffOpening(A, TARGET);
  patchHandoffOpening(own.token, { created: 'done', view: view() as unknown as HandoffReadResponse, text: 'the request text' });
  render(
    <>
      <Page />
      <HandoffDialogHost />
    </>,
  );
  await waitFor(() => expect(page.loading).toBe(false));
  await waitFor(() => expect(dialog()).not.toBeNull());
  await settle();
  return own.token as unknown as string;
}

function anotherEntryAnswers401(): void {
  act(() => {
    reportHandoffPageResponse(beginHandoffPageRequest(currentHandoffPage()!.id), { status: 401 });
  });
}

describe('[#4345 1c] the observation of a kill started by a resumed stop is recorded', () => {
  it('ending resumed → the kill held → another entry’s 401 → the kill answers: observed once, on the same opening', async () => {
    const token = await shown();
    detailHeld = true;
    killHeld = true;
    fireEvent.click(screen.getByTestId('handoff-stop'));
    await waitFor(() => expect(calls.kill).toBe(1));
    expect(calls.end).toBe(0);
    anotherEntryAnswers401();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await act(async () => {
      for (const release of killRelease.splice(0)) release();
    });
    await settle();
    await settle();
    expect(calls.observe).toBe(1);
    const opening = handoffStoreSnapshot().opening;
    expect(opening?.token as unknown as string).toBe(token);
    expect(opening?.view?.request.state).toBe('ended');
  });

  it('(negative control) resumed while already expired: no kill (fetch 0), no observation', async () => {
    await shown();
    detailHeld = true;
    anotherEntryAnswers401();
    expect(dialog()).toBeNull();
    // The host draws nothing; the page's own stop, pressed anyway, starts nothing either.
    let result: unknown;
    await act(async () => {
      result = await page.stopForHandoff();
    });
    await settle();
    expect(result).toBe('not-sent');
    expect(calls.kill).toBe(0);
    expect(calls.observe).toBe(0);
  });

  it('(negative control) the plain end → kill → observation, as before', async () => {
    request = { ...request, state: 'reviewing', endToken: null, version: 3 };
    await shown();
    fireEvent.click(screen.getByTestId('handoff-stop'));
    await waitFor(() => expect(calls.observe).toBe(1));
    expect(calls.end).toBe(1);
    expect(calls.kill).toBe(1);
  });

  it('(negative control) an observation without the capability (forged) stays refused while expired', async () => {
    await shown();
    detailHeld = true;
    anotherEntryAnswers401();
    const forged = await handoffApi.observe(A, 'r1', 'tok-1', currentHandoffPage()!.id);
    expect(forged.refused).toBeDefined();
    expect(calls.observe).toBe(0);
  });
});
