/**
 * What the chat surface shows for Command Code's footer-less question screen
 * (Issue #2521).
 *
 * Until this Issue the pane was published as `ready` / `input_prompt`, so the
 * surface raised nothing at all: no banner, no card, no keys. The reader saw an
 * idle chat while the agent sat on a question, and `wait` exited 0. What the card
 * has to be once the detector does read it:
 *
 *  - the QUESTION, not the pane. The capture is 409 rows of transcript and 14
 *    rows of dialog, and the pre-#2521 card drew all 423;
 *  - scrollable, because the rows are reached by arrow and the card is capped;
 *  - the arrow pad, Enter and Esc, delivered to the SAME instance the surface
 *    was handed;
 *  - **no number row.** Issue #2521 withdrew the claim that these numbers are
 *    answerable keys: the last option is a separate text input in the TUI, and
 *    measuring what a digit does on this screen is #2522's. The suppression is
 *    scoped to this frame, so every other numbered list keeps its numbers —
 *    asserted here as well, because a fix written into
 *    `shouldOfferOptionNumbers` would have taken codex's picker with it.
 *
 * Both layouts are rendered: the PC split (`compact={false}`) and the phone's
 * terminal tab (`compact`), because the card is mounted by one component for
 * both and a regression in either is invisible from the other.
 *
 * `ChatTranscript` is stubbed (jsdom gives the real one no scroll metrics);
 * everything below it is the real implementation, and `fetch` is the seam the
 * key assertions land on.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
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

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const CARD_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

const ASK_USER_QUESTION = fs.readFileSync(
  path.join(FIXTURES, 'askuserquestion-wrapped-1530-200x1000.txt'),
  'utf-8',
);
/** codex's seven-model picker: the numbered list whose numbers must survive. */
const CODEX_MODEL = fs.readFileSync(path.join(CARD_DIR, 'codex-model-0-151-0.txt'), 'utf-8');

const WORKTREE_ID = 'wt-2521';
const INSTANCE_ID = 'command-code-2';

/**
 * The live state `buildCurrentOutput` publishes for this frame (Issue #2521 C).
 *
 * `isPromptWaiting: false` / `promptData: null` are the half that keeps
 * `PromptPanel` and `MobilePromptSheet` shut: nothing parsed the options, so
 * there is no answerable payload and the surface must not pretend there is.
 */
const QUESTION_LIVE: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: true,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
};

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-12T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'command-code',
  };
}

function renderSurface(
  options: {
    frame?: string;
    cliToolId?: CLIToolType;
    instanceId?: string;
    compact?: boolean;
    live?: Partial<ChatSurfaceLiveState>;
  } = {},
) {
  cleanup();
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={options.cliToolId ?? 'command-code'}
      instanceId={options.instanceId ?? INSTANCE_ID}
      live={{ ...QUESTION_LIVE, ...options.live }}
      onSurfaceModeChange={vi.fn()}
      frame={options.frame ?? ASK_USER_QUESTION}
      compact={options.compact ?? false}
    />,
  );
}

/** The card's action row, the only place the controls may appear. */
const actions = (): HTMLElement => screen.getByTestId('chat-dialog-card-actions');

/** Every `/special-keys` request, as the key arrays it carried. */
function keyCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls
    .filter((call) => !String(call[0]).startsWith('/api/relays'))
    .map((call) => [String(call[0]), (call[1] ?? {}) as RequestInit]);
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
// A. The question reaches the card, on both layouts
// ===========================================================================

