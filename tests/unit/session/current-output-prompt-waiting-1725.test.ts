/**
 * `buildCurrentOutput` with the open-dialog layer wired in (Issue #1725).
 *
 * The composition rule is OR, and OR is the kind of rule that passes a careless
 * suite while being implemented as AND: assert only "hook says waiting ->
 * waiting" on a frame the scraper already reads as a prompt and the test is
 * green either way. So every case here starts from a frame whose scraper
 * verdict is *known and stated*, and the four corners of the truth table are
 * pinned separately — including both false, which is what proves the layer is
 * not simply always on.
 *
 * The timing case is the one this Issue cannot ship without. Structured facts
 * arrive by push the instant the agent posts them; the scraper reads a pane
 * through a 5 s capture cache. "The event is here and the scraper has not seen
 * the dialog yet" is therefore a state that always exists, and a release rule
 * that treated the scraper's silence as evidence would delete the detection in
 * exactly the situation it was added for.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const createMessage = vi.fn();
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: (...args: unknown[]) => createMessage(...args),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  recordAgentEvent,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const db = {} as Database.Database;

/** A frame the scraper reads as `running`/`default` — no prompt in it at all. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

/** A frame the scraper reads as a `multiple_choice` prompt. */
const PROMPT_FRAME = buildClaude1000RowPermissionFrame();

const NOTIFICATION_MESSAGE = 'Claude needs your permission to use Bash';

function openDialogEvent(at: number = Date.now() - 1_000): void {
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'notification',
    at,
    detail: 'permission_prompt',
    sessionId: 'sess-1',
    message: NOTIFICATION_MESSAGE,
  });
}

function build() {
  return buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
}

/** The `structured-prompt-recorded` history rows written so far. */
function structuredPromptRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, row]) => row as Record<string, unknown>)
    .filter((row) => (row.promptData as { type?: string } | undefined)?.type === UNCLASSIFIED_PROMPT_TYPE)
    .filter((row) => (row.promptData as { source?: string }).source !== undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
});

describe('the OR truth table (Issue #1725)', () => {
  it('scraper=false / structured=false -> not waiting', async () => {
    const payload = await build();

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.promptData).toBeNull();
    expect(payload.sessionStatus).toBe('running');
  });

  it('scraper=false / structured=true -> waiting, with the degraded prompt', async () => {
    openDialogEvent();

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData).toMatchObject({
      type: UNCLASSIFIED_PROMPT_TYPE,
      status: 'pending',
      options: [],
      source: 'notification',
      message: NOTIFICATION_MESSAGE,
    });
    // The payload must not contradict itself: a session a human has to answer
    // is not a session that is busy.
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('hook_permission_prompt');
    expect(payload.thinking).toBe(false);
    expect(payload.isGenerating).toBe(false);
  });

  it('scraper=true / structured=false -> waiting, with the parsed prompt', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.sessionStatus).toBe('waiting');
  });

  it('scraper=true / structured=true -> the parsed prompt wins the payload', async () => {
    // Both layers see it. The one with options is the one a user can answer, so
    // the degraded form must not displace it.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    openDialogEvent();

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
  });

  it('a structured `ready` does not cancel a prompt the scraper can see', async () => {
    // #1723's rule, restated because #1725 could have broken it: the scraper's
    // `waiting` always wins. A `Stop` that arrived while a confirmation screen
    // is still up must not publish `ready`.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: Date.now() - 1_000,
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await build();

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.isPromptWaiting).toBe(true);
  });
});

describe('the push/pull race the OR rule exists for (Issue #1725)', () => {
  it('publishes waiting on the very first poll after the event, before the scraper sees anything', async () => {
    // The capture cache is 5 s and the poll interval is 5 s, so this frame is
    // routinely the pane as it looked *before* the dialog was drawn. Requiring
    // the scraper to agree would lose the detection every time.
    openDialogEvent(Date.now());

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.structuredEvents.promptWaitingSource).toBe('notification');
  });

  it('keeps waiting across polls while the scraper stays blind to the dialog', async () => {
    // The #1708 shape: nothing the detector can parse, for as long as it lasts.
    openDialogEvent();

    for (let i = 0; i < 5; i++) {
      const payload = await build();
      expect(payload.isPromptWaiting).toBe(true);
    }
  });

  it('a scraper that never saw the dialog cannot report it gone', async () => {
    openDialogEvent();
    await build();

    expect(getStructuredPromptWaiting('wt-1', 'claude', 'claude')).not.toBeNull();
  });
});

