/**
 * Real Claude Code `/help` overlay frame (Issue #1497).
 *
 * Captured from a live Claude Code **v2.1.218** session (`tmux capture-pane -p`)
 * with `/help` open. Only the absolute worktree path on the banner line was
 * generalized to `~/worktree`; every other line is verbatim.
 *
 * It is a static, unclassified TUI overlay: the full-screen help view replaces
 * the composer, so the frame contains
 *   - no thinking spinner / "esc to interrupt" status bar (not `running`/thinking),
 *   - no numbered / yes-no prompt (not `waiting`),
 *   - a footer "Esc to cancel" that does NOT match CLAUDE_SELECTION_LIST_FOOTER
 *     ("Enter to select…/confirm · Esc/set as default"), so not a selection list,
 *   - and — critically — no `❯`/`>` input line (not `ready`/`input_prompt`).
 *
 * detectSessionStatus() therefore cannot positively classify it and reaches the
 * time-based heuristic (status-detector step 4). With no lastOutputTimestamp it
 * stays `running`/`default`; once the Auto-Yes poller has stamped a stale
 * timestamp it degrades to `ready`/`no_recent_output` — the path that used to
 * hide the detection-independent nav hatch (#1017/#1494) and strand the user.
 */
export function buildClaudeHelpOverlayFrame(): string {
  return [
    '',
    ' ▐▛███▜▌   Claude Code v2.1.218',
    '▝▜█████▛▘  Opus 4.8 (1M context) with xhigh effort · Claude Max',
    '  ▘▘ ▝▝    ~/worktree',
    '',
    '',
    '',
    '',
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
    '   Help  General   Commands   Custom commands',
    '',
    '',
    '   Claude understands your codebase, makes edits with your permission, and executes commands — right from your terminal.',
    '',
    '   New here? Run /powerup to learn the features most people miss.',
    '',
    '   Shortcuts',
    '   ! for shell mode          double tap esc to clear input        ctrl + shift + _ to undo',
    '   / for commands            shift + tab to auto-accept edits     ctrl + z to suspend',
    '   @ for file paths          ctrl + o for verbose output          ctrl + v to paste images',
    '   /btw for side question    ctrl + t to toggle tasks             opt + p to switch model',
    '                             \\⏎ for newline                       opt + o to toggle fast mode',
    '                                                                  ctrl + s to stash prompt',
    '                                                                  ctrl + g to edit in $EDITOR',
    '                                                                  /keybindings to customize',
    '',
    '   For more help: https://code.claude.com/docs/en/overview',
    '',
    '   Something else? Use /feedback to report bugs or request features.',
    '',
    '   Esc to cancel',
  ].join('\n');
}
