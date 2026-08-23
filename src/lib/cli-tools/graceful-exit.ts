/**
 * How each tool is asked to quit, and what must be true once it has
 * (Issue #1933, 受入条件 S10 / §13.2).
 *
 * ## The postcondition, and why "the pane is gone" is not all of it
 *
 * Every `killSession()` in this package ends with `tmux kill-session`, so the
 * pane always disappears and every shutdown has always *looked* successful.
 * Two failures hide inside that:
 *
 *  - **`graceful_exit_timeout`** — the TUI never quit and the pane was
 *    destroyed under it. Recoverable (the process dies with the pane) but worth
 *    reporting, because a tool that stops honouring its own exit command is
 *    otherwise invisible: `COPILOT_EXIT_WAIT_MS` had to be raised from 500 to
 *    3000 in #1905 precisely because every sample of copilot 1.0.80's shutdown
 *    (1.006 s … 2.193 s) was past the generic window, i.e. the tmux kill had
 *    been landing mid-shutdown for every copilot session, silently.
 *  - **`port_orphaned`** — opencode's TUI *is* an HTTP server once it is given
 *    `--port` (#1758 §5.1.2), and `lib/hooks/sources/opencode/ports` hands the
 *    number to the next instance that asks. If the server outlives the pane,
 *    that next instance's subscription attaches to the OLD server: its events
 *    are then filed against the wrong worktree, with no error anywhere. The
 *    port is only safe to reuse once `/global/health` stops answering.
 *
 * {@link verifyGracefulExit} is the check, with both probes injected so it can
 * be driven without tmux and without a socket.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not execute {@link GracefulExitSpec.keys}. The seven `killSession()`
 * implementations keep sending their own measured sequences, and
 * `tests/unit/cli-tools/graceful-exit-conformance-1933.test.ts` pins that what
 * they actually send equals what they declare here. Routing them through a
 * shared executor would change the argv of calls that
 * `tests/unit/api/kill-session-cli-tool-gateway-1905.test.ts` pins by exact
 * arity — a file outside this Issue's scope — for no behavioural gain: the exit
 * strings (`/exit`, `/quit`) are tool-owned constants, not tmux key names, so
 * `-l` changes not one byte for them. The user-typed message body, which is the
 * string that *does* change, went through `-l` in this same commit.
 *
 * @module lib/cli-tools/graceful-exit
 */

