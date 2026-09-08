/**
 * A codex bubble opens with the answer, not with the progress notes
 * (Issue #2420).
 *
 * ## What was on screen
 *
 * `renderCodexTurn` pushed every `AgentMessage` into the body as `prose`
 * regardless of its `phase`, and codex writes far more `commentary` (1,943 of
 * 2,211 archived items) than `final_answer` (268). Measured on one live session
 * — `codex-turn:01a07e37-0658` — the bubble opened with 4 commentary blocks /
 * 754 characters in front of a single 495-character answer.
 *
 * #2197 had a reason for keeping the commentary in the body: it explained the
 * tool line printed directly underneath it. **#2234 retired that reason** by
 * moving every tool line to a folded section at the end of the body, and left
 * narration with nothing left to narrate at the top.
 *
 * ## Why this test spans the writer and the reader
 *
 * The claim in the Issue is about a **bubble**, and two modules stand between
 * the rollout and the pixels: `renderCodexTurn` writes the Markdown, and
 * `splitChatThinking` folds it. The bodies here are therefore produced by
 * `renderCodexTurn` rather than typed out — a hand-written body would agree
 * with the reader by construction and would keep passing if the writer stopped
 * emitting the section at all. `./ChatThinking-2272.test.tsx` owns the reader's
 * own cases; what is pinned here is the seam.
 *
 * ## Non-vacuity
 *
 * Every "the answer leads" assertion is paired with a positive control on the
 * SOURCE string — the commentary really is in the body being handed to the
 * bubble — so none of them can pass because the fixture never had the defect.
 *
 * jsdom performs no layout, so the same rendering branch every other bubble
 * test exercises is what runs here.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import {
  CHAT_THINKING_BODY_TESTID,
  CHAT_THINKING_GROUP_TESTID,
  CHAT_THINKING_TOGGLE_TESTID,
  CHAT_TOOL_LOG_GROUP_TESTID,
  ChatMessageBubble,
  splitChatThinking,
} from '@/components/worktree/ChatMessageBubble';
import {
  renderCodexTurn,
  readCodexRolloutItem,
  type CodexTurnAccumulator,
} from '@/lib/hooks/sources/codex/transcript';
import { TURN_REASONING_LABEL } from '@/lib/hooks/sources/turn-body';
import { codexTurnRequestId } from '@/types/agent-transcript';
import type { ChatMessage } from '@/types/models';

const TURN_ID = '01a07e37-0658-7000-8000-000000002420';

/** One `AgentMessage`, through the same reader the rollout file goes through. */
function agentMessage(index: number, text: string, phase?: string) {
  return readCodexRolloutItem({
    type: 'AgentMessage',
    id: `m${index}`,
    content: [{ type: 'text', text, text_elements: [] }],
    ...(phase === undefined ? {} : { phase }),
  })!;
}

/** One `CommandExecution`, so the tool section #2234 added is in the picture. */
function exec(index: number, cmd: string) {
  return readCodexRolloutItem({
    type: 'CommandExecution',
    id: `e${index}`,
    parsed_cmd: [{ type: 'unknown', cmd }],
  })!;
}

function turnOf(items: readonly ReturnType<typeof agentMessage>[]): CodexTurnAccumulator {
  return {
    sessionId: '01a07e37-0658-7000-8000-000000000001',
    turnId: TURN_ID,
    startedAt: 0,
    prompts: [],
    items: [...items],
    started: true,
    closed: true,
    overflowed: false,
  };
}

/**
 * The shape #2420 was reported against: four progress notes, then the answer,
 * with the `exec` calls interleaved the way codex actually emits them.
 */
const REPORTED_TURN = turnOf([
  agentMessage(0, 'まずリポジトリの構成を確認します。', 'commentary'),
  exec(0, 'ls -la'),
  agentMessage(1, '設定ファイルを読みます。', 'commentary'),
  exec(1, 'cat config.toml'),
  agentMessage(2, '参照先がもう一つあるので、そちらも見ます。', 'commentary'),
  exec(2, 'cat nested.toml'),
  agentMessage(3, '値が二か所で食い違っていました。', 'commentary'),
  agentMessage(4, 'タイムアウトは 30 秒です。`config.toml` の 12 行目で設定されています。', 'final_answer'),
]);

const ANSWER = 'タイムアウトは 30 秒です。';
const FIRST_NOTE = 'まずリポジトリの構成を確認します。';

