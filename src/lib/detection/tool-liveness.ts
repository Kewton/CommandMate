/**
 * "Did the TOOL exit and leave a bare shell behind?" — the shared rule
 * (Issue #2070).
 *
 * A tmux session outlives the process it was created for more often than the
 * code used to admit. codex's own update dialog replaces codex with `npm
 * install` and exits; `Ctrl+C` twice quits it; a crash does the same thing
 * without asking. In each case `has-session` keeps answering yes, so `isRunning`
 * stayed true, the sidebar kept its dot, and the next `send` sat in
 * `waitForPrompt` until it timed out — recoverable only by killing the session
 * by hand.
 *
 * CommandMate already had the answer to this, written for claude and reachable
 * from exactly one `cliToolId === 'claude'` branch (`isSessionHealthy`). What
 * was claude-specific about it was not the rule but the two patterns it was
 * spelled in terms of. This module is that rule with the patterns lifted out
 * into {@link ToolLivenessSpec}; `lib/cli-tools/liveness-spec` is where each
 * tool fills them in.
 *
 * Pure and synchronous on purpose: no tmux, no capture, nothing to mock. The
 * probe that feeds it a frame is `probeSessionLiveness` in
 * `lib/cli-tools/session-liveness`, which is where the tmux round trip belongs
 * (§4 D4 keeps `src/lib/detection/**` off the transport).
 *
 * @module lib/detection/tool-liveness
 */

import type { ToolLivenessSpec, ToolLivenessVerdict } from '@/types/cli-tool-contracts';
import { stripAnsi } from './ansi';

/**
 * Trailing characters that make a short last row a shell prompt.
 *
 * `$` bash/sh, `%` zsh, `#` root. Verbatim the list `claude-session.ts` has
 * carried as its private `SHELL_PROMPT_ENDINGS` since the health check was
 * written — moved, not redesigned.
 */
export const SHELL_PROMPT_ENDINGS: readonly string[] = ['$', '%', '#'] as const;

/**
 * Longest a last row may be and still be read as a shell prompt by the endings
 * rule alone.
 *
 * claude's number, kept as claude's default (`MAX_SHELL_PROMPT_LENGTH`, "40 is
 * an empirical threshold with safety margin"). Issue #2070 measured why it
 * cannot be the whole rule: the zsh default prompt of the machine the Issue was
 * reproduced on renders as `maenokota@MAENOnoMac-Studio work-codex %` — forty
 * characters exactly, i.e. one past this gate — so a codex session that had
 * genuinely fallen back to the shell read as alive. See
 * {@link SHELL_PROMPT_LINE_PATTERNS}.
 */
export const MAX_SHELL_PROMPT_LENGTH = 40;

/**
 * Whole-line forms that positively identify a shell prompt, independent of
 * length (Issue #2070).
 *
 * Checked BEFORE the length gate, so a long-but-real prompt is still a prompt.
 * Both are anchored at both ends and require a `user@host` head, which is what
 * keeps them off TUI content: an agent's transcript row that happens to end in
 * `$` does not begin with `name@host`.
 *
 * Deliberately NOT extended to the bare `❯` / `>` prompts starship, pure and
 * agnoster draw. Those glyphs are the composer of claude, copilot and gemini —
 * `COPILOT_PROMPT_PATTERN` matching a starship prompt is a measured hazard
 * (#1907) — so a rule that read them as "shell" would relaunch a tool into its
 * own live pane. The cost is a false NEGATIVE on those prompts (the exit is not
 * noticed), which is the direction this rule is allowed to be wrong in.
 */
