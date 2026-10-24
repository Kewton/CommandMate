/**
 * Issue #3881: the chat transcript takes a stored reading as stated, and reads
 * a row without one through its compatibility rules — explicitly, and without
 * turning every unknown old row into a question.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/types/models';
import { PROMPT_READING_VERSION, type PromptReading } from '@/types/prompt-reading';
import { readStoredPromptReading } from '@/lib/detection/prompt-reading';
import {
  PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX,
  toToolApprovalEntry,
} from '@/lib/chat/chat-tool-approvals';

const CONFIRMATION_QUESTION = 'Review your answers ● Which goal? → Speed Ready to submit your answers?';

function row(promptData: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    worktreeId: 'wt',
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-10-24T10:00:00.000Z'),
    messageType: 'prompt',
    cliToolId: 'claude',
    instanceId: 'claude',
    archived: false,
    promptData: promptData as unknown as ChatMessage['promptData'],
    ...extra,
  };
}

function multipleChoice(question: string, labels: string[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'multiple_choice',
    question,
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
    status: 'pending',
    ...patch,
  };
}

function reading(patch: Partial<PromptReading> & Pick<PromptReading, 'kind'>): PromptReading {
  return { version: PROMPT_READING_VERSION, approvalTarget: 'complete', evidence: [], ...patch };
}

describe('[#3881] readStoredPromptReading', () => {
  it('reads a well-formed reading back', () => {
    const stored = reading({ kind: 'confirmation', phase: 'confirmation', evidence: ['confirm-page-reader'], liveRange: { startRow: 3, endRow: 9 } });
    expect(readStoredPromptReading({ reading: stored })).toEqual(stored);
  });

  it.each([
    ['no reading (a row from before #3881)', {}],
    ['not an object', { reading: 'confirmation' }],
    ['another version', { reading: { ...reading({ kind: 'question' }), version: 2 } }],
    ['an unknown kind', { reading: { ...reading({ kind: 'question' }), kind: 'picker' } }],
    ['a phase on a permission', { reading: reading({ kind: 'permission', phase: 'question' }) }],
    ['an unknown completeness', { reading: { ...reading({ kind: 'question' }), approvalTarget: 'partial' } }],
    ['unknown evidence', { reading: { ...reading({ kind: 'question' }), evidence: ['guessed'] } }],
    ['a malformed range', { reading: { ...reading({ kind: 'question' }), liveRange: { startRow: -1, endRow: 2 } } }],
  ])('null for %s', (_name, promptData) => {
    expect(readStoredPromptReading(promptData)).toBeNull();
  });

  it('null for no promptData at all', () => {
    expect(readStoredPromptReading(undefined)).toBeNull();
    expect(readStoredPromptReading(null)).toBeNull();
  });
});

describe('[#3881] a stored reading decides the chip, and the strings do not', () => {
  it('confirmation → a question’s confirmation, even when the strings would say approval', () => {
    const entry = toToolApprovalEntry(row(multipleChoice('should the scope be? → Narrow Ready to submit your answers?', ['Submit', 'Cancel'], {
      reading: reading({ kind: 'confirmation', phase: 'confirmation', evidence: ['confirm-page-reader'] }),
    })));
    expect(entry).toMatchObject({ kind: 'question', phase: 'confirmation', classifiedFrom: 'reading', mergeKey: '' });
  });

  it('question → a question’s question screen, even when the strings carry the confirmation’s structure', () => {
    const entry = toToolApprovalEntry(row(multipleChoice('Ready to submit your answers?', ['Submit answers', 'Cancel'], {
      isAskUserQuestion: true,
      reading: reading({ kind: 'question', phase: 'question', evidence: ['question-picker-chrome'] }),
    })));
    expect(entry).toMatchObject({ kind: 'question', phase: 'question', classifiedFrom: 'reading' });
    expect(entry.label).toBe('Ready to submit your answers?');
  });

  it('permission → an approval, even when the strings carry the confirmation’s structure', () => {
    const entry = toToolApprovalEntry(row(multipleChoice(CONFIRMATION_QUESTION, ['Submit answers', 'Cancel'], {
      reading: reading({ kind: 'permission', evidence: ['permission-option-effect'] }),
    })));
    expect(entry).toMatchObject({ kind: 'approval', classifiedFrom: 'reading' });
    expect(entry.phase).toBeUndefined();
  });

  it('unknown → the default approval chip, not a question guessed out of the text', () => {
    const entry = toToolApprovalEntry(row(multipleChoice(CONFIRMATION_QUESTION, ['Submit answers', 'Cancel'], {
      reading: reading({ kind: 'unknown' }),
    })));
    expect(entry).toMatchObject({ kind: 'approval', classifiedFrom: 'reading' });
  });

  it('a permission audit row stays an approval whatever its reading says', () => {
    const entry = toToolApprovalEntry(row(
      { type: 'yes_no', question: 'Approve Bash?', options: ['yes', 'no'], status: 'answered', reading: reading({ kind: 'question', phase: 'question' }) },
      { summary: `${PERMISSION_REQUEST_ALLOW_SUMMARY_PREFIX} · tool=Bash` },
    ));
    expect(entry.kind).toBe('approval');
    expect(entry.classifiedFrom).toBeUndefined();
  });
});

describe('[#3881] rows without a reading keep the compatibility rules (陰性対照)', () => {
  it('the producer’s isAskUserQuestion flag still makes a question', () => {
    const entry = toToolApprovalEntry(row(multipleChoice('Which goal?', ['Speed', 'Scope'], { isAskUserQuestion: true })));
    expect(entry).toMatchObject({ kind: 'question', phase: 'question' });
    expect(entry.classifiedFrom).toBeUndefined();
  });

  it('the confirmation’s full structure still makes a confirmation', () => {
    const entry = toToolApprovalEntry(row(multipleChoice(CONFIRMATION_QUESTION, ['Submit answers', 'Cancel'])));
    expect(entry).toMatchObject({ kind: 'question', phase: 'confirmation' });
  });

  it('an unknown old row is NOT turned into a question', () => {
    const entry = toToolApprovalEntry(row(multipleChoice('Pick a model', ['gpt-5', 'claude'])));
    expect(entry.kind).toBe('approval');
  });

  it('a reading this version cannot vouch for is read as no reading at all', () => {
    const entry = toToolApprovalEntry(row(multipleChoice(CONFIRMATION_QUESTION, ['Submit answers', 'Cancel'], {
      reading: { ...reading({ kind: 'permission' }), version: 99 },
    })));
    expect(entry).toMatchObject({ kind: 'question', phase: 'confirmation' });
    expect(entry.classifiedFrom).toBeUndefined();
  });
});
