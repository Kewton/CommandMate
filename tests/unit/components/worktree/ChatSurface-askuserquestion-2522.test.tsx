/**
 * One card for one Command Code question (Issue #2522).
 *
 * Issue #2521 gave this screen an arrow-driven fallback card, raised by
 * `isSelectionListActive`. Issue #2522 gives it a `promptData`, and the two must
 * not both be on: `resolveBlockedReason` tests `isSelectionListActive` BEFORE it
 * reaches the prompt panel, so a payload carrying both would replace the answer
 * buttons with an arrow pad — the reader would be shown the question twice, once
 * unanswerable.
 *
 * So the two states are rendered side by side, from the payloads
 * `buildCurrentOutput` actually publishes for each (pinned in
 * `tests/unit/lib/current-output-builder-2369.test.ts` and in the integration
 * suite):
 *
 *  - **read** — `isPromptWaiting: true` with the four options, and
 *    `isSelectionListActive: false`. No blocked card at all; the answer buttons
 *    are the surface;
 *  - **unreadable** — #2521's payload exactly. The fallback card, and no answer
 *    buttons.
 *
 * `ChatTranscript` is stubbed (jsdom gives the real one no scroll metrics);
 * everything below it is the real implementation.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ChatMessage, PromptData } from '@/types/models';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState, resolveBlockedReason } from '@/components/worktree/ChatSurface';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const DIR_2521 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const DIR_2522 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2522');

const READ = fs.readFileSync(
  path.join(DIR_2521, 'askuserquestion-wrapped-1530-200x1000.txt'),
  'utf-8',
);
const UNREADABLE = fs.readFileSync(path.join(DIR_2522, 'unsupported-missing-number.txt'), 'utf-8');

const WORKTREE_ID = 'wt-2522';
const INSTANCE_ID = 'command-code-2';

/**
 * The live state for one frame, DERIVED from the real detector.
 *
 * Hand-writing it would let the card pass against a payload the server never
 * produces, which is the failure mode this Issue is most exposed to: the two
 * flags are published by one function and read by another.
 */
function liveFor(frame: string): ChatSurfaceLiveState {
  const verdict = detectSessionStatus(frame, 'command-code');
  return {
    isRunning: true,
    sessionStatus: verdict.status,
    isThinking: false,
    isPromptWaiting: verdict.hasActivePrompt,
    promptData: verdict.hasActivePrompt
      ? (verdict.promptDetection.promptData as PromptData)
      : null,
    // `buildCurrentOutput`'s own rule, restated: `waiting` + a selection-list
    // reason. The reason for a read question is `prompt_detected`, which is not
    // one, so this goes false exactly as `promptData` appears.
    isSelectionListActive:
      verdict.status === 'waiting' && verdict.reason === 'command_code_selection_list',
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
  };
}

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

function renderSurface(frame: string, compact = false) {
  cleanup();
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="command-code"
      instanceId={INSTANCE_ID}
      live={liveFor(frame)}
      onSurfaceModeChange={vi.fn()}
      frame={frame}
      compact={compact}
    />,
  );
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

describe('[#2522] the read question is answered, not navigated', () => {
  it('the derived live state is the answerable one', () => {
    const live = liveFor(READ);

    expect(live.isPromptWaiting).toBe(true);
    expect(live.isSelectionListActive).toBe(false);
    expect(live.promptData?.type).toBe('multiple_choice');
  });

  it('raises no blocked card at all', () => {
    // `resolveBlockedReason` is the function that would draw two: it tests
    // `isSelectionListActive` before it ever reaches the prompt panel.
    expect(resolveBlockedReason(liveFor(READ), READ)).toBeNull();
  });

  it.each([
    ['PC split', false],
    ['phone terminal tab', true],
  ])('%s draws no #2521 fallback card', (_label, compact) => {
    renderSurface(READ, compact);

    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });
});

describe('[#2522] a question screen nobody could read keeps the #2521 card', () => {
  it('the derived live state is the fallback one', () => {
    const live = liveFor(UNREADABLE);

    expect(live.isPromptWaiting).toBe(false);
    expect(live.promptData).toBeNull();
    expect(live.isSelectionListActive).toBe(true);
  });

  it.each([
    ['PC split', false],
    ['phone terminal tab', true],
  ])('%s draws the arrow-driven card', (_label, compact) => {
    renderSurface(UNREADABLE, compact);

    const card = screen.getByTestId('chat-dialog-card');
    expect(card).toHaveAttribute('data-reason', 'selectionList');
  });

  it('and the two states are never both live for one frame', () => {
    // The invariant, stated once: `promptData` and the fallback card are
    // mutually exclusive by construction, on both frames.
    for (const frame of [READ, UNREADABLE]) {
      const live = liveFor(frame);
      expect(live.isPromptWaiting === true && live.isSelectionListActive === true).toBe(false);
    }
  });
});
