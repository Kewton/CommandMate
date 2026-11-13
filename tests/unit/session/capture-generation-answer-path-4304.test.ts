/**
 * Issue #4304 F1-a: the answer path acts only on frames of the pane generation
 * it confirmed (design `docs/design/capture-generation-binding-4304.md` G0,
 * §4.4 R4 / R5 / R7, §6 T1–T3 / T6 / T7 / T9 / TB1 / TA1 / TF1, §6.4 (iv) (v)).
 *
 * Everything here goes through entry points the code had before #4304 —
 * `capturePollerFrame`, `sendPromptAnswer` without a frame, the strict read,
 * `captureSessionOutputFresh` — over a tmux faked at the process boundary
 * (`fake-pane-tmux.ts`), so the same file runs against the code before the
 * fix and shows its wrong side effect (a key at the replaced pane, the old
 * frame handed to the answer), and against the fix and shows none. The pane is
 * replaced (a new `%N`) at the exact step each case names.
 *
 * Measured before the fix (develop 7677abe5d): the positive cases below were
 * red; the negative (same generation) cases were green on both.
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
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string) => `mcbd-${id}-${worktreeId}`,
      }),
    }),
  },
}));
// The strict read's payload and observation: built from what the read hands
// the builder — the bound frame when it gives one (#4304), else the display
// capture the builder reads itself (before #4304).
vi.mock('@/lib/session/current-output-builder', async () => {
  const { captureSessionOutput } = await import('@/lib/session/cli-session');
  return {
    buildCurrentOutput: async (
      _db: unknown,
      worktreeId: string,
      cliToolId: 'claude',
      instanceId?: string,
      _resolution?: unknown,
      options?: { boundFrame?: { frame: string } },
    ) => ({
      isRunning: true,
      fullOutput: options?.boundFrame?.frame ?? (await captureSessionOutput(worktreeId, cliToolId, 10000, instanceId)),
    }),
  };
});
vi.mock('@/lib/prompt-observation/session', () => ({ observeSession: () => ({}) }));

import { fakePaneTmux } from './fake-pane-tmux';
import { capturePollerFrame } from '@/lib/polling/auto-yes-poller-capture';
import { captureSessionOutput, captureSessionOutputFresh } from '@/lib/session/cli-session';
import { getCachedCapture, resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { createStrictRespondDeps } from '@/lib/session/strict-prompt-answer-io';
import {
  instanceInputReadMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import type { PromptData } from '@/types/models';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import type Database from 'better-sqlite3';

const WT = 'wt-4304-f1a';
const S = `mcbd-claude-${WT}`;
const CC = `mcbd-command-code-${WT}`;

const PROMPT_G = 'Bash command\n\n  rm -rf build   (pane G)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n';
const PROMPT_H = 'Bash command\n\n  rm -rf build   (pane H)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n';
const IDLE_H = '⏺ Done.   (pane H)\n\n❯ \n';

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

/** A live Claude approval (#1708): both panes show it, so only the pane tells them apart. */
const CLAUDE_APPROVAL = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
  'utf8',
);
const CLAUDE_APPROVAL_PROMPT = assessPromptAnswerability('claude', CLAUDE_APPROVAL).promptCheck?.promptData as PromptData;

const COMMAND_CODE_PERMISSION = readFileSync(
  path.resolve(__dirname, '../../fixtures/command-code-live-2250/dialog-shell-1490.txt'),
  'utf8',
);
const PERMISSION_PROMPT: PromptData = {
  type: 'multiple_choice',
  question: 'Execute Shell Command',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: "Yes, don't ask again for `sleep` commands in this project" },
    { number: 3, label: 'No, tell Command Code what to do differently', requiresTextInput: true },
  ],
  status: 'pending',
};

/** The `display-message` the answer's foreground check (#4303) asks: its last await before the keys pre-#4304. */
const isForegroundRead = (call: { argv: string[] }): boolean =>
  call.argv[call.argv.length - 1]?.includes('pane_current_command') === true;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error: unknown) {
    return { error };
  }
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

// ---------------------------------------------------------------------------
// R4: the Auto-Yes tick's capture (T1 / T2 / T3, §6.4 (iv))
// ---------------------------------------------------------------------------

