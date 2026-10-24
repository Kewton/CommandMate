/**
 * The worktree screen keeps Auto-Yes's answer mode on every path that writes its
 * per-instance state (Issue #3863).
 *
 * `autoYesStateMap` is written by three readers — the current-output poll
 * (one instance), the whole-worktree `GET .../auto-yes` (every instance; also
 * the periodic re-read that picks up another tab's change) and the toggle's
 * `POST .../auto-yes` answer. Each must carry `answerMode` through, and a
 * server older than the field must leave it unknown (undefined), never
 * `recommended`. The toggle's POST names the chosen mode — the default
 * explicitly.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AutoYesInstanceSummary } from '@/types/auto-yes';
import type { AutoYesToggleParams } from '@/types/auto-yes';

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3863',
  useSearchParams: () => nav.search,
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false,
    toggle: vi.fn(), setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({ useOptionalWorktreesCacheContext: () => null }));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-3863';
const ROSTER = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
];
const EXPIRES = Date.now() + 3_600_000;

type Mode = 'recommended' | 'careful';

/** The fake server's Auto-Yes state per instance; `undefined` mode = an older server. */
interface ServerEntry {
  enabled: boolean;
  answerMode?: Mode;
}

let server: Record<string, ServerEntry>;
/** Whether `GET .../auto-yes` carries `answerModeByInstance` (false = an older server). */
let mapCarriesModes: boolean;
/** What the next current-output poll says about the primary instance. */
let poll: { autoYes?: { enabled: boolean; expiresAt: number | null }; autoYesAnswerMode?: unknown };
const posts: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true, status: 200, redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (/\/auto-yes(\?|$)/.test(url) && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(body);
      const id = String(body.instanceId);
      const enabled = body.enabled === true;
      server[id] = enabled
        ? { enabled, answerMode: (body.answerMode as Mode | undefined) ?? server[id]?.answerMode ?? 'recommended' }
        : { enabled: false };
      return jsonResponse({
        enabled,
        expiresAt: enabled ? EXPIRES : null,
        ...(enabled && mapCarriesModes ? { answerMode: server[id].answerMode } : {}),
      });
    }
    if (/\/auto-yes(\?|$)/.test(url)) {
      const instances: Record<string, { enabled: boolean; expiresAt: number | null }> = {};
      const answerModeByInstance: Record<string, Mode> = {};
      for (const [id, entry] of Object.entries(server)) {
        instances[id] = { enabled: entry.enabled, expiresAt: entry.enabled ? EXPIRES : null };
        if (entry.enabled && entry.answerMode) answerModeByInstance[id] = entry.answerMode;
      }
      return jsonResponse({
        enabled: false,
        expiresAt: null,
        agents: {},
        instances,
        ...(mapCarriesModes ? { answerModeByInstance } : {}),
      });
    }
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: true, ...poll });
    return jsonResponse({
      id: WORKTREE_ID, name: 'feature/3863', path: '/repo/3863', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude'], agentInstances: ROSTER,
    });
  }));
}

interface Result {
  autoYesStateMap: Map<string, AutoYesInstanceSummary>;
  autoYesAnswerMode?: Mode;
  activeInstanceId: string;
  rosterReady: boolean;
  fetchCurrentOutput: () => Promise<void>;
  handleAutoYesToggle: (params: AutoYesToggleParams) => Promise<void>;
  makeAutoYesToggleHandler: (cliToolId: 'claude', instanceId?: string) => (params: AutoYesToggleParams) => Promise<void>;
}

function mount() {
  return renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }) as unknown as Result).result;
}

beforeEach(() => {
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  server = {};
  mapCarriesModes = true;
  poll = {};
  posts.length = 0;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#3863] the whole-worktree GET (mount, branch return, periodic re-read)', () => {
  it('carries each enabled instance\'s mode, the active one exposed as autoYesAnswerMode', async () => {
    server = {
      claude: { enabled: true, answerMode: 'careful' },
      'claude-2': { enabled: true, answerMode: 'recommended' },
    };
    const result = mount();

    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude')?.answerMode).toBe('careful');
    });
    expect(result.current.autoYesStateMap.get('claude-2')?.answerMode).toBe('recommended');
    expect(result.current.activeInstanceId).toBe('claude');
    expect(result.current.autoYesAnswerMode).toBe('careful');
  });

  it('follows the active instance: an alias reads its own mode', async () => {
    server = {
      claude: { enabled: true, answerMode: 'careful' },
      'claude-2': { enabled: true, answerMode: 'recommended' },
    };
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();

    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('claude-2');
      expect(result.current.autoYesAnswerMode).toBe('recommended');
    });
  });

  it('an older server (no answerModeByInstance) leaves the mode unknown, not recommended', async () => {
    server = { claude: { enabled: true, answerMode: 'careful' } };
    mapCarriesModes = false;
    const result = mount();

    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
    });
    expect(result.current.autoYesStateMap.get('claude')).not.toHaveProperty('answerMode');
    expect(result.current.autoYesAnswerMode).toBeUndefined();
  });

  it('a later re-read replaces the mode (another tab turned it on again in a different mode)', async () => {
    server = { claude: { enabled: true, answerMode: 'recommended' } };
    const result = mount();
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('recommended'));

    server = { claude: { enabled: true, answerMode: 'careful' } };
    // The toggle of another instance re-reads the whole map, like the periodic refresh.
    await act(async () => {
      await result.current.makeAutoYesToggleHandler('claude', 'claude-2')({ enabled: false });
    });

    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('careful'));
  });
});

