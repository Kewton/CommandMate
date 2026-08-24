/**
 * GitHub Copilot CLI 1.0.80 launch frames, from the keystroke to the composer
 * (Issue #1907).
 *
 * Recorded on 2026-08-22 by driving `copilot` on a private tmux socket
 * (`tmux -L …`, production geometry 200 x 1000) and capturing
 * `capture-pane -p -S -50 -E -` every 250 ms. The measured sequence:
 *
 * | t (s) | what the pane shows                                    |
 * |-------|--------------------------------------------------------|
 * | 0.41  | the shell, having just echoed the launch command        |
 * | 0.84  | screen cleared, first banner row                       |
 * | 1.27  | banner                                                 |
 * | 2.11  | banner + startup notices                               |
 * | 2.52  | "Confirm folder trust" dialog (see the #1886 fixture)   |
 * | after `1` | composer, between two full-width rules             |
 *
 * Two things this establishes, and neither was true of the assumptions the
 * launch path used to make:
 *
 *  - **copilot is not ready at 4 seconds because 4 seconds passed.** The banner
 *    lands at ~1.3 s and the dialog at ~2.5 s; the composer exists only once the
 *    dialog is answered. `COPILOT_INIT_WAIT_MS` was a guess either side of the
 *    real numbers.
 *  - **the shell is on screen for the first ~0.8 s.** Every frame before the
 *    banner is whatever prompt the operator uses, so any readiness rule that
 *    accepts `^❯` accepts the shell — which is why {@link buildCopilotShellEchoFrame}
 *    takes the prompt as a parameter and the tests run it with `❯`.
 *
 * ANSI escapes are stripped (every consumer strips them before matching, and raw
 * ESC bytes trip `scripts/check-control-chars.mjs`). The operator's hostname and
 * user name are replaced; nothing here reads them.
 */

/** Real pane geometry of a CommandMate copilot session. */
const PANE_HEIGHT = 1000;

/**
 * `capture-pane -S -50 -E -` on a pane whose scrollback holds one line: one
 * leading row, then the 1000 visible rows. Reproduced because the readiness
 * check walks neighbouring rows and a frame of the wrong shape would not
 * exercise that.
 */
const LEADING_SCROLLBACK_ROWS = 1;

function buildPane(rows: readonly [number, string][]): string {
  const lines = Array<string>(LEADING_SCROLLBACK_ROWS + PANE_HEIGHT).fill('');
  for (const [index, text] of rows) lines[LEADING_SCROLLBACK_ROWS + index] = text;
  return lines.join('\n');
}

/** A neutral zsh prompt in the shape the recording had. */
export const SHELL_PROMPT_PLAIN = 'dev@host copilot-probe % ';

/**
 * The same prompt as starship / pure / agnoster draw it.
 *
 * Not a recording — the operator whose session was captured uses the plain form.
 * It is the shape that matters: a `❯` at column 0, which is exactly what
 * `COPILOT_PROMPT_PATTERN` was accepting as "copilot is ready".
 */
export const SHELL_PROMPT_CHEVRON = '❯ ';

/**
 * t = 0.41 s: the shell has echoed the launch command and copilot has not drawn
 * anything yet.
 *
 * @param prompt - The operator's shell prompt, e.g. {@link SHELL_PROMPT_CHEVRON}
 * @param command - The line `startSession` typed
 */
export function buildCopilotShellEchoFrame(
  prompt: string = SHELL_PROMPT_PLAIN,
  command: string = 'copilot'
): string {
  return buildPane([[0, `${prompt}${command}`]]);
}

/**
 * t = 2.11 s: copilot has cleared the screen and painted its banner and startup
 * notices. No composer, no dialog — the frame a readiness check must NOT accept.
 */
export function buildCopilotBannerOnlyFrame(): string {
  return buildPane([
    [0, '  Current   Sessions   Issues   Pull requests   Gists'],
    [2, '  ╭─╮╭─╮'],
    [3, '  ╰─╯╰─╯  Copilot v1.0.80 uses AI.'],
    [4, '  █ ▘▝ █  Check for mistakes.'],
    [5, '   ▔▔▔▔'],
    [7, ' ● No copilot-instructions.md found. Run /init to generate.'],
    [9, ' ● Tip: /permissions'],
    [10, '   └ Switch between permission modes'],
  ]);
}
