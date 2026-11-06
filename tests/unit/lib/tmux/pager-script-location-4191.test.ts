/**
 * Issue #4191, item 5: the pager's location is spelled twice — `read-mode.ts`
 * `getPagerScriptPath()` (where it is written, and what `bind-key` names) and
 * the `PAGER_SCRIPT=` line of `AUTO_POPUP_SCRIPT` (where the auto-popup hook
 * looks for it, as `sh` under the hook's `$HOME`). They are kept as two
 * spellings; this holds them to one place. Nothing is written.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { getPagerScriptPath } from '@/lib/tmux/read-mode';
import { PAGER_SCRIPT_FILENAME } from '@/lib/tmux/read-mode-pager';
import { AUTO_POPUP_SCRIPT, SCRIPT_DIR_ENV } from '@/lib/tmux/session-hook-scripts';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The pager path the auto-popup script would use, given a `$HOME`. */
function popupPagerPath(home: string): string {
  const line = AUTO_POPUP_SCRIPT.split('\n').find((l) => l.startsWith('PAGER_SCRIPT='));
  if (line === undefined) throw new Error('AUTO_POPUP_SCRIPT has no PAGER_SCRIPT= line');
  const value = /^PAGER_SCRIPT="(.*)"$/.exec(line)?.[1];
  if (value === undefined) throw new Error(`unexpected PAGER_SCRIPT line: ${line}`);
  return value.replace(/^\$HOME\//, `${home}/`);
}

describe('where the pager script lives (Issue #4191)', () => {
  it('the auto-popup script looks where read-mode writes it', () => {
    expect(popupPagerPath(homedir())).toBe(getPagerScriptPath());
  });

  it('is ~/.commandmate/bin/<pager>, and CM_TMUX_SCRIPT_DIR does not move it', () => {
    vi.stubEnv(SCRIPT_DIR_ENV, '/elsewhere/scripts');
    expect(getPagerScriptPath()).toBe(join(homedir(), '.commandmate', 'bin', PAGER_SCRIPT_FILENAME));
    expect(popupPagerPath(homedir())).toBe(getPagerScriptPath());
  });
});
