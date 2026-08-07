/**
 * Issue #1685: prompt audit trail persistence.
 *
 * Auto-Yes (and /prompt-response) resolve what is on screen, not a stored
 * message, so the prompt they answer may or may not have been saved as a
 * pending chat row yet. `recordAnsweredPrompt` must cover both sides:
 * update-in-place when the row exists, create an already-answered row when the
 * answer landed inside the response poller's interval (the case the Issue is
 * about). `markPendingPromptsAsAnswered` and `getMessages({messageType})` carry
 * the attribution and the read path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createMessage,
  getMessages,
  getMessageById,
  recordAnsweredPrompt,
  markPendingPromptsAsAnswered,
  upsertWorktree,
} from '@/lib/db';
import type { PromptData, Worktree, YesNoPromptData } from '@/types/models';
import { answerablePromptOf } from '../helpers/prompt-type-guards';

const WORKTREE_ID = 'wt-prompt-audit';

function seedWorktree(db: Database.Database): void {
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Prompt Audit',
    path: '/test/prompt-audit',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
}

function yesNoPrompt(question: string): YesNoPromptData {
  return {
    type: 'yes_no',
    question,
    status: 'pending',
    options: ['yes', 'no'],
  };
}

function seedPendingPrompt(
  db: Database.Database,
  question: string,
  overrides: { instanceId?: string; timestamp?: Date } = {}
): string {
  const message = createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: question,
    messageType: 'prompt',
    promptData: yesNoPrompt(question),
    timestamp: overrides.timestamp ?? new Date(),
    cliToolId: 'claude',
    instanceId: overrides.instanceId ?? 'claude',
  });
  return message.id;
}

describe('recordAnsweredPrompt (Issue #1685)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
  });

  afterEach(() => {
    db.close();
  });

  it('marks the matching pending prompt answered in place (no duplicate row)', () => {
    const id = seedPendingPrompt(db, 'Allow tool use?');

    const result = recordAnsweredPrompt(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude',
      promptData: yesNoPrompt('Allow tool use?'),
      answer: 'yes',
      answeredBy: 'auto',
    });

    expect(result.created).toBe(false);
    expect(result.message.id).toBe(id);

    const stored = getMessageById(db, id)!;
    expect(stored.promptData).toMatchObject({
      status: 'answered',
      answer: 'yes',
      answeredBy: 'auto',
      question: 'Allow tool use?',
    });
    expect(answerablePromptOf(stored.promptData)!.answeredAt).toBeTruthy();
    // options from the originally saved prompt survive
    expect((stored.promptData as YesNoPromptData).options).toEqual(['yes', 'no']);

    const prompts = getMessages(db, WORKTREE_ID, { messageType: 'prompt' });
    expect(prompts).toHaveLength(1);
  });

  it('prefers the pending row whose question matches the screen', () => {
    const older = seedPendingPrompt(db, 'Question A?', { timestamp: new Date(Date.now() - 60_000) });
    const newer = seedPendingPrompt(db, 'Question B?');

    const result = recordAnsweredPrompt(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      promptData: yesNoPrompt('Question A?'),
      answer: 'no',
      answeredBy: 'auto',
    });

    expect(result.message.id).toBe(older);
    expect(getMessageById(db, newer)!.promptData!.status).toBe('pending');
  });

  it('falls back to the newest pending row when no question matches', () => {
    seedPendingPrompt(db, 'Question A?', { timestamp: new Date(Date.now() - 60_000) });
    const newer = seedPendingPrompt(db, 'Question B (cleaned differently)?');

    const result = recordAnsweredPrompt(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      promptData: yesNoPrompt('Question B (cleaned slightly differently) ?'),
      answer: 'yes',
      answeredBy: 'auto',
    });

    expect(result.created).toBe(false);
    expect(result.message.id).toBe(newer);
  });

  it('creates an already-answered row when no pending prompt was ever saved (sub-interval race)', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Pick a plan',
      status: 'pending',
      options: [
        { number: 1, label: 'Plan A', isDefault: true },
        { number: 2, label: 'Plan B' },
      ],
    };

    const result = recordAnsweredPrompt(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude-2',
      promptData,
      answer: '1',
      answeredBy: 'auto',
      content: 'Pick a plan\n1. Plan A\n2. Plan B',
    });

    expect(result.created).toBe(true);
    const stored = getMessageById(db, result.message.id)!;
    expect(stored.messageType).toBe('prompt');
    expect(stored.instanceId).toBe('claude-2');
    expect(stored.content).toBe('Pick a plan\n1. Plan A\n2. Plan B');
    expect(stored.promptData).toMatchObject({
      type: 'multiple_choice',
      question: 'Pick a plan',
      status: 'answered',
      answer: '1',
      answeredBy: 'auto',
    });
    expect((stored.promptData as { options: unknown[] }).options).toHaveLength(2);
  });

  it('scopes the pending lookup to the answering instance', () => {
    const otherInstance = seedPendingPrompt(db, 'Same question?', { instanceId: 'codex' });

    const result = recordAnsweredPrompt(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude',
      promptData: yesNoPrompt('Same question?'),
      answer: 'yes',
      answeredBy: 'human',
    });

    // codex's pending prompt is untouched; claude got a fresh audit row
    expect(result.created).toBe(true);
    expect(getMessageById(db, otherInstance)!.promptData!.status).toBe('pending');
  });
});

describe('markPendingPromptsAsAnswered attribution (Issue #1685)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stamps answeredBy: 'terminal' on swept prompts", () => {
    const id = seedPendingPrompt(db, 'Left on screen?');

    const count = markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude');

    expect(count).toBe(1);
    expect(getMessageById(db, id)!.promptData).toMatchObject({
      status: 'answered',
      answer: '(answered via terminal)',
      answeredBy: 'terminal',
    });
  });
});

describe('getMessages messageType filter (Issue #1685)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
    createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'user',
      content: 'do the thing',
      messageType: 'normal',
      timestamp: new Date(Date.now() - 30_000),
      cliToolId: 'claude',
    });
    seedPendingPrompt(db, 'Proceed?');
  });

  afterEach(() => {
    db.close();
  });

  it('returns only prompt rows when messageType is "prompt"', () => {
    const prompts = getMessages(db, WORKTREE_ID, { messageType: 'prompt' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].messageType).toBe('prompt');
    expect(prompts[0].promptData!.question).toBe('Proceed?');
  });

  it('keeps returning everything when the filter is absent', () => {
    expect(getMessages(db, WORKTREE_ID)).toHaveLength(2);
  });

  it('composes with the instance filter', () => {
    seedPendingPrompt(db, 'Other instance?', { instanceId: 'codex' });
    const prompts = getMessages(db, WORKTREE_ID, { messageType: 'prompt', instanceId: 'codex' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].promptData!.question).toBe('Other instance?');
  });
});
