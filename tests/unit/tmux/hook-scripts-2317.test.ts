/**
 * Issue #2317 — the shell the hooks actually run.
 *
 * These scripts execute on the user's tmux server, outside CommandMate, with no
 * node and no `dist/`. Nothing in TypeScript can catch a mistake in them, so
 * this file does two things a reader cannot: it runs `sh -n` over each one (a
 * syntax error would otherwise surface as a hook that silently does nothing),
 * and it pins the guards each script must keep.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  AUTO_POPUP_SCRIPT,
  AUTO_POPUP_SCRIPT_FILENAME,
  LIVE_DELEGATE_SCRIPT,
  LIVE_DELEGATE_SCRIPT_FILENAME,
  LIVE_RESTORE_SCRIPT,
  LIVE_RESTORE_SCRIPT_FILENAME,
} from '@/lib/tmux/session-hook-scripts';
import { PAGER_SCRIPT, PAGER_SCRIPT_FILENAME } from '@/lib/tmux/read-mode-pager';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { removeTempDir } from '@tests/helpers/temp-dir';

const SCRIPTS: ReadonlyArray<{ name: string; text: string }> = [
  { name: LIVE_RESTORE_SCRIPT_FILENAME, text: LIVE_RESTORE_SCRIPT },
  { name: LIVE_DELEGATE_SCRIPT_FILENAME, text: LIVE_DELEGATE_SCRIPT },
  { name: AUTO_POPUP_SCRIPT_FILENAME, text: AUTO_POPUP_SCRIPT },
  { name: PAGER_SCRIPT_FILENAME, text: PAGER_SCRIPT },
];

describe('every generated script parses as POSIX sh', () => {
  it.each(SCRIPTS)('$name', ({ name, text }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cm-2317-sh-'));
    try {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      // `sh -n` parses without executing. A hook whose script does not parse
      // fires, exits 2, and looks exactly like a hook that was never installed.
      expect(() => execFileSync('/bin/sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('the restore script', () => {
  it('waits for the HUMAN client count to reach zero', () => {
    // `#{session_attached}` is 1 forever, because CommandMate's own control-mode
    // transport never detaches. The control-mode filter is the whole difference.
    expect(LIVE_RESTORE_SCRIPT).toContain("#{client_control_mode}");
    expect(LIVE_RESTORE_SCRIPT).toContain("grep -c -v '^1$'");
    expect(LIVE_RESTORE_SCRIPT).not.toContain('session_attached');
  });

  it('returns to the #1163 canvas by default', () => {
    expect(LIVE_RESTORE_SCRIPT).toContain(`WIDTH="\${3:-${TUI_PANE_WIDTH}}"`);
    expect(LIVE_RESTORE_SCRIPT).toContain(`HEIGHT="\${4:-${TUI_PANE_HEIGHT}}"`);
    expect(LIVE_RESTORE_SCRIPT).toContain('window-size manual');
    expect(LIVE_RESTORE_SCRIPT).toContain('@cm_delegated');
  });

  it('refuses a session that is not CommandMate\'s', () => {
    expect(LIVE_RESTORE_SCRIPT).toContain('mcbd-*)');
  });

  it('does nothing when the detaching client was a control client', () => {
    expect(LIVE_RESTORE_SCRIPT).toContain('if [ "$CONTROL_MODE" = "1" ]; then');
  });
});

describe('the delegate script', () => {
  it('only ever acts on a claude session', () => {
    // Not a shortcut: a hook fires with tmux formats, not with CommandMate's
    // roster, so the session NAME is all it has. Widening it means widening
    // LIVE_ATTACH_TOOLS, which needs the per-tool re-measurement #2317 defers.
    expect(LIVE_DELEGATE_SCRIPT).toContain('mcbd-claude-*)');
  });

  it('raises the flag before changing the size, never the other way round', () => {
    const flagAt = LIVE_DELEGATE_SCRIPT.indexOf('@cm_delegated 1');
    const sizeAt = LIVE_DELEGATE_SCRIPT.indexOf('window-size latest');
    expect(flagAt).toBeGreaterThan(0);
    expect(sizeAt).toBeGreaterThan(flagAt);
  });

  it('never restores — the attach edge is the only one tmux gives a session hook', () => {
    expect(LIVE_DELEGATE_SCRIPT).not.toContain('window-size manual');
    expect(LIVE_DELEGATE_SCRIPT).not.toContain('resize-window');
  });

  it('does nothing for a control-mode client', () => {
    // Handing the canvas to CommandMate's own transport would resize it to
    // whatever that connection negotiated — the #1163 regression itself.
    expect(LIVE_DELEGATE_SCRIPT).toContain('if [ "$CONTROL_MODE" = "1" ]; then');
  });
});

describe('the auto-popup script', () => {
  it('opens the FOLLOWING popup, on the client that attached', () => {
    expect(AUTO_POPUP_SCRIPT).toContain('--follow');
    expect(AUTO_POPUP_SCRIPT).toContain('display-popup -c "$CLIENT"');
    expect(AUTO_POPUP_SCRIPT).toContain(PAGER_SCRIPT_FILENAME);
  });

  it('never opens for a control-mode client', () => {
    // A popup on a control client is a popup nobody can see and nobody can close.
    expect(AUTO_POPUP_SCRIPT).toContain('if [ "$CONTROL_MODE" = "1" ]; then');
  });

  it('changes no geometry at all', () => {
    for (const verb of ['resize-window', 'resize-pane', 'window-size', 'set-option']) {
      expect(AUTO_POPUP_SCRIPT, verb).not.toContain(verb);
    }
  });
});

describe('the pager script in --follow mode', () => {
  it('still only reads the pane', () => {
    // Issue #2317 受入条件 Phase C 2: the window's geometry must not change
    // because somebody opened a reader. `tests/unit/lib/tmux/reading-mode-invariants.test.ts`
    // pins the same property over the whole script; this is the follow path's
    // own share of it.
    expect(PAGER_SCRIPT).toContain('capture-pane -pe');
    for (const verb of ['resize', 'window-size', 'set-option', 'send-keys']) {
      expect(PAGER_SCRIPT, verb).not.toContain(verb);
    }
  });

  it('quits on q and restores the terminal however it ends', () => {
    expect(PAGER_SCRIPT).toContain('q|Q) exit 0 ;;');
    expect(PAGER_SCRIPT).toContain("trap 'cm_read_restore_tty' EXIT");
    expect(PAGER_SCRIPT).toContain("trap 'cm_read_restore_tty; exit 0' INT TERM");
  });

  it('reads a key with a deadline rather than blocking or busy-spinning', () => {
    // `min 0 time 2` makes a one-byte read return after 0.2s with nothing.
    expect(PAGER_SCRIPT).toContain('stty -icanon -echo min 0 time 2');
    expect(PAGER_SCRIPT).toContain('dd bs=1 count=1');
  });

  it('leaves the snapshot path exactly as #1623 shipped it', () => {
    expect(PAGER_SCRIPT).toContain('less -R +G');
    expect(PAGER_SCRIPT).toContain('CM_READ_LINES:-1000');
  });
});
