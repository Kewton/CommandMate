/**
 * GitHub Copilot CLI 1.0.80 "Confirm folder trust" screens (Issue #1886).
 *
 * Recorded on 2026-08-21 from a live `tmux capture-pane -p -e -S -50 -E -` of a
 * private tmux socket running `gh copilot` in a freshly `git init`-ed directory
 * that had never been trusted, at the production pane geometry (200 x 1000).
 * The ANSI escapes are stripped here because every consumer (`waitForReady`,
 * `detectSessionStatus`) strips them before matching, and raw ESC bytes would
 * trip `scripts/check-control-chars.mjs`.
 *
 * Two facts the recording establishes, both measured rather than assumed:
 *  - the dialog is drawn INSIDE a box, so every option line reads `│ ❯ 1. Yes`.
 *    `COPILOT_PROMPT_PATTERN` (`/^[>❯]\s|^\?\s+/m`) therefore does not match the
 *    frame at all, which is the 30-second stall reported in the Issue.
 *  - while the dialog is up the composer row is GONE: the frame has no `❯` at
 *    column 0 anywhere. That is what makes "composer visible" a usable positive
 *    readiness signal here, and it is why `stripBoxDrawing` must NOT be applied
 *    before the readiness check — doing so turns `│ ❯ 1. Yes` into `❯ 1. Yes`
 *    and the dialog starts reading as a ready prompt.
 *
 * The operator's absolute path is replaced with a neutral one; nothing here
 * reads it.
 */

/** Real pane geometry of a CommandMate copilot session. */
const PANE_WIDTH = 200;
const PANE_HEIGHT = 1000;

/** `│ ` + content, right-padded to `width`, closed with `│`. */
function framed(content: string, width: number): string {
  return `│ ${content}${' '.repeat(Math.max(0, width - 3 - content.length))}│`;
}

/** The banner copilot prints at the top of the pane on every launch. */
const LAUNCH_BANNER: readonly [number, string][] = [
  [0, '  Current   Sessions   Issues   Pull requests   Gists '],
  [2, '  ╭─╮╭─╮'],
  [3, '  ╰─╯╰─╯  Copilot v1.0.80 uses AI.'],
  [4, '  █ ▘▝ █  Check for mistakes.'],
  [5, '   ▔▔▔▔ '],
  [7, ' ● No copilot-instructions.md found. Run /init to generate.'],
  [9, ' ● Tip: /skills'],
  [10, '   └ Manage skills for enhanced capabilities'],
];

/** Path shown in the dialog's inner box. Neutralised; no pattern reads it. */
const TRUSTED_PATH_ROW = '/Users/dev/worktrees/commandmate-issue-1886';

/**
 * The dialog rows, verbatim apart from the path. Row 0 is the box top; the
 * option rows carry the `❯` selection marker on the default (`1. Yes`).
 */
const TRUST_DIALOG_ROWS: readonly string[] = [
  `╭${'─'.repeat(PANE_WIDTH - 2)}╮`,
  framed('Confirm folder trust', PANE_WIDTH),
  `│ ${'─'.repeat(PANE_WIDTH - 4)} │`,
  `│ ╭${'─'.repeat(PANE_WIDTH - 6)}╮ │`,
  `│ ${framed(TRUSTED_PATH_ROW, PANE_WIDTH - 4)} │`,
  `│ ╰${'─'.repeat(PANE_WIDTH - 6)}╯ │`,
  framed('', PANE_WIDTH),
  framed(
    'Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will remember your permissions for the rest of this session.',
    PANE_WIDTH,
  ),
  framed('', PANE_WIDTH),
  framed('Do you trust the files in this folder?', PANE_WIDTH),
  framed('', PANE_WIDTH),
  framed('❯ 1. Yes', PANE_WIDTH),
  framed('  2. Yes, and remember this folder for future sessions', PANE_WIDTH),
  framed('  3. No (Esc)', PANE_WIDTH),
  framed('', PANE_WIDTH),
  framed('↑/↓ to navigate · enter to select · esc to cancel', PANE_WIDTH),
  `╰${'─'.repeat(PANE_WIDTH - 2)}╯`,
];

/** Copilot's status bar: left half, then the usage counter flush right. */
function statusBar(left: string, right: string): string {
  const gap = Math.max(1, PANE_WIDTH - 1 - left.length - right.length);
  return ` ${left}${' '.repeat(gap)}${right}`;
}

function buildPane(rows: readonly [number, string][]): string {
  const lines = Array<string>(PANE_HEIGHT).fill('');
  for (const [index, text] of rows) lines[index] = text;
  return lines.join('\n');
}

/**
 * The untrusted-folder launch frame: banner at the top, trust dialog pinned to
 * the bottom of the 1000-row pane, no composer row.
 */
export function buildCopilotFolderTrustFrame(): string {
  const rows: [number, string][] = [...LAUNCH_BANNER];
  const top = PANE_HEIGHT - TRUST_DIALOG_ROWS.length;
  TRUST_DIALOG_ROWS.forEach((text, offset) => rows.push([top + offset, text]));
  return buildPane(rows);
}

/**
 * The same pane one keystroke later, after `1` was sent with no trailing Enter.
 * Copilot redraws the whole screen, so the dialog leaves nothing behind: the
 * composer `❯` is back on its own row (tmux trims the trailing padding, so the
 * row really is a bare `❯`) between the two rules, with the status bar above
 * and the shortcut hints below.
 */
export function buildCopilotReadyFrame(): string {
  const rule = '─'.repeat(PANE_WIDTH);
  const rows: [number, string][] = [
    ...LAUNCH_BANNER,
    [995, statusBar(`${TRUSTED_PATH_ROW} [⎇ master]`, 'Session: 0 AIC used')],
    [996, rule],
    [997, '❯'],
    [998, rule],
    [999, ' ← open sidebar · / commands · ? help · tab next tab                                                                                                                                      GPT-5.6 Terra'],
  ];
  return buildPane(rows);
}

/**
 * Fail-safe fixture, NOT a recording: the same dialog with the two "Yes" options
 * swapped, so option 1 is the one that writes `~/.copilot/config.json`
 * (`trustedFolders`) — a machine-global file shared by every checkout on the
 * host. Detection must reject this frame rather than answer `1` into it.
 */
export function buildCopilotFolderTrustReorderedFrame(): string {
  const rows: [number, string][] = [...LAUNCH_BANNER];
  const swapped = TRUST_DIALOG_ROWS.map((row) => {
    if (row.includes('1. Yes')) return framed('❯ 1. Yes, and remember this folder for future sessions', PANE_WIDTH);
    if (row.includes('2. Yes, and remember')) return framed('  2. Yes', PANE_WIDTH);
    return row;
  });
  const top = PANE_HEIGHT - swapped.length;
  swapped.forEach((text, offset) => rows.push([top + offset, text]));
  return buildPane(rows);
}
