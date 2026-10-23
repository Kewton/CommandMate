/**
 * POST /api/worktrees/:id/prompt-response refuses the browser's Auto-Yes
 * (Issue #3821).
 *
 * A body with `origin: 'auto-yes-browser'` (a tab loaded before this release,
 * #3820) is answered 409 with a reason, before the first side effect: no
 * worktree row read, no session check, no structured decision over the
 * agent's API, no keystroke, no ledger record (the id's alias lookup, a read,
 * comes first as for every request). A person's answer (no origin) goes on
 * as before, stops a poller tick under way on the instance, and drops
 * Auto-Yes's decision about the prompt.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const spies = vi.hoisted(() => ({
  getDbInstance: vi.fn(() => ({})),
  getWorktreeById: vi.fn(),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
  getTool: vi.fn(),
  answerViaStructuredDecision: vi.fn(),
  verifyPromptOnScreen: vi.fn(),
  notePromptResponseInLedger: vi.fn(async (_ctx: unknown, _request: unknown, response: unknown) => response),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: spies.getDbInstance }));
vi.mock('@/lib/db', () => ({ getWorktreeById: spies.getWorktreeById }));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: spies.checkSessionOwnership,
  foreignSessionErrorBody: vi.fn(() => ({})),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: spies.getTool }) },
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/structured-decision', () => ({
  answerViaStructuredDecision: spies.answerViaStructuredDecision,
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/frame-verification', () => ({
  verifyPromptOnScreen: spies.verifyPromptOnScreen,
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/ledger-record', () => ({
  notePromptResponseInLedger: spies.notePromptResponseInLedger,
}));

import { POST } from '@/app/api/worktrees/[id]/prompt-response/route';
import { AUTO_YES_BROWSER_ORIGIN } from '@/lib/prompt-response-body-builder';
import {
  clearAutoYesDecisions,
  getAutoYesDecisionRecord,
  recordAutoYesDecision,
} from '@/lib/polling/auto-yes-decision-state';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { getManualAnswerSeq, isManualAnswerHolding } from '@/lib/polling/auto-yes-manual-answer';

const WT = 'wt-3821';

async function post(body: Record<string, unknown>) {
  const response = await POST(
    new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: WT }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The session is running and the agent's API takes the answer. */
function arrangeAnswered(): void {
  spies.getWorktreeById.mockReturnValue({ id: WT, path: `/repo/${WT}`, cliToolId: 'claude' });
  spies.getTool.mockReturnValue({
    name: 'Claude',
    getSessionName: () => `mcbd-claude-${WT}`,
    isRunning: vi.fn(async () => true),
  });
  spies.answerViaStructuredDecision.mockResolvedValue(NextResponse.json({ success: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAutoYesDecisions();
});

describe('[#3821] the browser Auto-Yes origin is refused', () => {
  it('409 with a reason, and nothing read or done', async () => {
    arrangeAnswered();
    const { status, body } = await post({ answer: '1', cliTool: 'claude', origin: AUTO_YES_BROWSER_ORIGIN });

    expect(status).toBe(409);
    expect(body).toEqual(expect.objectContaining({ reason: 'browser-auto-yes-retired' }));
    expect(typeof body.error).toBe('string');
    expect(spies.getWorktreeById).not.toHaveBeenCalled();
    expect(spies.checkSessionOwnership).not.toHaveBeenCalled();
    expect(spies.getTool).not.toHaveBeenCalled();
    expect(spies.answerViaStructuredDecision).not.toHaveBeenCalled();
    expect(spies.verifyPromptOnScreen).not.toHaveBeenCalled();
    expect(spies.notePromptResponseInLedger).not.toHaveBeenCalled();
  });

  it('refused for a plan review and a structured decision alike', async () => {
    arrangeAnswered();
    for (const body of [
      { planReviewAction: 'approve', cliTool: 'command-code', origin: AUTO_YES_BROWSER_ORIGIN },
      { answer: '1', cliTool: 'opencode', origin: AUTO_YES_BROWSER_ORIGIN },
    ]) {
      expect((await post(body)).status).toBe(409);
    }
    expect(spies.answerViaStructuredDecision).not.toHaveBeenCalled();
    expect(spies.getWorktreeById).not.toHaveBeenCalled();
  });

  it('control: a person’s answer (no origin) goes on as before', async () => {
    arrangeAnswered();
    const { status, body } = await post({ answer: '1', cliTool: 'claude' });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(spies.answerViaStructuredDecision).toHaveBeenCalledTimes(1);
    expect(spies.notePromptResponseInLedger).toHaveBeenCalledTimes(1);
  });

  it('control: any other origin is a person’s too', async () => {
    arrangeAnswered();
    expect((await post({ answer: '1', cliTool: 'claude', origin: 'something-else' })).status).toBe(200);
  });

  it('control: a request that fails validation is still a 400, origin or not', async () => {
    expect((await post({ cliTool: 'claude', origin: AUTO_YES_BROWSER_ORIGIN })).status).toBe(400);
  });
});

describe('[#3821] a person’s answer drops Auto-Yes’s decision about the prompt', () => {
  const key = buildCompositeKey(WT, 'claude');
  const decide = () =>
    recordAutoYesDecision(key, {
      state: 'withheld',
      reason: 'unclassified-frame',
      promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
      grant: null,
      epoch: 0,
    });

  it('answered: the decision is gone', async () => {
    arrangeAnswered();
    decide();
    await post({ answer: '1', cliTool: 'claude' });
    expect(getAutoYesDecisionRecord(key)).toBeNull();
  });

  it('answered: a tick under way is no longer current, and the poller holds off the instance', async () => {
    arrangeAnswered();
    const before = getManualAnswerSeq(key);
    await post({ answer: '1', cliTool: 'claude' });
    expect(getManualAnswerSeq(key)).toBe(before + 1);
    expect(isManualAnswerHolding(key)).toBe(true);
  });

  it('control: refused as the browser’s Auto-Yes, no tick is stopped', async () => {
    arrangeAnswered();
    const before = getManualAnswerSeq(key);
    await post({ answer: '1', cliTool: 'claude', origin: AUTO_YES_BROWSER_ORIGIN });
    expect(getManualAnswerSeq(key)).toBe(before);
  });

  it('control: refused as the browser’s Auto-Yes, the decision is left alone', async () => {
    arrangeAnswered();
    decide();
    await post({ answer: '1', cliTool: 'claude', origin: AUTO_YES_BROWSER_ORIGIN });
    expect(getAutoYesDecisionRecord(key)).not.toBeNull();
  });

  it('another instance’s answer leaves this one’s decision', async () => {
    arrangeAnswered();
    decide();
    await post({ answer: '1', cliTool: 'claude', instanceId: 'claude-2' });
    expect(getAutoYesDecisionRecord(key)).not.toBeNull();
  });
});
