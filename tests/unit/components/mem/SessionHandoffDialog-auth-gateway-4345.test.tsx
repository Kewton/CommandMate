/**
 * Issue #4345 1b: the hand-off dialog's own requests — create, read, the text (`/send`) and its
 * `sent` / `send-failed`, decide, extend, rebase, cancel, end, `end/observe` — and the kill-session
 * report their 401 through the gateway of `@/lib/handoff/page-registration`
 * (`beginHandoffPageRequest` → `reportHandoffPageResponse`), owned by the registration the dialog
 * was handed when the operation started.
 *
 * Drawn as the app draws it: the real page (`useWorktreeDetailController`) with the one host
 * (`HandoffDialogHost`, the path `/worktrees/wt-a`) beside it, so the dialog's hiding and its return
 * are seen (not a call count).
 *
 * Positive controls (red on the code before 1b, where these answers never reached the registry):
 * (1) each entry answers 401 while the next detail read is held: the registry is expired, the host
 *     draws nothing, the unit and the opening stay; (2) a new detail read's success brings the same
 *     opening back, with no second create nor text; (3) another entry's 401 while create / end /
 *     cancel is answered: no text, kill nor close starts, the answer is recorded on its opening;
 *     (4) a 401 or a registration swapped after decide / the text / the kill: the settle, the text's
 *     record and the observation still go, for the opening they were for; (6) a 401 whose body is
 *     not JSON or never ends, and the redirect to /login, are reported all the same.
 * Negative controls (green before and after): (5) a request that left under an older registration
 * expires nothing of the current one; (7) 403, 409, no response (status 0) leave the session as it
 * is and keep the existing refusal / unknown.
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
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { publishMemWriteLock } from '@/components/mem/mem-write-lock';
import { handoffStoreSnapshot, handoffUnitsOf, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { handoffRegistrySnapshot, registerHandoffPage, resetHandoffRegistryForTests, unregisterHandoffPage } from '@/lib/handoff/page-registration';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

/** The entries of this PR, named by what the mock answers. */
type Entry = 'create' | 'read' | 'send' | 'sent' | 'send-failed' | 'decide' | 'extend' | 'rebase' | 'cancel' | 'end' | 'observe' | 'kill';
/** How an entry answers: a status, `0` (no response), or one of the expiry's odd shapes (6). */
type Answer = number | 'redirect' | 'bad-body' | 'stalled-body';

let answers: Partial<Record<Entry, Answer>>;
let calls: Record<Entry, number>;
let holds: Partial<Record<Entry, () => void>>;
let holding: Set<Entry>;
let detailQueued: boolean;
let detailQueue: Array<(status: number) => void>;
let stalledBodies: Array<() => void>;
let request: HandoffRequestView;
let proposals: HandoffProposalView[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });
const detailBody = { id: A, name: A, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} };

/** The entry's answer when it is not the default one. */
function odd(answer: Answer): Response | Promise<Response> {
  if (answer === 0) return Promise.reject(new TypeError('Failed to fetch'));
  if (answer === 'redirect') {
    const response = new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login?next=%2F' });
    return response;
  }
  if (answer === 'bad-body') return new Response('<html>not json</html>', { status: 401, headers: { 'content-type': 'text/html' } });
  if (answer === 'stalled-body') {
    const response = json(401, { error: 'x' });
    response.json = () => new Promise((resolve) => stalledBodies.push(() => resolve({ error: 'x' })));
    return response;
  }
  return json(answer, { ok: false, code: answer === 409 ? 'version_conflict' : answer === 403 ? 'screen_only' : undefined });
}

