/**
 * The dialog card's selection-list controls (Issue #2297).
 *
 * Issue #2254 gave every selection list ONE control set — ▲▼◀▶ Enter Esc — and
 * that turned out to be wrong in three different ways at once, each of which is
 * a section below:
 *
 *  A. **claude's `/model` could only be answered destructively.** Its footer is
 *     `Enter to set as default · s to use this session only · Esc to cancel`,
 *     the card published `Enter`, and `Enter` there rewrites `model` in
 *     `~/.claude/settings.json` (Issue #1495). The card now draws the two
 *     commits as separate, LABELLED buttons.
 *  B. **A seven-option picker cost six taps on ▼.** The card now draws `1`…`N`,
 *     sized to what the frame is offering — and refuses to draw them on the two
 *     screens where a number is not a cursor move (see below).
 *  C. **opencode had no way to change models at all**, because it has no
 *     numbered `/model`: the keys are `ctrl+t` and a `ctrl+x` chord.
 *
 * ## The measurement that shaped B, and why claude is the exception
 *
 * Issue #2297's plan reads "number buttons move the highlight, then the tool's
 * own confirm key commits". A live probe on claude 2.1.260 (private tmux socket,
 * 200x1000 pane) says otherwise: pressing `4` on the `/model` overlay answered
 * `Set model to Sonnet 5 and saved as your default for new sessions` and
 * rewrote the settings file in ONE keystroke. So on that screen a number button
 * would be an unlabelled version of the exact write this Issue exists to stop,
 * and the card refuses it there — every other numbered list keeps its numbers.
 *
 * ## What is asserted, and what would be vacuous
 *
 * Every claim below is anchored on a FRAME, because that is what the
 * implementation reads: `readSelectionListShape()` takes the pane, never
 * `cliToolId`. A suite that asserted "claude gets the commit buttons" would pass
 * against an implementation that keyed off the tool id and then drew the `s`
 * button on claude's folder-trust dialog, where there is no `s` to press.
 *
 * `ChatTranscript` is stubbed (a layout-less DOM cannot give the real one scroll
 * metrics); everything below it is the real implementation, and `fetch` is the
 * seam every assertion about a key lands on.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import {
  ChatSurface,
  DIALOG_REPAINT_REFRESH_MS,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';
import { SESSION_SCOPE_KEY, SESSION_SCOPE_KEY_TOOL_IDS } from '@/types/terminal-keys';

// ---------------------------------------------------------------------------
// Frames — the live captures wherever one exists
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');
const capture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

/** claude 2.1.259 `/model`: five models, effort row, session-scope footer. */
const CLAUDE_MODEL = capture('claude-model-2-1-259.txt');
/** codex 0.151.0 `/model`: seven models, and the `Update available!` box above them. */
const CODEX_MODEL = capture('codex-model-0-151-0.txt');
/** claude 2.1.259 folder trust: an arrow list, no numbers, no session scope. */
const CLAUDE_TRUST = capture('claude-trust-2-1-259.txt');
/** Command Code 1.40.1 `/model`: names behind a search box. */
const COMMAND_CODE_MODEL = capture('command-code-model-1-40-1.txt');
/** opencode 1.18.27 `ctrl+x a` overlay. */
const OPENCODE_OVERLAY = capture('opencode-agent-overlay-1-18-27.txt');

/**
 * antigravity's `Switch Model`, which has no live capture in this repository.
 *
 * Written to the shape Issue #2297's table records — named rows, no numbers, no
 * session scope — because the property being pinned is "an unnumbered list gets
 * arrows and nothing else", and that property is about the FRAME. The three
 * captures above cover the numbered cases with real bytes.
 */
const ANTIGRAVITY_SWITCH_MODEL = [
  '  Switch Model',
  '',
  '❯ Gemini 3.7 Pro',
  '  Gemini 3.7 Flash',
  '  Claude Sonnet 5',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

const WORKTREE_ID = 'wt-2297';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-04T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const SELECTION_LIST: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: true,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function renderSurface(
  options: {
    frame?: string;
    cliToolId?: CLIToolType;
    instanceId?: string;
    live?: Partial<ChatSurfaceLiveState>;
    onKeysSent?: () => void;
  } = {},
) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={options.cliToolId ?? 'claude'}
      instanceId={options.instanceId}
      live={{ ...SELECTION_LIST, ...options.live }}
      onSurfaceModeChange={vi.fn()}
      frame={options.frame ?? CLAUDE_MODEL}
      onKeysSent={options.onKeysSent}
    />,
  );
}

/** The card's action row, which is the only place these controls may appear. */
function actions(): HTMLElement {
  return screen.getByTestId('chat-dialog-card-actions');
}

