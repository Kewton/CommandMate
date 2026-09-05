/**
 * The shell scripts session-scoped tmux hooks run (Issue #2317, Phases C and D).
 *
 * ## Why the text is embedded rather than shipped as a file
 *
 * The same reason `read-mode-pager.ts` gives for `cm-read-pane.sh`:
 * `package.json`'s `files` list does not publish `scripts/`, and an `npx`
 * install lives in a cache npm may garbage-collect out from under a hook that
 * outlives the process which installed it. Embedding the text and materializing
 * it into `~/.commandmate/bin/` gives every hook one absolute path that is
 * stable across global / local / npx installs.
 *
 * ## Why the hooks call scripts instead of doing the work inline
 *
 * Measured on tmux 3.5a (Issue #2317 技術検証): a hook body of the shape
 * `if-shell -F '#{…}' '<command>'` is accepted by `set-hook` and then never
 * fires — silently, with no error anywhere. A
 * `run-shell -b '<script> #{session_name} #{client_control_mode}'` DOES fire.
 * So the formats are handed to a script and every branch is taken in `sh`.
 *
 * The hook environment is the tmux SERVER's, which carries `TMUX` — so the bare
 * `tmux` these scripts call reaches the same server that fired the hook, private
 * socket included. That is verified, not assumed: the whole live probe for this
 * Issue ran under `tmux -L cm2317` and the scripts reached that server.
 *
 * ## Both scripts refuse to touch a session that is not CommandMate's
 *
 * A hook is session-scoped, so in principle it can only fire on the session it
 * was installed on. The `mcbd-` guard is still there because these scripts are
 * also runnable by hand and because a session can be renamed.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '../../config/tmux-pane-config';
import { MCBD_SESSION_PREFIX } from '../session/tmux-session-surface';
import { PAGER_SCRIPT_FILENAME } from './read-mode-pager';

/** Basename of the Phase D geometry-restore script. */
export const LIVE_RESTORE_SCRIPT_FILENAME = 'cm-live-restore.sh';

/** Basename of the Phase D geometry-delegation script. */
export const LIVE_DELEGATE_SCRIPT_FILENAME = 'cm-live-delegate.sh';

/** Basename of the Phase C auto-popup script. */
export const AUTO_POPUP_SCRIPT_FILENAME = 'cm-auto-popup.sh';

/**
 * Restore a session's pinned canvas once no human client is attached.
 *
 * NOT a hook body — tmux 3.5a never fires a session-scoped `client-detached`
 * (see the measurement table in `live-attach.ts`). Two things run this sequence:
 * `commandmate attach --live` when `attach-session` returns, and the server's
 * status poll (`reconcileDelegatedGeometry`) for every case where the CLI never
 * got to — it was killed, the terminal window was closed, or the detach happened
 * from a client this process never saw. This script is the third, manual, path:
 * the escape hatch for a session left delegated while no server is running.
 *
 * The control-mode test is the whole reason the client count is not simply
 * `#{session_attached}`: CommandMate's own transport attaches as a `tmux -C`
 * client and never leaves, so a session with the human gone still reports
 * `session_attached=1`. `client_control_mode` is `1` for those and `0` for a
 * terminal, so the restore waits for the HUMAN count to reach zero
 * (Issue #2317 受入条件 Phase D 4).
 */
export const LIVE_RESTORE_SCRIPT = `#!/bin/sh
# CommandMate live-attach restore (Issue #2317) — generated file, edits are overwritten.
#
#   sh ~/.commandmate/bin/${LIVE_RESTORE_SCRIPT_FILENAME} <session> [control_mode] [width] [height]
#
# Pins the session's window back to CommandMate's canvas once no human client is
# attached to it any more. Safe to run when nothing is delegated: it then simply
# re-applies the geometry the session already has.
set -u

SESSION="\${1:-}"
CONTROL_MODE="\${2:-0}"
WIDTH="\${3:-${TUI_PANE_WIDTH}}"
HEIGHT="\${4:-${TUI_PANE_HEIGHT}}"

case "$SESSION" in
  ${MCBD_SESSION_PREFIX}*) ;;
  *) exit 0 ;;
esac

# A control-mode client detaching is CommandMate's own transport reconnecting,
# not the human leaving. Doing the restore here would fight the human's attach.
if [ "$CONTROL_MODE" = "1" ]; then
  exit 0
fi

# Anyone left who is NOT a control client? Then the geometry is still theirs.
HUMANS=$(tmux list-clients -t "=$SESSION:" -F '#{client_control_mode}' 2>/dev/null \\
  | grep -c -v '^1$') || HUMANS=0
if [ "\${HUMANS:-0}" -gt 0 ]; then
  exit 0
fi

tmux set-window-option -t "=$SESSION:" window-size manual 2>/dev/null || exit 0
tmux resize-window -t "=$SESSION:" -x "$WIDTH" -y "$HEIGHT" 2>/dev/null || true
tmux set-option -u -t "=$SESSION:" @cm_delegated 2>/dev/null || true
`;

/**
 * Hand a session's geometry to the terminal that just attached.
 *
 * The opt-in half of Phase D: `commandmate attach --live` performs these two
 * writes itself, and this script is what makes a HAND-ROLLED `tmux attach`
 * behave the same way when the operator asked for it with
 * `CM_LIVE_ATTACH_HOOK=on`.
 *
 * claude-only by session-name prefix, and that is not a shortcut. The session
 * name is `mcbd-<tool>-<worktree>`, no other CLI tool id begins with `claude`,
 * and the script has nothing but the name to go on — a hook fires with tmux
 * formats, not with CommandMate's roster. Widening it means widening
 * `LIVE_ATTACH_TOOLS` too, and that needs the per-tool re-measurement
 * Issue #2317 puts out of scope.
 */
