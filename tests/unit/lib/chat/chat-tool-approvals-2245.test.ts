/**
 * The approval-chip rules, pinned on the rows that produced Issue #2245.
 *
 * Everything here runs against `tests/fixtures/chat-transcript-2245`, which is a
 * verbatim slice of `GET /api/worktrees/<id>/messages` from two live worktrees.
 * That matters more than usual: the defect was not "prompt rows look wrong", it
 * was that 41 of 50 rows on one worktree and 43 of 50 on another were approval
 * dialogs whose `content` is the whole pane, and a hand-written `{ messageType:
 * 'prompt', content: 'x' }` would let a fix that only handles the tidy case pass.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildToolApprovalEntries,
  isPermissionAuditMessage,
  isToolApprovalMessage,
  mergeToolApprovalEntries,
  toToolApprovalEntry,
  PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX,
  TOOL_APPROVAL_LABEL_MAX_CHARS,
  TOOL_APPROVAL_MERGE_WINDOW_MS,
} from '@/lib/chat/chat-tool-approvals';
import { buildChatTranscriptRows } from '@/lib/chat/chat-transcript-view';
import type { ChatMessage } from '@/types/models';
import {
  agyMessages,
  codexMessages,
  AGY_AUDIT_INDEX,
  AGY_DUPLICATE_PAIR_INDEXES,
} from '@tests/fixtures/chat-transcript-2245';
import { degradedPromptRows } from '@tests/fixtures/chat-transcript-2245/degraded-prompt-rows';

const ESC = String.fromCharCode(0x1b);

function normalMessage(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: 'wt-2245',
    role: 'assistant',
    content: `body ${id}`,
    timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The fixture is what the Issue says it is
// ---------------------------------------------------------------------------

describe('[#2245] the captured rows', () => {
  it('carries scraped dialogs whose body is the pane, shell prompt line and all', () => {
    const prompts = agyMessages().filter(isToolApprovalMessage);
    expect(prompts.length).toBeGreaterThanOrEqual(5);

    const scraped = prompts.filter((m) => !isPermissionAuditMessage(m));
    expect(scraped.length).toBeGreaterThanOrEqual(4);
    // The body starts at the shell prompt that launched the agent, because the
    // producer stores 200 lines / 5,000 characters of pane rather than the dialog.
    expect(scraped.some((m) => m.content.includes("CM_HOOK_URL='http"))).toBe(true);
    expect(scraped.some((m) => m.content.length > 1500)).toBe(true);
  });

  it('carries non-Markdown rows with raw escape sequences in them', () => {
    const withEsc = [...agyMessages(), ...codexMessages()].filter(
      (m) => m.messageType === 'normal' && m.content.includes(ESC),
    );
    expect(withEsc.length).toBeGreaterThanOrEqual(2);
  });

  it('carries the permission hook audit rows, identified only by their summary', () => {
    const audits = codexMessages().filter(isPermissionAuditMessage);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    for (const audit of audits) {
      expect(audit.summary).toMatch(/^PermissionRequest allow · tool=Bash/);
      // The row itself is indistinguishable from a scraped dialog by type.
      expect(audit.messageType).toBe('prompt');
    }
  });

  it('carries the Auto-Yes duplicate: one dialog, two rows, seconds apart', () => {
    const [first, second] = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    const a = first.promptData as { question: string; answeredBy: string; approvalTarget: string };
    const b = second.promptData as { question: string; answeredBy: string; approvalTarget: string };

    expect(a.question).toBe(b.question);
    expect(a.approvalTarget).toBe(b.approvalTarget);
    expect(a.answeredBy).toBe('terminal');
    expect(b.answeredBy).toBe('auto');
    const gap = second.timestamp.getTime() - first.timestamp.getTime();
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(TOOL_APPROVAL_MERGE_WINDOW_MS);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('[#2245] isToolApprovalMessage', () => {
  it('selects prompt rows and nothing else', () => {
    expect(isToolApprovalMessage(normalMessage('n1', { messageType: 'prompt' }))).toBe(true);
    expect(isToolApprovalMessage(normalMessage('n2'))).toBe(false);
    // The answer is short and worth reading; only the dialog is folded.
    expect(isToolApprovalMessage(normalMessage('n3', { messageType: 'prompt_response' }))).toBe(
      false,
    );
    expect(isToolApprovalMessage(undefined)).toBe(false);
    expect(isToolApprovalMessage(null)).toBe(false);
  });
});

describe('[#2245] toToolApprovalEntry', () => {
  it('never puts the row body in the label', () => {
    for (const message of agyMessages().filter(isToolApprovalMessage)) {
      const entry = toToolApprovalEntry(message);
      expect(entry.label).not.toContain("CM_HOOK_URL='http");
      expect(entry.label).not.toContain(ESC);
      expect(entry.label.length).toBeLessThanOrEqual(TOOL_APPROVAL_LABEL_MAX_CHARS);
      // A label that came from the body would be far longer than the question.
      expect(entry.label.length).toBeLessThan(message.content.length);
    }
  });

  it('collapses the dialog’s own wrapping into one line', () => {
    const [scraped] = agyMessages()
      .filter(isToolApprovalMessage)
      .filter((m) => !isPermissionAuditMessage(m));
    expect(scraped.promptData).toBeTruthy();
    expect((scraped.promptData as { question: string }).question).toContain('Requesting permission');
    expect(toToolApprovalEntry(scraped).label).not.toContain('\n');
  });

  it('reads the outcome the row records', () => {
    const [first, second] = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    expect(toToolApprovalEntry(first).outcome).toBe('terminal');
    expect(toToolApprovalEntry(second).outcome).toBe('auto');
  });

  it('calls a row auto-approved because of the summary prefix, not the answeredBy', () => {
    const audit = agyMessages()[AGY_AUDIT_INDEX];
    expect(isPermissionAuditMessage(audit)).toBe(true);
    expect(toToolApprovalEntry(audit)).toMatchObject({ isPermissionAudit: true, outcome: 'auto' });

    // Strip everything the producer writes EXCEPT the prefix: the prefix alone
    // still has to be enough, because it is the only marker the schema gives.
    const prefixOnly: ChatMessage = {
      ...audit,
      summary: `${PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX} · tool=Bash · prompt_id=unknown`,
      promptData: { ...(audit.promptData as object), answeredBy: undefined } as ChatMessage['promptData'],
    };
    expect(toToolApprovalEntry(prefixOnly)).toMatchObject({
      isPermissionAudit: true,
      outcome: 'auto',
    });

    // …and a row that merely mentions the words later in its summary is not one.
    expect(
      isPermissionAuditMessage({ ...audit, summary: 'about the PermissionRequest allow rule' }),
    ).toBe(false);
  });

  it('reports a still-open dialog as pending, and an unreadable frame as unclassified', () => {
    const pending = normalMessage('p', {
      messageType: 'prompt',
      promptData: { type: 'yes_no', question: 'Proceed?', options: ['yes', 'no'], status: 'pending' },
    });
    expect(toToolApprovalEntry(pending).outcome).toBe('pending');
    expect(toToolApprovalEntry(degradedPromptRows[2]).outcome).toBe('unclassified');
  });

  it('survives every degraded promptData shape without throwing', () => {
    // A throw here is a white screen for the whole conversation, so this is the
    // property, not the label text: `isAnswerablePromptData` narrows away two of
    // these shapes and says nothing about `null` or a primitive.
    for (const row of degradedPromptRows) {
      expect(() => toToolApprovalEntry(row)).not.toThrow();
      const entry = toToolApprovalEntry(row);
      expect(typeof entry.label).toBe('string');
      expect(entry.label).not.toContain('pane dump that must never be rendered');
      expect(entry.messageIds).toEqual([row.id]);
    }
    expect(() => buildToolApprovalEntries(degradedPromptRows)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

describe('[#2245] mergeToolApprovalEntries', () => {
  it('folds the Auto-Yes duplicate into one chip and keeps the stronger outcome', () => {
    const pair = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    const merged = buildToolApprovalEntries(pair);

    expect(merged).toHaveLength(1);
    // `terminal` is the sweep's INFERENCE that somebody must have answered;
    // `auto` is a record of the poller actually answering. The record wins.
    expect(merged[0].outcome).toBe('auto');
    expect(merged[0].messageIds).toEqual(pair.map((m) => m.id));
    // The chip keeps the first row's place in the column.
    expect(merged[0].id).toBe(pair[0].id);
    expect(merged[0].timestampMs).toBe(pair[0].timestamp.getTime());
  });

  it('keeps unrelated approvals apart even when they ask the same question', () => {
    // Every codex audit row asks `Approve Bash?`; only `approvalTarget` and the
    // clock tell them apart, and folding them would delete seven commands.
    const audits = codexMessages().filter(isPermissionAuditMessage);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(
      new Set(audits.map((m) => (m.promptData as { question: string }).question)).size,
    ).toBe(1);

    expect(buildToolApprovalEntries(audits)).toHaveLength(audits.length);
  });

  it('will not fold two rows that are outside the window', () => {
    const pair = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    const far: ChatMessage = {
      ...pair[1],
      id: 'far',
      timestamp: new Date(pair[0].timestamp.getTime() + TOOL_APPROVAL_MERGE_WINDOW_MS + 1),
    };
    expect(buildToolApprovalEntries([pair[0], far])).toHaveLength(2);
  });

  it('will not chain past the window one step at a time', () => {
    const pair = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    const base = pair[0].timestamp.getTime();
    const step = Math.round(TOOL_APPROVAL_MERGE_WINDOW_MS * 0.6);
    const chain = [0, 1, 2, 3].map((n) => ({
      ...pair[1],
      id: `chain-${n}`,
      timestamp: new Date(base + n * step),
    }));

    // 0 and 1 fold (0.6 window apart); 2 and 3 are 1.2 and 1.8 windows from the
    // survivor, so they start a chip of their own rather than sliding along.
    const merged = buildToolApprovalEntries(chain);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged[0].messageIds).toEqual(['chain-0', 'chain-1']);
  });

  it('never folds a row that carries no question', () => {
    const anonymous = degradedPromptRows.filter((r) => r.id !== 'deg-structured');
    expect(buildToolApprovalEntries(anonymous)).toHaveLength(anonymous.length);
  });

  it('is pure: the inputs come back untouched', () => {
    const pair = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    const entries = pair.map(toToolApprovalEntry);
    const before = JSON.stringify(entries);
    mergeToolApprovalEntries(entries);
    expect(JSON.stringify(entries)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Rows, and the role headers they decide
// ---------------------------------------------------------------------------

describe('[#2245] buildChatTranscriptRows', () => {
  const user = (id: string) => normalMessage(id, { role: 'user' });
  const assistant = (id: string) => normalMessage(id, { role: 'assistant' });
  const approval = (id: string, question: string, offset = 0) =>
    normalMessage(id, {
      messageType: 'prompt',
      timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, 0) + offset),
      promptData: {
        type: 'multiple_choice',
        question,
        options: [],
        status: 'answered',
        answeredBy: 'terminal',
      } as unknown as ChatMessage['promptData'],
    });

  function assistantHeaderCount(messages: ChatMessage[]): number {
    return buildChatTranscriptRows(messages).filter(
      (row) => row.kind === 'message' && row.showHeader && row.message.role === 'assistant',
    ).length;
  }

  it('collapses a run of approvals into one row and leaves the rest alone', () => {
    const rows = buildChatTranscriptRows([
      user('u1'),
      approval('p1', 'Approve A?'),
      approval('p2', 'Approve B?'),
      approval('p3', 'Approve C?'),
      assistant('a1'),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['message', 'approvals', 'message']);
    const group = rows[1];
    expect(group.kind === 'approvals' && group.entries).toHaveLength(3);
    expect(group.key).toBe('approvals:p1');
  });

  it('starts a new group after a message interrupts the run', () => {
    const rows = buildChatTranscriptRows([
      approval('p1', 'Approve A?'),
      assistant('a1'),
      approval('p2', 'Approve B?'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['approvals', 'message', 'approvals']);
  });

  it('gives every row a key that cannot collide with a message id', () => {
    const rows = buildChatTranscriptRows([approval('p1', 'Approve A?'), assistant('p1-twin')]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[0].key.startsWith('approvals:')).toBe(true);
  });

  it('keeps the Assistant header count identical with and without the chips', () => {
    // The invariant Issue #2245 asks for: a chip group is not an assistant turn,
    // so inserting one must not add or remove a label.
    const withoutChips = [user('u1'), assistant('a1')];
    const withChips = [user('u1'), approval('p1', 'Approve A?'), approval('p2', 'Approve B?'), assistant('a1')];
    expect(assistantHeaderCount(withChips)).toBe(assistantHeaderCount(withoutChips));
    expect(assistantHeaderCount(withChips)).toBe(1);

    const around = [assistant('a1'), approval('p1', 'Approve A?'), assistant('a2')];
    expect(assistantHeaderCount(around)).toBe(assistantHeaderCount([assistant('a1'), assistant('a2')]));
    expect(assistantHeaderCount(around)).toBe(1);
  });

  it('labels the reply that follows a user turn even when chips sit between them', () => {
    // Before #2245 the chip rows WERE assistant bubbles, so the reply read as a
    // continuation of an audit row and lost its label entirely.
    const rows = buildChatTranscriptRows([
      user('u1'),
      approval('p1', 'Approve A?'),
      assistant('a1'),
    ]);
    const reply = rows[rows.length - 1];
    expect(reply.kind === 'message' && reply.showHeader).toBe(true);
  });

  it('folds the captured antigravity transcript down to what is worth reading', () => {
    const messages = agyMessages();
    const rows = buildChatTranscriptRows(messages);
    const approvals = messages.filter(isToolApprovalMessage).length;

    expect(approvals).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => r.kind === 'approvals')).toHaveLength(1);
    expect(rows).toHaveLength(messages.length - approvals + 1);

    const [group] = rows.filter((r) => r.kind === 'approvals');
    // The duplicate pair is folded, so the group carries one chip fewer than
    // there were rows.
    expect(group.kind === 'approvals' && group.entries.length).toBe(approvals - 1);
  });
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

describe('[#2245] worktree.chatTranscript.toolApproval i18n', () => {
  const LOCALES = ['en', 'ja'] as const;
  const KEYS = [
    'summary',
    'expand',
    'collapse',
    'autoApproved',
    'answeredByHuman',
    'answeredInTerminal',
    'awaitingAnswer',
    'unclassified',
    'resolved',
    'unlabeled',
  ];

  function section(locale: string): Record<string, string> {
    const file = path.resolve(process.cwd(), 'locales', locale, 'worktree.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).chatTranscript?.toolApproval;
  }

  for (const locale of LOCALES) {
    it(`${locale} defines every toolApproval key the chip requests`, () => {
      // The global next-intl mock echoes keys back, so the component tests stay
      // green with this whole section missing; `src/i18n.ts` has no fallback, so
      // production would render the literal key inside the chip.
      const dictionary = section(locale);
      expect(dictionary, `${locale}: chatTranscript.toolApproval`).toBeTypeOf('object');
      for (const key of KEYS) {
        expect(dictionary[key], `${locale}: toolApproval.${key}`).toBeTypeOf('string');
        expect(String(dictionary[key]).trim().length).toBeGreaterThan(0);
      }
    });
  }

  it('keeps the count interpolation in both dictionaries', () => {
    for (const locale of LOCALES) {
      expect(section(locale).summary, locale).toContain('{count}');
    }
  });

  it('en and ja declare exactly the same toolApproval keys', () => {
    expect(Object.keys(section('ja')).sort()).toEqual(Object.keys(section('en')).sort());
  });

  it('leaves no English string in the ja dictionary', () => {
    expect(/[぀-ヿ一-鿿]/.test(section('ja').autoApproved)).toBe(true);
    expect(/[぀-ヿ一-鿿]/.test(section('en').autoApproved)).toBe(false);
  });
});
