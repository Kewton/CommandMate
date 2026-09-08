/**
 * IME composition guard on Enter-to-commit inputs (Issue #2428)
 *
 * Japanese (and any IME) input uses Enter to CONFIRM the conversion candidate.
 * A handler that acts on every `key === 'Enter'` therefore fires mid-conversion
 * and commits the still-unconverted reading — saving 「れびゅーたんとう」 instead
 * of 「レビュー担当」, creating a file named by its reading, or running a search
 * for the wrong string.
 *
 * Every commit path below must ignore the composition Enter and still act on the
 * next, real Enter. `TodoPane` already guarded this way; these are the seven
 * sites that did not.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';
import { FileSearchBar } from '@/components/worktree/FileSearchBar';
import { MemoSearchBar } from '@/components/worktree/MemoSearchBar';
import { LogViewer } from '@/components/worktree/LogViewer';
import { FileViewer } from '@/components/worktree/FileViewer';
import { ToastProvider } from '@/components/common/Toast';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      ...actual.worktreeApi,
      getLogs: vi.fn(),
      getLogFile: vi.fn(),
    },
  };
});

import { worktreeApi } from '@/lib/api-client';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeAll(() => installRadixJsdomPolyfills());

// ---------------------------------------------------------------------------
// IME gestures
//
// The distinguishing bit is `isComposing` on the NATIVE keydown: the browser
// sets it while an IME candidate window is open, and React exposes it verbatim
// as `e.nativeEvent.isComposing`. jsdom honours it from the event init.
// ---------------------------------------------------------------------------

/** Open a composition and type the provisional (unconverted) reading. */
function composeInto(input: HTMLElement, provisional: string): void {
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: provisional } });
}

/** The Enter that only CONFIRMS the IME candidate — must not commit. */
function pressCompositionEnter(input: HTMLElement): void {
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
}

/** End the composition, leaving `converted` in the field. */
function endComposition(input: HTMLElement, converted: string): void {
  fireEvent.compositionEnd(input, { data: converted });
  fireEvent.change(input, { target: { value: converted } });
}

