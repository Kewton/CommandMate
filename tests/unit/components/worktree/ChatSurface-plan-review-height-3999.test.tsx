/**
 * Issue #3999: the chat card's height rule for Command Code's plan review.
 *
 * jsdom lays nothing out, so what is pinned here are the CLASSES the rule is
 * made of; the pixels are measured in `tests/e2e/plan-review-reachable-3999.spec.ts`.
 *
 *  - A': a plan review is not #2326's long picker — its 77+ rows of plan do not
 *    earn `max-h-[35vh]`; the phone keeps `max-h-32`, the PC `max-h-64`.
 *    Control: a long `/model` picker still gets `35vh` (#2326 unchanged).
 *  - A: the live region may shrink (`min-h-0`, scroll as the floor) instead of
 *    `shrink-0`; on a plan review the card's parts are laid out in the live
 *    region (`contents`) so the frame / banner / arrow pad yield before the
 *    comment box and the buttons. Control: a picker keeps the card's own box
 *    and the banner keeps its height.
 *  - The plan review's buttons are pinned (`shrink-0`), the comment editor and
 *    a refusal yield (`min-h-0` + `overflow-y-auto` + a cap).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import {
  ChatSurface,
  SELECTION_LIST_TALL_CARD_MIN_ROWS,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';
import { extractDialogFrameTail } from '@/lib/chat/dialog-frame';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

/** A plan of well over 24 rows — the shape observed on 2026-10-30. */
const PLAN_REVIEW_LONG = capture('command-code-plan-review-2763/plan-review-long-top.txt');
/** Command Code's `/model`: 76 rows after #2326's crop — the long picker #2326 is for. */
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

const WORKTREE_ID = 'wt-3999';

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

function msg(id: string): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role: 'user',
    content: id,
    timestamp: new Date('2026-10-30T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'command-code',
  };
}

function renderSurface(frame: string, compact = false) {
  return render(
    <ChatSurface
      messages={[msg('u1')]}
      worktreeId={WORKTREE_ID}
      cliToolId="command-code"
      live={SELECTION_LIST}
      onSurfaceModeChange={vi.fn()}
      frame={frame}
      compact={compact}
    />,
  );
}

const classesOf = (testId: string): string[] => screen.getByTestId(testId).className.split(/\s+/);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[#3999] A': a plan review is not #2326's long picker", () => {
  it('positive control: the plan counts past the 24-row threshold, so the old rule raised it', () => {
    const rows = extractDialogFrameTail(PLAN_REVIEW_LONG, { selectionList: true }).split('\n').length;
    expect(rows).toBeGreaterThan(SELECTION_LIST_TALL_CARD_MIN_ROWS);
  });

  it.each([
    ['PC', false, 'max-h-64'],
    ['phone', true, 'max-h-32'],
  ])('%s: the plan keeps the default cap, not 35vh', (_name, compact, cap) => {
    renderSurface(PLAN_REVIEW_LONG, compact);
    const frameClasses = classesOf('chat-dialog-card-frame');
    expect(frameClasses).toContain(cap);
    expect(frameClasses).not.toContain('max-h-[35vh]');
  });

  it.each([
    ['PC', false],
    ['phone', true],
  ])('control (%s): a long /model picker still gets 35vh', (_name, compact) => {
    renderSurface(COMMAND_CODE_MODEL, compact);
    expect(classesOf('chat-dialog-card-frame')).toContain('max-h-[35vh]');
  });
});

describe('[#3999] A: the live region gives way instead of clipping the buttons', () => {
  it('plan review: the live region may shrink and scrolls as the floor (was `shrink-0`)', () => {
    renderSurface(PLAN_REVIEW_LONG);
    const live = classesOf('chat-surface-live');
    expect(live).toContain('min-h-0');
    expect(live).toContain('overflow-y-auto');
    expect(live).not.toContain('shrink-0');
    // The surface keeps its own clip, so the region cannot paint over a neighbour.
    expect(classesOf('chat-surface')).toContain('overflow-hidden');
  });

  it('plan review: the card is laid out in the live region; frame, banner and pad yield', () => {
    renderSurface(PLAN_REVIEW_LONG, true);
    expect(classesOf('chat-dialog-card')).toContain('contents');
    expect(classesOf('chat-dialog-card-actions')).toContain('contents');
    expect(classesOf('chat-dialog-card-frame-slot')).toEqual(
      expect.arrayContaining(['min-h-0', 'shrink-[100000]', 'overflow-hidden']),
    );
    expect(classesOf('chat-surface-terminal-banner')).toEqual(
      expect.arrayContaining(['min-h-0', 'shrink-[100000]']),
    );
    expect(classesOf('selection-list-pad-slot')).toEqual(
      expect.arrayContaining(['min-h-0', 'shrink-[100000]']),
    );
  });

  it('plan review: the buttons are pinned, the comment box and a refusal yield', () => {
    renderSurface(PLAN_REVIEW_LONG, true);
    const controls = screen.getByTestId('plan-review-controls');
    expect(controls.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'min-h-0']));
    const row = within(controls).getByTestId('plan-review-approve').parentElement!;
    expect(row.className.split(/\s+/)).toContain('shrink-0');
    expect(within(controls).getByTestId('plan-review-submit').parentElement).toBe(row);
    expect(within(controls).getByTestId('plan-review-cancel').parentElement).toBe(row);
    const area = within(controls).getByTestId('plan-review-comment-area');
    expect(area.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['min-h-0', 'overflow-y-auto', 'max-h-24']),
    );
    expect(area).toContainElement(within(controls).getByTestId('plan-review-comment-input'));
  });

  it('control: a picker keeps the shrink-0 region, the card box and a banner that holds its height', () => {
    renderSurface(COMMAND_CODE_MODEL, true);
    expect(classesOf('chat-surface-live')).toContain('shrink-0');
    expect(classesOf('chat-dialog-card')).not.toContain('contents');
    expect(classesOf('chat-dialog-card-actions')).not.toContain('contents');
    expect(classesOf('chat-surface-terminal-banner')).not.toContain('min-h-0');
    expect(screen.queryByTestId('selection-list-pad-slot')).not.toBeInTheDocument();
    expect(classesOf('selection-list-keys')).toContain('space-y-2');
  });
});
