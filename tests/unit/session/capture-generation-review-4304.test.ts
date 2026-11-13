/**
 * Issue #4304 F1-a, the consistency review of e662dba (P2-1, P2-3, P2-4; P2-2
 * is in `tests/unit/api/prompt-response-strict-3756.test.ts`).
 *
 * The rule each case holds: an answer's keys, its record and the waiting
 * state rest only on the frame — of the same pane generation — the decision was
 * made on; a pane that changed or could not be read ends as "not sent", never
 * as sent, partly sent or a resolved wait. And the display never hands back an
 * older pane's frame after a newer one was read.
 *
 * tmux is faked at the process boundary (`fake-pane-tmux.ts`): panes with ids,
 * replaced at the exact step each case names. Each positive was red on
 * e662dba (commit message); each negative (same pane) is what it was.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

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
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { captureSessionOutput, captureSessionOutputFresh } from '@/lib/session/cli-session';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { walkWithRespond } from '../../../scripts/canary/respond-walk';
import { probeFrame } from '../../../scripts/canary/probe';
import type { Observation, ScenarioDriver } from '../../../scripts/canary/types';
import type { PromptData } from '@/types/models';

const WT = 'wt-4304-review';
const S = `mcbd-claude-${WT}`;

/** A live Claude approval (#1708), the `❯` on option 1. */
const APPROVAL_G = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
  'utf8',
);
/** The same approval on another pane, the `❯` on option 2: one more key is needed for "1". */
const APPROVAL_H = APPROVAL_G.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes, and always', ' ❯ 2. Yes, and always');

function promptOf(frame: string): PromptData {
  const promptData = assessPromptAnswerability('claude', frame).promptCheck?.promptData;
  if (!promptData) throw new Error('fixture is not an answerable prompt');
  return promptData;
}

/** The special keys a pane received, in order. */
function specialKeysTo(paneId: string): string[] {
  return fakePaneTmux
    .keysTo(paneId)
    .flatMap((key) => key.argv.slice(key.argv.indexOf('-t') + 2))
    .filter((arg) => arg !== '-l' && arg !== '--');
}

beforeEach(() => {
  fakePaneTmux.reset();
  resetCacheForTesting();
  resetInstanceInputLocks();
});

afterEach(() => {
  resetCacheForTesting();
  resetInstanceInputLocks();
});

describe('[#4304 review P2-1] a prompt handed over without a frame is read again off the pane the keys go to', () => {
  it('fixture sanity: G and H show the same approval with the cursor on 1 and on 2', () => {
    const g = promptOf(APPROVAL_G);
    const h = promptOf(APPROVAL_H);
    expect(g.type === 'multiple_choice' && g.options.find((o) => o.isDefault)?.number).toBe(1);
    expect(h.type === 'multiple_choice' && h.options.find((o) => o.isDefault)?.number).toBe(2);
  });

  it('positive (sender): decided on G (cursor on 1), the session now shows H (cursor on 2) — the keys are H’s, not G’s', async () => {
    fakePaneTmux.addSession(S, APPROVAL_G);
    const decidedOnG = promptOf(APPROVAL_G);
    const h = fakePaneTmux.replacePane(S, APPROVAL_H);

    await sendPromptAnswer({ sessionName: S, answer: '1', cliToolId: 'claude', promptData: decidedOnG });

    // G's cursor would have made a bare Enter — option 2 on H.
    expect(specialKeysTo(h)).toEqual(['Up', 'Enter']);
  });

  it('positive (sender): the pane shows another prompt, or none — nothing is typed', async () => {
    fakePaneTmux.addSession(S, APPROVAL_G);
    const decidedOnG = promptOf(APPROVAL_G);
    const h = fakePaneTmux.replacePane(S, '⏺ Done.\n\n❯ \n');

    const error = await sendPromptAnswer({ sessionName: S, answer: '1', cliToolId: 'claude', promptData: decidedOnG }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
  });

  it('positive (canary): the pane is replaced after `observe` — the walk answers on the frame it reads, not the observed one', async () => {
    fakePaneTmux.addSession(S, APPROVAL_G);
    let h = '';
    const driver = {
      observe: async (): Promise<Observation> => {
        const at = probeFrame(APPROVAL_G);
        h = fakePaneTmux.replacePane(S, APPROVAL_H);
        return at;
      },
      withProductionTmux: <T>(fn: (sessionName: string) => Promise<T>) => fn(S),
      waitFor: async () => probeFrame(APPROVAL_H),
      log: () => {},
    } as unknown as ScenarioDriver;

    await walkWithRespond(driver, [{ screen: 'approval', answer: '1', next: { label: 'next', reached: () => true } }]);

    expect(specialKeysTo(h)).toEqual(['Up', 'Enter']);
  });

  it('negative: the same pane — the keys are what they were (a bare Enter on the highlighted 1)', async () => {
    const g = fakePaneTmux.addSession(S, APPROVAL_G);
    await sendPromptAnswer({ sessionName: S, answer: '1', cliToolId: 'claude', promptData: promptOf(APPROVAL_G) });
    expect(specialKeysTo(g)).toEqual(['Enter']);
  });
});

describe('[#4304 review P2-4] the display never goes back to an older pane after a newer one was read', () => {
  it('positive: G cached, the pane replaced, a fresh read of H — the next display read is H', async () => {
    fakePaneTmux.addSession(S, 'pane G\n');
    expect(await captureSessionOutput(WT, 'claude', 100, 'claude')).toContain('pane G');
    fakePaneTmux.replacePane(S, 'pane H\n');
    expect(await captureSessionOutputFresh(WT, 'claude', 100, 'claude')).toContain('pane H');

    expect(await captureSessionOutput(WT, 'claude', 100, 'claude')).toContain('pane H');
  });

  it('positive: a display capture of G still in flight when the fresh read of H lands is not joined afterwards', async () => {
    fakePaneTmux.addSession(S, 'pane G\n');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fakePaneTmux.onceAfter('capture-pane', () => gate);
    const inFlight = captureSessionOutput(WT, 'claude', 100, 'claude');
    await vi.waitFor(() => expect(fakePaneTmux.calls.some((c) => c.subcommand === 'capture-pane')).toBe(true));
    fakePaneTmux.replacePane(S, 'pane H\n');
    expect(await captureSessionOutputFresh(WT, 'claude', 100, 'claude')).toContain('pane H');

    const after = captureSessionOutput(WT, 'claude', 100, 'claude');
    release();
    await inFlight;
    expect(await after).toContain('pane H');
    // And the late G is not written back over it.
    expect(await captureSessionOutput(WT, 'claude', 100, 'claude')).toContain('pane H');
  });

  it('negative: no fresh read — the display cache answers as before (one capture for two reads)', async () => {
    fakePaneTmux.addSession(S, 'pane G\n');
    await captureSessionOutput(WT, 'claude', 100, 'claude');
    await captureSessionOutput(WT, 'claude', 100, 'claude');
    expect(fakePaneTmux.calls.filter((c) => c.subcommand === 'capture-pane')).toHaveLength(1);
  });
});
