/**
 * Issue #4304 F1-a: `captureBoundFrame` and the generation check before a key
 * (design `docs/design/capture-generation-binding-4304.md` §4.1 / §4.2 / §4.8,
 * §6 T4 / T9 / TC-less F1-a rows, TE2 / TE3, the T10 boundary as types, and the
 * plan review's recapture (R6)).
 *
 * The tmux under the code is faked at the process boundary
 * (`fake-pane-tmux.ts`): panes with ids, the server's start time and pid,
 * `pane_dead`, and a pane that is gone. Each `unknown` reason has its positive
 * (no frame) and the same generation its negative (the frame).
 *
 * §6.4: removing ② "capture by `%N`" (back to `=s:`) turns T4 red; removing ③
 * "read again after the capture" turns the during-capture cases red — both were
 * measured by mutating a copy of the source (commit message).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) =>
  (await import('./fake-pane-tmux')).fakePaneChildProcess(importOriginal),
);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({ name: id, getSessionName: (worktreeId: string) => `mcbd-${id}-${worktreeId}` }),
    }),
  },
}));

import { fakePaneTmux } from './fake-pane-tmux';
import {
  captureBoundFrame,
  checkPaneGeneration,
  type BoundCapture,
  type BoundFrame,
  type PaneGeneration,
} from '@/lib/session/cli-session';
import {
  readPaneGeneration,
  readPaneGenerationById,
  samePaneGeneration,
} from '@/lib/tmux/tmux';
import { getCachedCapture, resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { answerCommandCodePlanReview } from '@/app/api/worktrees/[id]/prompt-response/plan-review';
import { readCommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';
import { sendPromptAnswer, type SendPromptAnswerParams } from '@/lib/prompt-answer-sender';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { readFileSync } from 'fs';
import path from 'path';

const S = 'mcbd-claude-wt-4304-bound';

function bound(capture: BoundCapture): BoundFrame {
  if (capture.kind !== 'bound') throw new Error(`expected a bound frame, got ${capture.reason}`);
  return capture;
}

beforeEach(() => {
  fakePaneTmux.reset();
  resetCacheForTesting();
  resetInstanceInputLocks();
});

describe('[#4304 F1-a] readPaneGeneration / readPaneGenerationById', () => {
  it('reads the server start, the server pid, the pane id and pane_dead', async () => {
    const id = fakePaneTmux.addSession(S, 'x');
    expect(await readPaneGeneration(S)).toEqual({
      generation: { serverStartTime: '1794589716', serverPid: '4242', paneId: id },
      dead: false,
    });
    fakePaneTmux.markDead(S);
    expect((await readPaneGenerationById(id))?.dead).toBe(true);
  });

  it('a session or pane that is gone is null (tmux prints an empty line and exits 0, §7.1)', async () => {
    const id = fakePaneTmux.addSession(S, 'x');
    fakePaneTmux.killSession(S);
    expect(await readPaneGeneration(S)).toBeNull();
    expect(await readPaneGenerationById(id)).toBeNull();
    expect(await readPaneGenerationById('not-a-pane')).toBeNull();
  });

  it('TE2 / TE3: the same pane id of a restarted server (another pid or start time) is another generation', () => {
    const g: PaneGeneration = { serverStartTime: '1794589716', serverPid: '4242', paneId: '%0' };
    expect(samePaneGeneration(g, { ...g })).toBe(true);
    expect(samePaneGeneration(g, { ...g, serverPid: '4243' })).toBe(false); // restarted within the same second
    expect(samePaneGeneration(g, { ...g, serverStartTime: '1794589720' })).toBe(false);
    expect(samePaneGeneration(g, { ...g, paneId: '%1' })).toBe(false);
  });
});

describe('[#4304 F1-a] captureBoundFrame — ① generation, ② that pane by id, ③ the same generation again', () => {
  it('negative: the same pane throughout — the frame, its generation and dead=false', async () => {
    const id = fakePaneTmux.addSession(S, 'line 1\nline 2\n');
    const frame = bound(await captureBoundFrame({ sessionName: S }, { lines: 50 }));
    expect(frame.frame).toBe('line 1\nline 2\n');
    expect(frame.generation.paneId).toBe(id);
    expect(frame.dead).toBe(false);
    expect(fakePaneTmux.calls.filter((c) => c.subcommand === 'capture-pane').map((c) => c.target)).toEqual([id]);
  });

  it('negative: an empty screen that was read is a frame, not unknown', async () => {
    fakePaneTmux.addSession(S, '');
    expect(bound(await captureBoundFrame({ sessionName: S })).frame).toBe('');
  });

  it('never reads or writes the display cache', async () => {
    fakePaneTmux.addSession(S, 'screen');
    await captureBoundFrame({ sessionName: S }, { lines: 50 });
    expect(getCachedCapture(S, 50)).toBeNull();
  });

  it('T9 ①: the session is gone — generation-unreadable', async () => {
    expect(await captureBoundFrame({ sessionName: S })).toMatchObject({ kind: 'unknown', reason: 'generation-unreadable' });
  });

  it('T9 ①: an expected generation that is not the session’s — generation-mismatch, nothing captured', async () => {
    const g = fakePaneTmux.addSession(S, 'G');
    const expected = bound(await captureBoundFrame({ sessionName: S })).generation;
    expect(expected.paneId).toBe(g);
    fakePaneTmux.replacePane(S, 'H');
    const before = fakePaneTmux.calls.length;
    expect(await captureBoundFrame({ sessionName: S }, { expected })).toMatchObject({
      kind: 'unknown',
      reason: 'generation-mismatch',
    });
    expect(fakePaneTmux.calls.slice(before).some((c) => c.subcommand === 'capture-pane')).toBe(false);
  });

  it('T4: G was replaced between ① and ② — the capture of %G fails; the successor’s grid is never returned', async () => {
    fakePaneTmux.addSession(S, 'G grid');
    fakePaneTmux.onceBefore('capture-pane', () => {
      fakePaneTmux.replacePane(S, 'H grid');
    });
    expect(await captureBoundFrame({ sessionName: S })).toMatchObject({ kind: 'unknown', reason: 'capture-failed' });
  });

  it('T9 ②: the capture itself fails — capture-failed', async () => {
    fakePaneTmux.addSession(S, 'x');
    fakePaneTmux.onceBefore('capture-pane', () => {
      throw new Error('timed out (test)');
    });
    expect(await captureBoundFrame({ sessionName: S })).toMatchObject({ kind: 'unknown', reason: 'capture-failed' });
  });

  it('T9 ③: the pane is gone once captured — generation-unreadable', async () => {
    fakePaneTmux.addSession(S, 'x');
    fakePaneTmux.onceAfter('capture-pane', () => {
      fakePaneTmux.killSession(S);
    });
    expect(await captureBoundFrame({ sessionName: S })).toMatchObject({ kind: 'unknown', reason: 'generation-unreadable' });
  });

  it('T3 variant (③): the pane died while it was captured — changed-during-capture, not a last screen', async () => {
    fakePaneTmux.addSession(S, 'last words');
    fakePaneTmux.onceAfter('capture-pane', () => {
      fakePaneTmux.markDead(S);
    });
    expect(await captureBoundFrame({ sessionName: S })).toMatchObject({ kind: 'unknown', reason: 'changed-during-capture' });
  });

  it('negative: a pane dead at ① and ③ is a frame with dead=true', async () => {
    fakePaneTmux.addSession(S, 'last words');
    fakePaneTmux.markDead(S);
    const frame = bound(await captureBoundFrame({ sessionName: S }));
    expect(frame.dead).toBe(true);
    expect(frame.frame).toBe('last words');
  });
});

describe('[#4304 F1-a] checkPaneGeneration — the look right before a key', () => {
  it('same / generation-mismatch / pane-dead / generation-unreadable', async () => {
    fakePaneTmux.addSession(S, 'x');
    const g = bound(await captureBoundFrame({ sessionName: S })).generation;
    expect(await checkPaneGeneration(S, g)).toBe('same');
    fakePaneTmux.markDead(S);
    expect(await checkPaneGeneration(S, g)).toBe('pane-dead');
    fakePaneTmux.replacePane(S, 'y');
    expect(await checkPaneGeneration(S, g)).toBe('generation-mismatch');
    fakePaneTmux.killSession(S);
    expect(await checkPaneGeneration(S, g)).toBe('generation-unreadable');
  });
});

describe('[#4304 F1-a] R5 — a caller’s frame binds the answer to its pane', () => {
  it('positive: the caller’s frame is of G, the session shows H — no key, even with H showing the same screen', async () => {
    const g = fakePaneTmux.addSession(S, 'Do you want to proceed? (y/n)');
    const frame = bound(await captureBoundFrame({ sessionName: S }));
    const h = fakePaneTmux.replacePane(S, 'Do you want to proceed? (y/n)');
    const error = await sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', frame }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false, generationCheck: 'generation-mismatch' });
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
  });

  it('TB3: the pane is replaced after the text, before its Enter — the Enter is not sent and keysSent is kept', async () => {
    const g = fakePaneTmux.addSession(S, 'Do you want to proceed? (y/n)');
    const frame = bound(await captureBoundFrame({ sessionName: S }));
    fakePaneTmux.onceAfter('send-keys', () => {
      fakePaneTmux.replacePane(S, 'Do you want to proceed? (y/n)');
    });
    const error = await sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', frame }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'PromptAnswerInputLostError', keysSent: true });
    expect(fakePaneTmux.keysTo(g)).toHaveLength(1);
    expect(fakePaneTmux.keys).toHaveLength(1);
  });

  it('negative: the caller’s frame is of the pane the session shows — the answer goes to it', async () => {
    const g = fakePaneTmux.addSession(S, 'Do you want to proceed? (y/n)');
    const frame = bound(await captureBoundFrame({ sessionName: S }));
    await sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', frame });
    expect(fakePaneTmux.keysTo(g)).toHaveLength(2);
  });
});

describe('[#4304 F1-a] R6 plan review — the overlay read off G is answered at G only', () => {
  const FIXTURES = path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125');
  const INITIAL = readFileSync(path.join(FIXTURES, 'plan-review-1-74-0-initial.txt'), 'utf8');
  const PR = 'mcbd-command-code-wt-4304-plan';
  const state = readCommandCodePlanReviewState(INITIAL)!;

  it('TB1 positive: G replaced by H showing the same review, the same keys — no step is sent', async () => {
    fakePaneTmux.addSession(PR, INITIAL);
    const frame = bound(await captureBoundFrame({ sessionName: PR }));
    const h = fakePaneTmux.replacePane(PR, INITIAL);
    const error = await answerCommandCodePlanReview({
      sessionName: PR,
      state,
      action: 'approve',
      answer: undefined,
      useDefault: false,
      frame,
      recapture: (expected) => captureBoundFrame({ sessionName: PR }, { expected }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
  });

  it('negative: the same pane — the review’s step goes to it', async () => {
    const g = fakePaneTmux.addSession(PR, INITIAL);
    const frame = bound(await captureBoundFrame({ sessionName: PR }));
    const result = await answerCommandCodePlanReview({
      sessionName: PR,
      state,
      action: 'approve',
      answer: undefined,
      useDefault: false,
      frame,
      recapture: (expected) => captureBoundFrame({ sessionName: PR }, { expected }),
    });
    expect(result.sent).toBe(true);
    expect(fakePaneTmux.keysTo(g).length).toBeGreaterThan(0);
  });
});

describe('[#4304 F1-a] T10 — the answer entries take a BoundFrame and nothing else (compile-time)', () => {
  it('a raw string, a hand-made object and a raw capture callback do not type-check', () => {
    const generation: PaneGeneration = { serverStartTime: '1', serverPid: '2', paneId: '%3' };
    const base = { sessionName: S, answer: 'y', cliToolId: 'claude' as const };
    // @ts-expect-error — a raw frame string is not an answer's frame (T10 (1))
    const raw: SendPromptAnswerParams = { ...base, frame: 'screen' };
    // @ts-expect-error — `{ frame, generation }` made by hand is not "confirmed" (T10 (2))
    const handMade: SendPromptAnswerParams = { ...base, frame: { kind: 'bound', sessionName: S, frame: 'x', generation, dead: false, headCut: false } };
    type PlanReviewArgs = Parameters<typeof answerCommandCodePlanReview>[0];
    // @ts-expect-error — the plan review's re-read is a bound capture, not `() => Promise<string>` (T10 (1))
    const recapture: PlanReviewArgs['recapture'] = async () => 'screen';
    expect([raw, handMade, recapture]).toHaveLength(3);
  });
});
