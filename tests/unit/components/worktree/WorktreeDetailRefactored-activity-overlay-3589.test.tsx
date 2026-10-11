/**
 * The PC worktree screen starts with its panels closed and opens the activity
 * pane OVER the body (Issue #3589).
 *
 * Real pieces under test: `WorktreeDetailRefactored` → `WorktreeDetailDesktop`
 * → `WorktreeDesktopLayout` (+ `PaneOverlayFrame`) → `ActivityPane`, with the
 * real `useActivityBarState` / `usePanePinnedState` / `useHistoryPaneState`.
 * Stubbed: the activity bar (plain buttons with the real test ids), the
 * terminal column (a composer to press "outside" on), and the pane children
 * (a file tree whose row opens a file; an Env editor with a field and a button
 * that opens a portal dialog — the two cases the Issue names; an empty Git
 * pane).
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { openFileMock, terminalState } = vi.hoisted(() => ({
  openFileMock: vi.fn(() => 'opened'),
  /** Whether the stub terminal shows an inline PromptPanel (a CLI question). */
  terminalState: { promptShown: false },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3589',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

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
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    isCatalogStale: false,
  }),
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: openFileMock,
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/ActivityBar', () => ({
  ActivityBar: ({ active, onToggle }: { active: string | null; onToggle: (id: string) => void }) => (
    <div data-testid="activity-bar">
      {['files', 'git', 'env'].map((id) => (
        <button
          key={id}
          type="button"
          data-testid={`activity-bar-button-${id}`}
          role="tab"
          aria-selected={active === id}
          onClick={() => onToggle(id)}
        >
          {id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/components/worktree/TerminalContainer', () => ({
  TerminalContainer: () => (
    <div data-testid="terminal-column">
      <textarea data-testid="composer" />
      {terminalState.promptShown && (
        // The real PromptPanel carries both attributes while it sits inline.
        <div role="dialog" aria-modal="true" data-testid="prompt-panel">
          Proceed?
        </div>
      )}
    </div>
  ),
}));

vi.mock('@/components/worktree/FileTreeView', () => ({
  FileTreeView: ({ onFileSelect }: { onFileSelect?: (path: string) => void }) => (
    <div data-testid="file-tree-view">
      <button type="button" data-testid="tree-row" onClick={() => onFileSelect?.('src/a.ts')}>
        a.ts
      </button>
    </div>
  ),
}));

vi.mock('@/components/worktree/GitPane', () => ({
  GitPane: () => <div data-testid="git-pane" />,
}));

/**
 * Reports its draft like the real EnvManagerPane (`useReportPaneDirty`): the
 * field and "add row" make it dirty, "save" clears it.
 */
function FakeEnvPane() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  useReportPaneDirty(dirty);
  return (
    <div data-testid="env-pane">
      <input data-testid="env-value" defaultValue="" onInput={() => setDirty(true)} />
      <button type="button" data-testid="env-add-row" onClick={() => setDirty(true)}>
        add row
      </button>
      <button type="button" data-testid="env-save" onClick={() => setDirty(false)}>
        save
      </button>
      <button type="button" data-testid="env-open-dialog" onClick={() => setDialogOpen(true)}>
        open
      </button>
      {dialogOpen &&
        createPortal(
          <div role="dialog" aria-modal="true" data-testid="env-dialog">
            <button type="button" data-testid="env-dialog-close" onClick={() => setDialogOpen(false)}>
              close
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

vi.mock('@/components/worktree/EnvManagerPane', () => ({
  EnvManagerPane: () => <FakeEnvPane />,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { useReportPaneDirty } from '@/hooks/useActivityPaneOverlay';

const WORKTREE_ID = 'wt-3589';
const PIN_KEY = 'commandmate.worktree.activityPanePinned';
const ACTIVITY_KEY = `commandmate.worktree.activeActivity-${WORKTREE_ID}`;
const HISTORY_KEY = 'commandmate.worktree.historyVisible';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  openFileMock.mockClear();
  terminalState.promptShown = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3589',
          path: '/tmp/wt-3589',
          repositoryPath: '/tmp/repo',
          repositoryName: 'Repo',
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

async function renderScreen() {
  const utils = render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('terminal-column');
  return utils;
}

async function openActivity(id: string) {
  fireEvent.click(screen.getByTestId(`activity-bar-button-${id}`));
  return screen.findByTestId('activity-pane-slot');
}

describe('[#3589] the worktree screen starts with its panels closed', () => {
  it('opens a never-visited worktree with no activity pane and History hidden', async () => {
    await renderScreen();
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-tree-view')).not.toBeInTheDocument();
    // Nothing is written until the user chooses.
    expect(window.localStorage.getItem(ACTIVITY_KEY)).toBeNull();
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('still opens the activity a visited worktree stored', async () => {
    window.localStorage.setItem(ACTIVITY_KEY, 'files');
    await renderScreen();
    expect(await screen.findByTestId('file-tree-view')).toBeInTheDocument();
  });
});

describe('[#3589] the activity pane opens over the body', () => {
  it('lays an unpinned pane over the right pane instead of beside it', async () => {
    await renderScreen();
    const slot = await openActivity('files');
    expect(slot).toHaveAttribute('data-pinned', 'false');
    expect(slot.className).toMatch(/\babsolute\b/);
    // No resizer: the right pane keeps the whole row.
    expect(screen.getByTestId('desktop-layout').querySelector('[role="separator"]')).toBeNull();
    expect(screen.getByTestId('activity-pane-frame')).toHaveAttribute('data-pinned', 'false');
    expect(screen.getByTestId('activity-pane-title')).toHaveTextContent('worktree.activityBar.files');
  });

  it('closes on × and gives focus back to the icon that opened it', async () => {
    await renderScreen();
    await openActivity('git');
    fireEvent.click(screen.getByTestId('activity-pane-close'));
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('activity-bar-button-git'));
  });

  it('closes on Esc and gives focus back to the icon that opened it', async () => {
    await renderScreen();
    await openActivity('files');
    fireEvent.keyDown(screen.getByTestId('activity-bar-button-files'), { key: 'Escape' });
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('activity-bar-button-files'));
  });

  it('closes on a re-click of its icon, and switches on another icon', async () => {
    await renderScreen();
    await openActivity('files');
    fireEvent.pointerDown(screen.getByTestId('activity-bar-button-git'));
    fireEvent.click(screen.getByTestId('activity-bar-button-git'));
    expect(screen.getByTestId('activity-pane')).toHaveAttribute('data-active', 'git');
    fireEvent.pointerDown(screen.getByTestId('activity-bar-button-git'));
    fireEvent.click(screen.getByTestId('activity-bar-button-git'));
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });

  it('closes on a press outside it (the terminal composer)', async () => {
    await renderScreen();
    await openActivity('git');
    fireEvent.pointerDown(screen.getByTestId('composer'));
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });

  it('closes when a file is opened from the tree', async () => {
    await renderScreen();
    await openActivity('files');
    fireEvent.click(screen.getByTestId('tree-row'));
    expect(openFileMock).toHaveBeenCalledWith('src/a.ts');
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });

  it('does not close on an outside press while Env is being edited', async () => {
    await renderScreen();
    await openActivity('env');
    fireEvent.input(screen.getByTestId('env-value'), { target: { value: 'API_KEY=x' } });
    fireEvent.pointerDown(screen.getByTestId('composer'));
    expect(screen.getByTestId('env-pane')).toBeInTheDocument();
    // × still closes.
    fireEvent.click(screen.getByTestId('activity-pane-close'));
    expect(screen.queryByTestId('env-pane')).not.toBeInTheDocument();
  });

  it('does not close while a dialog opened from the pane is operated', async () => {
    await renderScreen();
    await openActivity('env');
    fireEvent.click(screen.getByTestId('env-open-dialog'));
    const dialogButton = await screen.findByTestId('env-dialog-close');
    fireEvent.pointerDown(dialogButton);
    fireEvent.click(dialogButton);
    expect(screen.queryByTestId('env-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('env-pane')).toBeInTheDocument();
  });
});

describe('[#3589] the pin', () => {
  it('lays a pinned pane beside the body, and the pin survives a reload', async () => {
    const first = await renderScreen();
    await openActivity('files');
    fireEvent.click(screen.getByTestId('activity-pane-pin'));
    expect(window.localStorage.getItem(PIN_KEY)).toBe('true');
    const slot = screen.getByTestId('activity-pane-slot');
    expect(slot).toHaveAttribute('data-pinned', 'true');
    expect(slot.className).not.toMatch(/\babsolute\b/);
    expect(screen.getByTestId('desktop-layout').querySelector('[role="separator"]')).not.toBeNull();
    first.unmount();

    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true'),
    );
  });

  it('keeps a pinned pane open on an outside press, Esc, and a file open', async () => {
    window.localStorage.setItem(PIN_KEY, 'true');
    await renderScreen();
    await openActivity('files');
    await waitFor(() =>
      expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true'),
    );
    fireEvent.pointerDown(screen.getByTestId('composer'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('tree-row'));
    });
    expect(openFileMock).toHaveBeenCalledWith('src/a.ts');
    expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
  });
});

describe('[#3589 review] pinning keeps the pane mounted', () => {
  it('keeps an unsaved Env edit through pin and unpin (the pane is not remounted)', async () => {
    await renderScreen();
    await openActivity('env');
    const field = screen.getByTestId('env-value') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'API_KEY=draft' } });

    fireEvent.click(screen.getByTestId('activity-pane-pin'));
    expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true');
    expect(screen.getByTestId('env-value')).toBe(field);
    expect(field.value).toBe('API_KEY=draft');

    fireEvent.click(screen.getByTestId('activity-pane-pin'));
    expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'false');
    expect(screen.getByTestId('env-value')).toBe(field);
    expect(field.value).toBe('API_KEY=draft');
  });
});

describe('[#3589 review] Env edits made with buttons are unsaved edits', () => {
  it('does not close on an outside press after a row was added with a button', async () => {
    await renderScreen();
    await openActivity('env');
    fireEvent.click(screen.getByTestId('env-add-row'));
    fireEvent.pointerDown(screen.getByTestId('composer'));
    expect(screen.getByTestId('env-pane')).toBeInTheDocument();
  });

  it('closes on an outside press once the edit is saved (negative control)', async () => {
    await renderScreen();
    await openActivity('env');
    fireEvent.input(screen.getByTestId('env-value'), { target: { value: 'A=1' } });
    fireEvent.click(screen.getByTestId('env-add-row'));
    fireEvent.click(screen.getByTestId('env-save'));
    fireEvent.pointerDown(screen.getByTestId('composer'));
    expect(screen.queryByTestId('env-pane')).not.toBeInTheDocument();
  });
});

describe('[#3589 review] a question in the terminal does not hold the pane open', () => {
  it('closes Files on an outside press while the PromptPanel is shown', async () => {
    terminalState.promptShown = true;
    await renderScreen();
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    await openActivity('files');
    fireEvent.pointerDown(screen.getByTestId('composer'));
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });

  it('closes Files on Esc while the PromptPanel is shown', async () => {
    terminalState.promptShown = true;
    await renderScreen();
    await openActivity('files');
    fireEvent.keyDown(screen.getByTestId('tree-row'), { key: 'Escape' });
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });
});

describe('[#3589 review] Esc closes a pinned pane too', () => {
  async function openPinnedFiles() {
    window.localStorage.setItem(PIN_KEY, 'true');
    await renderScreen();
    await openActivity('files');
    await waitFor(() =>
      expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true'),
    );
  }

  it('closes on Esc pressed in the pane and gives focus back to the icon', async () => {
    await openPinnedFiles();
    fireEvent.keyDown(screen.getByTestId('tree-row'), { key: 'Escape' });
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('activity-bar-button-files'));
  });

  it('closes on Esc pressed on its icon', async () => {
    await openPinnedFiles();
    fireEvent.keyDown(screen.getByTestId('activity-bar-button-files'), { key: 'Escape' });
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
  });

  it('leaves an Esc typed into the terminal composer alone', async () => {
    await openPinnedFiles();
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
    expect(screen.getByTestId('activity-pane-slot')).toBeInTheDocument();
  });
});

describe('[#3589 review] opening a file from the keyboard keeps the focus', () => {
  it('moves focus to the Files icon when a focused row opens a file and the pane closes', async () => {
    await renderScreen();
    await openActivity('files');
    const row = screen.getByTestId('tree-row');
    row.focus();
    // Enter / Space on a focused row: the activation lands as a click on it.
    fireEvent.click(row);
    expect(screen.queryByTestId('activity-pane-slot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('activity-bar-button-files'));
  });

  it('leaves focus on the row when the pane is pinned and stays open (negative control)', async () => {
    window.localStorage.setItem(PIN_KEY, 'true');
    await renderScreen();
    await openActivity('files');
    await waitFor(() =>
      expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true'),
    );
    const row = screen.getByTestId('tree-row');
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement).toBe(row);
  });
});
