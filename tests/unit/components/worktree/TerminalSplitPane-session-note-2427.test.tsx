/**
 * The session note in the PC split header (Issue #2427).
 *
 * Six properties, in the order the Issue's acceptance list gives them:
 *
 *  1. **Empty means nothing.** No note in the list cache puts NO extra element
 *     in the header — the row already carries four controls, and the entry point
 *     for a first note is a row in the session-title menu that was going to be
 *     opened anyway.
 *  2. **Set, edit, clear.** The chip renders the memo and its time, clicking it
 *     opens the editor seeded with the current text, Enter writes through
 *     `PUT /api/worktrees/:id/instances/notes`, and an emptied field clears it.
 *  3. **The IME guard.** The Enter that confirms a conversion candidate is the
 *     same key event as the Enter that saves. Without `isComposing` the memo is
 *     written as unconverted kana, which is the Issue's eighth condition.
 *  4. **The 100-character bound.** The input's `maxLength` is pinned to the
 *     server's `MAX_SESSION_NOTE_LENGTH`, so the two cannot drift into a field
 *     that composes notes the route refuses.
 *  5. **The stamp.** `14:32` today, `9/7 14:32` before today, against a frozen
 *     clock so the assertion is a literal rather than a re-derivation.
 *  6. **Narrow means the note wins.** The model's width cap drops when a note is
 *     present. jsdom has no layout, so the class is the observable — which is
 *     why the assertion also pins that the cap is DIFFERENT from the no-note one
 *     rather than merely present.
 *
 * next-intl is mocked with the REAL `locales/en/worktree.json`, and the last
 * block pins the same keys in `ja` — a missing key ships as the literal key path
 * (`src/i18n.ts` sets no `getMessageFallback`), which for a `title` and an
 * `aria-label` is the only naming the control has.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const { cacheState } = vi.hoisted(() => ({
  /** What the app-wide worktrees cache publishes; null = no provider above. */
  cacheState: {
    value: null as null | { worktrees: unknown[]; refresh: () => Promise<void> },
  },
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cacheState.value,
  useWorktreesCacheContext: () => cacheState.value,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import {
  TerminalSplitPane,
  SESSION_NOTE_MAX_LENGTH,
  normalizeSessionNoteInput,
} from '@/components/worktree/TerminalSplitPane';
import { MAX_SESSION_NOTE_LENGTH } from '@/lib/db/agent-instances-db';
import { formatSessionNoteTimestamp } from '@/lib/date-utils';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const WORKTREE_ID = 'wt-2427';
/** The reference clock: 2026-09-08 18:00 local. */
const NOW = new Date(2026, 8, 8, 18, 0, 0);
const TODAY_1432 = new Date(2026, 8, 8, 14, 32, 0).getTime();
const YESTERDAY_1432 = new Date(2026, 8, 7, 14, 32, 0).getTime();

const refreshMock = vi.fn(() => Promise.resolve());
let fetchMock: ReturnType<typeof vi.fn>;

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

/** Publish a worktrees cache carrying (or not carrying) a note for `claude`. */
function mockCache(notes: Record<string, { text: string; updatedAt: number }> | null): void {
  cacheState.value = {
    worktrees: [{ id: WORKTREE_ID, ...(notes ? { sessionNotes: notes } : {}) }],
    refresh: refreshMock,
  };
}

/** The element under test, so a `rerender` keeps every prop identical. */
function pane(overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {}) {
  const props: React.ComponentProps<typeof TerminalSplitPane> = {
    worktreeId: WORKTREE_ID,
    splitIndex: 0,
    cliToolId: 'claude',
    instanceId: 'claude',
    instance: inst('claude'),
    availableInstances: [inst('claude'), inst('codex')],
    onInstanceChange: vi.fn(),
    onFocus: vi.fn(),
    terminal: <div data-testid="terminal-body">term</div>,
    footer: <div data-testid="footer-body">footer</div>,
    ...overrides,
  };
  return <TerminalSplitPane {...props} />;
}

function renderPane(
  overrides: Partial<React.ComponentProps<typeof TerminalSplitPane>> = {},
) {
  return render(pane(overrides));
}

/** Open the split's session-title menu (keyboard-opens the Radix trigger). */
function openSelector(): void {
  fireEvent.keyDown(screen.getByTestId('cli-selector-0'), { key: 'Enter' });
}

/** Let the queued macrotask that opens the editor from the menu run. */
async function flushMenuOpen(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
}