/** Every `keys` array POSTed to `/special-keys`, in order. */
function sentKeys(): string[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).keys);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// A. Session vs default — the write this Issue is about
// ===========================================================================

describe('[#2297] A. claude /model gets both halves of its own footer', () => {
  it('draws "this session only" and "set as default" as two separate buttons', () => {
    renderSurface();

    const commit = within(actions()).getByTestId('selection-commit-keys');
    expect(within(commit).getByTestId('selection-commit-session')).toBeInTheDocument();
    expect(within(commit).getByTestId('selection-commit-default')).toBeInTheDocument();
  });

  it('sends `s` for the session button', async () => {
    renderSurface();

    fireEvent.click(screen.getByTestId('selection-commit-session'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/special-keys`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      cliToolId: 'claude',
      keys: [SESSION_SCOPE_KEY],
    });
  });

  it('sends `Enter` for the default button', () => {
    renderSurface();

    fireEvent.click(screen.getByTestId('selection-commit-default'));

    expect(sentKeys()).toEqual([['Enter']]);
  });

  it('names the two instance-targeted requests the same way every other strip does', () => {
    // Issue #869: a non-primary instance names itself in the body.
    renderSurface({ instanceId: 'claude-2' });

    fireEvent.click(screen.getByTestId('selection-commit-session'));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      cliToolId: 'claude',
      keys: [SESSION_SCOPE_KEY],
      instanceId: 'claude-2',
    });
  });

  it('says out loud that Enter writes a default, because the key cap cannot', () => {
    // Issue #1495 is the trap: without the sentence, "Set as default" and "this
    // session only" read as two flavours of confirm.
    renderSurface();

    expect(screen.getByTestId('selection-commit-warning')).toBeInTheDocument();
  });

  it('carries the key notation in the accessible name of both buttons', () => {
    renderSurface();

    expect(screen.getByTestId('selection-commit-session')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('sessionOnlyAria'),
    );
    expect(screen.getByTestId('selection-commit-default')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('setDefaultAria'),
    );
  });

  it('is NOT drawn on a claude dialog whose footer offers no session scope', () => {
    // The frame decides, not the tool. claude's folder-trust dialog is
    // `Enter to confirm · Esc to cancel`: there is no `s` to press, and a button
    // for it would type an `s` into whatever the dialog does with letters.
    renderSurface({ frame: CLAUDE_TRUST });

    expect(within(actions()).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });

  it('is NOT drawn for a tool that does not declare `s`, even on a footer that offers it', () => {
    // Belt and braces: the route validates against the tool's own vocabulary
    // (#2046), so a button for a non-declaring tool would be a visible 400.
    // codex is not in SESSION_SCOPE_KEY_TOOL_IDS; the frame is claude's.
    expect(SESSION_SCOPE_KEY_TOOL_IDS as readonly string[]).not.toContain('codex');

    renderSurface({ cliToolId: 'codex', frame: CLAUDE_MODEL });

    expect(within(actions()).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// B. Number keys, and the two screens that must not have them
// ===========================================================================

describe('[#2297] B. a numbered list gets exactly as many numbers as it offers', () => {
  it('draws seven buttons for codex’s seven-model picker and sends `1`…`7`', () => {
    renderSurface({ cliToolId: 'codex', frame: CODEX_MODEL });

    const numbers = within(actions()).getByTestId('selection-number-keys');
    expect(numbers).toHaveAttribute('data-option-count', '7');

    for (const n of ['1', '2', '3', '4', '5', '6', '7']) {
      fireEvent.click(within(numbers).getByTestId(`selection-number-key-${n}`));
    }
    expect(sentKeys()).toEqual([['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7']]);
  });

  it('draws no eighth button — a key that does nothing is worse than no key', () => {
    renderSurface({ cliToolId: 'codex', frame: CODEX_MODEL });

    const numbers = screen.getByTestId('selection-number-keys');
    expect(within(numbers).queryByTestId('selection-number-key-8')).not.toBeInTheDocument();
    expect(within(numbers).queryByTestId('selection-number-key-9')).not.toBeInTheDocument();
  });

  it('counts the picker and not codex’s `Update available!` box above it', () => {
    // The capture is a real launch frame and carries both. Seven is the picker;
    // the box is the trap Issue #2297 names (`npm install -g @openai/codex`).
    expect(screen.queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    renderSurface({ cliToolId: 'codex', frame: CODEX_MODEL });

    expect(screen.getByTestId('selection-number-keys')).toHaveAttribute('data-option-count', '7');
  });

  it('draws NO numbers on claude’s /model, where a number key writes the default', () => {
    // MEASURED on 2.1.260: `4` answered "Set model to Sonnet 5 and saved as your
    // default for new sessions". The mutation guard runs the other way too — an
    // implementation that always drew `optionCount` buttons would light five here.
    renderSurface();

    expect(within(actions()).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(actions()).getByTestId('selection-commit-keys')).toBeInTheDocument();
  });

  it('draws no numbers on a picker with a search box (Command Code /model)', () => {
    // A `4` there is a character of a query, not the fourth model.
    renderSurface({ cliToolId: 'command-code', frame: COMMAND_CODE_MODEL });

    expect(within(actions()).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
  });

  it('draws no numbers for an unnumbered list — antigravity keeps arrows + Enter', () => {
    // Issue #2297: "antigravity は現状で動くので変更しない".
    renderSurface({ cliToolId: 'antigravity', frame: ANTIGRAVITY_SWITCH_MODEL });

    const row = actions();
    expect(within(row).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
    // …and what it DOES have is unchanged.
    expect(within(row).getByLabelText('Up')).toBeInTheDocument();
    expect(within(row).getByLabelText('Enter')).toBeInTheDocument();
    expect(within(row).getByLabelText('Escape')).toBeInTheDocument();
  });

  it('draws no numbers when the caller passes no frame at all', () => {
    // A caller that has not been updated degrades to the pre-#2297 surface
    // rather than to a row of guesses.
    renderSurface({ cliToolId: 'codex', frame: '' });

    expect(screen.queryByTestId('selection-number-keys')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// C. opencode's model chords
// ===========================================================================

describe('[#2297] C. opencode gets the keys that actually change its model', () => {
  it('draws the variant / models / commands keys on an opencode selection list', () => {
    renderSurface({ cliToolId: 'opencode', frame: OPENCODE_OVERLAY });

    const strip = within(actions()).getByTestId('opencode-model-keys');
    expect(within(strip).getByTestId('opencode-model-key-variant')).toBeInTheDocument();
    expect(within(strip).getByTestId('opencode-model-key-models')).toBeInTheDocument();
    expect(within(strip).getByTestId('opencode-model-key-commands')).toBeInTheDocument();
  });

  it('sends `C-t` as one key for the variant cycle', () => {
    renderSurface({ cliToolId: 'opencode', frame: OPENCODE_OVERLAY });

    fireEvent.click(screen.getByTestId('opencode-model-key-variant'));

    expect(sentKeys()).toEqual([['C-t']]);
  });

  it('sends the model picker as ONE request carrying the leader and the letter', () => {
    // The chord discipline #2046 measured: two entries in one request, which
    // `sendSpecialKeys()` delivers 100 ms apart, inside opencode's 2000 ms
    // `leader_timeout`. Two separate requests would race that window.
    renderSurface({ cliToolId: 'opencode', frame: OPENCODE_OVERLAY });

    fireEvent.click(screen.getByTestId('opencode-model-key-models'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentKeys()).toEqual([['C-x', 'm']]);
  });

  it('never offers `ctrl+x b`, the chord #2046 measured and refused', () => {
    renderSurface({ cliToolId: 'opencode', frame: OPENCODE_OVERLAY });

    const strip = screen.getByTestId('opencode-model-keys');
    expect(within(strip).queryByTestId('opencode-model-key-sidebar')).not.toBeInTheDocument();
    for (const keys of sentKeys()) expect(keys).not.toContain('b');
  });

  it.each<[CLIToolType, string]>([
    ['claude', CLAUDE_MODEL],
    ['codex', CODEX_MODEL],
    ['command-code', COMMAND_CODE_MODEL],
    ['antigravity', ANTIGRAVITY_SWITCH_MODEL],
  ])('is absent for %s', (cliToolId, frame) => {
    renderSurface({ cliToolId, frame });

    expect(screen.queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// The arrow pad, and where none of this is allowed to appear
// ===========================================================================

describe('[#2297] the arrow pad stays, and the new strips stay out of the other states', () => {
  it.each<[string, string]>([
    ['claude', CLAUDE_MODEL],
    ['codex', CODEX_MODEL],
    ['opencode', OPENCODE_OVERLAY],
  ])('keeps ▲▼ Enter Esc under %s’s dialog', (cliToolId, frame) => {
    renderSurface({ cliToolId: cliToolId as CLIToolType, frame });

    const row = actions();
    expect(within(row).getByLabelText('Up')).toBeInTheDocument();
    expect(within(row).getByLabelText('Down')).toBeInTheDocument();
    expect(within(row).getByLabelText('Enter')).toBeInTheDocument();
    expect(within(row).getByLabelText('Escape')).toBeInTheDocument();
    // Still not a pager: `showPagerKeys` is off for a selection list.
    expect(within(row).queryByLabelText('Page Up')).not.toBeInTheDocument();
  });

  it.each([
    ['pager', { isSelectionListActive: false, isPagerActive: true }],
    ['unclassified', { isSelectionListActive: false, isUnclassifiedActive: true }],
  ])('draws none of the selection strips for a %s frame', (_reason, live) => {
    // The three states share a card and must not share its controls: #2297's
    // scope is the selection list, and the other two are explicitly out of it.
    renderSurface({ live });

    const row = actions();
    expect(within(row).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
  });

  it('draws nothing at all when no dialog is up', () => {
    renderSurface({
      live: { isSelectionListActive: false, isRunning: false, sessionStatus: 'ready' },
    });

    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// D. Seeing the key land
// ===========================================================================

describe('[#2297] D. the card re-reads the pane after the TUI has repainted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes twice for one press — once promptly, once past the repaint', async () => {
    // The bug: the route drops the shared capture-cache entry BEFORE the TUI has
    // repainted, so whichever reader captures first (this refresh, the sidebar
    // probe, the global poller) stores the pre-repaint frame and CACHE_TTL_MS
    // serves it for five seconds. One refresh is not enough on its own.
    const onKeysSent = vi.fn();
    renderSurface({ onKeysSent });

    fireEvent.click(screen.getByTestId('selection-commit-session'));
    await act(async () => {
      await Promise.resolve();
    });

    // `useSpecialKeys` fires its own NAV_KEY_REFRESH_DELAY_MS tick first.
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(onKeysSent).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(DIALOG_REPAINT_REFRESH_MS);
    });
    expect(onKeysSent).toHaveBeenCalledTimes(2);
  });

  it('lands the second refresh inside the Issue’s one-second budget', () => {
    expect(DIALOG_REPAINT_REFRESH_MS).toBeLessThan(1000);
    // …and after the server's own second cache drop (REPAINT_INVALIDATE_DELAY_MS
    // = 250 ms), or it would re-read through the stale entry it is trying to skip.
    expect(DIALOG_REPAINT_REFRESH_MS).toBeGreaterThan(250);
  });

  it('does not fire the delayed refresh after the card unmounts', async () => {
    // Answering the dialog is what unmounts the card that answered it. A timer
    // that outlives the tree writes into a torn-down jsdom window and is charged
    // to whichever unrelated test happens to be running (Issue #2176's lesson).
    const onKeysSent = vi.fn();
    const { unmount } = renderSurface({ onKeysSent });

    fireEvent.click(screen.getByTestId('selection-commit-session'));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(150);
    });
    expect(onKeysSent).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(DIALOG_REPAINT_REFRESH_MS * 3);
    });

    expect(onKeysSent).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// i18n
// ===========================================================================

describe('[#2297] every new label exists in both dictionaries', () => {
  const KEYS = [
    'numbersToolbarLabel',
    'numbersCaption',
    'commitToolbarLabel',
    'sessionOnly',
    'sessionOnlyAria',
    'setDefault',
    'setDefaultAria',
    'defaultWarning',
    'opencodeToolbarLabel',
    'opencodeCaption',
  ];

  const dictionary = (locale: string): Record<string, unknown> =>
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, `../../../../locales/${locale}/worktree.json`),
        'utf-8',
      ),
    );

  it.each(['en', 'ja'])('%s carries worktree.selectionKeys', (locale) => {
    const block = dictionary(locale).selectionKeys as Record<string, string> | undefined;

    expect(block, `${locale} is missing worktree.selectionKeys`).toBeDefined();
    for (const key of KEYS) {
      expect(typeof block?.[key], `${locale}.selectionKeys.${key}`).toBe('string');
      expect((block?.[key] ?? '').length, `${locale}.selectionKeys.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has the same key set in both, with nothing extra on either side', () => {
    const en = Object.keys(dictionary('en').selectionKeys as object).sort();
    const ja = Object.keys(dictionary('ja').selectionKeys as object).sort();

    expect(en).toEqual([...KEYS].sort());
    expect(ja).toEqual(en);
  });

  it('does not leave the Japanese copy as the English string', () => {
    // A copied-through label is the failure a "both files have the key" check
    // cannot see. The two prose labels the user reads on the buttons must differ.
    const en = dictionary('en').selectionKeys as Record<string, string>;
    const ja = dictionary('ja').selectionKeys as Record<string, string>;

    for (const key of ['sessionOnly', 'setDefault', 'defaultWarning']) {
      expect(ja[key], key).not.toBe(en[key]);
    }
  });
});
