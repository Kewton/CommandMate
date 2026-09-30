/**
 * The "could not read this dialog" rows stay out of the chat while the agent
 * holds a decision this server can answer by id (Issue #2965).
 *
 * Measured in the 2026-09-28 UAT (TC-06 / TC-07) on OpenCode V2: an approval and
 * a question, both published with their `per_…` / `que_…` id and answerable
 * over the agent's API (#2945), each put an assistant row into the chat — the
 * unclassified-frame row (#1708) after 60 s, and the structured-prompt row
 * (#1725) at once. Both rows mean "nobody could answer this", which was false.
 *
 * The negative controls are the safe side the Issue asks to keep: no id, an
 * expired delivery, or a source without per-decision ids still write the rows.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import {
  resetUnclassifiedFrameTracking,
  UNCLASSIFIED_RECORD_DWELL_MS,
} from '@/lib/detection/unclassified-frame-tracker';
import { UNCLASSIFIED_PROMPT_TYPE, type Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2965';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  ),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordAskUserQuestion,
  reportQuestionPending,
} from '@/lib/session/agent-event-state';
import { hasApiAnswerableDecision } from '@/lib/session/structured-prompt';
import { OPENCODE_QUESTION_TOOL_NAME } from '@/lib/hooks/pending-decision-kind';

const PERMISSION_ID = 'per_0000000000000000000000000';
const QUESTION_ID = 'que_0000000000000000000000000';

/** A frame no rule reads: the floor's `running` / `default`, i.e. unclassified. */
const UNREADABLE_FRAME = ['  Some overlay nothing recognises', '  ▸ alpha', '  ▸ beta'].join('\n');

function seedWorktree(db: Database.Database, cliToolId: CLIToolType): void {
  const worktree: Worktree = {
    id: WT,
    name: 'Answerable',
    path: '/test/answerable',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId,
  };
  upsertWorktree(db, worktree);
}

function notices(db: Database.Database, cliToolId: CLIToolType) {
  return getMessages(db, WT, { limit: 50, cliToolId }).filter(
    (m) =>
      m.messageType === 'prompt' &&
      (m.promptData as { type?: string } | undefined)?.type === UNCLASSIFIED_PROMPT_TYPE,
  );
}

/** A structured approval as the source's ingest records it. */
function openApproval(cliToolId: CLIToolType, decisionId?: string): void {
  recordAgentEvent(WT, cliToolId, cliToolId, {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'ses-1',
    message: 'Edit notes.txt',
    ...(decisionId ? { decisionId } : {}),
  });
}

/** A structured question as the source's ingest records it (#2100). */
function openQuestion(cliToolId: CLIToolType, decisionId: string | null): void {
  const at = Date.now() - 1_000;
  recordAgentEvent(WT, cliToolId, cliToolId, {
    event: 'notification',
    at,
    detail: 'question_prompt',
    sessionId: 'ses-1',
  });
  recordAskUserQuestion(
    WT,
    cliToolId,
    cliToolId,
    {
      questions: [
        {
          question: 'Which color do you prefer?',
          header: 'Color',
          multiSelect: false,
          choices: [
            { label: 'Red', description: 'The color red' },
            { label: 'Blue', description: 'The color blue' },
          ],
        },
      ],
      promptId: decisionId,
    },
    at,
  );
  reportQuestionPending(
    WT,
    cliToolId,
    cliToolId,
    { toolName: OPENCODE_QUESTION_TOOL_NAME, decisionId, detail: 'question_prompt' },
    at,
  );
}

/** Poll once, then once more past the unclassified dwell. */
async function pollPastDwell(cliToolId: CLIToolType) {
  await buildCurrentOutput(db, WT, cliToolId, cliToolId);
  await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS + 1_000);
  return buildCurrentOutput(db, WT, cliToolId, cliToolId);
}

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  db = new Database(':memory:');
  runMigrations(db);
  clearAgentStopEvents();
  resetUnclassifiedFrameTracking();
  vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
});

afterEach(() => {
  vi.useRealTimers();
  clearAgentStopEvents();
  resetUnclassifiedFrameTracking();
  db.close();
});