async function answer(entry: Entry, normal: () => Response): Promise<Response> {
  calls[entry] += 1;
  if (holding.has(entry)) await new Promise<void>((resolve) => (holds[entry] = resolve));
  const given = answers[entry];
  if (given === undefined) return normal();
  return odd(given);
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  answers = {};
  calls = { create: 0, read: 0, send: 0, sent: 0, 'send-failed': 0, decide: 0, extend: 0, rebase: 0, cancel: 0, end: 0, observe: 0, kill: 0 };
  holds = {};
  holding = new Set();
  detailQueued = false;
  detailQueue = [];
  stalledBodies = [];
  request = {
    id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'reviewing', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z', endedAt: null, agentTimedOut: false, version: 3,
  };
  proposals = [
    {
      id: 'p1', op: 'add', itemId: null, kind: 'note', baseVersion: null, revision: 1, fingerprint: 'fp-p1',
      state: 'proposed', stateReason: null, payload: { text: 'text of p1' }, current: null, appliedItemId: null, appliedVersion: null,
    },
    {
      id: 'p2', op: 'add', itemId: null, kind: 'note', baseVersion: null, revision: 1, fingerprint: 'fp-p2',
      state: 'conflict', stateReason: null, payload: { text: 'text of p2' }, current: null, appliedItemId: null, appliedVersion: null,
    },
  ];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const rest = match ? match[2] : url;
    if (rest.startsWith('/mem/mode')) return json(200, ATTENDED);
    if (rest.startsWith('/kill-session')) return answer('kill', () => json(200, { success: true, message: 'ok' }));
    if (rest === '/send') return answer('send', () => json(201, { id: 'm1' }));
    if (rest === '/mem/handoff/requests' && method === 'POST') return answer('create', () => json(201, { ...view(), text: 'the request text' }));
    const step = /^\/mem\/handoff\/requests\/r1(\/.*)?$/.exec(rest);
    if (step) {
      switch (step[1]) {
        case undefined:
          return answer('read', () => json(200, view()));
        case '/sent':
          return answer('sent', () => json(200, view()));
        case '/send-failed':
          return answer('send-failed', () => {
            request = { ...request, sendState: 'failed' };
            return json(200, view());
          });
        case '/decide':
          return answer('decide', () => json(200, { ...view(), results: [] }));
        case '/extend':
          return answer('extend', () => json(200, view()));
        case '/proposals/p2/rebase':
          return answer('rebase', () => json(200, view()));
        case '/cancel':
          return answer('cancel', () => {
            request = { ...request, state: 'cancelled' };
            return json(200, view());
          });
        case '/end':
          return answer('end', () => {
            request = { ...request, state: 'ending', endToken: 'tok-1', version: request.version + 1 };
            return json(200, { ...view(), endToken: 'tok-1' });
          });
        case '/end/observe':
          return answer('observe', () => {
            request = { ...request, state: 'ended', outcome: 'confirmed' };
            return json(200, view());
          });
        default:
          return json(404, { ok: false, code: 'not_found' });
      }
    }
    if (rest.startsWith('/current-output')) return json(200, { isRunning: false });
    if (rest.startsWith('/messages')) return json(200, []);
    if (rest.startsWith('/auto-yes')) return json(200, { instances: {} });
    if (match && rest === '') {
      if (detailQueued) {
        return new Promise<Response>((resolve) => detailQueue.push((status) => resolve(status === 200 ? json(200, detailBody) : json(status, { error: 'x' }))));
      }
      return json(200, detailBody);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const release of Object.values(holds)) release?.();
  for (const release of stalledBodies.splice(0)) release();
  for (const release of detailQueue.splice(0)) release(200);
  cleanup();
  publishMemWriteLock('mem-items', null);
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

let page: ReturnType<typeof useWorktreeDetailController>;
function Page() {
  page = useWorktreeDetailController({ worktreeId: A });
  return null;
}
const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');
const press = (testId: string): void => {
  fireEvent.click(screen.getByTestId(testId));
};
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** The page and its host drawn, "end" pressed: the hand-off opened, its request made and its text sent. */
async function opened(): Promise<void> {
  render(
    <>
      <Page />
      <HandoffDialogHost />
    </>,
  );
  await waitFor(() => expect(page.loading).toBe(false));
  await act(async () => {
    await page.openEnd(TARGET);
  });
  await waitFor(() => expect(dialog()).not.toBeNull());
  await settle();
}

/** From now on the page's detail reads wait to be answered (the recovery is the test's to give). */
function holdDetailReads(): void {
  detailQueued = true;
}

/** A new detail read answers 200: the one recovery. */
async function recover(): Promise<void> {
  detailQueued = true;
  act(() => {
    void page.handleRetry();
  });
  await waitFor(() => expect(detailQueue.length).toBeGreaterThan(0));
  await act(async () => {
    for (const release of detailQueue.splice(0)) release(200);
  });
  await settle();
}

/** The opening kept, not closed, and the page still holds the target. */
function expectKept(token: unknown): void {
  const opening = handoffStoreSnapshot().opening;
  expect(opening?.token).toBe(token);
  expect(opening?.closed).toBe(false);
  expect(page.handoffTarget).toEqual(TARGET);
  const units = handoffUnitsOf(A);
  expect(units.pending).toBeNull();
  expect(units.inflight).toBeNull();
  expect(units.stopping).toBe(false);
  expect(units.cancelling).toBe(false);
}

/** How each entry is reached from the dialog, the request set up for it first. */
const DRIVE: Record<Exclude<Entry, 'create' | 'send' | 'sent' | 'send-failed'>, { prepare?: () => void; run: () => Promise<void> }> = {
  read: { run: async () => press('handoff-reload') },
  decide: {
    run: async () => {
      press('handoff-approve-p1');
      await settle();
      press('handoff-confirm');
    },
  },
  extend: {
    prepare: () => {
      request = { ...request, state: 'awaiting_agent', agentTimedOut: true, agentDoneAt: null };
    },
    run: async () => press('handoff-extend'),
  },
  rebase: { run: async () => press('handoff-rebase-p2') },
  cancel: { run: async () => press('handoff-cancel') },
  end: { run: async () => press('handoff-stop') },
  observe: {
    run: async () => {
      press('handoff-stop');
      // The kill succeeded and the page reads its detail (held): answered 200 before the observation
      // leaves, so it is older than the observation's 401 and recovers nothing.
      await waitFor(() => expect(detailQueue.length).toBeGreaterThan(0));
      await act(async () => {
        for (const release of detailQueue.splice(0)) release(200);
      });
    },
  },
  kill: { run: async () => press('handoff-stop') },
};

describe('[#4345 1b] (1)(2) each entry’s 401: expired, hidden, the unit and the opening kept; the detail read’s success brings the same opening back', () => {
  it.each(Object.keys(DRIVE) as Array<keyof typeof DRIVE>)('%s answers 401', async (entry) => {
    DRIVE[entry].prepare?.();
    await opened();
    const token = handoffStoreSnapshot().opening?.token;
    expect(token).toBeDefined();
    expect(calls.create).toBe(1);
    expect(calls.send).toBe(1);
    holdDetailReads();
    answers[entry] = 401;
    await act(async () => DRIVE[entry].run());
    await waitFor(() => expect(calls[entry]).toBe(1));
    await settle();
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expectKept(token);
    // (4) what was sent is recorded: after the kill (even its own 401), the observation goes.
    if (entry === 'kill') expect(calls.observe).toBe(1);
    // (3) after `end`'s 401 no kill starts.
    if (entry === 'end') expect(calls.kill).toBe(0);
    // (2) back with the same opening, nothing made or sent again.
    delete answers[entry];
    await recover();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(calls.create).toBe(1);
    expect(calls.send).toBe(1);
  });

  it('create answers 401: expired and hidden; the same opening makes its request once after the recovery, and its text once', async () => {
    answers.create = 401;
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(page.loading).toBe(false));
    holdDetailReads();
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(calls.create).toBe(1));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    const token = handoffStoreSnapshot().opening?.token;
    expect(token).toBeDefined();
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffStoreSnapshot().opening?.plainOnly).toBeNull();
    expect(calls.send).toBe(0);
    delete answers.create;
    await recover();
    await waitFor(() => expect(dialog()).not.toBeNull());
    await waitFor(() => expect(calls.send).toBe(1));
    await settle();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(calls.create).toBe(2);
    expect(calls.send).toBe(1);
    expect(screen.queryByTestId('handoff-approve-p1')).not.toBeNull();
  });

  it.each(['send', 'sent', 'send-failed'] as const)('the text’s %s answers 401: expired and hidden; the text’s record still goes; no second create nor text after the recovery', async (entry) => {
    answers[entry] = 401;
    if (entry === 'send-failed') answers.send = 500;
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(page.loading).toBe(false));
    holdDetailReads();
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(calls[entry]).toBe(1));
    await settle();
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    const token = handoffStoreSnapshot().opening?.token;
    expectKept(token);
    // (4) the text's own 401: its failure is still recorded for the request.
    if (entry === 'send') expect(calls['send-failed']).toBe(1);
    delete answers[entry];
    delete answers.send;
    await recover();
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(calls.create).toBe(1);
    expect(calls.send).toBe(1);
  });
});