describe('releasing it from the pane (Issue #1725)', () => {
  it('releases once the scraper has seen the dialog and then seen it gone', async () => {
    openDialogEvent();

    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    const whileOpen = await build();
    expect(whileOpen.isPromptWaiting).toBe(true);

    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    const afterAnswer = await build();

    expect(afterAnswer.isPromptWaiting).toBe(false);
    expect(afterAnswer.promptData).toBeNull();
    expect(afterAnswer.sessionStatus).toBe('running');
    expect(getStructuredPromptWaiting('wt-1', 'claude', 'claude')).toBeNull();
  });

  it('does not resurrect the released dialog on later polls', async () => {
    // The `Notification` is still the newest event after the release. Reading
    // the verdict off that event alone — which is what #1723 declined to do —
    // would put the session back into `waiting` forever.
    openDialogEvent();
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    await build();
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    await build();

    const later = await build();

    expect(later.isPromptWaiting).toBe(false);
    expect(later.sessionStatus).toBe('running');
    expect(later.structuredEvents.lastEventDetail).toBe('permission_prompt');
    expect(later.structuredEvents.promptWaitingSince).toBeNull();
  });

  it('releases on the Stop the agent sends when the turn resumes', async () => {
    openDialogEvent();
    expect((await build()).isPromptWaiting).toBe(true);

    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.sessionStatus).toBe('ready');
  });

  it('expires an uncorroborated PermissionRequest instead of holding the session', async () => {
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', Date.now());
    const immediately = await build();
    expect(immediately.isPromptWaiting).toBe(true);
    expect(immediately.sessionStatusReason).toBe('hook_permission_request');

    // `openPromptWaiting` refreshes rather than replaces, so start the stale
    // episode from a clean state.
    clearAgentStopEvents();
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'Bash', Date.now() - 60_000);

    const later = await build();

    expect(later.isPromptWaiting).toBe(false);
    expect(later.sessionStatus).toBe('running');
  });

  it('leaves a session that is not running alone', async () => {
    openDialogEvent();
    isRunning.mockResolvedValue(false);

    const payload = await build();

    expect(payload.isRunning).toBe(false);
    expect(payload.isPromptWaiting).toBeUndefined();
    expect(payload.structuredEvents.promptWaitingSince).toBeNull();
  });
});

describe('the prompt-history row (Issue #1725, continuing #1708 proposal 2)', () => {
  it('records the dialog the scraper could not see, exactly once', async () => {
    openDialogEvent();

    await build();
    await build();
    await build();

    const rows = structuredPromptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      worktreeId: 'wt-1',
      messageType: 'prompt',
      cliToolId: 'claude',
      instanceId: 'claude',
      promptData: {
        type: UNCLASSIFIED_PROMPT_TYPE,
        // Not `pending`: markPendingPromptsAsAnswered() selects on that, and
        // this row must never be stamped "(answered via terminal)" by a sweep.
        status: 'unclassified',
        source: 'notification',
        options: [],
      },
    });
    expect(String(rows[0].content)).toContain('commandmate respond wt-1 <number>');
  });

  it('writes nothing when the scraper published the prompt itself', async () => {
    // The ordinary prompt writers already record that one, with its options and
    // its answer. A second row would double-count the audit trail and claim a
    // detection gap that did not happen.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    openDialogEvent();

    await build();

    expect(structuredPromptRows()).toHaveLength(0);
  });

  it('writes a second row for a second episode', async () => {
    openDialogEvent();
    await build();

    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: 'sess-1',
    });
    await build();
    openDialogEvent(Date.now());
    await build();

    expect(structuredPromptRows()).toHaveLength(2);
  });

  it('survives a failing insert', async () => {
    createMessage.mockImplementation(() => {
      throw new Error('database is locked');
    });
    openDialogEvent();

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'structured-prompt-record-failed',
      expect.objectContaining({ worktreeId: 'wt-1' }),
    );
  });
});