describe('[#4304 F1-a] R4 — the Auto-Yes tick reads the pane it answers, not the display cache', () => {
  it('T1 positive: a cached frame of the replaced pane G is not the tick’s frame', async () => {
    fakePaneTmux.addSession(S, PROMPT_G);
    await captureSessionOutput(WT, 'claude', 200, 'claude'); // a display reader fills the 5 s cache with G
    fakePaneTmux.replacePane(S, IDLE_H);

    const frame = await capturePollerFrame(WT, 'claude', 200, 'claude');

    expect(frame.raw).not.toContain('(pane G)');
    expect(frame.raw).toContain('(pane H)');
  });

  it('T2 positive: a tick does not join a capture of G still in flight when the pane was replaced', async () => {
    fakePaneTmux.addSession(S, PROMPT_G);
    const gate = deferred();
    // The display capture has read G's grid; Node gets it only once the gate opens.
    fakePaneTmux.onceAfter('capture-pane', () => gate.promise);
    const display = captureSessionOutput(WT, 'claude', 200, 'claude');
    await vi.waitFor(() => expect(fakePaneTmux.calls.some((c) => c.subcommand === 'capture-pane')).toBe(true));
    fakePaneTmux.replacePane(S, IDLE_H);

    const tick = capturePollerFrame(WT, 'claude', 200, 'claude');
    // A tick that joined the in-flight capture would wait for the gate; give it a turn, then open it.
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const frame = await tick;
    await display;

    expect(frame.raw).not.toContain('(pane G)');
    expect(frame.raw).toContain('(pane H)');
  });

  it('T3 positive: a fresh capture of G that completes after the replacement is not served to the tick', async () => {
    fakePaneTmux.addSession(S, PROMPT_G);
    const gate = deferred();
    fakePaneTmux.onceAfter('capture-pane', () => gate.promise);
    const fresh = captureSessionOutputFresh(WT, 'claude', 200, 'claude');
    await vi.waitFor(() => expect(fakePaneTmux.calls.some((c) => c.subcommand === 'capture-pane')).toBe(true));
    fakePaneTmux.replacePane(S, IDLE_H);
    gate.resolve();
    await expect(fresh).resolves.toContain('(pane G)'); // its own caller (a display / F1-b reader) still gets G

    // §6.4 (iv): the late fresh frame is not written back to the display cache.
    expect(getCachedCapture(S, 200)).toBeNull();
    const frame = await capturePollerFrame(WT, 'claude', 200, 'claude');
    expect(frame.raw).toContain('(pane H)');
  });

  it('T7 negative: no replacement — the tick reads the same pane’s frame, as before', async () => {
    fakePaneTmux.addSession(S, PROMPT_G);
    const frame = await capturePollerFrame(WT, 'claude', 200, 'claude');
    expect(frame.raw).toBe(PROMPT_G);
    expect(frame.clean).toContain('Do you want to proceed?');
  });
});

// ---------------------------------------------------------------------------
// R5: right before the first key, on every path (T6 / TB1, §6.4 (v))
// ---------------------------------------------------------------------------

