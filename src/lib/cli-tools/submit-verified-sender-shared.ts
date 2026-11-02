/**
 * The shared sender's logger, constants and option types (Issue #4056: split
 * out of `submit-verified-sender.ts`, which re-exports the public ones).
 *
 * Imports nothing from `submit-verified-sender.ts` (no import cycle).
 */

import type { ComposerSpec } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';
import { createLogger } from '@/lib/logger';
import type { PromptSubmitExpected } from '@/lib/session/prompt-submit-receipt';

export const logger = createLogger('cli-tools/submit-verified-sender');

/**
 * Largest body typed as keystrokes (`send-keys -l`); anything longer is pasted
 * (Issue #2464).
 *
 * The limit is the pty's, not tmux's. tmux hands the pane the whole argv —
 * 16,320 bytes arrived intact on tmux 3.5a, and past ~16.3 KB `send-keys`
 * refuses with `command too long`, loudly — but the TUI reads it back in
 * pty-sized pieces, 1,022 bytes each on macOS. Claude Code keeps only the last
 * piece of unbracketed input (`12288 mod 1022` = the 24 bytes that arrived of a
 * 12 KB brief), so a body is only safe as keystrokes while it fits in a single
 * read. Half the smallest read measured leaves room for multi-byte text and for
 * a platform whose reads are shorter.
 */
export const LITERAL_SEND_MAX_BYTES = 512;

/**
 * How often the composer is read while a pasted body is expected to appear in
 * it. Claude, codex, Command Code and agy all drew the pasted body within
 * 60 ms of `paste-buffer` on a 12 KB brief.
 */
export const PASTE_LANDED_POLL_MS = 100;

/** Composer reads before a paste that has not fully appeared is abandoned (2 s). */
export const DEFAULT_PASTE_LANDED_ATTEMPTS = 20;

/**
 * How often the composer is read while a TYPED body is expected to appear in it
 * (Issue #3366). codex draws a burst of keystrokes all at once when the burst
 * ends, so the poll only decides how late after that moment Enter goes in.
 */
export const TYPED_BODY_POLL_MS = 50;

/**
 * Composer reads before a typed body that has not appeared is abandoned (5 s).
 *
 * codex 0.160.0 drew a 539-character body ~2.2 s after `send-keys` — about 4 ms
 * per character — and a typed body is at most {@link LITERAL_SEND_MAX_BYTES},
 * so this is roughly twice the slowest draw measured, for a loaded machine.
 */
export const DEFAULT_TYPED_BODY_ATTEMPTS = 100;

/** Per-command timeout for `load-buffer` / `paste-buffer`, as for every other tmux call. */
export const PASTE_COMMAND_TIMEOUT_MS = 5000;

/**
 * Rows read for the re-check under the input lock (Issue #3945). The same
 * capture `clearComposer` takes for its first read, so on a tool that clears
 * before sending that read is the re-check's frame and no extra read is made.
 */
export const RECHECK_CAPTURE_LINES = 200;

/** How often a send waiting out a carried paste mark reads the composer (Issue #3945). */
export const CARRIED_MARK_POLL_MS = 200;

/** Default bounded recovery Enters (each read back) before giving up (throwing). */
export const DEFAULT_VERIFY_ATTEMPTS = 4;

/**
 * How long a B/F verdict on a session's first prompt waits for the agent's own
 * report of it (Issue #4035). Claude 2.1.314 reported the first prompt 0.66–0.74 s
 * after the send began in all 29 submitted first sends measured; an unsent body
 * was drawn into the composer 0.9–1.7 s after its Enter.
 */
export const PROMPT_REPORT_WAIT_MS = 5000;

/** How often the report and the composer are looked at during that wait. */
export const PROMPT_REPORT_POLL_MS = 100;

/**
 * What the `prompt-unreported` failure says about the body (Issue #4048): the
 * agent's report never came, but that is no proof the body did not go — an
 * environment where only the http `UserPromptSubmit` hook fails still submits
 * it. Kept after the `(Issue #4035)` wording `classifySendFailure` matches.
 */
export const PROMPT_UNREPORTED_RESEND_NOTE =
  'The body may already have been submitted; check the pane (`commandmate capture <worktree-id> --pane`) before resending it.';

/**
 * {@link PROMPT_UNREPORTED_RESEND_NOTE} aimed at the pane the body went to
 * (Issue #4048): with an explicit target its worktree and ` --instance <id>`
 * for a named instance, else ` --agent <tool>` for the tool's primary (the
 * worktree's default agent may be another tool) — the same flags the CLI's
 * own hint (`paneCaptureCommand`) gives. Without a target the note names none.
 */
export function promptUnreportedResendNote(target?: PromptSubmitExpected, cliToolId?: CLIToolType): string {
  if (target === undefined) return PROMPT_UNREPORTED_RESEND_NOTE;
  const instance = target.instanceId
    ? ` --instance ${target.instanceId}`
    : cliToolId !== undefined
      ? ` --agent ${cliToolId}`
      : '';
  return (
    'The body may already have been submitted; check the pane ' +
    `(\`commandmate capture ${target.worktreeId}${instance} --pane\`) before resending it.`
  );
}

