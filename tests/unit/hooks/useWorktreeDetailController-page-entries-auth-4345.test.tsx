/**
 * Issue #4345 1c: the page's own remaining entries report their 401 through the gateway
 * (`@/lib/handoff/page-owner` → `beginHandoffPageRequest` / `reportHandoffPageResponse`), owned by the
 * registration the page held when each request left: the messages poll, the parent current-output
 * poll, the auto-yes GET and POST, the prompt answer (`/prompt-response`), the file operations
 * (create file / directory, rename, delete, move, upload) and the content search.
 *
 * Drawn as the app draws it: the real page (`useWorktreeDetailController`) with the one host
 * (`HandoffDialogHost`, the path `/worktrees/wt-a`), so the dialog's hiding and its return are seen.
 *
 * Positive controls (red before 1c, where these answers never reached the registry): each entry
 * answers 401 while the next detail read is held — the registry is expired, the host draws nothing,
 * the opening and the page's target stay; the next detail read's success brings the same opening
 * back. Negative controls (green before and after): 403, 409 and no response (status 0) leave the
 * session as it is; the entry's 200 never recovers (only the detail read does); the existing
 * failure (the alert, the toast) is still told.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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
// The delete asks first; the person says yes.
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => async () => true };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { beginHandoffOpening, handoffStoreSnapshot, patchHandoffOpening, resetHandoffStoreForTests, type HandoffOpeningToken } from '@/lib/handoff/close-rule';
import {
  beginHandoffPageRequest,
  currentHandoffPage,
  handoffRegistrySnapshot,
  reportHandoffPageResponse,
  resetHandoffRegistryForTests,
} from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

type Entry =
  | 'messages' | 'current-output' | 'auto-yes-get' | 'auto-yes-post' | 'prompt-response'
  | 'new-file' | 'new-dir' | 'rename' | 'delete' | 'move' | 'upload' | 'search';
const ENTRIES: Entry[] = [
  'messages', 'current-output', 'auto-yes-get', 'auto-yes-post', 'prompt-response',
  'new-file', 'new-dir', 'rename', 'delete', 'move', 'upload', 'search',
];

let answers: Partial<Record<Entry, number>>;
let calls: Record<Entry, number>;
let detailQueued: boolean;
let detailQueue: Array<(status: number) => void>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const detailBody = { id: A, name: A, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} };
const readView = {
  ok: true,
  request: {
    id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  },
  proposals: [],
  direct: [],
};

/** Which entry a request is (null: not one of this file's). */
function entryOf(rest: string, method: string, body: unknown): Entry | null {
  if (rest.startsWith('/messages')) return 'messages';
  if (rest.startsWith('/current-output')) return 'current-output';
  if (rest === '/auto-yes') return method === 'POST' ? 'auto-yes-post' : 'auto-yes-get';
  if (rest === '/prompt-response') return 'prompt-response';
  if (rest.startsWith('/upload/')) return 'upload';
  if (rest.startsWith('/search?')) return 'search';
  if (rest.startsWith('/files/')) {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { type?: string; action?: string }) : {};
    if (method === 'DELETE') return 'delete';
    if (method === 'POST') return parsed.type === 'directory' ? 'new-dir' : 'new-file';
    if (method === 'PATCH') return parsed.action === 'move' ? 'move' : 'rename';
  }
  return null;
}

const DEFAULTS: Record<Entry, () => Response> = {
  messages: () => json(200, []),
  'current-output': () => json(200, { isRunning: false }),
  'auto-yes-get': () => json(200, { instances: {} }),
  'auto-yes-post': () => json(200, { enabled: true, expiresAt: Date.now() + 3_600_000 }),
  'prompt-response': () => json(200, { success: true }),
  'new-file': () => json(201, { success: true }),
  'new-dir': () => json(201, { success: true }),
  rename: () => json(200, { success: true }),
  delete: () => json(200, { success: true }),
  move: () => json(200, { success: true }),
  upload: () => json(201, { success: true, filename: 'a.png' }),
  search: () => json(200, { success: true, results: [], totalMatches: 0, truncated: false, executionTimeMs: 1 }),
};

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  answers = {};
  calls = Object.fromEntries(ENTRIES.map((e) => [e, 0])) as Record<Entry, number>;
  detailQueued = false;
  detailQueue = [];
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(window, 'prompt').mockImplementation(() => 'renamed.md');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const rest = match ? match[2] : url;
    if (rest.startsWith('/mem/mode')) return json(200, ATTENDED);
    if (rest.startsWith('/mem/handoff/requests/r1')) return json(200, readView);
    const entry = entryOf(rest, method, init?.body);
    if (entry) {
      calls[entry] += 1;
      const status = answers[entry];
      if (status === undefined) return DEFAULTS[entry]();
      if (status === 0) throw new TypeError('Failed to fetch');
      return json(status, { error: `e${status}`, success: false });
    }
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
  for (const release of detailQueue.splice(0)) release(200);
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

