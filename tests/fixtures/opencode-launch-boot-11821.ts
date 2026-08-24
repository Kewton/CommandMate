/**
 * opencode 1.18.21 launch frames, from the keystroke to the composer
 * (Issue #1908).
 *
 * Recorded on 2026-08-22 by driving `opencode` on a private tmux socket
 * (`tmux -L …`) at CommandMate's production geometry for this tool — 80 columns
 * by `OPENCODE_PANE_HEIGHT` (200) rows — with a disposable `HOME`, capturing
 * `capture-pane -p -S -50 -E -` every ~550 ms. The measured sequence, with the
 * project holding a 24-model Ollama `opencode.json`:
 *
 * | t (s) | what the pane shows                                          |
 * |-------|--------------------------------------------------------------|
 * | 0.21  | the shell, having just echoed the launch command              |
 * | 0.89  | the same                                                      |
 * | 1.58  | screen cleared — 200 blank rows, nothing painted yet          |
 * | 2.96  | still blank                                                   |
 * | 3.64  | banner + composer (`┃  Ask anything...`) + footer             |
 *
 * A second run under a fresh `HOME` with no provider configured reached the
 * composer at 2.88 s. Under the load of six parallel agents the same launch
 * took 24.1 s. Three things this establishes:
 *
 *  - **`OPENCODE_INIT_WAIT_MS = 15000` was wrong in both directions.** Its
 *    comment said "GPU model loading via Ollama"; opencode loads no model at
 *    launch, the TUI is up at ~3 s, and under load 15 s is not enough.
 *  - **the shell is on screen for the first ~0.9 s**, under whatever prompt the
 *    operator uses — which is the trap #1907 fell into for copilot, where
 *    `^[>❯]\s` matched starship / pure / agnoster. {@link SHELL_PROMPT_CHEVRON}
 *    is here so the opencode readiness rule is run against that same frame.
 *  - **the `Connect a provider` overlay removes the composer from the frame.**
 *    `Ask anything` occurs zero times while it is up, so a readiness rule that
 *    only knows the composer would burn its whole window on a pane parked
 *    there.
 *
 * ANSI escapes are stripped: `capture-pane` without `-e` emits none, every
 * consumer strips them before matching, and raw ESC bytes trip
 * `scripts/check-control-chars.mjs`. Absolute paths from the recording are
 * replaced; nothing here reads them.
 */

/** Real pane geometry of a CommandMate opencode session (`OPENCODE_PANE_HEIGHT`). */
const PANE_HEIGHT = 200;

/**
 * `capture-pane -S -50 -E -` on a pane whose scrollback holds one line: one
 * leading row, then the 200 visible rows. Reproduced because a frame of the
 * wrong height would not put the composer where the recording put it.
 */
const LEADING_SCROLLBACK_ROWS = 1;

function buildPane(rows: readonly [number, string][]): string {
  const lines = Array<string>(LEADING_SCROLLBACK_ROWS + PANE_HEIGHT).fill('');
  for (const [index, text] of rows) lines[LEADING_SCROLLBACK_ROWS + index] = text;
  return lines.join('\n');
}

/** A neutral bash prompt in the shape the recording had. */
export const SHELL_PROMPT_PLAIN = 'dev@host opencode-probe $ ';

/**
 * The same prompt as starship / pure / agnoster draw it — the shape the
 * recording actually used, and the one that made copilot's readiness check
 * accept a shell in Issue #1907.
 */
export const SHELL_PROMPT_CHEVRON = '❯ ';

/**
 * t = 0.21 s: the shell has echoed the launch command and opencode has not
 * drawn anything yet.
 *
 * @param prompt - The operator's shell prompt, e.g. {@link SHELL_PROMPT_CHEVRON}
 * @param command - The line `startSession` typed
 */
export function buildOpencodeShellEchoFrame(
  prompt: string = SHELL_PROMPT_PLAIN,
  command: string = 'opencode --port 4242 --hostname 127.0.0.1'
): string {
  return buildPane([
    [0, 'The default interactive shell is now zsh.'],
    [1, 'To update your account to use zsh, please run `chsh -s /bin/zsh`.'],
    [2, 'For more details, please visit https://support.apple.com/kb/HT208050.'],
    [3, prompt.trimEnd()],
    [4, `${prompt}${command}`],
  ]);
}

/**
 * t = 1.58 s and t = 2.96 s: opencode has taken the alternate screen and
 * painted nothing at all. Two full poll intervals land here, so the readiness
 * rule has to survive a frame with no content whatsoever.
 */
export function buildOpencodeClearedFrame(): string {
  return buildPane([]);
}

/**
 * t = 3.64 s: banner, composer and footer.
 *
 * The composer is the four gutter (`┃`) rows at 98-101 and the `╹`-cornered
 * rule under them. Row 99 is what `OPENCODE_IDLE_COMPOSER_PATTERN` anchors on:
 * the placeholder *behind the input box's gutter*. Row 101 is opencode's own
 * model line, kept because it also starts with the gutter and a readiness rule
 * that matched any guttered row would accept the frame one row too early.
 */
export function buildOpencodeComposerFrame(): string {
  return buildPane([
    [92, '                                                      ▄'],
    [93, '                     █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█'],
    [94, '                     █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀'],
    [95, '                     ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'],
    [98, '   ┃'],
    [99, '   ┃  Ask anything... "What is the tech stack of this project?"'],
    [100, '   ┃'],
    [101, '   ┃  Build · Big Pickle OpenCode Zen'],
    [102, `   ╹${'▀'.repeat(74)}`],
    [103, '   tab agents  ctrl+p commands'],
    [196, '  /Users/dev/work/opencode-probe                            1.18.21'],
    [198, '  opencode-probe:master'],
  ]);
}

/**
 * The `Connect a provider` overlay, captured by sending `/connect` to a live
 * pane.
 *
 * The composer is **gone** from this frame — the recording has zero occurrences
 * of `Ask anything` while the overlay is up. The provider list is abridged to
 * the rows that matter (the recording listed ~400 providers); the header row is
 * verbatim, including the trailing `esc`.
 */
export function buildOpencodeConnectProviderFrame(): string {
  return buildPane([
    [50, '              Connect a provider                               esc'],
    [52, '              Search'],
    [54, '              Popular'],
    [55, '            ✓ OpenCode Zen (Recommended)'],
    [56, '              OpenCode Go Low cost subscription for everyone'],
    [57, '              OpenAI (ChatGPT Plus/Pro or API key)'],
    [58, '              GitHub Copilot'],
    [59, '              Anthropic (API key)'],
    [60, '              Google'],
    [62, '              Providers'],
    [63, '              302.AI'],
    [64, '              Amazon Bedrock'],
  ]);
}

/**
 * The composer as it looks with a character typed into it.
 *
 * opencode paints the placeholder only while the input buffer is empty (Issue
 * #1883, `opencode-live-1883/composer-residual.txt`). Kept here so a readiness
 * rule cannot be satisfied by "the input box exists".
 */
export function buildOpencodeTypedComposerFrame(): string {
  return buildPane([
    [98, '   ┃'],
    [99, '   ┃  echo PREFILLED'],
    [100, '   ┃'],
    [101, '   ┃  Build · Big Pickle OpenCode Zen'],
    [102, `   ╹${'▀'.repeat(74)}`],
    [103, '   tab agents  ctrl+p commands'],
  ]);
}
