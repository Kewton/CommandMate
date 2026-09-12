/**
 * `AskUserQuestion` rows are questions, not approvals (Issue #2460).
 *
 * ## What was on screen
 *
 * `/worktrees/mycodebranchdesk`, 2026-09-10 21:48: one `AskUserQuestion` call
 * with two questions plus its submit confirmation rendered as a single chip
 * group reading **「ツール承認 3 件」** — three, for two questions — with the
 * picker's tab bar (`←  ☐ 実行範囲  ☐ 起動場所  ✔ Submit  →`) still glued to the
 * front of each label, and the confirmation's `human` outcome standing where the
 * questions' `auto` belonged, so a set Auto-Yes had answered read as the
 * reader's own choice.
 *
 * `tests/fixtures/chat-tool-approvals-2460` rebuilds those three rows; its
 * README records what is verbatim (the shapes, the `answeredBy` values and the
 * clock to the millisecond) and what is rewritten (the prose, since the rows are
 * a private worktree's `/uat` session).
 *
 * ## What this file pins
 *
 * The four rules that can each be removed on their own, which is how they were
 * checked (see `## Mutation injection` at the foot of this file):
 * classification, label normalization, the fold's identity and window, and the
 * separation of the answerer from the confirmer.
 */

import { describe, it, expect } from 'vitest';
import {
  buildToolApprovalEntries,
  countToolApprovalEntries,
  mergeToolApprovalEntries,
  readSubmitConfirmation,
  stripAskUserQuestionTabs,
  toToolApprovalEntry,
  PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX,
  TOOL_APPROVAL_LABEL_MAX_CHARS,
  TOOL_APPROVAL_MERGE_WINDOW_MS,
  type ToolApprovalEntry,
} from '@/lib/chat/chat-tool-approvals';
import { buildChatTranscriptRows, buildPromptRunIds } from '@/lib/chat/chat-transcript-view';
import type { ChatMessage } from '@/types/models';
import {
  questionSetMessages,
  QUESTION_SET_IDS,
  QUESTION_SET_TIMESTAMPS,
  QUESTION_TEXTS,
  QUESTION_SET_TAB_ROWS,
  UNRELATED_SHELL_FRAGMENT,
} from '@tests/fixtures/chat-tool-approvals-2460';
import { agyMessages, codexMessages } from '@tests/fixtures/chat-transcript-2245';
import { degradedPromptRows } from '@tests/fixtures/chat-transcript-2245/degraded-prompt-rows';

const CONFIRMATION_TAIL = 'Ready to submit your answers?';

// ---------------------------------------------------------------------------
// Helpers over the fixture
// ---------------------------------------------------------------------------

function rowsById(): Record<string, ChatMessage> {
  const byId: Record<string, ChatMessage> = {};
  for (const message of questionSetMessages()) byId[message.id] = message;
  return byId;
}

/** One fixture row, with `promptData` fields replaced. */
function withPromptData(message: ChatMessage, patch: Record<string, unknown>): ChatMessage {
  return {
    ...message,
    promptData: {
      ...(message.promptData as unknown as Record<string, unknown>),
      ...patch,
    } as unknown as ChatMessage['promptData'],
  };
}

/** One fixture row, moved by `offsetMs` from its own timestamp. */
function shifted(message: ChatMessage, offsetMs: number, id = message.id): ChatMessage {
  return { ...message, id, timestamp: new Date(message.timestamp.getTime() + offsetMs) };
}

function normalMessage(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: 'mycodebranchdesk',
    role: 'assistant',
    content: `body ${id}`,
    timestamp: new Date(QUESTION_SET_TIMESTAMPS.first),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    instanceId: 'claude-2',
    ...extra,
  };
}

function entriesOf(messages: ChatMessage[]): ToolApprovalEntry[] {
  const rows = buildChatTranscriptRows(messages);
  return rows.flatMap((row) => (row.kind === 'approvals' ? row.entries : []));
}

// ---------------------------------------------------------------------------
// The fixture is what the Issue says it is
// ---------------------------------------------------------------------------

