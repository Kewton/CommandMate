/**
 * The chat transcript tells a question apart from an approval (Issue #2460).
 *
 * Everything here goes through the real pipeline — `ChatTranscript` →
 * `buildChatTranscriptRows` → `ChatToolApprovalGroup` — against
 * `tests/fixtures/chat-tool-approvals-2460`, because the defect was visible only
 * at the end of it: the helpers each behaved, and the group still said
 * 「ツール承認 3 件」 for two questions with the picker's tab bar in the labels.
 *
 * `tests/setup.ts` stubs next-intl with an echo of the key, so what an assertion
 * on rendered text can see is WHICH key was asked for, not the sentence. That is
 * the right thing to pin here (the wrong key is exactly what shipped) and the
 * dictionaries themselves are pinned in `chat-tool-approvals-2245.test.ts`.
 *
 * jsdom performs no layout, so the #1123 fallback list is what renders here —
 * the same branch every other `ChatTranscript` test exercises.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX } from '@/lib/chat/chat-tool-approvals';
import {
  questionSetMessages,
  QUESTION_SET_IDS,
  QUESTION_TEXTS,
  QUESTION_SET_TAB_ROWS,
  UNRELATED_SHELL_FRAGMENT,
} from '@tests/fixtures/chat-tool-approvals-2460';

const WORKTREE_ID = 'mycodebranchdesk';
const KEY = 'worktree.chatTranscript.toolApproval';
const CONFIRMATION_TAIL = 'Ready to submit your answers?';

function renderTranscript(messages: ChatMessage[]) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
    />,
  );
}

function group(): HTMLElement {
  return screen.getByTestId('chat-tool-approval-group');
}

function toggle(): HTMLElement {
  return within(group()).getByTestId('chat-tool-approval-toggle');
}

function openTheGroup(): HTMLElement[] {
  fireEvent.click(toggle());
  return within(group()).getAllByTestId('chat-tool-approval-entry');
}

function withPromptData(message: ChatMessage, patch: Record<string, unknown>): ChatMessage {
  return {
    ...message,
    promptData: {
      ...(message.promptData as unknown as Record<string, unknown>),
      ...patch,
    } as unknown as ChatMessage['promptData'],
  };
}

/** A permission audit row, so a group can hold both kinds. */
function auditRow(): ChatMessage {
  return {
    id: 'audit',
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: 'Bash: {"command":"git status"}',
    summary: `${PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX} · tool=Bash · prompt_id=unknown`,
    timestamp: new Date('2026-09-10T21:48:03.000+09:00'),
    messageType: 'prompt',
    cliToolId: 'claude',
    instanceId: 'claude-2',
    archived: false,
    promptData: {
      type: 'yes_no',
      question: 'Approve Bash?',
      options: ['yes', 'no'],
      status: 'answered',
    } as unknown as ChatMessage['promptData'],
  };
}

// ---------------------------------------------------------------------------
// 1. The summary counts the kinds apart
// ---------------------------------------------------------------------------

describe('[#2460] the group summary', () => {
  it('says "questions" for a group of questions, and counts two of them', () => {
    renderTranscript(questionSetMessages());

    // Three rows in the database, two questions on screen: the confirmation is
    // folded into the question it confirms and is not a third anything.
    expect(group().getAttribute('data-approval-count')).toBe('2');
    expect(group().getAttribute('data-questions')).toBe('2');
    expect(group().getAttribute('data-approvals')).toBe('0');
    expect(group().getAttribute('data-confirmations')).toBe('0');
    expect(toggle().textContent).toBe(`${KEY}.summaryQuestions`);
  });

  it('names both kinds when the run holds both', () => {
    renderTranscript([auditRow(), ...questionSetMessages()]);

    expect(group().getAttribute('data-approvals')).toBe('1');
    expect(group().getAttribute('data-questions')).toBe('2');
    // One order, no zero-count segment, joined by the locale's own separator.
    expect(toggle().textContent).toBe(
      `${KEY}.summary${KEY}.summarySeparator${KEY}.summaryQuestions`,
    );
  });

  it('keeps the approval-only wording exactly as it was', () => {
    renderTranscript([auditRow()]);
    expect(toggle().textContent).toBe(`${KEY}.summary`);
    expect(group().getAttribute('data-approval-count')).toBe('1');
    expect(group().getAttribute('data-questions')).toBe('0');
  });

  it('names what a loose confirmation is, on its own', () => {
    const confirmation = questionSetMessages().find(
      (m) => m.id === QUESTION_SET_IDS.confirmation,
    ) as ChatMessage;
    renderTranscript([confirmation]);

    expect(group().getAttribute('data-confirmations')).toBe('1');
    expect(group().getAttribute('data-questions')).toBe('0');
    // Alone it has to say what it confirms; beside its questions the short form
    // would be enough.
    expect(toggle().textContent).toBe(`${KEY}.summaryConfirmationsOnly`);
  });
});

// ---------------------------------------------------------------------------
// 2. The toggle names what it opens
// ---------------------------------------------------------------------------

describe('[#2460] the disclosure control', () => {
  it('offers to show the QUESTIONS, in both directions', () => {
    renderTranscript(questionSetMessages());
    expect(toggle().getAttribute('aria-label')).toBe(`${KEY}.expandQuestions`);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-label')).toBe(`${KEY}.collapseQuestions`);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('offers both kinds for a mixed run, and approvals alone for an approval run', () => {
    const { unmount } = renderTranscript([auditRow(), ...questionSetMessages()]);
    expect(toggle().getAttribute('aria-label')).toBe(`${KEY}.expandMixed`);
    unmount();

    renderTranscript([auditRow()]);
    expect(toggle().getAttribute('aria-label')).toBe(`${KEY}.expand`);
  });
});