function message(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-2420',
    worktreeId: 'wt-2420',
    role: 'assistant',
    content,
    timestamp: new Date(Date.UTC(2026, 8, 8, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'codex',
    requestId: codexTurnRequestId(TURN_ID),
    ...overrides,
  };
}

function renderBubble(content: string) {
  return render(
    <ChatMessageBubble message={message(content)} showHeader onFilePathClick={vi.fn()} />
  );
}

/** The bubble's rendered body element, chips included. */
function bodyOf(): HTMLElement {
  const node = document.querySelector('[data-message-id="msg-2420"]');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

describe('[#2420] the body the codex reader hands the bubble', () => {
  it('leads with the answer and carries the notes in one folded section', () => {
    const body = renderCodexTurn(REPORTED_TURN).body;
    expect(body.startsWith(ANSWER)).toBe(true);
    // One heading for all four, not four headings — the chip stands for a run.
    expect(body).toContain(`> **${TURN_REASONING_LABEL} (4)**`);
    expect(body.match(/^> \*\*Thinking/gm)).toHaveLength(1);
    // Nothing is dropped on the way: every note is still in the row.
    for (const note of [
      FIRST_NOTE,
      '設定ファイルを読みます。',
      '参照先がもう一つあるので、そちらも見ます。',
      '値が二か所で食い違っていました。',
    ]) {
      expect(body).toContain(note);
    }
  });

  it('puts the notes behind the answer and the calls behind them', () => {
    const body = renderCodexTurn(REPORTED_TURN).body;
    expect(body.indexOf(ANSWER)).toBeLessThan(body.indexOf(FIRST_NOTE));
    expect(body.indexOf(FIRST_NOTE)).toBeLessThan(body.indexOf('`exec` — ls -la'));
  });
});

describe('[#2420] the chat surface folds it into the chip that is already there', () => {
  it('reads the section the codex reader wrote as reasoning, count intact', () => {
    const body = renderCodexTurn(REPORTED_TURN).body;
    // Positive control: the section really is in the string being split.
    expect(body).toContain(FIRST_NOTE);

    const split = splitChatThinking(body);
    expect(split.blocks).toBe(4);
    expect(split.body.startsWith(ANSWER)).toBe(true);
    expect(split.body).not.toContain(FIRST_NOTE);
    expect(split.reasoning).toContain(FIRST_NOTE);
    expect(split.reasoning).toContain('値が二か所で食い違っていました。');
  });

  it('opens with the answer on screen, not with a progress note', () => {
    const body = renderCodexTurn(REPORTED_TURN).body;
    expect(body).toContain(FIRST_NOTE); // positive control

    renderBubble(body);
    // The first block the card draws, by DOM order rather than by text search:
    // the chip's own label is a next-intl key under the test harness, so it is
    // not a landmark a string comparison could use.
    const first = bodyOf().querySelector('p, blockquote');
    expect(first?.tagName.toLowerCase()).toBe('p');
    expect(first?.textContent).toContain(ANSWER);
    // Closed by default: the notes are not in the DOM until asked for.
    expect(bodyOf().textContent ?? '').not.toContain(FIRST_NOTE);
  });

  it('draws one thinking chip and one tool chip, both closed', () => {
    renderBubble(renderCodexTurn(REPORTED_TURN).body);
    expect(screen.getAllByTestId(CHAT_THINKING_GROUP_TESTID)).toHaveLength(1);
    expect(screen.getAllByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toHaveLength(1);
    expect(screen.queryByTestId(CHAT_THINKING_BODY_TESTID)).toBeNull();
  });

  it('shows every note in full when the chip is opened', () => {
    renderBubble(renderCodexTurn(REPORTED_TURN).body);
    fireEvent.click(screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID));
    const opened = within(screen.getByTestId(CHAT_THINKING_BODY_TESTID));
    for (const note of [
      FIRST_NOTE,
      '設定ファイルを読みます。',
      '参照先がもう一つあるので、そちらも見ます。',
      '値が二か所で食い違っていました。',
    ]) {
      expect(opened.getByText(note)).toBeTruthy();
    }
  });
});

describe('[#2420] the turns that must keep leading with what they always led with', () => {
  it('leaves a short answer alone rather than hiding it behind a chip', () => {
    // 18 % of measured turns answer in fifty characters or fewer — `PONG-1` is
    // a real captured one. A one-word reply must still be the first thing read.
    const body = renderCodexTurn(
      turnOf([
        agentMessage(0, '`marker.txt` を作ります。', 'commentary'),
        agentMessage(1, 'PONG-1', 'final_answer'),
      ])
    ).body;
    expect(body.startsWith('PONG-1\n')).toBe(true);

    renderBubble(body);
    const first = bodyOf().querySelector('p, blockquote');
    expect(first?.tagName.toLowerCase()).toBe('p');
    expect(first?.textContent).toBe('PONG-1');
    expect(screen.getAllByTestId(CHAT_THINKING_GROUP_TESTID)).toHaveLength(1);
  });

  it('draws no chip and hides nothing when the turn produced no answer', () => {
    // The fallback. Folding is an improvement only when there is something
    // better to lead with; a turn that only narrated has nothing else to show.
    const body = renderCodexTurn(
      turnOf([
        agentMessage(0, '移行に着手します。', 'commentary'),
        agentMessage(1, 'まだ fixture を直しています。', 'commentary'),
      ])
    ).body;
    expect(body).toBe('移行に着手します。\n\nまだ fixture を直しています。');

    renderBubble(body);
    expect(screen.queryByTestId(CHAT_THINKING_GROUP_TESTID)).toBeNull();
    expect(bodyOf().textContent).toContain('移行に着手します。');
  });

  it('keeps a message codex gave no phase in the bubble itself', () => {
    // The allow-list, seen from the surface: a phase this reader has never met
    // must reach the operator's eyes, not the inside of a closed chip.
    const body = renderCodexTurn(
      turnOf([
        agentMessage(0, 'A message with no phase at all.'),
        agentMessage(1, 'Something from a newer codex.', 'plan_update'),
        agentMessage(2, 'Done.', 'final_answer'),
      ])
    ).body;
    expect(body).not.toContain(TURN_REASONING_LABEL);

    renderBubble(body);
    const rendered = bodyOf().textContent ?? '';
    expect(rendered).toContain('A message with no phase at all.');
    expect(rendered).toContain('Something from a newer codex.');
    expect(screen.queryByTestId(CHAT_THINKING_GROUP_TESTID)).toBeNull();
  });
});
