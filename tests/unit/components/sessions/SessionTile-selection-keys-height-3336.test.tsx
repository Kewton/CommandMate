/**
 * Issue #3336 — the selection-list row fits in the tile body with History
 * stacked and the composer grown to its bound.
 *
 * The first cut put the row (3rem floor) under the terminal without telling
 * the body: the two #2510 floors (8.5rem terminal + 6.5rem History) already add
 * up to the body's 15rem floor, and the composer's bound (#2598) let the
 * composer take the body down to exactly that. With the row drawn, the stack
 * wanted 18rem of a 15rem body and `overflow-hidden` cut History's bottom off.
 *
 * The fix grows the floor by the row's 3rem while the row is drawn
 * (`sessionTileBodyFloor`), and the composer's bound is measured against it.
 * jsdom has no layout, so:
 *
 *  - the arithmetic is checked on `measureComposerMaxHeight` itself — the
 *    function the tile's hook runs — over a column whose rects are the tile's
 *    measured sizes (#2598: 560px tile, 55px header, composer at its bound);
 *  - the wiring is checked on a real tile with the REAL composer
 *    (`MessageInput` is not mocked): the body is drawn with the floor, and the
 *    hook is handed the same floor in px.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

const { useTerminalPanePollingMock, useSplitMessagesMock, composerFloorCalls } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  composerFloorCalls: [] as number[],
}));

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

// The real hook, recording the floor it is handed.
vi.mock('@/hooks/useComposerHeight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useComposerHeight')>();
  return {
    ...actual,
    useComposerMaxHeight: (...args: Parameters<typeof actual.useComposerMaxHeight>) => {
      composerFloorCalls.push(args[2]);
      return actual.useComposerMaxHeight(...args);
    },
  };
});

import {
  SessionTile,
  SESSION_TILE_BODY_FLOOR_CLASS,
  SESSION_TILE_BODY_FLOOR_PX,
  SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_CLASS,
  SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_PX,
  SESSION_TILE_HISTORY_ROW_CLASS,
  SESSION_TILE_SELECTION_KEYS_ROW_CLASS,
  SESSION_TILE_TERMINAL_ROW_CLASS,
  sessionTileBodyFloor,
} from '@/components/sessions/SessionTile';
import { measureComposerMaxHeight } from '@/hooks/useComposerHeight';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

const CODEX_MODEL = fs.readFileSync(
  path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254/codex-model-0-151-0.txt'),
  'utf-8',
);

/** `min-h-[Nrem]` of a class, in px at the root's 16px. */
function floorPx(cls: string): number {
  const rem = /min-h-\[(\d+(?:\.\d+)?)rem\]/.exec(cls)?.[1];
  if (rem === undefined) throw new Error(`no min-h in ${cls}`);
  return Number(rem) * 16;
}

/** The stack's floors with the row drawn and History stacked. */
const STACK_FLOOR_PX =
  floorPx(SESSION_TILE_TERMINAL_ROW_CLASS) +
  floorPx(SESSION_TILE_SELECTION_KEYS_ROW_CLASS) +
  floorPx(SESSION_TILE_HISTORY_ROW_CLASS);

// ---------------------------------------------------------------------------
// The arithmetic, on the function the tile's hook runs
// ---------------------------------------------------------------------------

/** #2598's measured tile: 560px, a 55px header, the composer 101px plus its textarea. */
const TILE_PX = 560;
const HEADER_PX = 55;
const COMPOSER_CHROME_PX = 101;

function rect(el: HTMLElement, height: number): void {
  el.getBoundingClientRect = () => ({ height, width: 0, top: 0, left: 0, bottom: height, right: 0, x: 0, y: 0, toJSON: () => ({}) });
}

/**
 * Body height once the composer's textarea is grown to the bound the hook
 * measures for `floor`, starting from a textarea at #2598's 164px.
 */
