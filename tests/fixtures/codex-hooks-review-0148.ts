/**
 * codex-cli 0.148.0 launch / lifecycle screens (Issue #1829).
 *
 * Transcribed from the live `tmux capture-pane -p -S -200` of the two stuck
 * `mcbd-codex-*` sessions recorded in Issue #1829 on 2026-08-19 (pane width
 * 200). 0.147.0 — what the Issue #1760 fixtures were taken from — showed **one**
 * screen; 0.148.0 shows **three**, and the middle one is the reason a stuck
 * session is invisible: neither screen 2 nor screen 3 carries an anchor that
 * `isCodexHooksReviewDialog` or `getCodexActiveDialog` recognises, and both were
 * measured as `running` / `hasActivePrompt: false`.
 *
 * Two deliberate substitutions, neither of which any pattern here reads:
 *  - the hook row list on screen 2 is elided as "..." in the Issue capture; it
 *    is written out here as the five events `hooks-config.ts` actually writes.
 *  - the operator's absolute repository path in screen 3's `Command` row is
 *    replaced with a neutral one.
 */

/**
 * Screen 1 — the launch dialog. `4 hooks are new or changed.` is the 0.148.0
 * wording (0.147.0 said `5`); the count is data, which is why neither anchor
 * reads it.
 */
export const CODEX_HOOKS_REVIEW_PANE = [
  '  Hooks need review',
  '  4 hooks are new or changed.',
  '  Hooks can run outside the sandbox after you trust them.',
  '',
  '› 1. Review hooks',
  '  2. Trust all and continue',
  "  3. Continue without trusting (hooks won't run)",
  '',
  '  Press enter to confirm or esc to go back',
].join('\n');

/**
 * Screen 2 — the hooks list, reached by confirming option 1. New in 0.148.0 and
 * the screen the original Issue report dropped.
 */
export const CODEX_HOOKS_LIST_PANE = [
  '  Hooks',
  '  Lifecycle hooks from config and enabled plugins.',
  '',
  '  ⚠ 4 hooks need review before they can run.',
  '',
  '  Event                 Installed   Active      Review      Description',
  '  PermissionRequest     1           0           1           Before a tool call is allowed',
  '  SessionEnd            1           0           1           When a session ends',
  '  SessionStart          1           0           1           When a new session starts',
  '  Stop                  1           0           1           When the agent finishes a turn',
  '  UserPromptSubmit      1           0           1           When a prompt is submitted',
  '',
  '  Press t to trust all; enter to review hooks; esc to close',
].join('\n');

/**
 * Screen 3 — the per-hook review detail. This is where both live sessions were
 * found: nothing in the server sends `t` or `esc`, so the pane sits here until a
 * human notices, and until Issue #1829 nothing reported it as anything but
 * `running`.
 */
export const CODEX_HOOKS_DETAIL_PANE = [
  '  [!] Hook 1 · modified',
  '',
  '  Event     SessionStart',
  '  Source    User config - ~/.codex/hooks.json',
  "  Command   '/Users/dev/work/CommandMate/scripts/hooks/cmate-agent-event.sh' --tool codex --event session_start",
  '  Mode      Sync',
  '  Timeout   5s',
  '  Trust     Modified since last trusted - review required',
  '',
  '  Press t to trust; esc to go back',
].join('\n');

/**
 * What the stuck sessions actually looked like: the dialog reappeared **after**
 * the prompt had come up, so `› Ask Codex to do anything` sits in scrollback
 * ABOVE both hooks screens. `waitForReady` was long gone by then and only the
 * Auto-Yes poller was still watching — the sequence the Issue's comment
 * reconstructed.
 *
 * Position matters here: the bottom-most screen is the detail one, and a
 * classifier that scans top-down would answer `hooks-list` for this frame.
 */
export const CODEX_HOOKS_STUCK_PANE = [
  '  • Ran echo hello',
  '    hello',
  '',
  '› Ask Codex to do anything',
  '',
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_DETAIL_PANE,
].join('\n');

/**
 * The interactive update dialog (Issue #890). Auto-Yes resolves its default
 * option to `"1"` — `Update now`, which runs `npm install -g @openai/codex` and
 * kills the running codex process. `waitForReady` sends `"2"` for exactly that
 * reason.
 */
export const CODEX_UPDATE_DIALOG_PANE = [
  '✨ Update available! 0.148.0 -> 0.149.0',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  'Press enter to continue',
].join('\n');

/** The directory-trust dialog (Issue #890). */
export const CODEX_TRUST_DIALOG_PANE = [
  'Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
].join('\n');

/** A pane whose bottom-most element is the genuine input prompt. */
export const CODEX_READY_PANE = ['  Tip: use /init', '', '› ', '  gpt-5.6-sol · /tmp/wt'].join('\n');

/**
 * A hooks review dialog that has already been dealt with, left in scrollback
 * above a live prompt. Nothing here is active, so no guard may fire on it —
 * this is the Issue #892 shape that position-independent matching gets wrong.
 */
export const CODEX_HOOKS_RESIDUAL_PLUS_PROMPT = [
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_HOOKS_LIST_PANE,
  '',
  '› ',
].join('\n');

/**
 * A genuine approval request — the agent asking the human for permission
 * mid-turn. Auto-Yes exists to answer these, so it is the control that proves
 * the launch-dialog guard did not simply switch Auto-Yes off for codex.
 */
export const CODEX_APPROVAL_PANE = [
  '  Would you like to run the following command?',
  '',
  '  $ npm run lint',
  '',
  '› 1. Yes',
  "  2. Yes, and don't ask again for this command",
  '  3. No, and tell Codex what to do differently',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');
