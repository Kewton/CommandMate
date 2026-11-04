/**
 * Claude Code's "Make auto mode your default permission mode?" at launch
 * (Issue #4134).
 *
 * Claude Code 2.1.318 puts it in front of the composer when the operator's
 * `~/.claude/settings.json` holds a `permissions.defaultMode` other than `auto`
 * and `hasSeenAutoDefaultNudge` is not set. A session start then waited out its
 * 60-second budget and `send` ended in exit 99. The launch answers it the way it
 * answers the folder trust, as a writer of the instance's input lock: one key,
 * then read the screen again.
 *
 * The answer is No, whichever mode that keeps: No writes only
 * `hasSeenAutoDefaultNudge`, Yes writes `permissions.defaultMode: "auto"` to the
 * operator's settings (measured). The cursor starts on Yes, so a screen that does
 * not show it on No gets no Enter (`resolveClaudeAutoDefaultNudgeKey`).
 *
 * Two callers, because a launch ends. {@link answerClaudeAutoDefaultNudgeUntil}
 * runs beside a start; a process already parked on the dialog starts no launch,
 * and is answered by the send that finds it there
 * ({@link answerClaudeAutoDefaultNudgeBeforeSend}).
 *
 * @module lib/cli-tools/claude-auto-default-nudge
 */

import { capturePane, sendKeys, sendSpecialKeys } from '../tmux/tmux';
import { isClaudeAutoDefaultNudgeOpen, resolveClaudeAutoDefaultNudgeKey, stripAnsi } from '../detection/cli-patterns';
import { answerUnderInstanceInputLock, instanceInputLaunchReadMark } from '@/lib/session/instance-input-lock';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/claude-auto-default-nudge');

/** How often the pane is read. The dialog is there for as long as nobody answers. */
const POLL_INTERVAL_MS = 500;

/** Rows read: as the start's own loop. */
const CAPTURE_LINES = 50;

/** Keys one launch may spend. Two are enough; the rest are for a TUI not yet taking keys. */
const MAX_KEYS = 5;

/** Reads one send gives the dialog before it refuses: 10 seconds, as its own prompt wait. */
const BEFORE_SEND_MAX_READS = 20;

/** Read the pane while `start` runs and answer the dialog if it comes up. */
export async function answerClaudeAutoDefaultNudgeUntil(sessionName: string, start: Promise<unknown>): Promise<void> {
  let settled = false;
  const over = Promise.resolve(start).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  let keys = 0;
  while (keys < MAX_KEYS) {
    await Promise.race([over, new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))]);
    if (settled) return;
    const readMark = instanceInputLaunchReadMark();
    let key: ReturnType<typeof resolveClaudeAutoDefaultNudgeKey>;
    try {
      key = resolveClaudeAutoDefaultNudgeKey(stripAnsi(await capturePane(sessionName, { startLine: -CAPTURE_LINES })));
    } catch {
      // The session may not exist yet; the start reports what is wrong with it.
      continue;
    }
    if (key === null) continue;
    if (await sendNudgeKey(sessionName, readMark, key)) keys++;
  }
  logger.warn('claude-auto-default-nudge-unanswered', { sessionName, keys });
}

/**
 * Answer the dialog if this pane is on it, before a send waits for the prompt.
 * One read and no key on any other screen. Inside a send that holds the input
 * lock the keys join it.
 *
 * @throws Error (`prompt not ready`: `not-sent`, nothing typed) when the dialog
 *   stays open: its cursor cannot be read or it does not take the keys. Only the
 *   screen is named, nothing captured.
 */
export async function answerClaudeAutoDefaultNudgeBeforeSend(sessionName: string): Promise<void> {
  let keys = 0;
  for (let reads = 0; reads < BEFORE_SEND_MAX_READS; reads++) {
    const readMark = instanceInputLaunchReadMark();
    let screen: string;
    try {
      screen = stripAnsi(await capturePane(sessionName, { startLine: -CAPTURE_LINES }));
    } catch {
      // The send's own check reports what is wrong with the session.
      return;
    }
    if (!isClaudeAutoDefaultNudgeOpen(screen)) return;
    const key = resolveClaudeAutoDefaultNudgeKey(screen);
    if (key !== null && keys < MAX_KEYS && (await sendNudgeKey(sessionName, readMark, key))) keys++;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  logger.warn('claude-auto-default-nudge-unanswered-at-send', { sessionName, keys });
  throw new Error(
    'Claude Code prompt not ready: "Make auto mode your default permission mode?" is open and did not take its keys. ' +
      'Nothing was typed. Answer it in the terminal: No keeps the current mode'
  );
}

/**
 * One key, as an `exclusive` writer of the input lock, as the folder trust's keys go.
 *
 * @internal Exported for the input lock's evidence test.
 */
export async function sendNudgeKey(sessionName: string, readMark: number, key: 'Down' | 'Up' | 'Enter'): Promise<boolean> {
  try {
    const outcome = await answerUnderInstanceInputLock(
      sessionName,
      readMark,
      async () =>
        resolveClaudeAutoDefaultNudgeKey(stripAnsi(await capturePane(sessionName, { startLine: -CAPTURE_LINES }))) === key,
      () => (key === 'Enter' ? sendKeys(sessionName, '', true) : sendSpecialKeys(sessionName, [key])),
      { mode: 'exclusive' }
    );
    logger.info('claude-auto-default-nudge-key', { sessionName, key, answered: outcome.answered });
    return outcome.answered;
  } catch {
    // Left for a later poll, as the folder trust's key is.
    return false;
  }
}