describe('[#4304 F1-a] R5 — no key reaches a pane other than the one the answer was decided for', () => {
  it('TB1 positive (no wait): the pane is replaced at the last read before the keys — none is typed', async () => {
    const g = fakePaneTmux.addSession(S, PROMPT_G);
    let h = '';
    fakePaneTmux.onceBefore('display-message', () => {
      h = fakePaneTmux.replacePane(S, PROMPT_H);
    }, isForegroundRead);

    const result = await settle(
      sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', promptData: YES_NO }),
    );

    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
    expect(result.error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
  });

  it('TB1 positive (joined): an answer inside its own send’s hold of the input reads nothing again — still no key to H', async () => {
    const g = fakePaneTmux.addSession(S, PROMPT_G);
    let h = '';
    fakePaneTmux.onceBefore('display-message', () => {
      h = fakePaneTmux.replacePane(S, PROMPT_H);
    }, isForegroundRead);

    const result = await settle(
      withInstanceInputLock(S, () =>
        sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', promptData: YES_NO }),
      ),
    );

    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
    expect(result.error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
  });

  it('TB1 positive (waited): H shows the same prompt after the wait — the re-read of H is not the answer’s screen', async () => {
    expect(CLAUDE_APPROVAL_PROMPT?.type).toBe('multiple_choice');
    const g = fakePaneTmux.addSession(S, CLAUDE_APPROVAL);
    const readMark = instanceInputReadMark();
    const release = deferred();
    const held = withInstanceInputLock(S, () => release.promise);
    const answering = settle(
      sendPromptAnswer({ sessionName: S, answer: '1', cliToolId: 'claude', promptData: CLAUDE_APPROVAL_PROMPT, readMark }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const h = fakePaneTmux.replacePane(S, CLAUDE_APPROVAL);
    release.resolve();
    await held;
    const result = await answering;

    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
    expect(result.error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
  });

  it('TB1 positive (Enter omitted): a Command Code digit with no input lock is not typed at H', async () => {
    const g = fakePaneTmux.addSession(CC, COMMAND_CODE_PERMISSION);
    let h = '';
    fakePaneTmux.onceBefore('display-message', () => {
      h = fakePaneTmux.replacePane(CC, COMMAND_CODE_PERMISSION);
    }, isForegroundRead);

    const result = await settle(
      sendPromptAnswer({ sessionName: CC, answer: '1', cliToolId: 'command-code', promptData: PERMISSION_PROMPT }),
    );

    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
    expect(result.error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
  });

  it('T9 / TB2 positive: the pane cannot be captured for the guard — no key (it used to fall open)', async () => {
    fakePaneTmux.addSession(CC, COMMAND_CODE_PERMISSION);
    fakePaneTmux.onceBefore('capture-pane', () => {
      throw new Error('capture-pane timed out (test)');
    });
    const result = await settle(
      sendPromptAnswer({ sessionName: CC, answer: '1', cliToolId: 'command-code', promptData: PERMISSION_PROMPT }),
    );
    expect(fakePaneTmux.keys).toEqual([]);
    expect(result.error).toMatchObject({ name: 'PromptAnswerNotDeliveredError', keysSent: false });
  });

  it('T7 negative: the same pane throughout — the same keys as before (text, then Enter)', async () => {
    const g = fakePaneTmux.addSession(S, PROMPT_G);
    await sendPromptAnswer({ sessionName: S, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    const sent = fakePaneTmux.keysTo(g).map((k) => k.argv.slice(k.argv.indexOf('-t') + 2));
    expect(sent).toEqual([['-l', '--', 'y'], ['', 'C-m']]);
  });

  it('T7 negative (waited): the same pane after the wait — the cursor keys go to it, as before', async () => {
    const g = fakePaneTmux.addSession(S, CLAUDE_APPROVAL);
    const readMark = instanceInputReadMark();
    const release = deferred();
    const held = withInstanceInputLock(S, () => release.promise);
    const answering = sendPromptAnswer({ sessionName: S, answer: '1', cliToolId: 'claude', promptData: CLAUDE_APPROVAL_PROMPT, readMark });
    await new Promise((r) => setTimeout(r, 10));
    release.resolve();
    await held;
    await answering;
    expect(fakePaneTmux.keysTo(g).map((k) => k.argv[k.argv.length - 1])).toEqual(['Enter']);
  });

  it('T7 negative (Enter omitted): the same pane — the digit alone, as before', async () => {
    const g = fakePaneTmux.addSession(CC, COMMAND_CODE_PERMISSION);
    await sendPromptAnswer({ sessionName: CC, answer: '1', cliToolId: 'command-code', promptData: PERMISSION_PROMPT });
    const sent = fakePaneTmux.keysTo(g).map((k) => k.argv.slice(k.argv.indexOf('-t') + 2));
    expect(sent).toEqual([['-l', '--', '1']]);
  });
});

// ---------------------------------------------------------------------------
// R7 strict: reads of the pane the answer started on (TA1 / TA4)
// ---------------------------------------------------------------------------

describe('[#4304 F1-a] R7 strict — the reads and keys of one answer stay on its pane', () => {
  const target = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: undefined, sessionName: S, resolvedBy: null };

  it('TA1 positive: after the pane is replaced, the next read is refused, not a read of H', async () => {
    fakePaneTmux.addSession(S, PROMPT_G);
    const deps = createStrictRespondDeps({} as Database.Database, target);
    const first = await deps.read();
    expect(first).toMatchObject({ ok: true });
    expect((first as { frame: string }).frame).toContain('(pane G)');

    fakePaneTmux.replacePane(S, PROMPT_H);
    const second = await deps.read();
    expect(second).toMatchObject({ ok: false, stage: 'capture' });
  });

  it('TA1 positive: a key after the pane was replaced is not sent', async () => {
    const g = fakePaneTmux.addSession(S, PROMPT_G);
    const deps = createStrictRespondDeps({} as Database.Database, target);
    await deps.read();
    const h = fakePaneTmux.replacePane(S, PROMPT_H);
    const result = await settle(deps.sendKey('Enter'));
    expect(result.error).toBeInstanceOf(Error);
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(fakePaneTmux.keysTo(g)).toEqual([]);
  });

  it('TA4 negative: the same pane — every read is of it and the key goes to it', async () => {
    const g = fakePaneTmux.addSession(S, PROMPT_G);
    const deps = createStrictRespondDeps({} as Database.Database, target);
    expect(await deps.read()).toMatchObject({ ok: true, frame: PROMPT_G });
    expect(await deps.read()).toMatchObject({ ok: true, frame: PROMPT_G });
    await deps.sendKey('Enter');
    expect(fakePaneTmux.keysTo(g)).toHaveLength(1);
  });
});
