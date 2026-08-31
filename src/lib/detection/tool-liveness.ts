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
 * How the bottom row of a frame was recognised as a shell prompt.
 *
 * `pattern` is a positive `user@host …` match, `ending` the length-gated
 * `$` / `%` / `#` rule. The two are kept apart only so
 * {@link judgeToolLiveness} can keep saying which one fired: its two reason
 * strings are read back by `worktree-status-helper` and asserted verbatim in
 * `claude-session.test.ts`.
 */
export interface ShellPromptTail {
  /** The row itself, trimmed. */
  line: string;
  /** Which of the two rules recognised it. */
  via: 'pattern' | 'ending';
}

/**
 * The bottom row of `cleanOutput`, when it reads as a shell prompt.
 *
 * Steps 4-6 of {@link judgeToolLiveness}, lifted out verbatim so there is one
 * definition of "this pane is a bare shell" rather than two. Note what is NOT
 * here: the alive-pattern window of step 2. That is the difference between the
 * two questions, and it is why this is exported (Issue #2068).
 *
 * `judgeToolLiveness` asks **"is the tool gone?"** and answers conservatively —
 * any alive pattern anywhere in the bottom window vetoes the exit, because a
 * relaunch hangs off its verdict. That veto is right for the general case and
 * wrong for exactly one measured frame: the pane codex leaves behind after its
 * own `1. Update now`. codex-cli 0.149.1 exits into `npm install -g
 * @openai/codex`, which prints three rows and returns to the shell — so the
 * dead `› 1. Update now` option row is still SEVEN content rows above the live
 * shell prompt, inside `LIVENESS_ALIVE_TAIL_LINES`, and `CODEX_PROMPT_PATTERN`
 * reads it as codex still drawing the pane (measured 2026-08-31, private tmux
 * socket, 200x1000, isolated `CODEX_HOME`).
 *
 * `CodexTool.waitForReady` therefore asks this narrower question instead, and
 * only about a pane it has just watched answer the update dialog — where the
 * scrollback above the prompt is known to be spent and position is the whole
 * story, exactly as it is for every other codex classifier since Issue #892.
 * Widening `judgeToolLiveness` itself to agree would be a change to the shared
 * rule every tool is judged by, and it is not made here.
 *
 * @param cleanOutput - ANSI-stripped pane output
 * @param spec - The tool's liveness declaration
 * @returns The prompt row and how it was recognised, or null
 */
export function findShellPromptTail(
  cleanOutput: string,
  spec: Pick<
    ToolLivenessSpec,
    'shellPromptPatterns' | 'maxShellPromptLength' | 'shellPromptEndings'
  >
): ShellPromptTail | null {
  const rows = contentRows(cleanOutput.trim());
  const lastLine = rows[rows.length - 1]?.trim() ?? '';

  if (!/\d+%$/.test(lastLine) && spec.shellPromptPatterns.some((p) => p.test(lastLine))) {
    return { line: lastLine, via: 'pattern' };
  }

  // The length gate is a NEGATIVE result, not a fall-through: a row this long is
  // not a prompt, and the endings rule below must not get to claim it.
  if (lastLine.length >= spec.maxShellPromptLength) {
    return null;
  }

  if (endsWithShellPromptChar(lastLine, spec.shellPromptEndings)) {
    return { line: lastLine, via: 'ending' };
  }

  return null;
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

  // Steps 4-6, via the predicate they were lifted into (Issue #2068). The two
  // reason strings are unchanged, and so is the verdict for every frame: a
  // `null` here is the old "too long" and "nothing matched" branches, which both
  // came out alive.
  const shellTail = findShellPromptTail(trimmed, spec);
  if (shellTail !== null) {
    return shellTail.via === 'pattern'
      ? { alive: false, reason: `shell prompt detected: ${shellTail.line}` }
      : { alive: false, reason: `shell prompt ending detected: ${shellTail.line}` };
  }

  return { alive: true };
}
