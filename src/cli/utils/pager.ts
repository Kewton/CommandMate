/**
 * Terminal pager for CLI output (Issue #1623, 案B).
 *
 * `commandmate capture --pane` prints a whole transcript, which is unreadable if
 * it just scrolls past. When stdout is a terminal the text goes through a pager;
 * when it is a pipe or a file it must stay plain so `| grep` and `> file` behave.
 */

import { spawnSync } from 'child_process';

/** Pager used when neither `CM_PAGER` nor `PAGER` is set. `-R` keeps ANSI colors. */
const DEFAULT_PAGER = 'less -R';

/**
 * Resolve the pager command line.
 *
 * `CM_PAGER` wins so a user can page CommandMate output differently from the
 * rest of their shell; `PAGER` is the conventional fallback. An explicitly empty
 * value means "no pager" and is honoured rather than overridden.
 *
 * @returns argv for the pager, or undefined when paging is disabled
 */
export function resolvePagerCommand(): string[] | undefined {
  const configured = process.env.CM_PAGER ?? process.env.PAGER ?? DEFAULT_PAGER;
  const argv = configured.trim().split(/\s+/).filter(Boolean);
  return argv.length > 0 ? argv : undefined;
}

/**
 * Print `text`, paging it when stdout is an interactive terminal.
 *
 * Falls back to plain stdout whenever paging is not possible or not wanted:
 * non-TTY stdout, no pager configured, or a pager that could not be spawned (so
 * a missing `less` degrades to readable output instead of an error).
 *
 * @param text - Content to display
 */
export function printMaybePaged(text: string): void {
  if (!process.stdout.isTTY) {
    console.log(text);
    return;
  }

  const argv = resolvePagerCommand();
  if (!argv) {
    console.log(text);
    return;
  }

  // The pager reads the keyboard from /dev/tty, exactly as in `cmd | less`, so
  // piping the body in through stdin does not cost it its interactivity.
  const result = spawnSync(argv[0], argv.slice(1), {
    input: text.endsWith('\n') ? text : `${text}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    console.log(text);
  }
}