/** A real Enter, outside any composition — must commit. */
function pressEnter(input: HTMLElement, init: Record<string, unknown> = {}): void {
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false, ...init });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. AgentInstancesPane — the alias input (persists; highest severity)
// ===========================================================================

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const paneProps = {
  worktreeId: 'w-1',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

/** Roster traffic only — `/api/relays?…` is issued unconditionally on mount. */
function rosterCalls(): Array<[string, RequestInit | undefined]> {
  return mockFetch.mock.calls
    .map((call) => [String(call[0]), call[1] as RequestInit | undefined] as const)
    .filter(([url]) => !url.startsWith('/api/relays'))
    .map(([url, init]) => [url, init] as [string, RequestInit | undefined]);
}

describe('AgentInstancesPane alias input (Issue #2428)', () => {
  function renderPane(): HTMLInputElement {
    render(<AgentInstancesPane {...paneProps} instances={[primary('claude', 0, 'Claude')]} />);
    const input = screen.getByTestId('agent-instance-alias-claude') as HTMLInputElement;
    // Enter commits by blurring; a blur() on an unfocused element is a no-op in
    // jsdom, so the field must really hold focus for this to prove anything.
    input.focus();
    expect(document.activeElement).toBe(input);
    return input;
  }

  it('saves 「レビュー担当」, not the reading, when Enter confirms the conversion first', async () => {
    const input = renderPane();

    composeInto(input, 'れびゅーたんとう');
    pressCompositionEnter(input);

    // Still composing: no blur, so nothing was persisted.
    expect(document.activeElement).toBe(input);
    expect(rosterCalls()).toEqual([]);

    endComposition(input, 'レビュー担当');
    pressEnter(input);

    await waitFor(() => expect(rosterCalls()).toHaveLength(1));
    const body = JSON.parse(rosterCalls()[0][1]!.body as string) as {
      agentInstances: AgentInstance[];
    };
    expect(body.agentInstances.find((i) => i.id === 'claude')?.alias).toBe('レビュー担当');
  });

  it('still commits an ASCII alias on the first Enter (no regression)', async () => {
    const input = renderPane();

    fireEvent.change(input, { target: { value: 'Reviewer' } });
    pressEnter(input);

    await waitFor(() => expect(rosterCalls()).toHaveLength(1));
    const body = JSON.parse(rosterCalls()[0][1]!.body as string) as {
      agentInstances: AgentInstance[];
    };
    expect(body.agentInstances.find((i) => i.id === 'claude')?.alias).toBe('Reviewer');
  });
});

// ===========================================================================
// 2. NewFileDialog — the file name (creates a file; highest severity)
// ===========================================================================

describe('NewFileDialog file name (Issue #2428)', () => {
  function renderDialog(onConfirm: (name: string) => void): HTMLInputElement {
    render(
      <NewFileDialog isOpen parentPath="docs" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    return screen.getByTestId('new-file-name-input') as HTMLInputElement;
  }

  it('does not create the file on the Enter that confirms the conversion', () => {
    const onConfirm = vi.fn();
    const input = renderDialog(onConfirm);

    composeInto(input, 'せっけいめも');
    pressCompositionEnter(input);
    expect(onConfirm).not.toHaveBeenCalled();

    endComposition(input, '設計メモ');
    pressEnter(input);
    expect(onConfirm).toHaveBeenCalledWith('設計メモ.md');
  });

  it('still creates the file on the first Enter for ASCII input (no regression)', () => {
    const onConfirm = vi.fn();
    const input = renderDialog(onConfirm);

    fireEvent.change(input, { target: { value: 'design-note' } });
    pressEnter(input);
    expect(onConfirm).toHaveBeenCalledWith('design-note.md');
  });
});

// ===========================================================================
// 3. FileSearchBar — Enter runs the search
// ===========================================================================

describe('FileSearchBar (Issue #2428)', () => {
  function renderBar(overrides: Partial<React.ComponentProps<typeof FileSearchBar>> = {}) {
    const onNextMatch = vi.fn();
    const onPrevMatch = vi.fn();
    render(
      <FileSearchBar
        inputRef={React.createRef<HTMLInputElement>() as React.RefObject<HTMLInputElement>}
        searchQuery=""
        onQueryChange={vi.fn()}
        matchCount={3}
        currentIdx={0}
        onNextMatch={onNextMatch}
        onPrevMatch={onPrevMatch}
        onClose={vi.fn()}
        {...overrides}
      />,
    );
    return { input: screen.getByRole('textbox'), onNextMatch, onPrevMatch };
  }

  it('does not advance the match on the Enter that confirms the conversion', () => {
    const { input, onNextMatch } = renderBar();

    composeInto(input, 'けんさく');
    pressCompositionEnter(input);
    expect(onNextMatch).not.toHaveBeenCalled();

    endComposition(input, '検索');
    pressEnter(input);
    expect(onNextMatch).toHaveBeenCalledTimes(1);
  });

  it('still honours Shift+Enter for the previous match (no regression)', () => {
    const { input, onPrevMatch } = renderBar();

    pressEnter(input, { shiftKey: true });
    expect(onPrevMatch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4. MemoSearchBar — Enter runs the search
// ===========================================================================

describe('MemoSearchBar (Issue #2428)', () => {
  function renderBar() {
    const onNext = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoSearchBar
        query=""
        onQueryChange={vi.fn()}
        matchCount={2}
        currentIndex={0}
        onNext={onNext}
        onPrev={vi.fn()}
        onClose={onClose}
        onCompositionStart={vi.fn()}
        onCompositionEnd={vi.fn()}
      />,
    );
    return { input: screen.getByRole('textbox'), onNext, onClose };
  }

  it('does not advance the match on the Enter that confirms the conversion', () => {
    const { input, onNext } = renderBar();

    composeInto(input, 'めも');
    pressCompositionEnter(input);
    expect(onNext).not.toHaveBeenCalled();

    endComposition(input, 'メモ');
    pressEnter(input);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('still closes on Escape (no regression)', () => {
    const { input, onClose } = renderBar();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 5. LogViewer — Enter navigates matches
// ===========================================================================

describe('LogViewer search (Issue #2428)', () => {
  // The fixture carries BOTH the reading (えらー) and the converted word (エラー)
  // so the match list is non-empty DURING composition too. Otherwise "the counter
  // did not move" would be trivially true — there would be nothing to move.
  async function renderViewer(): Promise<HTMLInputElement> {
    vi.mocked(worktreeApi.getLogs).mockResolvedValue(['claude.log']);
    vi.mocked(worktreeApi.getLogFile).mockResolvedValue({
      content: 'えらー エラー 1\nえらー エラー 2\nえらー エラー 3\n',
    } as Awaited<ReturnType<typeof worktreeApi.getLogFile>>);

    render(
      <ToastProvider>
        <LogViewer worktreeId="w-1" />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'claude.log' }));
    return (await screen.findByPlaceholderText(
      'worktree.logViewer.searchPlaceholder',
    )) as HTMLInputElement;
  }

  it('does not advance the match on the Enter that confirms the conversion', async () => {
    const input = await renderViewer();

    composeInto(input, 'えらー');
    await screen.findByText('1 / 3');
    pressCompositionEnter(input);
    expect(screen.getByText('1 / 3')).toBeInTheDocument();

    endComposition(input, 'エラー');
    await screen.findByText('1 / 3');
    pressEnter(input);
    await screen.findByText('2 / 3');
  });
});

// ===========================================================================
// 6. FileViewer — its own (inlined) search bar
// ===========================================================================

describe('FileViewer search (Issue #2428)', () => {
  async function openSearch(): Promise<HTMLInputElement> {
    // Same reasoning as LogViewer: every line holds the reading AND the converted
    // word, so a match list exists while the IME is still composing.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'src/a.ts',
        content: 'あるふぁ alpha 1\nあるふぁ alpha 2\nあるふぁ alpha 3\n',
        extension: 'ts',
        worktreePath: '/wt',
      }),
    }) as unknown as typeof fetch;

    render(
      <FileViewer isOpen onClose={vi.fn()} worktreeId="w-1" filePath="src/a.ts" />,
    );
    fireEvent.click(await screen.findByLabelText('worktree.actions.searchInFile'));
    return (await screen.findByPlaceholderText(
      'worktree.fileSearch.placeholder',
    )) as HTMLInputElement;
  }

  it('does not advance the match on the Enter that confirms the conversion', async () => {
    const input = await openSearch();

    // The scan is debounced (300ms) and needs >= 2 chars, so wait for the count.
    composeInto(input, 'あるふぁ');
    await screen.findByText('1/3', undefined, { timeout: 2000 });

    pressCompositionEnter(input);
    expect(screen.getByText('1/3')).toBeInTheDocument();

    endComposition(input, 'alpha');
    await screen.findByText('1/3', undefined, { timeout: 2000 });
    pressEnter(input);
    await screen.findByText('2/3');
  });
});