describe('[#2460] the reported rows', () => {
  it('is two flagged questions and one unflagged confirmation, in one pane', () => {
    const [first, second, confirmation] = questionSetMessages();

    for (const message of [first, second, confirmation]) {
      expect(message.messageType).toBe('prompt');
      expect(message.worktreeId).toBe('mycodebranchdesk');
      expect(message.instanceId).toBe('claude-2');
      expect(message.cliToolId).toBe('claude');
    }

    const promptOf = (m: ChatMessage) => m.promptData as unknown as Record<string, unknown>;
    expect(promptOf(first).isAskUserQuestion).toBe(true);
    expect(promptOf(second).isAskUserQuestion).toBe(true);
    // The confirmation row carries no flag at all — this is the shape the
    // classifier has to recognize structurally.
    expect(promptOf(confirmation).isAskUserQuestion).toBeUndefined();
    expect(promptOf(first).answeredBy).toBe('auto');
    expect(promptOf(second).answeredBy).toBe('auto');
    expect(promptOf(confirmation).answeredBy).toBe('human');
  });

  it('puts the confirmation exactly on the merge window, to the millisecond', () => {
    const byId = rowsById();
    const gap =
      byId[QUESTION_SET_IDS.confirmation].timestamp.getTime() -
      byId[QUESTION_SET_IDS.second].timestamp.getTime();
    // Not "about five seconds": the fold's bound is inclusive BECAUSE the
    // reported row sits on it, and a fixture that was 4,900 ms would let a `<`
    // comparison pass.
    expect(gap).toBe(TOOL_APPROVAL_MERGE_WINDOW_MS);
    expect(
      byId[QUESTION_SET_IDS.second].timestamp.getTime() -
        byId[QUESTION_SET_IDS.first].timestamp.getTime(),
    ).toBe(2_000);
  });

  it('carries the tab bar in the question and the pane in the body', () => {
    const byId = rowsById();
    for (const [id, tabRow] of [
      [QUESTION_SET_IDS.first, QUESTION_SET_TAB_ROWS.first],
      [QUESTION_SET_IDS.second, QUESTION_SET_TAB_ROWS.second],
      [QUESTION_SET_IDS.confirmation, QUESTION_SET_TAB_ROWS.confirmation],
    ] as const) {
      const prompt = byId[id].promptData as unknown as Record<string, string>;
      expect(prompt.question.startsWith(tabRow)).toBe(true);
    }

    const confirmation = byId[QUESTION_SET_IDS.confirmation];
    expect(confirmation.content).toContain(UNRELATED_SHELL_FRAGMENT);
    expect(
      (confirmation.promptData as unknown as Record<string, string>).instructionText,
    ).toContain(UNRELATED_SHELL_FRAGMENT);
  });
});

// ---------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------

describe('[#2460] classification', () => {
  it('calls a flagged row a question, and its submit screen a confirmation', () => {
    const byId = rowsById();
    expect(toToolApprovalEntry(byId[QUESTION_SET_IDS.first])).toMatchObject({
      kind: 'question',
      phase: 'question',
    });
    expect(toToolApprovalEntry(byId[QUESTION_SET_IDS.second])).toMatchObject({
      kind: 'question',
      phase: 'question',
    });
    expect(toToolApprovalEntry(byId[QUESTION_SET_IDS.confirmation])).toMatchObject({
      kind: 'question',
      phase: 'confirmation',
    });
  });

  it('keeps a permission audit an approval however its question reads', () => {
    // Priority 1. The hook writes the tool name into `question`, and a row whose
    // command happened to quote the picker must not change kind: the audit row
    // records a permission decision and nothing else.
    const byId = rowsById();
    const audit: ChatMessage = {
      ...byId[QUESTION_SET_IDS.confirmation],
      id: 'audit',
      summary: `${PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX} · tool=Bash · prompt_id=unknown`,
    };
    expect(toToolApprovalEntry(audit)).toMatchObject({
      kind: 'approval',
      isPermissionAudit: true,
      outcome: 'auto',
    });
  });

  it('reads an unflagged confirmation from its structure, not from the sentence', () => {
    const byId = rowsById();
    const confirmation = byId[QUESTION_SET_IDS.confirmation];

    // The structure: the sentence CLOSES the text and the options are the
    // screen's own.
    expect(toToolApprovalEntry(confirmation).kind).toBe('question');

    // The sentence alone, quoted inside an ordinary approval, is not one.
    const quoting = withPromptData(confirmation, {
      question: `${CONFIRMATION_TAIL} is the line the picker ends on. Approve Bash?`,
      options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }],
    });
    expect(toToolApprovalEntry(quoting).kind).toBe('approval');

    // The sentence at the end, with neither the options nor a review list, is
    // not enough either: a pane dump can end anywhere.
    const tailOnly = withPromptData(confirmation, {
      question: `Approve Bash? ${CONFIRMATION_TAIL}`,
      options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }],
    });
    expect(toToolApprovalEntry(tailOnly).kind).toBe('approval');
  });

  it('leaves every captured approval row an approval', () => {
    // The regression side of the same rule: nothing in the #2245 slices — five
    // scraped antigravity dialogs and four codex audit rows — becomes a question.
    const entries = [...agyMessages(), ...codexMessages()]
      .filter((m) => m.messageType === 'prompt')
      .map((m) => toToolApprovalEntry(m));
    expect(entries.length).toBeGreaterThanOrEqual(9);
    expect(entries.every((entry) => entry.kind === 'approval')).toBe(true);
    expect(entries.every((entry) => entry.phase === undefined)).toBe(true);
  });

  it('classifies a degraded promptData without throwing', () => {
    for (const row of degradedPromptRows) {
      expect(() => toToolApprovalEntry(row)).not.toThrow();
      expect(toToolApprovalEntry(row).kind).toBe('approval');
    }
    // A question whose options are the wrong TYPE entirely is still readable.
    const malformed = withPromptData(rowsById()[QUESTION_SET_IDS.second], {
      options: 'not an array',
      askUserQuestion: 42,
    });
    expect(() => toToolApprovalEntry(malformed)).not.toThrow();
    expect(toToolApprovalEntry(malformed).kind).toBe('question');
  });
});