/** Let the in-flight PUT settle. */
async function flushSave(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TerminalSplitPane session note (Issue #2427)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    refreshMock.mockClear();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ instanceId: 'claude', note: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    mockCache(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cacheState.value = null;
  });

  // ==========================================================================
  // 1. Empty means nothing
  // ==========================================================================

  it('puts nothing extra in the header when the session has no note', () => {
    renderPane();

    expect(screen.queryByTestId('split-session-note-0')).toBeNull();
    expect(screen.queryByTestId('split-session-note-time-0')).toBeNull();
    expect(screen.queryByTestId('split-session-note-editor-0')).toBeNull();
  });

  it('renders nothing when there is no worktrees cache above it at all', () => {
    cacheState.value = null;
    renderPane();

    expect(screen.queryByTestId('split-session-note-0')).toBeNull();
    // ...and the pre-#2427 header is otherwise intact.
    expect(screen.getByTestId('cli-selector-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-search-button-0')).toBeInTheDocument();
  });

  it('offers the note in the session-title menu even when it is empty', async () => {
    renderPane();
    openSelector();

    fireEvent.click(screen.getByTestId('split-session-note-menu-item-0'));
    await flushMenuOpen();

    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('');
  });

  // ==========================================================================
  // 2. Set, edit, clear
  // ==========================================================================

  it('renders the memo and its time when the list carries one', () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane();

    const note = screen.getByTestId('split-session-note-0');
    expect(note).toHaveTextContent('DB 層の実装');
    expect(note).toHaveAttribute('title', 'Note: DB 層の実装 (updated 14:32)');
  });

  it('opens the editor seeded with the current memo when the chip is clicked', () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));

    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('DB 層の実装');
  });

  it('writes through the narrow endpoint on Enter and shows the new memo at once', async () => {
    mockCache({ claude: { text: 'old', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: 'レビュー待ち' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/instances/notes`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      instanceId: 'claude',
      text: 'レビュー待ち',
    });

    // The editor closes and the header shows the written value before the poll
    // that would confirm it — the cache is the only reader and has not heard.
    expect(screen.queryByTestId('split-session-note-editor-0')).toBeNull();
    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('レビュー待ち');
    // ...and the list is asked to re-read, which is how the other surfaces of
    // this browser catch up without waiting for their own poll.
    expect(refreshMock).toHaveBeenCalled();
  });

  it('clears the memo when the field is emptied, and the chip disappears', async () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      instanceId: 'claude',
      text: '',
    });
    expect(screen.queryByTestId('split-session-note-0')).toBeNull();
  });

  it('falls back to the stored memo when the write is refused', async () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    fireEvent.change(screen.getByTestId('split-session-note-input-0'), {
      target: { value: 'never stored' },
    });
    fireEvent.keyDown(screen.getByTestId('split-session-note-input-0'), { key: 'Enter' });
    await flushSave();

    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('DB 層の実装');
  });

  it('discards the edit on Escape without writing anything', () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: 'abandoned' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('split-session-note-editor-0')).toBeNull();
    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('DB 層の実装');
  });

  it('shows a memo another browser wrote as soon as the poll brings it', () => {
    mockCache(null);
    const { rerender } = renderPane();
    expect(screen.queryByTestId('split-session-note-0')).toBeNull();

    // The next /api/worktrees poll, as the cache publishes it.
    mockCache({ claude: { text: '別ブラウザで書いた', updatedAt: TODAY_1432 } });
    rerender(pane());

    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('別ブラウザで書いた');
  });

  it('yields to another browser that wrote in the same second as this one', async () => {
    mockCache({ claude: { text: 'old', updatedAt: TODAY_1432 } });
    const { rerender } = renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    fireEvent.change(screen.getByTestId('split-session-note-input-0'), {
      target: { value: 'mine' },
    });
    fireEvent.keyDown(screen.getByTestId('split-session-note-input-0'), { key: 'Enter' });
    await flushSave();
    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('mine');

    // The poll comes back with somebody ELSE's write — it matches neither the
    // optimistic value nor what the list held when this write started. Without
    // the second release rule the optimistic 'mine' would never settle and this
    // browser would show it forever.
    mockCache({ claude: { text: 'theirs', updatedAt: TODAY_1432 + 500 } });
    rerender(pane());

    expect(screen.getByTestId('split-session-note-0')).toHaveTextContent('theirs');
  });

  // ==========================================================================
  // 3. The IME guard
  // ==========================================================================

  it('does not save the unconverted kana when Enter confirms an IME candidate', () => {
    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: 'れびゅー' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
    // The editor stays open: the operator is mid-conversion, not done.
    expect(screen.getByTestId('split-session-note-input-0')).toBeInTheDocument();

    // The Enter that follows the conversion — no longer composing — saves.
    fireEvent.change(input, { target: { value: 'レビュー' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 4. The 100-character bound
  // ==========================================================================

  it('bounds the field at the server’s own limit', () => {
    mockCache({ claude: { text: 'x', updatedAt: TODAY_1432 } });
    renderPane();
    fireEvent.click(screen.getByTestId('split-session-note-0'));

    expect(SESSION_NOTE_MAX_LENGTH).toBe(MAX_SESSION_NOTE_LENGTH);
    expect(screen.getByTestId('split-session-note-input-0')).toHaveAttribute(
      'maxlength',
      String(MAX_SESSION_NOTE_LENGTH)
    );
  });

  it('refuses to send an over-long memo even if the field is bypassed', async () => {
    mockCache({ claude: { text: 'x', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    // `maxLength` is a DOM constraint on typing; a programmatic change is how a
    // paste-and-script, or a future refactor of the input, gets past it.
    fireEvent.change(input, { target: { value: 'a'.repeat(MAX_SESSION_NOTE_LENGTH + 1) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the whitespace-folded text, so the optimistic value can settle', async () => {
    mockCache({ claude: { text: 'x', updatedAt: TODAY_1432 } });
    renderPane();

    fireEvent.click(screen.getByTestId('split-session-note-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: '  レビュー   待ち  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).text).toBe(
      'レビュー 待ち'
    );
    expect(normalizeSessionNoteInput('  レビュー   待ち  ')).toBe('レビュー 待ち');
  });

  // ==========================================================================
  // 5. The stamp
  // ==========================================================================

  it('stamps a memo written today with the time alone', () => {
    mockCache({ claude: { text: 'today', updatedAt: TODAY_1432 } });
    renderPane();

    expect(screen.getByTestId('split-session-note-time-0')).toHaveTextContent('14:32');
  });

  it('stamps a memo written before today with the date in front of it', () => {
    mockCache({ claude: { text: 'yesterday', updatedAt: YESTERDAY_1432 } });
    renderPane();

    expect(screen.getByTestId('split-session-note-time-0')).toHaveTextContent('9/7 14:32');
  });

  it('formats the two shapes the Issue names, straight from the formatter', () => {
    expect(formatSessionNoteTimestamp(new Date(TODAY_1432), NOW)).toBe('14:32');
    expect(formatSessionNoteTimestamp(new Date(YESTERDAY_1432), NOW)).toBe('9/7 14:32');
    expect(formatSessionNoteTimestamp(new Date('nonsense'), NOW)).toBe('');
  });

  // ==========================================================================
  // 6. Narrow means the note wins
  // ==========================================================================

  it('narrows the model’s width budget when a memo is competing for the row', () => {
    mockCache(null);
    const { unmount } = renderPane({ agentModel: 'claude-opus-5' });
    const withoutNote = screen.getByTestId('split-agent-model-0').className;
    unmount();

    mockCache({ claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } });
    renderPane({ agentModel: 'claude-opus-5' });
    const withNote = screen.getByTestId('split-agent-model-0').className;

    expect(withoutNote).toContain('max-w-[10rem]');
    expect(withNote).toContain('max-w-[5rem]');
    expect(withNote).not.toBe(withoutNote);
    // ...and the model gives way faster than the memo does.
    expect(withNote).toContain('shrink-[4]');
    expect(screen.getByTestId('split-session-note-0').className).not.toContain('shrink-[4]');
  });

  // ==========================================================================
  // The dictionaries
  // ==========================================================================

  describe('locales', () => {
    const KEYS = ['menuItem', 'placeholder', 'hint', 'editLabel', 'label', 'empty'];
    const PLACEHOLDERS: Record<string, string[]> = {
      editLabel: ['{split}'],
      label: ['{note}', '{time}'],
    };

    for (const locale of ['en', 'ja']) {
      it(`declares every sessionNote key in ${locale}`, () => {
        const dict = JSON.parse(
          fs.readFileSync(
            path.resolve(__dirname, '../../../../locales', locale, 'worktree.json'),
            'utf-8'
          )
        ) as { sessionNote?: Record<string, string> };

        expect(dict.sessionNote).toBeDefined();
        for (const key of KEYS) {
          expect(typeof dict.sessionNote?.[key]).toBe('string');
          expect(dict.sessionNote?.[key]).not.toBe('');
        }
        for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
          for (const token of tokens) {
            expect(dict.sessionNote?.[key]).toContain(token);
          }
        }
      });
    }
  });
});