describe('the predicate', () => {
  it('needs per-decision ids, an id, and a live delivery', () => {
    const live = { id: PERMISSION_ID, deliveryExpired: false };
    expect(hasApiAnswerableDecision('permission-id', [live])).toBe(true);
    expect(hasApiAnswerableDecision('permission-id', [])).toBe(false);
    expect(hasApiAnswerableDecision('permission-id', [{ id: null, deliveryExpired: false }])).toBe(false);
    expect(hasApiAnswerableDecision('permission-id', [{ id: '', deliveryExpired: false }])).toBe(false);
    expect(hasApiAnswerableDecision('permission-id', [{ ...live, deliveryExpired: true }])).toBe(false);
    expect(hasApiAnswerableDecision('tool-call-id', [live])).toBe(false);
    expect(hasApiAnswerableDecision(null, [live])).toBe(false);
  });
});

describe.each(['opencode-v2', 'opencode'] as const)('%s: a pending decision answerable by id', (tool) => {
  beforeEach(() => seedWorktree(db, tool));

  it('writes no notice for an approval, even past the 60 s dwell', async () => {
    openApproval(tool, PERMISSION_ID);
    const payload = await pollPastDwell(tool);
    // Premise: the approval is held, by id, and published as answerable.
    expect(payload.structuredEvents?.pendingDecisions?.map((d) => d.id)).toEqual([PERMISSION_ID]);
    expect(payload.isPromptWaiting).toBe(true);
    expect((payload.promptData as { decisionId?: string | null }).decisionId).toBe(PERMISSION_ID);
    expect(notices(db, tool)).toHaveLength(0);
  });

  it('writes no notice for a question, even past the 60 s dwell', async () => {
    openQuestion(tool, QUESTION_ID);
    const payload = await pollPastDwell(tool);
    expect(payload.structuredEvents?.pendingDecisions?.map((d) => d.id)).toEqual([QUESTION_ID]);
    expect(notices(db, tool)).toHaveLength(0);
  });
});

describe('the safe side: the rows are still written', () => {
  it('for an approval with no id (nothing can address it)', async () => {
    seedWorktree(db, 'opencode-v2');
    openApproval('opencode-v2');
    await pollPastDwell('opencode-v2');
    const rows = notices(db, 'opencode-v2');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.content.includes('published no options'))).toBe(true);
  });

  it('for a question with no id', async () => {
    seedWorktree(db, 'opencode-v2');
    openQuestion('opencode-v2', null);
    await pollPastDwell('opencode-v2');
    expect(notices(db, 'opencode-v2').some((r) => r.content.includes('published no options'))).toBe(true);
  });

  it('for an unreadable frame with no decision pending at all', async () => {
    seedWorktree(db, 'opencode-v2');
    const payload = await pollPastDwell('opencode-v2');
    expect(payload.isUnclassifiedActive).toBe(true);
    const rows = notices(db, 'opencode-v2');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('Unclassified interactive frame');
  });

  it('once the decision is gone and the frame is still unreadable, after a fresh dwell', async () => {
    seedWorktree(db, 'opencode-v2');
    openApproval('opencode-v2', PERMISSION_ID);
    await pollPastDwell('opencode-v2');
    expect(notices(db, 'opencode-v2')).toHaveLength(0);

    // The approval is settled; the pane stays on a frame nobody reads.
    recordAgentEvent(WT, 'opencode-v2', 'opencode-v2', {
      event: 'post_tool_use',
      detail: null,
      at: Date.now(),
      sessionId: 'ses-1',
      decisionId: PERMISSION_ID,
    });
    const after = await buildCurrentOutput(db, WT, 'opencode-v2', 'opencode-v2');
    expect(after.structuredEvents?.pendingDecisions ?? []).toHaveLength(0);
    // The run restarted when the decision went away: not yet 60 s.
    expect(notices(db, 'opencode-v2')).toHaveLength(0);
  });

  it("for Claude, whose source has no per-decision ids", async () => {
    seedWorktree(db, 'claude');
    openApproval('claude', PERMISSION_ID);
    await pollPastDwell('claude');
    expect(notices(db, 'claude').some((r) => r.content.includes('published no options'))).toBe(true);
  });
});
