/**
 * Synthetic Claude Code `/help` overlay frame (Issue #1497).
 *
 * Models a static, unclassified TUI overlay: the full-screen help view replaces
 * the composer, so the frame contains
 *   - no thinking spinner / "esc to interrupt" status bar (not `running`),
 *   - no numbered / yes-no prompt (not `waiting`),
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
    'Claude Code — Help',
    '',
    'Usage Modes',
    ' • Interactive:  claude',
    ' • One-off:      claude -p "your question"',
    '',
    'Slash Commands',
    ' /help      Show this help view',
    ' /clear     Clear the current conversation',
    ' /model     Switch the active model',
    ' /config    Open configuration',
    '',
    'Keyboard Shortcuts',
    ' Ctrl+C     Cancel the current input',
    ' Ctrl+D     Exit Claude Code',
    ' Shift+Tab  Cycle permission modes',
    ' Up / Down  Navigate input history',
    '',
    'Press Esc to close this help view',
  ].join('\n');
}
