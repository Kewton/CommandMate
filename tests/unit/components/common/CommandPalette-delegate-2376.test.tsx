/**
 * `/delegate` in the command palette (Issue #2376).
 *
 * The palette is the way to delegate to a session whose roster pane is not on
 * screen. Two things are pinned here beyond the pane's own tests:
 *
 *   - the group is GATED on the query. One row per instance per worktree would
 *     otherwise bury Navigation and Actions on an empty palette, and `/delegate`
 *     is the form the docs and the brief both name;
 *   - the row inserts the same brief the pane inserts, built from the same two
 *     server reads.
 *
 * The DOM bridge itself (`insertIntoVisibleComposer`) is unit-tested here too,
 * because it is the one part of the delegation feature with no React seam: on
 * PC the screen's `onInsertToComposer` is unreachable from either caller, so a
 * composer that stopped answering to the selector would break both surfaces at
 * once with nothing else to notice.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

const pushMock = vi.fn();
let currentPathname = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => currentPathname,
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({
    size: 'medium',
    setSize: vi.fn(),
    isMobile: false,
    factor: 1,
    isAvailable: false,
  }),
}));

interface MockCache {
  worktrees: Array<Record<string, unknown>>;
  repositories: unknown[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}
let mockCache: MockCache | null;
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => mockCache,
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

const showToast = vi.fn();
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast }) };
});

import {
  CommandPalette,
  buildDelegateTargets,
  insertIntoVisibleComposer,
  readVisibleChatInstanceId,
  shouldShowDelegateGroup,
  worktreeIdFromPath,
} from '@/components/common/CommandPalette';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const WORKTREES = [
  {
    id: 'anvil-develop',
    name: 'develop',
    branch: 'develop',
    repositoryName: 'anvil',
    cliToolId: 'claude',
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ],
  },
];

function renderPalette() {
  return render(
    <CommandPaletteProvider>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}

function openPalette(): void {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    );
  });
}

function type(value: string): void {
  const input = screen.getByTestId('command-palette-input');
  fireEvent.change(input, { target: { value } });
}

function mountComposer(initialValue = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('data-testid', 'message-input-textarea');
  textarea.value = initialValue;
  document.body.appendChild(textarea);
  return textarea;
}

function answerBriefReads(instanceId = 'codex-2'): void {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/cli-reference')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          binary: 'commandmate',
          worktreeId: 'anvil-develop',
          portPrefix: 3135,
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        cliToolId: 'codex',
        instanceId,
        resolvedBy: 'roster',
        conflict: null,
      }),
    });
  });
}

describe('shouldShowDelegateGroup', () => {
  it('stays out of the way until the query asks for it', () => {
    expect(shouldShowDelegateGroup('')).toBe(false);
    expect(shouldShowDelegateGroup('  ')).toBe(false);
    expect(shouldShowDelegateGroup('anvil')).toBe(false);

    expect(shouldShowDelegateGroup('/delegate')).toBe(true);
    expect(shouldShowDelegateGroup('/')).toBe(true);
    expect(shouldShowDelegateGroup('delegate codex')).toBe(true);
  });
});

describe('buildDelegateTargets', () => {
  it('produces one row per roster instance', () => {
    const targets = buildDelegateTargets(WORKTREES as never);
    expect(targets.map((t) => t.instance.id)).toEqual(['claude', 'codex-2']);
  });

  it('gives a rosterless worktree its primary instance rather than none', () => {
    const targets = buildDelegateTargets(
      [{ id: 'wt', name: 'wt', cliToolId: 'codex' }] as never
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].instance.id).toBe('codex');
  });
});

describe('worktreeIdFromPath', () => {
  it('reads the worktree the browser is on, and nothing else', () => {
    expect(worktreeIdFromPath('/worktrees/anvil-develop')).toBe('anvil-develop');
    expect(worktreeIdFromPath('/worktrees/anvil-develop/terminal')).toBe('anvil-develop');
    expect(worktreeIdFromPath('/sessions')).toBeNull();
    expect(worktreeIdFromPath(null)).toBeNull();
  });
});

describe('insertIntoVisibleComposer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports false when there is no composer, without throwing', () => {
    expect(insertIntoVisibleComposer('brief')).toBe(false);
  });

  it('writes through the native setter and fires the event React listens for', () => {
    const composer = mountComposer();
    const onInput = vi.fn();
    composer.addEventListener('input', onInput);

    expect(insertIntoVisibleComposer('brief')).toBe(true);
    expect(composer.value).toBe('brief');
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput.mock.calls[0][0].bubbles).toBe(true);
  });

  it('prefers the focused composer when a PC split renders several', () => {
    mountComposer('first');
    const second = mountComposer('second');
    second.focus();

    insertIntoVisibleComposer('brief');
    expect(second.value).toContain('brief');
  });

  it('reads the visible chat surface for the self test', () => {
    expect(readVisibleChatInstanceId()).toBeNull();
    const el = document.createElement('div');
    el.setAttribute('data-instance-id', 'codex-2');
    document.body.appendChild(el);
    expect(readVisibleChatInstanceId()).toBe('codex-2');
  });
});

describe('CommandPalette /delegate', () => {
  beforeEach(() => {
    currentPathname = '/';
    mockCache = {
      worktrees: WORKTREES,
      repositories: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
    showToast.mockClear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows no delegate rows on an empty query', () => {
    renderPalette();
    openPalette();
    expect(screen.queryByTestId('palette-delegate-anvil-develop-codex-2')).toBeNull();
  });

  it('lists every session once /delegate is typed', () => {
    renderPalette();
    openPalette();
    type('/delegate');

    expect(screen.getByTestId('palette-delegate-anvil-develop-claude')).toBeTruthy();
    expect(screen.getByTestId('palette-delegate-anvil-develop-codex-2')).toBeTruthy();
  });

  it('inserts the brief built from the server\'s two answers', async () => {
    answerBriefReads();
    const composer = mountComposer();

    renderPalette();
    openPalette();
    type('/delegate');
    fireEvent.click(screen.getByTestId('palette-delegate-anvil-develop-codex-2'));

    await waitFor(() => expect(composer.value).not.toBe(''));
    // The CM_PORT prefix comes from /cli-reference — the browser cannot know it.
    expect(composer.value).toContain(
      'CM_PORT=3135 commandmate ask anvil-develop --instance codex-2'
    );
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('refuses the session on screen', async () => {
    answerBriefReads();
    const composer = mountComposer();
    currentPathname = '/worktrees/anvil-develop';
    const surface = document.createElement('div');
    surface.setAttribute('data-instance-id', 'codex-2');
    document.body.appendChild(surface);

    renderPalette();
    openPalette();
    type('/delegate');
    fireEvent.click(screen.getByTestId('palette-delegate-anvil-develop-codex-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info'));
    expect(composer.value).toBe('');
  });

  it('still delegates to the same instance id on a DIFFERENT worktree', async () => {
    answerBriefReads();
    const composer = mountComposer();
    // Same instance id showing, but the row belongs to another worktree — not
    // self, and refusing it would make cross-worktree delegation impossible for
    // every roster that names its rows the same way (which most do).
    currentPathname = '/worktrees/other-main';
    const surface = document.createElement('div');
    surface.setAttribute('data-instance-id', 'codex-2');
    document.body.appendChild(surface);

    renderPalette();
    openPalette();
    type('/delegate');
    fireEvent.click(screen.getByTestId('palette-delegate-anvil-develop-codex-2'));

    await waitFor(() => expect(composer.value).not.toBe(''));
  });

  it('says so, and inserts nothing, when no composer is on screen', async () => {
    answerBriefReads();

    renderPalette();
    openPalette();
    type('/delegate');
    fireEvent.click(screen.getByTestId('palette-delegate-anvil-develop-codex-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });
});
