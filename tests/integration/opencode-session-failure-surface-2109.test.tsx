/**
 * The composer actually shows the reason a 409 gives (Issue #2109).
 *
 * The unit suite for `OpencodeSessionControls` stubs `next-intl` to echo the
 * key, so it pins *which* string the component asks for and nothing about what
 * the operator reads. Two things it therefore cannot see, and this file does:
 *
 *  1. **`MessageInput` actually hands its toast surface down.** The control's
 *     `showToast` is optional; the composer passing it is a separate edit that
 *     a refactor of either file can drop, and the failure mode is silent — the
 *     control quietly falls back to the inline chip, which the unit suite is
 *     equally happy with.
 *  2. **Both dictionaries resolve to a human sentence.** The `next-intl` mock
 *     below reads `locales/<locale>/worktree.json` off disk and *throws* on an
 *     unknown key, so a missing entry fails here rather than putting
 *     `errorNoPort` on screen.
 *
 * That mock is local rather than `@tests/helpers/real-intl` for one reason:
 * the helper treats the whole namespace as the file name, so the control's
 * `useTranslations('worktree.opencodeSession')` sends it looking for
 * `locales/ja/worktree.opencodeSession.json`. Teaching it to split file from
 * path is the right fix and belongs to whoever owns `tests/helpers/` — it is
 * outside this Issue's change scope, so the split is done here instead.
 *
 * The refusal driven here is the Issue's own reproduction: `NO_OPENCODE_PORT`,
 * which is what the route returns for a pane whose opencode server is gone —
 * after the pane is stopped, or when it was launched with
 * `CM_AGENT_HOOKS_INJECT=0`. #2108 makes it rarer; it cannot make it impossible.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const cache = new Map<string, (key: string) => string>();

  /**
   * `useTranslations('<file>.<path>')`, resolved against the real dictionary.
   *
   * Cached per locale+namespace so `t` keeps a stable identity across renders,
   * the way `use-intl`'s own `useMemo` does — a fresh closure per render turns
   * any `[t]` dependency into a render loop that reproduces only under a mock.
   */
  const translatorFor = (loc: string, namespace: string) => {
    const cacheKey = `${loc}/${namespace}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;

    const [file, ...prefix] = namespace.split('.');
    const dict = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'locales', loc, `${file}.json`), 'utf-8')
    ) as Record<string, unknown>;

    const translate = (key: string): string => {
      const value = [...prefix, ...key.split('.')].reduce<unknown>(
        (acc, part) => (acc as Record<string, unknown>)?.[part],
        dict
      );
      if (typeof value !== 'string') {
        throw new Error(`no string at "${namespace}.${key}" in locales/${loc}/${file}.json`);
      }
      return value;
    };
    cache.set(cacheKey, translate);
    return translate;
  };

  return {
    useLocale: () => locale.current,
    useTranslations: (namespace?: string) => {
      if (!namespace) throw new Error('useTranslations() requires a namespace');
      return translatorFor(locale.current, namespace);
    },
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
  },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    cliTool: 'opencode',
    isCatalogStale: false,
  })),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }));

import { MessageInput } from '@/components/worktree/MessageInput';
import type { ShowToast } from '@/types/markdown-editor';

const WORKTREE_ID = 'wt-2109-integration';

/** What the route answers for a pane whose opencode server is not attached. */
const NO_PORT_409 = {
  ok: false,
  status: 409,
  statusText: 'Conflict',
  json: async () => ({
    error: 'No opencode server is attached to this instance',
    code: 'NO_OPENCODE_PORT',
  }),
};

/** Typed as the prop it stands in for, so a signature drift is a type error. */
let showToast: ReturnType<typeof vi.fn<ShowToast>>;

beforeEach(() => {
  locale.current = 'en';
  showToast = vi.fn<ShowToast>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/opencode/session')) return NO_PORT_409;
      // Share is off, so only the three session buttons render.
      return {
        ok: true,
        status: 200,
        statusText: '',
        json: async () => ({
          instanceId: 'opencode',
          shareMode: 'disabled',
          canShare: false,
          sessionId: null,
          lastShareUrl: null,
        }),
      };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The composer, wired the way `TerminalSplitPaneContent` wires it. */
function renderComposer(withToast: boolean) {
  return render(
    <MessageInput
      worktreeId={WORKTREE_ID}
      onMessageSent={vi.fn()}
      cliToolId="opencode"
      isSessionRunning
      {...(withToast ? { showToast } : {})}
    />
  );
}

describe('a 409 from the session route reaches the operator', () => {
  it.each([
    ['en', /No opencode server is attached to this pane/i],
    ['ja', /opencode サーバが接続されていません/],
  ])('toasts the %s sentence, not a key path', async (which, expected) => {
    locale.current = which;
    renderComposer(true);

    fireEvent.click(await screen.findByTestId('opencode-session-fork'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const [message, level] = showToast.mock.calls[0];
    expect(String(message)).toMatch(expected);
    expect(level).toBe('error');
    // The key path itself must never be what lands on screen.
    expect(String(message)).not.toContain('errorNoPort');
  });

  it('renders the sentence inline at a mount that lends no toast surface', async () => {
    // `WorktreeDetailRefactored.tsx` renders `MessageInput` without showToast;
    // a toast-only fix would leave that view as silent as it was before #2109.
    renderComposer(false);

    fireEvent.click(await screen.findByTestId('opencode-session-fork'));

    const alert = await screen.findByTestId('opencode-session-error');
    expect(alert.textContent).toMatch(/No opencode server is attached to this pane/i);
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('says nothing at all for a non-opencode composer', async () => {
    // The Issue's last acceptance criterion: no other tool changes behaviour.
    render(
      <MessageInput
        worktreeId={WORKTREE_ID}
        onMessageSent={vi.fn()}
        cliToolId="claude"
        isSessionRunning
        showToast={showToast}
      />
    );

    expect(screen.queryByTestId('opencode-session-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('opencode-session-fork')).not.toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });
});