describe('[#4345 1b] (3) another entry’s 401 while create / end / cancel is answered', () => {
  it('a read answers 401 while create is answered: the text is not sent; the request is recorded on its opening', async () => {
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(page.loading).toBe(false));
    holdDetailReads();
    holding.add('create');
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(holds.create).toBeDefined());
    // The kill (another entry of the same page) answers 401 meanwhile.
    answers.kill = 401;
    await act(async () => {
      await page.stopForHandoff();
    });
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await act(async () => holds.create!());
    await settle();
    expect(calls.send).toBe(0);
    expect(handoffStoreSnapshot().opening?.view?.request.id).toBe('r1');
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('a read answers 401 while `end` is answered: no kill; `end`’s answer is adopted into the opening', async () => {
    await opened();
    holdDetailReads();
    holding.add('end');
    press('handoff-stop');
    await waitFor(() => expect(holds.end).toBeDefined());
    answers.read = 401;
    press('handoff-reload');
    await waitFor(() => expect(handoffRegistrySnapshot().authExpired).toBe(true));
    await act(async () => holds.end!());
    await settle();
    expect(calls.kill).toBe(0);
    expect(calls.observe).toBe(0);
    expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ending');
    expect(handoffUnitsOf(A).stopping).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('a read answers 401 while the cancel is answered: nothing is closed; the answer is read into the opening', async () => {
    await opened();
    holdDetailReads();
    holding.add('cancel');
    press('handoff-cancel');
    await waitFor(() => expect(holds.cancel).toBeDefined());
    answers.read = 401;
    press('handoff-reload');
    await waitFor(() => expect(handoffRegistrySnapshot().authExpired).toBe(true));
    delete answers.read;
    await act(async () => holds.cancel!());
    await settle();
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(page.handoffTarget).toEqual(TARGET);
    await waitFor(() => expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('cancelled'));
  });
});

describe('[#4345 1b] (4) after decide / the text / the kill: a 401 or a swapped registration discards nothing', () => {
  it('a decide answered after another entry’s 401: settled on its own unit, its answer adopted into its opening', async () => {
    await opened();
    holdDetailReads();
    holding.add('decide');
    press('handoff-approve-p1');
    await settle();
    press('handoff-confirm');
    await waitFor(() => expect(holds.decide).toBeDefined());
    expect(handoffUnitsOf(A).inflight).not.toBeNull();
    answers.read = 401;
    press('handoff-reload');
    await waitFor(() => expect(handoffRegistrySnapshot().authExpired).toBe(true));
    request = { ...request, version: 9 };
    await act(async () => holds.decide!());
    await settle();
    expect(handoffUnitsOf(A).inflight).toBeNull();
    expect(handoffUnitsOf(A).pending).toBeNull();
    expect(handoffStoreSnapshot().opening?.view?.request.version).toBe(9);
  });

  it('a newer registration while the kill is answered with 401: the kill’s 401 expires nothing of it, and the observation still goes for the request', async () => {
    await opened();
    holding.add('kill');
    answers.kill = 401;
    press('handoff-stop');
    await waitFor(() => expect(holds.kill).toBeDefined());
    act(() => {
      registerHandoffPage(A);
    });
    await act(async () => holds.kill!());
    await waitFor(() => expect(calls.observe).toBe(1));
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ended');
  });

  it('a newer registration while the text is answered with 401: the old registration’s 401 expires nothing; its failure is recorded on its opening', async () => {
    holding.add('send');
    answers.send = 401;
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(holds.send).toBeDefined());
    const token = handoffStoreSnapshot().opening?.token;
    act(() => {
      registerHandoffPage(A);
    });
    await act(async () => holds.send!());
    await waitFor(() => expect(calls['send-failed']).toBe(1));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.view?.request.sendState).toBe('failed');
  });
});