// ---------------------------------------------------------------------------
// 2. The label
// ---------------------------------------------------------------------------

describe('[#2460] stripAskUserQuestionTabs', () => {
  it('removes the whole tab bar, whatever the tab names are', () => {
    expect(stripAskUserQuestionTabs(`${QUESTION_SET_TAB_ROWS.first}\n\nどこまで？`)).toBe('どこまで？');
    // English tab names hold spaces — the shape originally proposed for this
    // used `\S+` and stopped inside `Color scheme`.
    expect(
      stripAskUserQuestionTabs('←  ☒ Color scheme  ☐ Editor mode  ✔ Submit  →  Which editor?'),
    ).toBe('Which editor?');
    // The bar can arrive wrapped across lines, because the scan sweeps pane rows.
    expect(
      stripAskUserQuestionTabs('←  ☐ First\ntask  ☐ Second\n task  ✔ Submit  →\n\nWhich task?'),
    ).toBe('Which task?');
  });

  it('leaves text that only resembles the bar alone', () => {
    // The canary frame: a checkbox, no arrows, no `✔ Submit`. Trimming leading
    // glyphs by shape would eat the sentence in front of the question.
    const canary = "⏺ I'll load the TaskCreate tool schema first. ☐ First task Which task would you like to start with?";
    expect(stripAskUserQuestionTabs(canary)).toBe(canary);
    // Arrows with no checkbox, and checkboxes with no `Submit`, are prose.
    expect(stripAskUserQuestionTabs('← back → forward ✔ Submit → done')).toBe(
      '← back → forward ✔ Submit → done',
    );
    expect(stripAskUserQuestionTabs('☐ 実行範囲 ☐ 起動場所 どこまで？')).toBe(
      '☐ 実行範囲 ☐ 起動場所 どこまで？',
    );
  });

  it('is only a leading rule: a bar inside the body stays', () => {
    // Whitespace is collapsed (a chip is one line); the STRUCTURE survives,
    // because it is not at the front and is therefore the author's own text.
    const inline = `質問です。 ${QUESTION_SET_TAB_ROWS.first} は picker の chrome です。`;
    expect(stripAskUserQuestionTabs(inline)).toBe(inline.replace(/\s+/g, ' '));
    expect(stripAskUserQuestionTabs(inline)).toContain('✔ Submit →');
  });
});

