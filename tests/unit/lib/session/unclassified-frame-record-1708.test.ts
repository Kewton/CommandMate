/** @vitest-environment node */

/**
 * Issue #1708: a frame the detection layer could not classify must leave a trace.
 *
 * Both prompt-history writers are gated on `promptDetection.isPrompt === true`
 * (response-checker's pending row, and recordAnsweredPrompt via the Auto-Yes
 * poller / prompt-response route), so a frame that slipped past detection was
 * recorded nowhere. `capture --prompts` answered "No prompt history." for a
 * worker that had been stopped at a visible dialog for 900s, and the only
 * evidence it ever happened was the live pane — for as long as it stayed there.
 *
 * The row this writes has to thread a needle: listed by `capture --prompts`
 * (so `messageType: 'prompt'`), never mistakable for a detected prompt, never
 * answerable, and never swept into "answered" by the stale-prompt cleanup in
 * worktree-status-helper.ts, which fires precisely when `hasActivePrompt` is
 * false — i.e. always, for these rows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, markPendingPromptsAsAnswered, upsertWorktree, createMessage } from '@/lib/db';
import {
  observeUnclassifiedFrame,
  resetUnclassifiedFrameTracking,
  unclassifiedFrameRunCount,
  UNCLASSIFIED_RECORD_DWELL_MS,
} from '@/lib/detection/unclassified-frame-tracker';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import { buildClaudeIdleComposerFrame } from '../../../fixtures/claude-idle-composer';
import type { PromptData, Worktree, YesNoPromptData } from '@/types/models';

const WORKTREE_ID = 'wt-unclassified-1708';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => `${WORKTREE_ID}:claude`),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { answerablePromptOf } from '../../../helpers/prompt-type-guards';

/**
 * A frame status-detector cannot classify: interactive-looking output with no
 * prompt, no thinking indicator and no column-0 `❯` composer, which lands on
 * `running`/`default` — the exact triple Issue #1708 reported.
 */
const UNCLASSIFIED_FRAME = [
  '  Some overlay nothing recognises',
  '  ┃ pick one ┃',
  '  ▸ alpha',
  '  ▸ beta',
].join('\n');

/**
 * A frame that classifies cleanly, so the flag goes away.
 *
 * Issue #1927 replaced `['⏺ done', '', '❯ ']` here. A bare composer row is what
 * §4 D1 stopped accepting as completion evidence — Claude draws `❯` while it
 * generates too — so that frame now reads `ready`/`input_prompt` with no
 * evidence and the flag would never clear. The builder below is the smallest
 * frame carrying Claude's measured completion marker.
 */
const CLASSIFIED_FRAME = buildClaudeIdleComposerFrame();

function seedWorktree(db: Database.Database): void {
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Unclassified',
    path: '/test/unclassified',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
}

function promptRows(db: Database.Database) {
  return getMessages(db, WORKTREE_ID, { limit: 50, cliToolId: 'claude' }).filter(
    m => m.messageType === 'prompt'
  );
}

describe('Issue #1708: unclassified frames reach capture --prompts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
    resetUnclassifiedFrameTracking();
    vi.mocked(captureSessionOutput).mockResolvedValue(UNCLASSIFIED_FRAME);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUnclassifiedFrameTracking();
    db.close();
  });

  it('records nothing until the frame has actually persisted', async () => {
    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    // Guard the premise: if this frame ever starts classifying, the test below
    // would pass for the wrong reason.
    expect(payload.isUnclassifiedActive).toBe(true);
    expect(payload.isPromptWaiting).toBe(false);

    await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS - 1000);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');

    expect(promptRows(db)).toHaveLength(0);
  });

  it('records exactly one row however long the frame dwells', async () => {
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    // Ten more polls, all well past the threshold.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS);
      await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    }

    const rows = promptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptData).toMatchObject({
      type: UNCLASSIFIED_PROMPT_TYPE,
      status: 'unclassified',
      options: [],
      sessionStatusReason: 'running/default',
    });
    // Actionable on its own: a reader has no parsed contents to go on, so the
    // row has to say where the frame itself can still be looked at.
    expect(rows[0].promptData?.question).toContain('capture wt-unclassified-1708 --pane');
  });

  it('arms again for a NEW stall after the frame classifies', async () => {
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    expect(promptRows(db)).toHaveLength(1);

    // The session recovers...
    vi.mocked(captureSessionOutput).mockResolvedValue(CLASSIFIED_FRAME);
    await vi.advanceTimersByTimeAsync(5_000);
    const recovered = await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    expect(recovered.isUnclassifiedActive).toBe(false);

    // ...and stalls again later. That is a second incident, not the same one.
    vi.mocked(captureSessionOutput).mockResolvedValue(UNCLASSIFIED_FRAME);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');

    expect(promptRows(db)).toHaveLength(2);
  });
});