function bodyAtComposerBound(floor: number): number {
  const column = document.createElement('section');
  const header = document.createElement('header');
  const body = document.createElement('div');
  const composer = document.createElement('div');
  const textarea = document.createElement('textarea');
  composer.appendChild(textarea);
  column.append(header, body, composer);
  document.body.appendChild(column);
  const textareaPx = 164;
  rect(column, TILE_PX);
  rect(header, HEADER_PX);
  rect(textarea, textareaPx);
  rect(composer, COMPOSER_CHROME_PX + textareaPx);
  const bound = measureComposerMaxHeight(body, textarea, floor);
  column.remove();
  if (bound === null) throw new Error('unmeasured');
  return TILE_PX - HEADER_PX - (COMPOSER_CHROME_PX + bound);
}

describe('[#3336] the body floor makes room for the selection-list row', () => {
  it('is the class and px pair, 3rem taller while the row is drawn', () => {
    expect(sessionTileBodyFloor(false)).toEqual({
      className: SESSION_TILE_BODY_FLOOR_CLASS,
      px: SESSION_TILE_BODY_FLOOR_PX,
    });
    expect(sessionTileBodyFloor(true)).toEqual({
      className: SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_CLASS,
      px: SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_PX,
    });
    expect(floorPx(SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_CLASS)).toBe(
      SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_PX,
    );
  });

  it('holds terminal + row + History whole', () => {
    expect(STACK_FLOOR_PX).toBeLessThanOrEqual(SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_PX);
  });

  it('with the composer at its bound, the body still holds the whole stack', () => {
    const body = bodyAtComposerBound(sessionTileBodyFloor(true).px);
    expect(body).toBeGreaterThanOrEqual(STACK_FLOOR_PX);
  });

  it('positive control: the old 15rem floor left History cut off', () => {
    const body = bodyAtComposerBound(SESSION_TILE_BODY_FLOOR_PX);
    expect(body).toBeLessThan(STACK_FLOOR_PX);
  });
});

// ---------------------------------------------------------------------------
// The wiring, on a real tile with the real composer
// ---------------------------------------------------------------------------

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['codex'],
  } as Worktree;
}

function mockPane(isSelectionListActive: boolean) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: CODEX_MODEL,
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      agentMode: 'unknown',
      startingSince: null,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderTerminalTile() {
  render(<SessionTile worktree={worktree()} enabled />);
  act(() => {
    fireEvent.click(screen.getByTestId('session-tile-surface-terminal-wt-1'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  composerFloorCalls.length = 0;
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe('[#3336] a real tile, real composer: History stacked and a selection list open', () => {
  it('draws the row, History and the composer, with the taller floor on the body and the hook', () => {
    mockPane(true);
    renderTerminalTile();

    const stack = screen.getByTestId('session-tile-terminal-stack-wt-1');
    const keys = screen.getByTestId('session-tile-selection-keys-wt-1');
    const history = screen.getByTestId('session-tile-history-wt-1');
    expect(stack).toContainElement(keys);
    expect(stack).toContainElement(history);
    expect(keys.className).toContain(SESSION_TILE_SELECTION_KEYS_ROW_CLASS);
    // The real composer, with its textarea — the element the bound is measured from.
    expect(
      within(screen.getByTestId('session-tile-composer-wt-1')).getByRole('textbox'),
    ).toBeInTheDocument();

    expect(screen.getByTestId('session-tile-body-wt-1').className).toContain(
      SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_CLASS,
    );
    expect(composerFloorCalls.at(-1)).toBe(SESSION_TILE_BODY_FLOOR_WITH_SELECTION_KEYS_PX);
  });

  it('negative control: no selection list keeps the #2512 floor', () => {
    mockPane(false);
    renderTerminalTile();

    expect(screen.queryByTestId('session-tile-selection-keys-wt-1')).toBeNull();
    expect(screen.getByTestId('session-tile-body-wt-1').className).toContain(SESSION_TILE_BODY_FLOOR_CLASS);
    expect(composerFloorCalls.at(-1)).toBe(SESSION_TILE_BODY_FLOOR_PX);
  });

  it('negative control: the chat surface keeps the #2512 floor (the card is inside the chat body)', () => {
    mockPane(true);
    render(<SessionTile worktree={worktree()} enabled />);

    expect(screen.getByTestId('session-tile-body-wt-1').className).toContain(SESSION_TILE_BODY_FLOOR_CLASS);
    expect(composerFloorCalls.at(-1)).toBe(SESSION_TILE_BODY_FLOOR_PX);
  });
});