export const LIVE_DELEGATE_SCRIPT = `#!/bin/sh
# CommandMate live-attach delegate (Issue #2317) — generated file, edits are overwritten.
#
#   sh ~/.commandmate/bin/${LIVE_DELEGATE_SCRIPT_FILENAME} <session> <control_mode> [client]
#
# Hands the session's window from CommandMate's pinned canvas to the terminal
# that just attached, so an alternate-screen agent re-lays-out and its transcript
# becomes readable. Installed as a session-scoped \`client-attached[0]\` hook only
# when CM_LIVE_ATTACH_HOOK=on; \`commandmate attach --live\` does the same two
# writes itself and needs no hook.
#
# The window is put back by whoever notices the human is gone first: the CLI on
# return from attach-session, or the server's status poll. This script never
# restores — the attach edge is the only edge tmux 3.5a lets a session-scoped
# hook see.
set -u

SESSION="\${1:-}"
CONTROL_MODE="\${2:-0}"

case "$SESSION" in
  ${MCBD_SESSION_PREFIX}claude-*) ;;
  *) exit 0 ;;
esac

# A control-mode client is CommandMate's own transport. Handing it the geometry
# would resize the canvas to whatever that connection negotiated, which is the
# #1163 regression this whole feature is built to avoid.
if [ "$CONTROL_MODE" = "1" ]; then
  exit 0
fi

# Raised BEFORE the size change, so a status poll landing between the two sees
# "delegated, still pinned" rather than "not delegated, 44 rows".
tmux set-option -t "=$SESSION:" @cm_delegated 1 2>/dev/null || exit 0
tmux set-window-option -t "=$SESSION:" window-size latest 2>/dev/null || true
`;

/**
 * Open the following transcript popup when a human attaches (Phase C, opt-in).
 *
 * Default off, and it has to be: the popup owns the keyboard until `q` is
 * pressed, so opening it unasked would make every attach start by taking input
 * away from the composer. `CM_READ_MODE_AUTO_POPUP=on` is the opt-in, and even
 * then the control-mode test below keeps it from firing for CommandMate's own
 * transport — a popup opened on a control client would be a popup nobody can
 * see and nobody can close.
 */
export const AUTO_POPUP_SCRIPT = `#!/bin/sh
# CommandMate auto read popup (Issue #2317) — generated file, edits are overwritten.
#
#   sh ~/.commandmate/bin/${AUTO_POPUP_SCRIPT_FILENAME} <session> <control_mode> <client>
#
# Opens the following transcript popup for a human client attaching to a
# CommandMate session. Never opens for a control-mode client.
set -u

SESSION="\${1:-}"
CONTROL_MODE="\${2:-0}"
CLIENT="\${3:-}"

case "$SESSION" in
  ${MCBD_SESSION_PREFIX}*) ;;
  *) exit 0 ;;
esac

if [ "$CONTROL_MODE" = "1" ]; then
  exit 0
fi

PAGER_SCRIPT="$HOME/.commandmate/bin/${PAGER_SCRIPT_FILENAME}"
[ -x "$PAGER_SCRIPT" ] || exit 0

if [ -n "$CLIENT" ]; then
  tmux display-popup -c "$CLIENT" -w 90% -h 85% -E "sh \\"$PAGER_SCRIPT\\" --follow \\"$SESSION\\"" 2>/dev/null || true
else
  tmux display-popup -w 90% -h 85% -E "sh \\"$PAGER_SCRIPT\\" --follow \\"$SESSION\\"" 2>/dev/null || true
fi
`;

/** Directory every materialized CommandMate script lives in. */
export function getScriptDir(): string {
  return join(homedir(), '.commandmate', 'bin');
}

/** Absolute path of a materialized script. */
export function getScriptPath(filename: string): string {
  return join(getScriptDir(), filename);
}

/**
 * Write a script to `~/.commandmate/bin/<filename>` if its content changed.
 *
 * Idempotent by content comparison so a restart does not churn the file's mtime,
 * and re-executable after a `chmod` accident because the mode is re-applied —
 * the same contract `materializePagerScript()` has had since #1623.
 *
 * @param filename - Basename to write
 * @param content - Full script text
 * @returns The absolute path written
 */
export function materializeScript(filename: string, content: string): string {
  const scriptPath = getScriptPath(filename);
  mkdirSync(dirname(scriptPath), { recursive: true });

  let current: string | undefined;
  if (existsSync(scriptPath)) {
    try {
      current = readFileSync(scriptPath, 'utf-8');
    } catch {
      current = undefined;
    }
  }
  if (current !== content) {
    writeFileSync(scriptPath, content, { mode: 0o755 });
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Materialize the Phase D restore script and return its absolute path. */
export function materializeLiveRestoreScript(): string {
  return materializeScript(LIVE_RESTORE_SCRIPT_FILENAME, LIVE_RESTORE_SCRIPT);
}

/** Materialize the Phase D delegate script and return its absolute path. */
export function materializeLiveDelegateScript(): string {
  return materializeScript(LIVE_DELEGATE_SCRIPT_FILENAME, LIVE_DELEGATE_SCRIPT);
}

/** Materialize the Phase C auto-popup script and return its absolute path. */
export function materializeAutoPopupScript(): string {
  return materializeScript(AUTO_POPUP_SCRIPT_FILENAME, AUTO_POPUP_SCRIPT);
}