describe('[#4345 1b] (5) an old registration’s 401 leaves the current one', () => {
  it('a read that left under the page’s registration answers 401 after its registration was removed and another registered: not expired', async () => {
    await opened();
    holding.add('read');
    answers.read = 401;
    press('handoff-reload');
    await waitFor(() => expect(holds.read).toBeDefined());
    const old = page.handoffRegistration!;
    act(() => {
      unregisterHandoffPage(old);
      registerHandoffPage(A);
    });
    await act(async () => holds.read!());
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });
});

describe('[#4345 1b] (6) odd shapes of the expiry are reported all the same', () => {
  it.each(['bad-body', 'stalled-body', 'redirect'] as const)('the read answers %s: expired and hidden, the opening kept', async (shape) => {
    await opened();
    const token = handoffStoreSnapshot().opening?.token;
    holdDetailReads();
    answers.read = shape;
    press('handoff-reload');
    await waitFor(() => expect(handoffRegistrySnapshot().authExpired).toBe(true));
    await settle();
    expect(dialog()).toBeNull();
    expectKept(token);
  });

  it.each(['bad-body', 'stalled-body', 'redirect'] as const)('the kill answers %s: expired; the observation still goes', async (shape) => {
    await opened();
    holdDetailReads();
    answers.kill = shape;
    press('handoff-stop');
    await waitFor(() => expect(handoffRegistrySnapshot().authExpired).toBe(true));
    if (shape === 'stalled-body') {
      // The kill's error body is read after the report; once it ends the kill goes on to be observed.
      await act(async () => {
        for (const release of stalledBodies.splice(0)) release();
      });
    }
    await waitFor(() => expect(calls.observe).toBe(1));
    expect(dialog()).toBeNull();
  });
});

describe('[#4345 1b] (7) negative controls: not the expiry', () => {
  it.each([403, 409, 0])('decide answers %s: not expired, the dialog stays, the existing refusal / unknown', async (status) => {
    await opened();
    answers.decide = status;
    press('handoff-approve-p1');
    await settle();
    press('handoff-confirm');
    await waitFor(() => expect(calls.decide).toBe(1));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
    if (status === 0) expect(handoffUnitsOf(A).pending).not.toBeNull();
    else expect(handoffUnitsOf(A).pending).toBeNull();
    expect(screen.getByTestId('handoff-notice')).toBeTruthy();
  });

  it.each([403, 409, 0])('the kill answers %s: not expired, the dialog stays', async (status) => {
    await opened();
    answers.kill = status;
    press('handoff-stop');
    await waitFor(() => expect(calls.kill).toBe(1));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
  });

  it.each([403, 409, 0])('create answers %s: not expired, the dialog stays with the plain stop (as before)', async (status) => {
    answers.create = status;
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(calls.create).toBe(1));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(handoffStoreSnapshot().opening?.plainOnly).not.toBeNull();
  });
});