// ---------------------------------------------------------------------------
// 3. The labels
// ---------------------------------------------------------------------------

describe('[#2460] what each question chip says', () => {
  it('starts at the question, with no tab bar and no pane', () => {
    renderTranscript(questionSetMessages());
    const entries = openTheGroup();

    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain('この Issue の核心は');
    expect(entries[1].textContent).toContain(QUESTION_TEXTS.second);

    const transcript = screen.getByTestId('chat-transcript').textContent ?? '';
    for (const noise of [
      QUESTION_SET_TAB_ROWS.first,
      QUESTION_SET_TAB_ROWS.second,
      '✔ Submit',
      CONFIRMATION_TAIL,
      'Review your answers',
      UNRELATED_SHELL_FRAGMENT,
    ]) {
      expect(transcript, `chrome on screen: ${noise}`).not.toContain(noise);
    }
  });

  it('marks the folded confirmation on the chip that absorbed it', () => {
    renderTranscript(questionSetMessages());
    const [first, second] = openTheGroup();

    expect(second.getAttribute('data-approval-merged')).toBe('2');
    expect(second.getAttribute('data-approval-kind')).toBe('question');
    expect(second.getAttribute('data-approval-phase')).toBe('question');
    expect(first.getAttribute('data-approval-merged')).toBe('1');
  });

  it('names a loose confirmation rather than printing an empty chip', () => {
    // Its review lists two questions, so no single one of them is the label —
    // and the shell fragment in `content` is not a fallback.
    const confirmation = questionSetMessages().find(
      (m) => m.id === QUESTION_SET_IDS.confirmation,
    ) as ChatMessage;
    renderTranscript([
      withPromptData(confirmation, {
        question:
          `Review your answers\n\n ● ${QUESTION_TEXTS.first}\n   → 最小\n` +
          ` ● ${QUESTION_TEXTS.second}\n   → worktree で起動（推奨）\n\n${CONFIRMATION_TAIL}`,
      }),
    ]);

    const [entry] = openTheGroup();
    expect(entry.getAttribute('data-approval-phase')).toBe('confirmation');
    expect(entry.textContent).toContain(`${KEY}.submitConfirmation`);
    expect(entry.textContent).not.toContain(UNRELATED_SHELL_FRAGMENT);
  });
});

// ---------------------------------------------------------------------------
// 4. Who answered, and who confirmed
// ---------------------------------------------------------------------------

describe('[#2460] the outcome a question chip reports', () => {
  it('says auto-ANSWERED, not auto-approved', () => {
    renderTranscript(questionSetMessages());
    const entries = openTheGroup();

    for (const entry of entries) {
      expect(entry.getAttribute('data-approval-outcome')).toBe('auto');
      expect(within(entry).getByTestId('chat-tool-approval-outcome').textContent).toBe(
        `${KEY}.autoAnswered`,
      );
    }
  });

  it('keeps saying auto-APPROVED for a permission dialog', () => {
    renderTranscript([auditRow()]);
    const [entry] = openTheGroup();
    expect(within(entry).getByTestId('chat-tool-approval-outcome').textContent).toBe(
      `${KEY}.autoApproved`,
    );
    expect(entry.getAttribute('data-approval-kind')).toBe('approval');
    expect(entry.getAttribute('data-approval-audit')).toBe('true');
  });

  it('shows the person who submitted the set beside the answers Auto-Yes gave', () => {
    renderTranscript(questionSetMessages());
    const [first, second] = openTheGroup();

    // The defect: `human` > `auto` in the fold's rank, so the confirmer's
    // outcome stood where the answerer's belonged and a set nobody chose read
    // as the reader's own choice.
    expect(second.getAttribute('data-approval-outcome')).toBe('auto');
    expect(second.getAttribute('data-approval-confirmation')).toBe('human');
    expect(within(second).getByTestId('chat-tool-approval-confirmation').textContent).toBe(
      `${KEY}.confirmation`,
    );
    // The question that was not the last of the set has no confirmer of its own.
    expect(first.getAttribute('data-approval-confirmation')).toBeNull();
    expect(within(first).queryByTestId('chat-tool-approval-confirmation')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. `message_updated`
// ---------------------------------------------------------------------------

describe('[#2460] a pending row that is answered later', () => {
  it('re-derives the outcome, the confirmer and the counts from the new rows', () => {
    const [first, second, confirmation] = questionSetMessages();
    const pending = (message: ChatMessage) =>
      withPromptData(message, { status: 'pending', answeredBy: undefined, answer: undefined });

    const { rerender } = renderTranscript([first, pending(second), pending(confirmation)]);
    let entries = openTheGroup();

    expect(entries).toHaveLength(2);
    expect(entries[1].getAttribute('data-approval-outcome')).toBe('pending');
    // A pending submission is still the submission of this question's set: it
    // folds, and it reports itself as awaiting an answer rather than as done.
    expect(entries[1].getAttribute('data-approval-confirmation')).toBe('pending');

    rerender(
      <ChatTranscript
        messages={[first, second, confirmation]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
      />,
    );

    entries = within(group()).getAllByTestId('chat-tool-approval-entry');
    expect(entries).toHaveLength(2);
    expect(entries[1].getAttribute('data-approval-outcome')).toBe('auto');
    expect(entries[1].getAttribute('data-approval-confirmation')).toBe('human');
    expect(group().getAttribute('data-questions')).toBe('2');
  });
});