import { COPILOT_TEXT_INPUT_DELAY_MS } from '@/config/copilot-constants';
import {
  COPILOT_EXIT_WAIT_MS,
  OPENCODE_EXIT_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  TUI_INTERRUPT_SETTLE_MS,
  TUI_TEXT_INPUT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import {
  keyStep,
  literalStep,
  type GracefulExitSpec,
  type GracefulExitVerdict,
} from '@/types/cli-tool-contracts';
import type { CLIToolType } from './types';

/** The graceful exit command copilot's TUI accepts. */
export const COPILOT_EXIT_COMMAND_TEXT = '/exit';

/** The graceful exit command opencode's TUI accepts. */
export const OPENCODE_EXIT_COMMAND_TEXT = '/exit';

/** The graceful exit command gemini's TUI accepts. */
export const GEMINI_EXIT_COMMAND_TEXT = '/quit';

/**
 * A literal whose Enter is part of the same tmux write.
 *
 * `send-keys -t X '/quit' 'C-m'` and `send-keys -t X -l -- '/quit\r'` put the
 * identical six bytes (`2f 71 75 69 74 0d`) into the pty in one write —
 * measured on tmux 3.5a, private socket, `cat` on a raw pty. So a tool that
 * still batches its exit command is described faithfully by a single literal
 * step ending in CR, and nothing has to be modelled as "a literal that is
 * secretly not literal".
 */
function submittedLiteral(text: string, delayAfterMs?: number) {
  return literalStep(`${text}\r`, delayAfterMs);
}

/**
 * The claude-shaped default, which is also `BaseCLITool`'s: one Ctrl-D, then
 * the generic TUI shutdown window.
 */
export const DEFAULT_GRACEFUL_EXIT_SPEC: GracefulExitSpec = {
  keys: [keyStep('C-d')],
  exitWaitMs: TUI_EXIT_WAIT_MS,
  ownsLoopbackServer: false,
};

/**
 * Per-tool exit descriptions.
 *
 * Every sequence is what the tool's `killSession()` already sends; the
 * conformance suite is what keeps that true.
 */
const GRACEFUL_EXIT_SPECS: Record<CLIToolType, GracefulExitSpec> = {
  claude: DEFAULT_GRACEFUL_EXIT_SPEC,
  codex: DEFAULT_GRACEFUL_EXIT_SPEC,
  antigravity: DEFAULT_GRACEFUL_EXIT_SPEC,

  // Ctrl-C to abandon anything running, a settle, then `/quit` submitted in one
  // write (gemini is the one tool still on the pre-#1471 batched form).
  gemini: {
    keys: [
      keyStep('C-c', TUI_INTERRUPT_SETTLE_MS),
      submittedLiteral(GEMINI_EXIT_COMMAND_TEXT),
    ],
    exitWaitMs: TUI_EXIT_WAIT_MS,
    ownsLoopbackServer: false,
  },

  // Two Ctrl-Cs: the first interrupts, the second exits.
  'vibe-local': {
    keys: [keyStep('C-c', TUI_INTERRUPT_SETTLE_MS), keyStep('C-c')],
    exitWaitMs: TUI_EXIT_WAIT_MS,
    ownsLoopbackServer: false,
  },

  // Ctrl-C, then `/exit` typed and submitted as SEPARATE tmux commands. The
  // 3000 ms window is copilot's own: every measured shutdown of 1.0.80 (1.006 /
  // 1.109 / … / 2.193 s) is past the generic 500 (#1905).
  copilot: {
    keys: [
      keyStep('C-c', TUI_INTERRUPT_SETTLE_MS),
      literalStep(COPILOT_EXIT_COMMAND_TEXT, COPILOT_TEXT_INPUT_DELAY_MS),
      keyStep('Enter'),
    ],
    exitWaitMs: COPILOT_EXIT_WAIT_MS,
    ownsLoopbackServer: false,
  },

  // `/exit` typed and submitted separately, because the batched form does not
  // exit at all: typing `/` opens the command palette and the `C-m` arriving in
  // the same tmux command is consumed by it, leaving `/exit` in the composer
  // 10.8 s later, 2 runs out of 2 (#1905).
  opencode: {
    keys: [
      literalStep(OPENCODE_EXIT_COMMAND_TEXT, TUI_TEXT_INPUT_WAIT_MS),
      keyStep('Enter'),
    ],
    exitWaitMs: OPENCODE_EXIT_WAIT_MS,
    ownsLoopbackServer: true,
  },
};

/**
 * The graceful-exit description for a CLI tool.
 *
 * @param cliToolId - CLI tool identifier
 * @returns That tool's {@link GracefulExitSpec}
 */
export function resolveGracefulExitSpec(cliToolId: CLIToolType): GracefulExitSpec {
  return GRACEFUL_EXIT_SPECS[cliToolId] ?? DEFAULT_GRACEFUL_EXIT_SPEC;
}

/** What {@link verifyGracefulExit} needs in order to decide. */
export interface GracefulExitProbe {
  /** Whether the tmux session still exists. */
  sessionAlive(): Promise<boolean>;
  /**
   * Whether the tool's loopback server is still answering, or null when the
   * tool owns none / no port was ever allocated.
   *
   * Only consulted once the session is gone: a server answering while its pane
   * is still up is not an orphan, it is a running agent.
   */
  portAnswering?: (() => Promise<boolean>) | null;
  /** Bounded re-checks, INCLUDING the first. Default 1 — one check, no polling. */
  attempts?: number;
  /** ms between re-checks. Ignored when `attempts` is 1. */
  intervalMs?: number;
  /** How the interval is waited out. Injectable so tests need no timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decide whether a graceful exit met its postcondition.
 *
 * Order matters and is not arbitrary: the session is checked first because a
 * live pane makes the port question meaningless, and the port is checked only
 * after the pane is gone because that is the only moment "still answering"
 * means "orphaned".
 *
 * The default is a SINGLE check with no polling, which is byte-for-byte what
 * every `killSession()` already did after its own `exitWaitMs` sleep. A caller
 * that wants the tool given more rope passes `attempts` / `intervalMs`.
 *
 * @param probe - How to observe the session and the port
 * @returns `{ ok: true }`, or the reason the postcondition failed
 */
export async function verifyGracefulExit(
  probe: GracefulExitProbe
): Promise<GracefulExitVerdict> {
  const attempts = Math.max(1, probe.attempts ?? 1);
  const intervalMs = probe.intervalMs ?? 0;
  const sleep = probe.sleep ?? defaultSleep;

  let alive = true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    alive = await probe.sessionAlive();
    if (!alive) break;
    if (attempt < attempts - 1 && intervalMs > 0) await sleep(intervalMs);
  }
  if (alive) return { ok: false, reason: 'graceful_exit_timeout' };

  const portAnswering = probe.portAnswering;
  if (!portAnswering) return { ok: true };

  let answering = true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    answering = await portAnswering();
    if (!answering) break;
    if (attempt < attempts - 1 && intervalMs > 0) await sleep(intervalMs);
  }
  return answering ? { ok: false, reason: 'port_orphaned' } : { ok: true };
}
