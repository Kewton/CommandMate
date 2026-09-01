/**
 * `markPendingPromptsAsAnswered` reports what it stamped (Issue #2195).
 *
 * Auditing the producers of history rows for #2195 turned up one mutation with
 * no realtime frame behind it: this sweep. It flips every still-pending prompt
 * row of an instance to answered the moment the poller sees the agent has moved
 * on, so a chat surface that was showing "waiting for your answer" keeps showing
 * it until the pane's next `/messages` poll — and #2195 demotes that poll to a
 * 15s fallback, tripling how long the stale card survives.
 *
 * The DB layer does not import the socket; it hands each stamped row back
 * through `onUpdated` and the caller broadcasts. These tests pin the contract
 * that makes such a broadcast possible: a full `ChatMessage` (not just an id),
 * already carrying the new `answered` status, and only for rows that were
 * actually written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createMessage,
  getMessageById,
  markPendingPromptsAsAnswered,
  upsertWorktree,
} from '@/lib/db';
import type { ChatMessage, Worktree, YesNoPromptData } from '@/types/models';

const WORKTREE_ID = 'wt-sweep-2195';

function seedWorktree(db: Database.Database): void {
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Sweep',
    path: '/test/sweep',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
}

function pendingPrompt(question: string): YesNoPromptData {
  return { type: 'yes_no', question, status: 'pending', options: ['yes', 'no'] };
}

function seedPendingPrompt(
  db: Database.Database,
  question: string,
  instanceId = 'claude',
): string {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: question,
    messageType: 'prompt',
    promptData: pendingPrompt(question),
    timestamp: new Date(),
    cliToolId: 'claude',
    instanceId,
  }).id;
}

describe('markPendingPromptsAsAnswered onUpdated (Issue #2195)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
  });

  afterEach(() => {
    db.close();
  });

  it('hands back every stamped row as a broadcastable ChatMessage', () => {
    const first = seedPendingPrompt(db, 'Allow tool use?');
    const second = seedPendingPrompt(db, 'Overwrite the file?');

    const seen: ChatMessage[] = [];
    const count = markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude', (message) => {
      seen.push(message);
    });

    expect(count).toBe(2);
    expect(seen.map((m) => m.id).sort()).toEqual([first, second].sort());
    for (const message of seen) {
      // Everything `useSplitMessages` routes on has to be present, or the pane
      // cannot tell whether the row is its own.
      expect(message.worktreeId).toBe(WORKTREE_ID);
      expect(message.cliToolId).toBe('claude');
      expect(message.instanceId).toBe('claude');
      expect(message.messageType).toBe('prompt');
      expect(message.content).toBeTruthy();
      expect(message.timestamp).toBeInstanceOf(Date);
      // The published copy shows the NEW state, not the pending one it replaced.
      expect(message.promptData).toMatchObject({
        status: 'answered',
        answeredBy: 'terminal',
      });
    }
  });

  it('publishes the same state the row was left in', () => {
    const id = seedPendingPrompt(db, 'Allow tool use?');

    let published: ChatMessage | null = null;
    markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude', (message) => {
      published = message;
    });

    const stored = getMessageById(db, id)!;
    expect(published).not.toBeNull();
    expect(published!.promptData).toEqual(stored.promptData);
  });

  it('reports nothing when no prompt was pending', () => {
    const seen: ChatMessage[] = [];
    const count = markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude', (message) => {
      seen.push(message);
    });

    expect(count).toBe(0);
    expect(seen).toEqual([]);
  });

  it('reports only the swept instance, never a sibling instance of the same tool', () => {
    seedPendingPrompt(db, 'mine?', 'claude-2');
    const sibling = seedPendingPrompt(db, 'theirs?', 'claude-3');

    const seen: ChatMessage[] = [];
    markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude-2', (message) => {
      seen.push(message);
    });

    expect(seen.map((m) => m.instanceId)).toEqual(['claude-2']);
    // And the sibling's row really is untouched, not merely unreported.
    expect(getMessageById(db, sibling)!.promptData).toMatchObject({ status: 'pending' });
  });

  it('still sweeps when no callback is supplied (the pre-#2195 callers)', () => {
    const id = seedPendingPrompt(db, 'Allow tool use?');

    expect(markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude')).toBe(1);
    expect(getMessageById(db, id)!.promptData).toMatchObject({ status: 'answered' });
  });
});
