/**
 * Issue #4134: a Claude process that is already parked on "Make auto mode your
 * default permission mode?" starts no launch, so the launch's answer never
 * reaches it and every send ended in `Prompt detection timeout`. The send answers
 * it No first. Yes rewrites the operator's `permissions.defaultMode`, and the
 * cursor starts there.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { getSessionName, sendMessageToClaude } from '@/lib/session/claude-session';
import { withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';

const WORKTREE = 'wt-4134-send';
const frame = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/claude-auto-default-nudge-4134', `${name}.txt`), 'utf8');
const COMPOSER = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on · ? for shortcuts'].join('\n');

/** A pane that moves on the keys Claude Code 2.1.318 was measured to take; `keys` is what it was given. */
function parkedOnTheDialog(): { keys: string[] } {
  const pane = { keys: [] as string[] };
  let current = frame('cursor-yes');
  vi.mocked(capturePane).mockImplementation(async () => current);
  vi.mocked(sendSpecialKeys).mockImplementation(async (_session, [key]) => {
    pane.keys.push(String(key));
    if (key === 'Down') current = frame('cursor-no');
  });
  vi.mocked(sendKeys).mockImplementation(async () => {
    pane.keys.push(current === frame('cursor-no') ? 'Enter on No' : 'Enter elsewhere');
    current = COMPOSER;
  });
  return pane;
}

async function outcomeOf(send: Promise<void>): Promise<unknown> {
  const settled = send.then(
    () => null,
    (error: unknown) => error
  );
  await vi.runAllTimersAsync();
  return settled;
}

describe('sendMessageToClaude and a process parked on the auto-mode offer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to No, confirms it, and then sends', async () => {
    const pane = parkedOnTheDialog();
    expect(await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'))).toBeNull();
    expect(pane.keys).toEqual(['Down', 'Enter on No']);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
  });

  it('answers the same way inside the send that holds the composer, joining its lock', async () => {
    const pane = parkedOnTheDialog();
    const session = getSessionName(WORKTREE);
    const held = withInstanceInputLock(session, () => sendMessageToClaude(WORKTREE, 'hello'));
    expect(await outcomeOf(held)).toBeNull();
    expect(pane.keys).toEqual(['Down', 'Enter on No']);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
  });

  it('never presses Enter on a cursor that stays on Yes, and says what stopped it, with nothing typed', async () => {
    vi.mocked(capturePane).mockResolvedValue(frame('cursor-yes'));
    const error = await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'));
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys).mock.calls.length).toBeLessThanOrEqual(5);
    expect(String(error)).toMatch(/Make auto mode your default permission mode/);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('types no key at all when the cursor cannot be read', async () => {
    vi.mocked(capturePane).mockResolvedValue(frame('cursor-no').replace('❯', ' '));
    const error = await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'));
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    expect(String(error)).toMatch(/Make auto mode your default permission mode/);
  });

  it('is one read and no key on the composer: a send as before', async () => {
    vi.mocked(capturePane).mockResolvedValue(COMPOSER);
    expect(await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'))).toBeNull();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
  });

  it('leaves a read that fails to the send, which reports what is wrong with the session', async () => {
    vi.mocked(capturePane).mockRejectedValueOnce(new Error('no pane')).mockResolvedValue(COMPOSER);
    expect(await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'))).toBeNull();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
  });

  it('keeps the old timeout for a screen that is not this dialog', async () => {
    vi.mocked(capturePane).mockResolvedValue('Loading');
    const error = await outcomeOf(sendMessageToClaude(WORKTREE, 'hello'));
    expect(String(error)).toMatch(/Prompt detection timeout/);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});
