/**
 * Issue #3952: agy's automatic folder-trust Enter — the launch window's
 * (`waitForReady`) and the owed one a later send delivers (`waitForPrompt`) —
 * is a writer of the session's input. Neither runs under a send's lock (the
 * launch is before any send; agy's sends are not under `sendUserMessage`'s
 * lock), so both wait for a send that holds the composer and press only if
 * the trust screen still asks for that key after it. An owed Enter that was not
 * pressed stays owed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn(),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import {
  clearStartupTrust,
  isStartupTrustPending,
  markStartupTrustPending,
} from '@/lib/cli-tools/antigravity-startup-trust';
import { capturePane, sendSpecialKey } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';

const SESSION = 'mcbd-antigravity-wt-3952';
const TRUST = readFileSync(join(resolve(__dirname, '../../fixtures/antigravity-live-2364'), 'trust-dialog.txt'), 'utf8');
const IDLE = readFileSync(join(resolve(__dirname, '../../fixtures/antigravity-live-2478'), 'after-plain-turns.txt'), 'utf8');

let frame = TRUST;
let events: string[] = [];

type Private = { waitForReady(s: string): Promise<void>; waitForPrompt(s: string): Promise<void> };

function holdSend(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = withInstanceInputLock(SESSION, async () => {
    events.push('<send>');
    await new Promise<void>((resolve) => (release = resolve));
  });
  return { release: () => release(), done };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetInstanceInputLocks();
  clearStartupTrust();
  frame = TRUST;
  events = [];
  vi.mocked(capturePane).mockImplementation((async () => frame) as never);
  vi.mocked(sendSpecialKey).mockImplementation((async (_s: string, key: string) => {
    events.push(`key:${key}`);
    frame = IDLE;
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
  clearStartupTrust();
});

describe('agy trust Enter and the input lock (Issue #3952)', () => {
  it('launch window: waits for a send in progress, then presses on the screen still up', async () => {
    const held = holdSend();
    const ready = (new AntigravityTool() as unknown as Private).waitForReady(SESSION);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual(['<send>']);
    held.release();
    await held.done;
    await vi.runAllTimersAsync();
    await ready;
    expect(events).toEqual(['<send>', 'key:Enter']);
  });

  it('positive: launch window, the screen is gone once the send is over — no Enter', async () => {
    const held = holdSend();
    const ready = (new AntigravityTool() as unknown as Private).waitForReady(SESSION);
    await vi.advanceTimersByTimeAsync(3_000);
    frame = IDLE;
    held.release();
    await held.done;
    await vi.runAllTimersAsync();
    await ready;
    expect(events).toEqual(['<send>']);
  });

  it('owed Enter: not pressed while the screen moved under a send, and still owed', async () => {
    markStartupTrustPending(SESSION);
    const held = holdSend();
    const tool = new AntigravityTool() as unknown as Private;
    const waiting = tool.waitForPrompt(SESSION).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    // A screen that is not the trust confirmation (blank), so the re-check says no.
    frame = '';
    held.release();
    await held.done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['<send>']);
    expect(isStartupTrustPending(SESSION)).toBe(true);
    // The screen comes back: the owed Enter is delivered once.
    frame = TRUST;
    await vi.runAllTimersAsync();
    await waiting;
    expect(events).toEqual(['<send>', 'key:Enter']);
    expect(isStartupTrustPending(SESSION)).toBe(false);
  });

  it('negative: nothing holds the composer — the owed Enter is pressed at once', async () => {
    markStartupTrustPending(SESSION);
    const waiting = (new AntigravityTool() as unknown as Private).waitForPrompt(SESSION);
    await vi.runAllTimersAsync();
    await waiting;
    expect(events).toEqual(['key:Enter']);
  });
});
