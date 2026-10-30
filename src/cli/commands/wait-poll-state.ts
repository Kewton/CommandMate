/**
 * wait Command - what pollWorktree carries between polls and hands its stages
 * Issue #3964: split out of wait.ts; wait.ts re-exports what it exported.
 */

import type { WaitOptions } from '../types';
import type { ApiClient } from '../utils/api-client';

/**
 * {@link pollWorktree}'s options: {@link WaitOptions} plus the Auto-Yes grace
 * (Issue #2463).
 */
export interface PollWorktreeOptions extends WaitOptions {
  /**
   * `--auto-yes-grace`, in seconds; 0 turns the hold off. Absent means
   * {@link AUTO_YES_GRACE_DEFAULT_SECONDS}, which is what `ask` gets: it calls
   * {@link pollWorktree} without the flag.
   */
  autoYesGrace?: number;
  /**
   * Told the turn this poll has adopted, every poll (Issue #3955).
   *
   * `ask` reads it after a completion to tell whether the turn whose end it
   * waited on had already opened before its own message was sent — the shape
   * of a second `ask` folded into a turn another sender started. Absent for
   * `wait`, which has no send to compare against.
   *
   * `closedAt` is the server's close time for that turn when this poll's
   * published turn is the adopted one, else null: a turn that had already
   * closed before the send is not one the message could have joined.
   */
  onTurnStart?: (turnStartedAt: number | null, closedAt: number | null) => void;
  /**
   * Told the turn record the server published, every poll, whether or not
   * this poll adopts it (Issue #3955).
   *
   * {@link onTurnStart} only ever names an adopted turn, and adoption drops a
   * closed turn that opened more than {@link TURN_ADOPTION_GRACE_MS} before the
   * poll started. A second `ask` that joined such a turn, which then closed
   * before that ask's first poll, would never hear of it. This is the raw
   * record, read only: nothing `wait` decides depends on it.
   */
  onTurnRecord?: (openedAt: number | null, closedAt: number | null) => void;
  /**
   * Epoch ms the command started, from which `--timeout` counts (Issue #3983).
   *
   * `--timeout` is the deadline of the whole command, so the reads before the
   * poll (`--instance` resolution, the task ledger, `ask`'s send) are inside it
   * rather than in front of it. Absent means the poll's own start, as before.
   */
  timeoutStartedAt?: number;
}

/**
 * What {@link pollWorktree} carries from one poll to the next: every variable its
 * loop writes. What the loop only reads stays a `const` there.
 */
export interface PollState {
  lastActivityTime: number;
  lastContent: string;
  /**
   * Issue #1628: whether this wait ever saw the session alive. `!isRunning` on the
   * FIRST poll is "there is nothing here to wait for", not "the agent finished" —
   * reporting SUCCESS for it is how a wait on a worktree whose agent never started
   * (wrong tool, wrong instance, session never created) came back `Completed` in
   * milliseconds and handed a `passed` verdict to whatever ran next.
   */
  everRunning: boolean;
  /**
   * Epoch ms of the first poll in the current unbroken run of
   * `isUnclassifiedActive === true`, or null when the last poll cleared it
   * (Issue #1708).
   */
  unclassifiedSince: number | null;
  /**
   * Epoch ms of the `user_prompt_submit` / `pre_tool_use` / `post_tool_use` this
   * wait adopted as "the turn I am waiting on", or null when the agent has
   * reported none (Issue #1839). See {@link adoptTurnStart}.
   */
  turnStartedAt: number | null;
  /**
   * Whether the chat ledger is still worth asking (Issue #1975). Cleared by the
   * first read that fails, after which this wait judges completion from the
   * frame alone — the pre-#1975 behaviour — rather than re-reporting the same
   * unreachable endpoint on every poll.
   */
  promptLedgerReadable: boolean;
  /**
   * Epoch ms of the first poll in the current unbroken run of an agent-mode
   * prompt the target's Auto-Yes is expected to answer, or null (Issue #2463).
   * Cleared by the first poll that shows no prompt, so every prompt Auto-Yes
   * answers gets a window of its own.
   */
  autoYesAnsweringSince: number | null;
  /**
   * The self-resume hold in progress: the `stop` it is about, and when this wait
   * first held on it (CLI clock). Null when none is (Issue #2614).
   */
  selfResumeHold: { stopAt: number; since: number } | null;
  /** Milliseconds spent in self-resume holds that have already ended (Issue #2614). */
  selfResumeHeldMs: number;
  /** Whether any poll of this wait was held for a self-resume (Issue #2614). */
  selfResumeHeld: boolean;
  /**
   * The orphan turn being held: its `openedAt`, and when this wait first saw it
   * as one (CLI clock). Null when none is (Issue #3429). See
   * {@link releaseOrphanTurn}.
   */
  orphanTurnHold: { openedAt: number; since: number } | null;
}

/**
 * What {@link pollWorktree} hands every stage of a poll and never writes: its
 * `const`s, as {@link PollState} is its variables.
 */
export interface PollContext {
  client: ApiClient;
  worktreeId: string;
  options: PollWorktreeOptions;
  /**
   * Where `--timeout` counts from: {@link PollWorktreeOptions.timeoutStartedAt}
   * when given, else {@link pollStartedAt} (Issue #3983).
   */
  startTime: number;
  /**
   * When this poll began. The turn window (turn adoption, #1975's pending-prompt
   * hold) is about the poll, not about the command, and stays here so that a
   * slow send before an `ask`'s poll does not shift it (Issue #3983).
   */
  pollStartedAt: number;
  autoYesGraceSeconds: number;
  autoYesGraceMs: number;
}
