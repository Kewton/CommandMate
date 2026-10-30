/**
 * Issue #3952 review P2-1: `/prompt-response` and `/respond` hand the sender
 * the read mark taken before THEIR capture — the frame the answer was verified
 * against — not one taken inside `sendPromptAnswer`.
 *
 * A message send admitted and released between that capture and the answer's
 * keys typed at the screen the route verified. With the mark taken inside the
 * sender (after that send was over), the answer saw no send since its "read",
 * did not read the screen again, and typed at whatever was up. Taken before
 * the capture, the send is seen and the screen is read again.
 *
 * Runs the real frame verification, delivery, `screenAtSend` and
 * `sendPromptAnswer`; the capture and the tmux module are stubbed, the lock is
 * the real one.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    delivered.push(enter ? `${keys}<Enter>` : keys);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    delivered.push(...keys);
  }),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

/** The route's capture: returns `frame`, after running `during` (a send that comes and goes). */
const capture = vi.hoisted(() => ({
  frame: '',
  during: null as (() => Promise<void>) | null,
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(async () => {
    if (capture.during) await capture.during();
    return capture.frame;
  }),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { capturePane } from '@/lib/tmux/tmux';
import { instanceInputReadMark, resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { noteManualAnswerStarted } from '@/lib/polling/auto-yes-manual-answer';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { verifyPromptOnScreen } from '@/app/api/worktrees/[id]/prompt-response/frame-verification';
import { sendResolvedAnswer } from '@/app/api/worktrees/[id]/prompt-response/answer-delivery';
import type { PromptResponseContext } from '@/app/api/worktrees/[id]/prompt-response/context';
import type { ValidatedPromptResponse } from '@/app/api/worktrees/[id]/prompt-response/request-validation';
import type { ResolvedAnswer } from '@/app/api/worktrees/[id]/prompt-response/answer-resolution';
import { screenAtSend } from '@/app/api/worktrees/[id]/respond/screen-at-send';
import type Database from 'better-sqlite3';

const WORKTREE_ID = 'wt-3952-mark';
const SESSION = `cm-${WORKTREE_ID}-claude`;

/** claude's y/n confirmation. */
const YES_NO_FRAME = ['some output', '', 'Do you want to proceed? (y/n)', ''].join('\n');
/** The same pane after the send: the confirmation is gone. */
const COMPOSER_FRAME = '❯ ';

/** A message send admitted and released inside the route's capture. */
const sendDuringCapture = async (): Promise<void> => {
  await withInstanceInputLock(SESSION, async () => {
    delivered.push('<send>');
  });
};

const ctx: PromptResponseContext = {
  id: WORKTREE_ID,
  db: null as unknown as Database.Database,
  cliToolId: 'claude',
  instanceId: undefined,
};

const request: ValidatedPromptResponse = {
  answer: 'y',
  useDefault: false,
  cliToolParam: 'claude',
  instanceId: undefined,
  bodyPromptType: undefined,
  bodyDefaultOptionNumber: undefined,
  validSubmitMode: undefined,
  planReviewAction: undefined,
  selectionNumbers: null,
  deferredSelectionError: null,
  origin: undefined,
};

/** Verify, then deliver — the route's two stages, as `route.ts` chains them. */
async function verifyAndDeliver(): Promise<Record<string, unknown> | null> {
  const verification = await verifyPromptOnScreen(ctx, request, SESSION);
  if ('response' in verification) throw new Error('verification refused the frame');
  const verified = verification.value;
  expect(verified.promptCheck?.isPrompt).toBe(true);
  const promptData = verified.promptCheck?.isPrompt ? verified.promptCheck.promptData ?? null : null;
  const resolved = {
    resolution: { input: 'y' },
    effectivePromptData: promptData ?? undefined,
  } as unknown as ResolvedAnswer;
  const failure = await sendResolvedAnswer(
    ctx,
    request,
    SESSION,
    resolved,
    verified.verifiedFrame,
    noteManualAnswerStarted(`${WORKTREE_ID}:claude`),
    promptData,
    verified.readMark,
  );
  return failure === null ? null : ((await failure.json()) as Record<string, unknown>);
}

const ORIGINAL_DIALOG_GATE_ENV = process.env.CM_AUTOYES_DIALOG_GATE;

beforeEach(() => {
  // As auto-yes-poller-input-lock-3952: claude's generic (y/n) is answerable under `legacy`.
  process.env.CM_AUTOYES_DIALOG_GATE = 'claude=legacy';
  delivered = [];
  capture.frame = YES_NO_FRAME;
  capture.during = null;
  vi.mocked(capturePane).mockReset();
  resetInstanceInputLocks();
});

afterEach(() => {
  if (ORIGINAL_DIALOG_GATE_ENV === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = ORIGINAL_DIALOG_GATE_ENV;
  resetInstanceInputLocks();
});

describe('[#3952 review P2-1] /prompt-response: the mark is taken before the verified capture', () => {
  it('positive: a send came and went after the capture, and the prompt is gone — nothing is typed', async () => {
    capture.during = sendDuringCapture;
    vi.mocked(capturePane).mockResolvedValue(COMPOSER_FRAME);
    const body = await verifyAndDeliver();
    expect(body).toMatchObject({ success: false, reason: 'answer_not_delivered' });
    expect(delivered).toEqual(['<send>']);
    expect(capturePane).toHaveBeenCalled();
  });

  it('negative: no send since the capture — answered without a second read', async () => {
    vi.mocked(capturePane).mockResolvedValue(COMPOSER_FRAME);
    const body = await verifyAndDeliver();
    expect(body).toBeNull();
    expect(delivered).toEqual(['y', '<Enter>']);
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('negative: a send came and went, and the prompt is still up — answered', async () => {
    capture.during = sendDuringCapture;
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const body = await verifyAndDeliver();
    expect(body).toBeNull();
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
  });

  it('the route hands the verified mark to the delivery', () => {
    const route = readFileSync(
      path.resolve(__dirname, '../../../src/app/api/worktrees/[id]/prompt-response/route.ts'),
      'utf8',
    );
    expect(route).toContain('verified.readMark,');
  });
});

describe('[#3952 review P2-1] /respond (stored row): the mark is taken before screenAtSend’s capture', () => {
  it('positive: screenAtSend’s mark predates a send inside its capture; the answer reads again and types nothing', async () => {
    const before = instanceInputReadMark();
    capture.during = sendDuringCapture;
    const atSend = await screenAtSend(WORKTREE_ID, 'claude', 'claude');
    expect(atSend.readMark).toBe(before);
    expect(instanceInputReadMark()).not.toBe(before);

    vi.mocked(capturePane).mockResolvedValue(COMPOSER_FRAME);
    const sent = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'y',
      cliToolId: 'claude',
      promptData: atSend.promptData ?? undefined,
      frame: atSend.frame,
      readMark: atSend.readMark,
    });
    await expect(sent).rejects.toMatchObject({ name: 'PromptAnswerNotDeliveredError', skip: 'target-changed' });
    expect(delivered).toEqual(['<send>']);
  });

  it('negative: nothing in between — the mark is the current one', async () => {
    const atSend = await screenAtSend(WORKTREE_ID, 'claude', 'claude');
    expect(atSend.readMark).toBe(instanceInputReadMark());
  });

  it('the route hands that mark to the sender', () => {
    const route = readFileSync(path.resolve(__dirname, '../../../src/app/api/worktrees/[id]/respond/route.ts'), 'utf8');
    expect(route).toContain('readMark: atSend.readMark');
  });
});