describe('Issue #1708: the stale-prompt sweep must not claim an unclassified row', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
    resetUnclassifiedFrameTracking();
    vi.mocked(captureSessionOutput).mockResolvedValue(UNCLASSIFIED_FRAME);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUnclassifiedFrameTracking();
    db.close();
  });

  it('leaves it untouched while sweeping a genuine pending prompt', async () => {
    // worktree-status-helper.ts calls markPendingPromptsAsAnswered() whenever
    // hasActivePrompt is false — which is ALWAYS true for an unclassified frame,
    // by definition. If the row were `status: 'pending'` it would be stamped
    // "(answered via terminal)" on the very next status poll, and the audit
    // trail would claim someone answered a frame nobody could even read.
    const pending: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      status: 'pending',
      options: ['yes', 'no'],
    };
    createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'assistant',
      content: 'Continue?',
      messageType: 'prompt',
      promptData: pending,
      timestamp: new Date(),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    await buildCurrentOutput(db, WORKTREE_ID, 'claude');
    await vi.advanceTimersByTimeAsync(UNCLASSIFIED_RECORD_DWELL_MS);
    await buildCurrentOutput(db, WORKTREE_ID, 'claude');

    const swept = markPendingPromptsAsAnswered(db, WORKTREE_ID, 'claude', 'claude');
    expect(swept).toBe(1); // the yes_no row, and only it

    const rows = promptRows(db);
    const unclassified = rows.find(
      m => m.promptData?.type === UNCLASSIFIED_PROMPT_TYPE
    );
    expect(unclassified).toBeDefined();
    expect(unclassified!.promptData?.status).toBe('unclassified');
    // Issue #1738: the row is not an answerable prompt at all — the type now
    // says so, which is a stronger statement than `answer` happening to be
    // undefined on a shape that could have carried one.
    expect(answerablePromptOf(unclassified!.promptData)).toBeUndefined();

    const answered = rows.find(
      m => m.promptData?.type === 'yes_no'
    );
    expect(answered!.promptData?.status).toBe('answered');
  });
});

describe('Issue #1708: unclassified dwell tracker', () => {
  beforeEach(() => resetUnclassifiedFrameTracking());

  it('fires once per unbroken run and re-arms after a clear reading', () => {
    const key = 'wt:claude';
    expect(observeUnclassifiedFrame(key, true, 0).shouldRecord).toBe(false);
    expect(observeUnclassifiedFrame(key, true, UNCLASSIFIED_RECORD_DWELL_MS - 1).shouldRecord).toBe(
      false
    );

    const fired = observeUnclassifiedFrame(key, true, UNCLASSIFIED_RECORD_DWELL_MS);
    expect(fired.shouldRecord).toBe(true);
    expect(fired.dwellMs).toBe(UNCLASSIFIED_RECORD_DWELL_MS);

    expect(
      observeUnclassifiedFrame(key, true, UNCLASSIFIED_RECORD_DWELL_MS * 5).shouldRecord
    ).toBe(false);

    observeUnclassifiedFrame(key, false, UNCLASSIFIED_RECORD_DWELL_MS * 6);
    observeUnclassifiedFrame(key, true, UNCLASSIFIED_RECORD_DWELL_MS * 6);
    expect(
      observeUnclassifiedFrame(key, true, UNCLASSIFIED_RECORD_DWELL_MS * 7).shouldRecord
    ).toBe(true);
  });

  it('keys sessions independently', () => {
    observeUnclassifiedFrame('a', true, 0);
    observeUnclassifiedFrame('b', true, UNCLASSIFIED_RECORD_DWELL_MS);
    expect(observeUnclassifiedFrame('a', true, UNCLASSIFIED_RECORD_DWELL_MS).shouldRecord).toBe(true);
    expect(observeUnclassifiedFrame('b', true, UNCLASSIFIED_RECORD_DWELL_MS).shouldRecord).toBe(false);
  });

  it('treats a backwards clock as a fresh start rather than a stuck run', () => {
    observeUnclassifiedFrame('c', true, 10_000);
    const skewed = observeUnclassifiedFrame('c', true, 0);
    expect(skewed.dwellMs).toBe(0);
    expect(skewed.shouldRecord).toBe(false);
  });

  it('survives module re-evaluation via globalThis (dev hot reload)', async () => {
    // Without the globalThis handle, `npm run dev` throws the run away on every
    // hot reload, so the dwell restarts from zero and the record is never
    // written — invisible from the payload, which still reports the flag fine.
    observeUnclassifiedFrame('hot', true, 0);
    vi.resetModules();
    const reloaded = await import('@/lib/detection/unclassified-frame-tracker');

    const verdict = reloaded.observeUnclassifiedFrame(
      'hot',
      true,
      reloaded.UNCLASSIFIED_RECORD_DWELL_MS,
    );
    expect(verdict.shouldRecord).toBe(true);
  });

  it('ages out runs for sessions that stopped being polled', () => {
    // A run normally ends when its session reports a classified frame. It can
    // also end by nobody ever asking again (worktree removed, session killed).
    // Nothing calls back to say so, and this Map is deliberately not registered
    // with resource-cleanup's orphan sweep, so it has to age them out itself.
    observeUnclassifiedFrame('gone', true, 0);
    expect(unclassifiedFrameRunCount()).toBe(1);

    observeUnclassifiedFrame('other', true, 60 * 60 * 1000 + 1);
    expect(unclassifiedFrameRunCount()).toBe(1);
  });
});