describe.each([
  ['PC split', false],
  ['phone terminal tab', true],
])('[#2521] A. %s draws the question and not the pane', (_label, compact) => {
  it('raises the dialog card for the selection-list reason', () => {
    renderSurface({ compact });

    const card = screen.getByTestId('chat-dialog-card');
    expect(card).toHaveAttribute('data-reason', 'selectionList');
  });

  it('shows the tab strip, the question and all four options', () => {
    renderSurface({ compact });

    const frame = screen.getByTestId('chat-dialog-card-frame');
    expect(frame.textContent).toContain('● Dispatch | ◯ Review');
    expect(frame.textContent).toContain(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    for (const option of [
      '1. Prepare worktrees + dispatch (Recommended)',
      '2. Worktrees only, then pause',
      '3. Stop at the plan',
      '4. Type something...',
    ]) {
      expect(frame.textContent, option).toContain(option);
    }
    // The wrapped continuation row, which is the row the shared prompt parser
    // stopped at. A card that dropped it would end option 1 mid-clause.
    expect(frame.textContent).toContain('answer).');
  });

  it('leaves the 409 rows of transcript out of the card', () => {
    renderSurface({ compact });

    const frame = screen.getByTestId('chat-dialog-card-frame');
    for (const row of [
      '# Command Code v1.53.0',
      'Draft a dispatch plan for the sample backlog.',
      'Presenting dispatch decision',
    ]) {
      expect(frame.textContent, row).not.toContain(row);
    }
  });

  it('lets the reader scroll the frame rather than clipping it', () => {
    renderSurface({ compact });

    const frame = screen.getByTestId('chat-dialog-card-frame');
    expect(frame.className).toContain('overflow-auto');
    // Exactly one height cap, so the box is bounded and therefore scrollable
    // rather than growing into the transcript (Issue #2326's budget).
    const caps = frame.className.split(/\s+/).filter((name) => name.startsWith('max-h-'));
    expect(caps).toHaveLength(1);
  });
});

// ===========================================================================
// B. The controls
// ===========================================================================

describe.each([
  ['PC split', false],
  ['phone terminal tab', true],
])('[#2521] B. %s offers arrows, Enter and Esc and nothing else', (_label, compact) => {
  it('draws the arrow pad', () => {
    renderSurface({ compact });

    const row = actions();
    for (const key of ['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape']) {
      expect(within(row).getByLabelText(key), key).toBeInTheDocument();
    }
  });

  it('draws NO number row for this frame', () => {
    renderSurface({ compact });

    expect(within(actions()).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
  });

  it('draws neither the commit keys nor opencode’s chords', () => {
    renderSurface({ compact });

    expect(within(actions()).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
    expect(within(actions()).queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
  });

  it.each(['Down', 'Enter', 'Escape'])('routes %s to the same instance', (key) => {
    renderSurface({ compact });

    fireEvent.click(within(actions()).getByLabelText(key));

    expect(keyCalls()).toHaveLength(1);
    const [url, init] = keyCalls()[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/special-keys`);
    expect(JSON.parse(init.body as string)).toEqual({
      cliToolId: 'command-code',
      keys: [key === 'Escape' ? 'Escape' : key],
      instanceId: INSTANCE_ID,
    });
  });
});

// ===========================================================================
// C. The suppression is scoped to this frame
// ===========================================================================

describe('[#2521] C. every other numbered list keeps its numbers', () => {
  it('still draws seven for codex’s picker', () => {
    // The guard against the fix being written into `shouldOfferOptionNumbers`:
    // that function's rules are #2297's measurements and this Issue does not
    // touch them.
    renderSurface({ cliToolId: 'codex', frame: CODEX_MODEL, instanceId: undefined });

    expect(within(actions()).getByTestId('selection-number-keys')).toHaveAttribute(
      'data-option-count',
      '7',
    );
  });

  it('draws numbers for a numbered list that merely resembles this screen', () => {
    // Same rule row, same four options, no tab strip — an assistant answering in
    // a numbered list. The region reading declines it, so the card behaves
    // exactly as it did before Issue #2521.
    const lookalike = [
      '─'.repeat(200),
      '',
      'Here are the four things I changed:',
      '',
      '❯ 1. renamed the field',
      '  2. updated the test',
      '  3. rebuilt the CLI',
      '  4. refreshed the docs',
    ].join('\n');

    renderSurface({ frame: lookalike });

    expect(within(actions()).getByTestId('selection-number-keys')).toHaveAttribute(
      'data-option-count',
      '4',
    );
  });
});

// ===========================================================================
// D. The positive control
// ===========================================================================

describe('[#2521] D. without the server verdict there is no card at all', () => {
  it('shows the reader an idle chat, which is the reported defect', () => {
    // The pre-#2521 payload for these bytes: `ready`, no selection list, no
    // prompt. Every assertion above depends on the detection branch having
    // changed that, and this is what says so — the card is not merely wrong
    // here, it does not exist.
    renderSurface({
      live: {
        sessionStatus: 'ready',
        isSelectionListActive: false,
        isPromptWaiting: false,
        promptData: null,
      },
    });

    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });
});