describe('[#2460] the chip label', () => {
  it('starts at the question, with no tab bar, pane or confirmation English', () => {
    const entries = entriesOf(questionSetMessages());
    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect(entry.label.startsWith('←')).toBe(false);
      expect(entry.label).not.toContain('☐');
      expect(entry.label).not.toContain('✔ Submit');
      expect(entry.label).not.toContain(CONFIRMATION_TAIL);
      expect(entry.label).not.toContain(UNRELATED_SHELL_FRAGMENT);
      expect(entry.label).not.toContain('Review your answers');
      expect(entry.label.length).toBeLessThanOrEqual(TOOL_APPROVAL_LABEL_MAX_CHARS);
    }

    expect(entries[0].label.startsWith('この Issue の核心は')).toBe(true);
    expect(entries[1].label).toBe(QUESTION_TEXTS.second);
  });

  it('keeps the untruncated question for identity while the label is elided', () => {
    const [first] = entriesOf(questionSetMessages());
    expect(QUESTION_TEXTS.first.length).toBeGreaterThan(TOOL_APPROVAL_LABEL_MAX_CHARS);
    expect(first.questionText).toBe(QUESTION_TEXTS.first);
    expect(first.label.endsWith('…')).toBe(true);
    // The identity is the full text, so it cannot be the label.
    expect(first.mergeKey).toContain(QUESTION_TEXTS.first);
    expect(first.mergeKey).not.toContain(first.label);
  });

  it('names the reviewed question on a loose confirmation, and nothing when it reviews several', () => {
    const byId = rowsById();
    const alone = toToolApprovalEntry(byId[QUESTION_SET_IDS.confirmation]);
    expect(alone.label).toBe(QUESTION_TEXTS.second);
    expect(alone.reviewQuestions).toEqual([QUESTION_TEXTS.second]);

    const both = withPromptData(byId[QUESTION_SET_IDS.confirmation], {
      question:
        `${QUESTION_SET_TAB_ROWS.confirmation}\n\nReview your answers\n\n` +
        ` ● ${QUESTION_TEXTS.first}\n   → 最小（スケジュール 1 件を作成して実行）\n` +
        ` ● ${QUESTION_TEXTS.second}\n   → worktree で起動（推奨）\n\n${CONFIRMATION_TAIL}`,
    });
    const entry = toToolApprovalEntry(both);
    expect(entry.reviewQuestions).toEqual([QUESTION_TEXTS.first, QUESTION_TEXTS.second]);
    // Concatenating two questions into one line would be a chip that asks
    // something nobody asked; the caller renders the translated placeholder.
    expect(entry.label).toBe('');
  });

  it('never joins the chosen answer to the question', () => {
    const entry = toToolApprovalEntry(rowsById()[QUESTION_SET_IDS.confirmation]);
    expect(entry.label).not.toContain('worktree で起動');
    expect(entry.reviewQuestions.join(' ')).not.toContain('→');
  });
});