let page: ReturnType<typeof useWorktreeDetailController>;
function Page() {
  page = useWorktreeDetailController({ worktreeId: A });
  return null;
}
const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** A's opening, its request made and read (the page takes it back on its first render). */
function openingOfA(): HandoffOpeningToken {
  const own = beginHandoffOpening(A, TARGET);
  patchHandoffOpening(own.token, { created: 'done', view: readView as unknown as HandoffReadResponse, text: 'the request text' });
  return own.token;
}

/** The page and its host drawn, the dialog shown. */
async function shown(): Promise<HandoffOpeningToken> {
  const token = openingOfA();
  render(
    <>
      <Page />
      <HandoffDialogHost />
    </>,
  );
  await waitFor(() => expect(page.loading).toBe(false));
  await waitFor(() => expect(dialog()).not.toBeNull());
  await settle();
  return token;
}

/** How each entry is reached from the page. */
const DRIVE: Record<Entry, () => Promise<void>> = {
  messages: async () => page.handleMessageSent(),
  'current-output': async () => page.handleMessageSent(),
  // The toggle answers 200 and re-reads the whole map (the GET).
  'auto-yes-get': async () => page.makeAutoYesToggleHandler('claude')({ enabled: true, duration: 3_600_000 }),
  'auto-yes-post': async () => page.makeAutoYesToggleHandler('claude')({ enabled: true, duration: 3_600_000 }),
  'prompt-response': async () => page.handlePromptRespond('1'),
  'new-file': async () => page.handleNewFileConfirm('a.md'),
  'new-dir': async () => page.handleNewDirectory(''),
  rename: async () => page.handleRename('a.md'),
  delete: async () => page.handleDelete('a.md'),
  // The move dialog is opened first (`PREPARE`); this is its confirmation.
  move: async () => page.handleMoveConfirm('dir'),
  upload: async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await page.handleFileInputChange({ target: { files: [file], value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>);
  },
  search: async () => {
    act(() => page.fileSearch.setMode('content'));
    act(() => page.fileSearch.setQuery(`needle-${(searches += 1)}`));
  },
};
let searches = 0;

/** What an entry needs before it is pressed (a render in between). */
const PREPARE: Partial<Record<Entry, () => void>> = {
  move: () => page.handleMove('a.md', 'file'),
};

async function drive(entry: Entry): Promise<void> {
  const before = calls[entry];
  const prepare = PREPARE[entry];
  if (prepare) {
    act(() => prepare());
    await settle();
  }
  await act(async () => DRIVE[entry]());
  await waitFor(() => expect(calls[entry]).toBeGreaterThan(before), { timeout: 3000 });
  await settle();
  await settle();
}

async function recover(): Promise<void> {
  detailQueued = true;
  act(() => {
    void page.handleRetry();
  });
  await waitFor(() => expect(detailQueue.length).toBeGreaterThan(0));
  expect(dialog()).toBeNull();
  await act(async () => {
    for (const release of detailQueue.splice(0)) release(200);
  });
  await settle();
}

describe('[#4345 1c] each page entry’s 401: expired, hidden, the opening kept; the detail read’s success brings it back', () => {
  it.each(ENTRIES)('%s answers 401', async (entry) => {
    const token = await shown();
    detailQueued = true;
    answers[entry] = 401;
    await drive(entry);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(page.handoffTarget).toEqual(TARGET);
    // Back with the same opening once a new detail read succeeds.
    delete answers[entry];
    await recover();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });
});

describe('[#4345 1c] (negative controls) 403, 409 and no response leave the session as it is', () => {
  it.each(ENTRIES.flatMap((entry) => [403, 409, 0].map((status) => [entry, status] as const)))('%s answers %s', async (entry, status) => {
    const token = await shown();
    answers[entry] = status;
    await drive(entry);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
  });

  it.each(ENTRIES)('%s answering 200 after a 401 recovers nothing', async (entry) => {
    await shown();
    detailQueued = true;
    // Expired by another entry's 401 (through the gateway itself, under the page's registration).
    act(() => {
      reportHandoffPageResponse(beginHandoffPageRequest(currentHandoffPage()!.id), { status: 401 });
    });
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await drive(entry);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
  });
});

describe('[#4345 1c] (negative controls) the existing failure is still told', () => {
  it.each(['new-file', 'new-dir', 'rename', 'delete'] as const)('%s: the alert, on 401 as on 403', async (entry) => {
    await shown();
    for (const status of [403, 401]) {
      vi.mocked(window.alert).mockClear();
      answers[entry] = status;
      await drive(entry);
      expect(window.alert).toHaveBeenCalledTimes(1);
    }
  });
});
