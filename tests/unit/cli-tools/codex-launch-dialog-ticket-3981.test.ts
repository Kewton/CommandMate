/**
 * Issue #3981 (evidence for the pane-key-writers ledger): codex's launch-time
 * answers to the update and trust dialogs (`CodexTool.waitForReady`, #3952) are
 * typed while the answer holds a ticket of the instance input lock — and not
 * while a send holds the composer.
 *
 * Positive: with a send holding the lock, neither digit goes out until it lets
 * go. Negative: with nothing in the way, both digits go out, each with a ticket.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UPDATE_DIALOG = [
  '✨ Update available! 0.139.0 -> 0.140.0',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  'Press enter to continue',
].join('\n');
const TRUST_DIALOG = ['Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'].join('\n');
const PROMPT = '› ';

const pane = vi.hoisted(() => ({ screen: '', keys: [] as Array<{ key: string; ticket: boolean }> }));

vi.mock('@/lib/tmux/tmux', async () => {
  const lock = await import('@/lib/session/instance-input-lock');
  return {
    hasSession: vi.fn().mockResolvedValue(true),
    createSession: vi.fn(),
    sendKeys: vi.fn(async (session: string, key: string) => {
      pane.keys.push({ key, ticket: lock.currentInstanceInputTicket(session) !== null });
      pane.screen = pane.screen === UPDATE_DIALOG ? TRUST_DIALOG : PROMPT;
    }),
    sendSpecialKey: vi.fn(),
    sendSpecialKeys: vi.fn(),
    capturePane: vi.fn(async () => pane.screen),
    killSession: vi.fn(),
    getSessionWorkingDirectory: vi.fn().mockResolvedValue('/path/to/wt'),
    reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  };
});

import { CodexTool } from '@/lib/cli-tools/codex';
import { CODEX_UPDATE_DIALOG_ENV_VAR } from '@/config/codex-update-dialog-config';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';

const SESSION = 'mcbd-codex-wt3981';

function waitForReady(tool: CodexTool): Promise<void> {
  return (tool as unknown as { waitForReady(s: string, o: { trustHooks: boolean }): Promise<void> }).waitForReady(
    SESSION,
    { trustHooks: false }
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, undefined as unknown as string);
  pane.screen = UPDATE_DIALOG;
  pane.keys = [];
  resetInstanceInputLocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetInstanceInputLocks();
});

describe('[#3981 evidence] codex launch-dialog digits are typed with a ticket', () => {
  it('positive: no digit while a send holds the composer; both after, each with a ticket', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = withInstanceInputLock(SESSION, () => gate);
    const ready = waitForReady(new CodexTool());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pane.keys).toEqual([]);

    release();
    await held;
    await vi.advanceTimersByTimeAsync(10_000);
    await ready;
    expect(pane.keys.map((k) => k.ticket)).toEqual([true, true]);
    expect(pane.keys[1].key).toBe('1');
  });

  it('negative: with nothing in the way, the update answer and the trust "1" go out once each', async () => {
    const ready = waitForReady(new CodexTool());
    await vi.advanceTimersByTimeAsync(10_000);
    await ready;
    expect(pane.keys).toHaveLength(2);
    expect(pane.keys.every((k) => k.ticket)).toBe(true);
  });
});