describe('[#3863] the current-output poll', () => {
  async function mountSettled() {
    const result = mount();
    await waitFor(() => expect(result.current.rosterReady).toBe(true));
    // Let the mount's whole-worktree GETs land before driving the poll by hand.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    return result;
  }

  it('seeds the mode it names, and keeps it through a poll that does not name one', async () => {
    const result = await mountSettled();

    poll = { autoYes: { enabled: true, expiresAt: EXPIRES }, autoYesAnswerMode: 'careful' };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });
    expect(result.current.autoYesStateMap.get('claude')?.answerMode).toBe('careful');

    // A stopped session / older server: the key is absent; the mode last read stays.
    poll = { autoYes: { enabled: true, expiresAt: EXPIRES } };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });
    expect(result.current.autoYesStateMap.get('claude')?.answerMode).toBe('careful');
    expect(result.current.autoYesAnswerMode).toBe('careful');
  });

  it('drops the mode when Auto-Yes goes off', async () => {
    const result = await mountSettled();
    poll = { autoYes: { enabled: true, expiresAt: EXPIRES }, autoYesAnswerMode: 'careful' };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    poll = { autoYes: { enabled: false, expiresAt: null }, autoYesAnswerMode: 'careful' };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });
    expect(result.current.autoYesStateMap.get('claude')).not.toHaveProperty('answerMode');
    expect(result.current.autoYesAnswerMode).toBeUndefined();
  });

  it('ignores a value that is not a mode', async () => {
    const result = await mountSettled();
    poll = { autoYes: { enabled: true, expiresAt: EXPIRES }, autoYesAnswerMode: 'yolo' };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });
    expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
    expect(result.current.autoYesStateMap.get('claude')).not.toHaveProperty('answerMode');
  });
});

describe('[#3863] the toggle POST', () => {
  it('names the chosen mode in the body and keeps the answer\'s mode', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.rosterReady).toBe(true));

    await act(async () => {
      await result.current.handleAutoYesToggle({ enabled: true, duration: 3_600_000, answerMode: 'careful' });
    });

    expect(posts.at(-1)).toMatchObject({ enabled: true, instanceId: 'claude', answerMode: 'careful' });
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('careful'));
  });

  it('names the default explicitly when the dialog passed none', async () => {
    server = { claude: { enabled: true, answerMode: 'careful' } };
    const result = mount();
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('careful'));

    await act(async () => {
      await result.current.handleAutoYesToggle({ enabled: true, duration: 3_600_000 });
    });

    expect(posts.at(-1)).toMatchObject({ enabled: true, answerMode: 'recommended' });
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('recommended'));
  });

  it('a split\'s handler arms its own instance in its own mode', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.rosterReady).toBe(true));

    await act(async () => {
      await result.current.makeAutoYesToggleHandler('claude', 'claude-2')({ enabled: true, answerMode: 'careful' });
    });

    expect(posts.at(-1)).toMatchObject({ instanceId: 'claude-2', answerMode: 'careful' });
    await waitFor(() => expect(result.current.autoYesStateMap.get('claude-2')?.answerMode).toBe('careful'));
    expect(result.current.autoYesStateMap.get('claude')?.answerMode).toBeUndefined();
  });

  it('turning it off sends no mode and clears it', async () => {
    server = { claude: { enabled: true, answerMode: 'careful' } };
    const result = mount();
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBe('careful'));

    await act(async () => {
      await result.current.handleAutoYesToggle({ enabled: false });
    });

    expect(posts.at(-1)).not.toHaveProperty('answerMode');
    await waitFor(() => expect(result.current.autoYesAnswerMode).toBeUndefined());
  });

  it('an older server\'s answer (no answerMode) leaves the mode unknown', async () => {
    mapCarriesModes = false;
    const result = mount();
    await waitFor(() => expect(result.current.rosterReady).toBe(true));

    await act(async () => {
      await result.current.handleAutoYesToggle({ enabled: true, answerMode: 'careful' });
    });

    await waitFor(() => expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true));
    expect(result.current.autoYesAnswerMode).toBeUndefined();
  });
});
