/**
 * The launch line is typed behind `clear 2>/dev/null; printf '\033[3J'; ` (Issue #3180),
 * and nothing that reads the pane for "did the tool exit?" changes because of it.
 *
 * `clear` runs in the pane's login shell before the agent, so the shell stays
 * the agent's parent: when the agent quits, the pane falls back to the same
 * prompt it always did, and `judgeToolLiveness` — what `relaunchIfToolExited`
 * and every reuse branch ask — reads the same frame it read before.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { LAUNCH_SCREEN_CLEAR_PREFIX, withLaunchScreenCleared } from '@/lib/session/launch-screen';
import { judgeToolLiveness } from '@/lib/detection/tool-liveness';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

describe('withLaunchScreenCleared', () => {
  it('puts `clear 2>/dev/null; ` in front of the line and leaves the line byte-identical', () => {
    const line =
      "CM_HOOK_URL='http://127.0.0.1:3000/api/hooks/agent-event?tool=antigravity&worktreeId=wt&instanceId=antigravity' " +
      "CM_PERMISSION_HOOK_URL='http://127.0.0.1:3000/api/hooks/permission-request?tool=antigravity&worktreeId=wt&instanceId=antigravity' " +
      "CM_PORT='3000' 'agy' --model 'model'\\''; rm -rf ~ #'";

    const typed = withLaunchScreenCleared(line);

    expect(LAUNCH_SCREEN_CLEAR_PREFIX).toBe("clear 2>/dev/null; printf '\\033[3J'; ");
    expect(typed).toBe(`clear 2>/dev/null; printf '\\033[3J'; ${line}`);
    // The env assignments, their quoting and their order are the line's own.
    expect(typed.slice(LAUNCH_SCREEN_CLEAR_PREFIX.length)).toBe(line);
  });

  it('runs the launch line even when `clear` fails: joined by `;`, never `&&` / `||`', () => {
    const typed = withLaunchScreenCleared("CM_PORT='3000' 'codex'");

    // `clear`'s exit status is not consulted: a missing or failing `clear`
    // (unknown TERM, no ncurses) still reaches the agent, and its stderr does
    // not land on the screen in the launch line's place.
    expect(typed).toBe("clear 2>/dev/null; printf '\\033[3J'; CM_PORT='3000' 'codex'");
    expect(LAUNCH_SCREEN_CLEAR_PREFIX).toMatch(/^clear 2>\/dev\/null; printf '\\033\[3J'; $/);
    expect(LAUNCH_SCREEN_CLEAR_PREFIX).not.toContain('&&');
    expect(LAUNCH_SCREEN_CLEAR_PREFIX).not.toContain('||');
  });

  it('erases the scrollback (ESC [3J) after `clear` and before the launch line', () => {
    // tmux 3.4+ `scroll-on-clear on` moves what `clear` wiped into the
    // scrollback, and capture reads the scrollback (UAT 2026-10-04, tmux 3.5a:
    // codex / antigravity / Command Code / gemini kept the line twice there).
    const line = "CM_PORT='3000' 'codex'";
    const typed = withLaunchScreenCleared(line);
    const clearAt = typed.indexOf('clear 2>/dev/null;');
    const eraseAt = typed.indexOf("printf '\\033[3J';");
    const lineAt = typed.indexOf(line);

    expect(clearAt).toBe(0);
    expect(eraseAt).toBeGreaterThan(clearAt);
    expect(lineAt).toBeGreaterThan(eraseAt);
    // Single-quoted so the shell hands printf the backslash: printf, not the
    // shell, turns `\033` into ESC — the same in zsh, bash, dash and fish.
    expect(typed.slice(eraseAt, lineAt)).toBe("printf '\\033[3J'; ");
  });

  it('makes a POSIX shell write ESC [3J and still run the launch line', () => {
    // `TERM` is dropped so `clear` fails: the line must still run.
    const out = execFileSync('/bin/sh', ['-c', withLaunchScreenCleared('echo launched')], {
      env: { ...process.env, TERM: undefined },
    }).toString('latin1');

    expect(out.endsWith('\x1b[3Jlaunched\n')).toBe(true);
  });
});

describe('exit detection after a `clear 2>/dev/null; ` launch', () => {
  // What the pane holds once the agent has quit: `clear` wiped the echo, the
  // agent drew below it, and the shell printed its prompt again.
  const EXITED_FRAME = ['', 'Goodbye!', '', 'user@host repo % '].join('\n');

  it.each(CLI_TOOL_IDS)('%s: the shell prompt the agent falls back to still reads as exited', (id) => {
    expect(judgeToolLiveness(EXITED_FRAME, resolveLivenessSpec(id)).alive).toBe(false);
  });

  it.each(CLI_TOOL_IDS)('%s: the verdict is the same with or without the echoed launch line above', (id) => {
    const spec = resolveLivenessSpec(id);
    const withEcho = [`user@host repo % CM_PORT='3000' '${id}'`, EXITED_FRAME].join('\n');
    expect(judgeToolLiveness(EXITED_FRAME, spec)).toEqual(judgeToolLiveness(withEcho, spec));
  });
});