export interface SubmitVerifiedSendParams {
  /** tmux session name (already validated by the caller chain). */
  sessionName: string;
  /** Message body to type (sent verbatim, without a trailing newline). */
  message: string;
  /** CLI tool id — selects the tool-specific "generating" detector. */
  cliToolId: CLIToolType;
  /**
   * ms to wait after typing the body before pressing Enter, so the TUI
   * registers the input first. Default: TUI_TEXT_INPUT_WAIT_MS (100). A pasted
   * body waits at least this long too, counted from the paste.
   */
  textInputWaitMs?: number;
  /**
   * The tool's composer description (Issue #1933). Defaults to the tool's own
   * (`resolveComposerSpec`), so every existing call site is unchanged; a tool
   * passes `this.describeComposer()` when it wants its override honoured.
   */
  composer?: ComposerSpec;
  /**
   * Number of Enter presses for the INITIAL submit. Defaults to the composer
   * spec's `submitEnterCount` (1 for every tool but vibe-local, whose IME mode
   * makes the first Enter insert a newline) — see VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS.
   */
  submitEnterCount?: number;
  /** ms between the initial Enter presses when submitEnterCount > 1. */
  interEnterWaitMs?: number;
  /**
   * Bounded recovery Enters while the message is still pending. Default
   * DEFAULT_VERIFY_ATTEMPTS (4). Each is read back, so the pane is read up to
   * one more time than this (Issue #3880).
   */
  verifyAttempts?: number;
  /**
   * ms to wait before each read-back capture. Default
   * TUI_MESSAGE_PROCESSED_WAIT_MS (200). Callers that must stay snappy
   * (terminal route) can lower the attempts/delay to keep the total bounded.
   */
  verifyDelayMs?: number;
  /**
   * Composer reads while waiting for a pasted body (longer than
   * {@link LITERAL_SEND_MAX_BYTES}) to appear in full before Enter.
   * Default DEFAULT_PASTE_LANDED_ATTEMPTS (20, i.e. 2 s at the poll interval).
   */
  pasteLandedAttempts?: number;
  /**
   * Before Enter, wait until the composer shows the TYPED body (Issue #3366).
   *
   * For a TUI that draws fast keystrokes only once they stop arriving (codex's
   * paste burst) and turns an Enter that arrives earlier into a newline. Only a
   * tool whose composer `extractComposerText` can read (claude, codex) takes
   * part; for any other the flag is ignored. A body that does not appear within
   * {@link typedBodyAttempts} reads THROWS before Enter, with nothing submitted.
   * Default false: the fixed {@link textInputWaitMs} alone, as before.
   */
  awaitTypedBody?: boolean;
  /**
   * Composer reads while waiting for a typed body (only with
   * {@link awaitTypedBody}). Default DEFAULT_TYPED_BODY_ATTEMPTS (100, i.e. 5 s
   * at the poll interval).
   */
  typedBodyAttempts?: number;
  /**
   * The instance this send is for (Issue #4048), as the caller knows it. The
   * agent's prompt report and the remembered body are looked up by
   * {@link sessionName}; with a target they are taken only from the entry that
   * both name — a target and a name that disagree prove nothing. Never
   * registers or resets an entry. Omitted, the name alone decides, as before.
   */
  target?: PromptSubmitExpected;
  /**
   * The tool's own "the input prompt is up" test, asked again under the input
   * lock (Issue #4040).
   *
   * A tool's readiness wait runs before the lock, so its "ready" may be stale
   * by the time this send owns the composer: another send went first (a picker
   * it opened may still be up), the session was relaunched, or the pane went
   * back to loading. When given, the newest frame read under the lock — after
   * the carried paste wait — must pass it before any key. A frame that does not
   * is read again for at most {@link INPUT_READINESS_UNDER_LOCK_WAIT_MS} — the
   * captures included: one still running at the deadline is not waited for,
   * and a frame read after it is not taken — each read through
   * {@link recheckComposerBeforeInput}, so a dialog that opens is refused at
   * once (`prompt-waiting`) and the lock let go rather than held for a person.
   * Past that the send THROWS with a `prompt not ready` wording
   * (`not-sent` / `prompt-not-ready`). Omitted, nothing changes.
   */
  readiness?: InputReadiness;
}

/** A tool's readiness test for the frames read under the input lock (Issue #4040). */
export interface InputReadiness {
  /** The tool's name as the refusal message spells it (`copilot`, `Vibe Local`, `OpenCode`). */
  label: string;
  /** Whether `frame` (raw `capture-pane -e` output) shows the input prompt ready for a body. */
  isReady(frame: string): boolean;
}

/**
 * How long a send that owns the input lock keeps re-reading a pane whose input
 * prompt is not up (Issue #4040), the sleeps and the captures together: a
 * `capture-pane` may take up to its own 5 s timeout (`tmux.ts`), so a read
 * still running at the deadline is abandoned rather than awaited. Short on
 * purpose: the tool's own wait (15 s) ran before the lock, and every writer
 * behind this one waits as long. It covers a picker or a redraw finishing just
 * as the lock changed hands.
 */
export const INPUT_READINESS_UNDER_LOCK_WAIT_MS = 2000;

/** How often that wait reads the pane. */
export const INPUT_READINESS_UNDER_LOCK_POLL_MS = 200;