describe('[#2460] readSubmitConfirmation', () => {
  it('separates the review from the closing sentence', () => {
    const shape = readSubmitConfirmation(
      `${QUESTION_SET_TAB_ROWS.confirmation}\nReview your answers\n ● Which editor?\n   → Vim\n\n${CONFIRMATION_TAIL}`,
      [{ number: 1, label: 'Submit answers' }, { number: 2, label: 'Cancel' }],
    );
    expect(shape).toEqual({
      hasTail: true,
      hasSubmitOptions: true,
      reviewQuestions: ['Which editor?'],
    });
  });

  it('reads `yes_no` string options and a missing options field alike', () => {
    expect(readSubmitConfirmation(`x ${CONFIRMATION_TAIL}`, ['yes', 'no']).hasSubmitOptions).toBe(
      false,
    );
    expect(readSubmitConfirmation(`x ${CONFIRMATION_TAIL}`, undefined).hasTail).toBe(true);
    expect(readSubmitConfirmation('', null).reviewQuestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Folding: duplicates
// ---------------------------------------------------------------------------

describe('[#2460] duplicate questions', () => {
  const byId = rowsById();
  const second = () => byId[QUESTION_SET_IDS.second];

  it('folds a second record of the same question and keeps the stronger outcome', () => {
    const sweep = withPromptData(second(), { answeredBy: 'terminal' });
    const auto = shifted(withPromptData(second(), { answeredBy: 'auto' }), 1_000, 'dup');
    const merged = entriesOf([sweep, auto]);

    expect(merged).toHaveLength(1);
    expect(merged[0].messageIds).toEqual([QUESTION_SET_IDS.second, 'dup']);
    expect(merged[0].outcome).toBe('auto');
    expect(merged[0].id).toBe(QUESTION_SET_IDS.second);
    expect(merged[0].timestampMs).toBe(second().timestamp.getTime());
  });

  it('keeps the two questions of one call apart', () => {
    // 2,000 ms apart and inside the window; different questions, so two chips.
    expect(entriesOf(questionSetMessages())).toHaveLength(2);
  });

  it('will not fold two questions that differ only past the elision cap', () => {
    const first = byId[QUESTION_SET_IDS.first];
    const head = QUESTION_TEXTS.first.slice(0, TOOL_APPROVAL_LABEL_MAX_CHARS);
    const a = withPromptData(first, { question: `${QUESTION_SET_TAB_ROWS.first}\n${head}A` });
    const b = shifted(
      withPromptData(first, { question: `${QUESTION_SET_TAB_ROWS.first}\n${head}B` }),
      1_000,
      'variant',
    );

    const merged = entriesOf([a, b]);
    // Both labels are elided to the same 160 characters, so a key built from
    // the label would fold two different questions into one chip.
    expect(merged[0].label).toBe(merged[1].label);
    expect(merged).toHaveLength(2);
  });

  it('will not fold two identical questions from different positions in the call', () => {
    const a = second();
    const b = shifted(
      withPromptData(second(), {
        askUserQuestion: { header: '起動場所', multiSelect: false, questionIndex: 0, questionCount: 2, metaOptionNumbers: [] },
      }),
      1_000,
      'other-index',
    );
    expect(entriesOf([a, b])).toHaveLength(2);
  });

  it('will not fold two identical questions offering different options', () => {
    const b = shifted(
      withPromptData(second(), { options: [{ number: 1, label: 'main で起動' }] }),
      1_000,
      'other-options',
    );
    expect(entriesOf([second(), b])).toHaveLength(2);
  });

  it('will not fold across panes', () => {
    const otherInstance: ChatMessage = { ...shifted(second(), 1_000, 'other-pane'), instanceId: 'claude-3' };
    expect(entriesOf([second(), otherInstance])).toHaveLength(2);
  });

  it('will not chain past the window one step at a time', () => {
    const step = Math.round(TOOL_APPROVAL_MERGE_WINDOW_MS * 0.6);
    const chain = [0, 1, 2, 3].map((n) => shifted(second(), n * step, `chain-${n}`));
    const merged = entriesOf(chain);

    // 0+1 fold; 2 and 3 are 1.2 and 1.8 windows from the SURVIVOR, so they open
    // chips of their own instead of walking the deadline forward.
    expect(merged.length).toBeGreaterThan(1);
    expect(merged[0].messageIds).toEqual(['chain-0', 'chain-1']);
  });

  it('will not reach back over a different question', () => {
    const twin = shifted(second(), 3_000, 'twin');
    const merged = entriesOf([second(), byId[QUESTION_SET_IDS.first], twin]);
    // All three are inside the window of the first; folding the third into the
    // first would delete the question the agent asked between them.
    expect(merged).toHaveLength(3);
  });

  it('will not fold two segments of the column together', () => {
    // The previous-session fold and the live conversation are built by separate
    // `buildChatTranscriptRows` calls (#2445), so one question asked in each is
    // two chips even though they are one second apart.
    const archived: ChatMessage = { ...second(), id: 'archived', archived: true };
    const live = shifted(second(), 1_000, 'live');
    expect(entriesOf([archived])).toHaveLength(1);
    expect(entriesOf([live])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Folding: the submit confirmation
// ---------------------------------------------------------------------------

describe('[#2460] the submit confirmation', () => {
  const byId = rowsById();
  const second = () => byId[QUESTION_SET_IDS.second];
  const confirmation = () => byId[QUESTION_SET_IDS.confirmation];

  it('is absorbed into the question it confirms, and counts as no question', () => {
    const entries = entriesOf(questionSetMessages());

    expect(entries).toHaveLength(2);
    expect(entries[1].messageIds).toEqual([QUESTION_SET_IDS.second, QUESTION_SET_IDS.confirmation]);
    // The chip keeps the QUESTION's id, timestamp and label.
    expect(entries[1].id).toBe(QUESTION_SET_IDS.second);
    expect(entries[1].timestampMs).toBe(second().timestamp.getTime());
    expect(entries[1].label).toBe(QUESTION_TEXTS.second);
    expect(countToolApprovalEntries(entries)).toEqual({
      approvals: 0,
      questions: 2,
      confirmations: 0,
      total: 2,
    });
  });

  it('is absorbed at exactly the window and not one millisecond past it', () => {
    expect(entriesOf([second(), confirmation()])).toHaveLength(1);
    expect(entriesOf([second(), shifted(confirmation(), 1, 'late')])).toHaveLength(2);
  });

  it('is not absorbed backwards, or on an unreadable clock', () => {
    // Dated BEFORE the question: not a later record of the same operation.
    expect(entriesOf([second(), shifted(confirmation(), -6_000, 'early')])).toHaveLength(2);

    const undated: ChatMessage = {
      ...confirmation(),
      id: 'undated',
      timestamp: new Date('not a date'),
    };
    expect(entriesOf([second(), undated])).toHaveLength(2);
  });

  it('is not absorbed across panes', () => {
    const other: ChatMessage = { ...confirmation(), id: 'other-pane', instanceId: 'claude-3' };
    expect(entriesOf([second(), other])).toHaveLength(2);
  });

  it('is not absorbed when it reviews a different question', () => {
    const elsewhere = withPromptData(confirmation(), {
      question: `Review your answers\n ● エディタは？\n   → Vim\n\n${CONFIRMATION_TAIL}`,
    });
    expect(entriesOf([second(), elsewhere])).toHaveLength(2);
  });

  it('is not absorbed over another dialog', () => {
    // A permission dialog between the question and the confirmation means they
    // are not one uninterrupted operation.
    const between = normalMessage('bash', {
      messageType: 'prompt',
      timestamp: new Date(second().timestamp.getTime() + 1_000),
      promptData: {
        type: 'yes_no',
        question: 'Approve Bash?',
        options: ['yes', 'no'],
        status: 'answered',
        answeredBy: 'human',
      } as unknown as ChatMessage['promptData'],
    });
    const entries = entriesOf([second(), between, confirmation()]);
    expect(entries).toHaveLength(3);
    expect(countToolApprovalEntries(entries)).toMatchObject({ approvals: 1, questions: 1, confirmations: 1 });
  });

  it('is not absorbed over a reply, even though the hoist makes them adjacent', () => {
    // `[q2, reply, confirmation]` renders as `[q2, confirmation, reply]` (#2273),
    // so adjacency in the group is not evidence of one operation. The run
    // boundary is taken from the INPUT order, which still has the reply in it.
    const reply = normalMessage('reply', {
      timestamp: new Date(second().timestamp.getTime() + 1_000),
    });
    const messages = [second(), reply, confirmation()];

    const runIds = buildPromptRunIds(messages);
    expect(runIds.get(QUESTION_SET_IDS.second)).not.toBe(runIds.get(QUESTION_SET_IDS.confirmation));

    const rows = buildChatTranscriptRows(messages);
    const [group] = rows.filter((row) => row.kind === 'approvals');
    expect(group.kind === 'approvals' && group.entries).toHaveLength(2);
  });

  it('stands on its own when the question it confirms was never loaded', () => {
    const entries = entriesOf([confirmation()]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'question', phase: 'confirmation' });
    expect(countToolApprovalEntries(entries)).toEqual({
      approvals: 0,
      questions: 0,
      confirmations: 1,
      total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The answerer and the confirmer
// ---------------------------------------------------------------------------

describe('[#2460] who answered and who confirmed', () => {
  it('does not let the confirmer overwrite the answerer', () => {
    const entries = entriesOf(questionSetMessages());
    const [first, second] = entries;

    // Both questions were answered by Auto-Yes, and the SET was submitted by a
    // person. The rank rule would print `human` here — it is `human` > `auto` —
    // and the reader would see a question they never chose an answer to.
    expect(first.outcome).toBe('auto');
    expect(second.outcome).toBe('auto');
    expect(second.confirmationOutcome).toBe('human');
    expect(first.confirmationOutcome).toBeUndefined();
  });

  it('records an auto-submitted set as auto-confirmed', () => {
    const byId = rowsById();
    const auto = withPromptData(byId[QUESTION_SET_IDS.confirmation], { answeredBy: 'auto' });
    const [entry] = entriesOf([byId[QUESTION_SET_IDS.second], auto]);
    expect(entry.confirmationOutcome).toBe('auto');
    expect(entry.outcome).toBe('auto');
  });

  it('keeps a still-open question pending until its row is updated', () => {
    const byId = rowsById();
    const pending = withPromptData(byId[QUESTION_SET_IDS.second], {
      status: 'pending',
      answeredBy: undefined,
      answer: undefined,
    });
    expect(entriesOf([pending])[0].outcome).toBe('pending');
    // The `message_updated` push replaces the row; nothing is cached, so the
    // chip follows.
    expect(entriesOf([byId[QUESTION_SET_IDS.second]])[0].outcome).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// 6. Counting, and what does not change
// ---------------------------------------------------------------------------

describe('[#2460] countToolApprovalEntries', () => {
  it('counts chips per kind, not rows', () => {
    const byId = rowsById();
    const approval = normalMessage('audit', {
      messageType: 'prompt',
      summary: `${PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX} · tool=Bash`,
      timestamp: new Date(QUESTION_SET_TIMESTAMPS.first),
      promptData: {
        type: 'yes_no',
        question: 'Approve Bash?',
        options: ['yes', 'no'],
        status: 'answered',
      } as unknown as ChatMessage['promptData'],
    });

    const entries = entriesOf([approval, ...questionSetMessages()]);
    // Four rows in, three chips out: one approval and two questions, the
    // confirmation folded into the second. `messageIds.length` would say four.
    expect(entries.reduce((n, entry) => n + entry.messageIds.length, 0)).toBe(4);
    expect(countToolApprovalEntries(entries)).toEqual({
      approvals: 1,
      questions: 2,
      confirmations: 0,
      total: 3,
    });
  });

  it('counts an empty group as nothing at all', () => {
    expect(countToolApprovalEntries([])).toEqual({
      approvals: 0,
      questions: 0,
      confirmations: 0,
      total: 0,
    });
  });
});

describe('[#2460] the approval path is untouched', () => {
  it('folds the captured antigravity run exactly as it did before', () => {
    const messages = agyMessages();
    const approvals = messages.filter((m) => m.messageType === 'prompt');
    const entries = entriesOf(messages);

    // The Auto-Yes duplicate pair still folds, and nothing else does.
    expect(entries).toHaveLength(approvals.length - 1);
    expect(countToolApprovalEntries(entries)).toMatchObject({
      approvals: approvals.length - 1,
      questions: 0,
      confirmations: 0,
    });
    expect(entries.some((entry) => entry.isPermissionAudit && entry.outcome === 'auto')).toBe(true);
    expect(entries.find((entry) => entry.messageIds.length === 2)?.outcome).toBe('auto');
  });

  it('keeps the codex audit rows apart', () => {
    const audits = codexMessages().filter((m) => m.messageType === 'prompt');
    expect(entriesOf(audits)).toHaveLength(audits.length);
  });

  it('is pure: neither the rows nor the entries handed in come back changed', () => {
    const messages = questionSetMessages();
    const before = JSON.stringify(messages);
    const entries = messages.map((message) => toToolApprovalEntry(message));
    const entriesBefore = JSON.stringify(entries);

    mergeToolApprovalEntries(entries);
    buildToolApprovalEntries(messages);

    expect(JSON.stringify(messages)).toBe(before);
    expect(JSON.stringify(entries)).toBe(entriesBefore);
  });
});

// ---------------------------------------------------------------------------
// Mutation injection
// ---------------------------------------------------------------------------
//
// Each rule was removed on its own, on 2026-09-11, and both #2460 files were run
// against the mutant (55 tests: this file and
// `tests/unit/components/worktree/ChatTranscript-questions-2460.test.tsx`):
//
//  1. classification — `classifyToolApprovalRow` returning `{ kind: 'approval' }`
//     before it reads anything: 30 failures;
//  2. the tab strip — `stripAskUserQuestionTabs` returning
//     `collapseWhitespace(question)` with no `replace`: 16 failures;
//  3. confirmation absorption — `canAbsorbConfirmation` returning `false`:
//     14 failures;
//  4. outcome separation — the rank rule applied to the confirmation as well as
//     to a duplicate, so `previous.outcome` takes the confirmer's value:
//     4 failures, all of them about who answered;
//  5. the window's inclusive edge — `<` in place of `<=` in `withinWindow`:
//     14 failures, because the reported confirmation sits exactly on it.
//
// A green suite under any of those five is a suite that has stopped asserting
// the Issue.