export const SHELL_PROMPT_LINE_PATTERNS: readonly RegExp[] = [
  // zsh / bash defaults: `user@host dir %`, `user@host:~/dir$`
  /^[\w.-]+@[\w.-]+[\s:].*[$%#]$/,
  // RHEL-style bash: `[user@host dir]$`
  /^\[[\w.-]+@[\w.-]+[^\]]*\][$#]$/,
] as const;

/**
 * How many content rows from the bottom a fatal-pattern search may read.
 *
 * claude's `HEALTH_CHECK_ERROR_TAIL_LINES`, unchanged: an error that has already
 * scrolled up describes a session that recovered, and must not condemn it.
 */
export const FATAL_PATTERN_TAIL_LINES = 10;

/** `cleanOutput` split into rows, blank ones dropped. */
function contentRows(cleanTrimmedOutput: string): string[] {
  return cleanTrimmedOutput.split('\n').filter((line) => line.trim() !== '');
}

/**
 * The fatal pattern visible in the tail of `cleanOutput`, or null.
 *
 * Only the last {@link FATAL_PATTERN_TAIL_LINES} content rows are searched.
 * Exported because claude's launch loop applies the same judgement while it is
 * still waiting for the prompt (Issue #1637) — a session already showing
 * "Claude Code cannot be launched inside another Claude Code session" must not
 * burn the whole 60 s budget before saying so.
 *
 * @param cleanOutput - ANSI-stripped pane output
 * @param spec - The tool's liveness declaration
 * @returns The matched pattern (or regex source) for the log, or null
 */
export function findFatalPattern(cleanOutput: string, spec: ToolLivenessSpec): string | null {
  const tailText = contentRows(cleanOutput.trim())
    .slice(-FATAL_PATTERN_TAIL_LINES)
    .join('\n');

  for (const pattern of spec.fatalPatterns) {
    if (tailText.includes(pattern)) return pattern;
  }
  for (const regex of spec.fatalRegexPatterns) {
    if (regex.test(tailText)) return regex.source;
  }
  return null;
}

/**
 * Whether `line` ends in one of `endings`, applying claude's own exclusion.
 *
 * `Context left until auto-compact: 7%` ends in `%` and is not a prompt; the
 * `\d+%$` carve-out is the one claude has always had, and it is kept here
 * character for character because claude's verdicts must not move (Issue #2070
 * 受入条件).
 */
function endsWithShellPromptChar(line: string, endings: readonly string[]): boolean {
  return endings.some((ending) => {
    if (!line.endsWith(ending)) return false;
    if (ending === '%' && /\d+%$/.test(line)) return false;
    return true;
  });
}

/**
 * Decide whether the tool this spec describes is still drawing the pane.
 *
 * The rule, in the order the branches run — which is claude's order, because
 * claude's spec must produce claude's historical answers:
 *
 *  1. **nothing on the pane** → exited only if the spec says an unreadable
 *     frame counts (claude alone; see {@link ToolLivenessSpec.unreadableIsExited});
 *  2. **an alive pattern matches the bottom window** → alive. This is the
 *     tool's prompt-ready rule and its busy/dialog chrome, and it is checked
 *     against a WINDOW rather than the frame for every tool but claude: a tool's
 *     chrome does not vanish when it quits, it scrolls up;
 *  3. **a fatal pattern in the tail** → exited;
 *  4. **the last row positively reads as a shell prompt** → exited;
 *  5. **the last row is too long to be a prompt** → alive;
 *  6. **the last row ends in `$` / `%` / `#`** → exited;
 *  7. otherwise **alive** — the honest answer when nothing said either way.
 *
 * Steps 4-6 are the positive half of the verdict and they are not optional.
 * A frame that merely fails step 2 (a tool mid-launch, a screen nobody has
 * measured) must come out ALIVE, because Issue #2070 puts a relaunch behind
 * this answer and a relaunch into a live pane types the launch command into the
 * agent's composer.
 *
 * @param rawOutput - Pane capture, ANSI intact (stripped here)
 * @param spec - The tool's liveness declaration
 * @returns Whether the tool is there, and — when it is not — why not
 */
export function judgeToolLiveness(
  rawOutput: string,
  spec: ToolLivenessSpec
): ToolLivenessVerdict {
  const trimmed = stripAnsi(rawOutput).trim();

  if (trimmed === '') {
    return spec.unreadableIsExited
      ? { alive: false, reason: 'empty output' }
      : { alive: true };
  }

  const rows = contentRows(trimmed);
  const aliveWindow =
    spec.aliveTailLines === null ? trimmed : rows.slice(-spec.aliveTailLines).join('\n');
  if (spec.alivePatterns.some((pattern) => pattern.test(aliveWindow))) {
    return { alive: true };
  }

  const fatal = findFatalPattern(trimmed, spec);
  if (fatal !== null) {
    return { alive: false, reason: `error pattern: ${fatal}` };
  }

  const lastLine = rows[rows.length - 1]?.trim() ?? '';

  if (!/\d+%$/.test(lastLine) && spec.shellPromptPatterns.some((p) => p.test(lastLine))) {
    return { alive: false, reason: `shell prompt detected: ${lastLine}` };
  }

  if (lastLine.length >= spec.maxShellPromptLength) {
    return { alive: true };
  }

  if (endsWithShellPromptChar(lastLine, spec.shellPromptEndings)) {
    return { alive: false, reason: `shell prompt ending detected: ${lastLine}` };
  }

  return { alive: true };
}
