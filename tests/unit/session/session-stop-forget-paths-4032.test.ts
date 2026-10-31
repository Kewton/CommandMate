/**
 * Issue #4032: which stops of a session forget its launch in progress.
 *
 * `clearSessionStarting` without a token drops the "starting" record and
 * forgets the session's launch (`forgetSessionLaunch`, #3981), so the next
 * start is a launch of its own. Only the kill-session route calls it. Every
 * `tmux kill-session` in src is enumerated here (read off the source with the
 * pane-key-writers scanner), with what each one does about the launch.
 *
 * Decided (#4032): `session-cleanup`'s two kills do not forget — recorded in
 * `session-starting-state.ts` and module-reference, not changed, because
 * `session-cleanup.ts` was outside #4032's scope. A start that comes in after
 * them joins the killed launch until the launch's own bound (#3981 P3-1).
 *
 * Positive controls: a new `killSession(` anywhere in src fails the table; a
 * forget added to `session-cleanup` fails the pin (and the doc then has to
 * change with it). Negative control: today's tree matches.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../guards/route-tmux-reach';
import { candidateFiles, scanKeyWriters, srcFiles, type KeySite } from '../guards/pane-key-writers-scan';

type Forget =
  /** Reached only through `ICLITool.killSession`, whose one caller (the route) forgets after it. */
  | 'via-kill-session-route'
  /** A kill inside a launch of its own (the launch is not over). */
  | 'inside-launch'
  /** Kills and does not forget: the recorded constraint. */
  | 'does-not-forget'
  /** No caller in src. */
  | 'no-caller';

interface StopPath {
  file: string;
  site: string;
  count?: number;
  forget: Forget;
}

const STOP_PATHS: readonly StopPath[] = [
  { file: 'src/lib/cli-tools/base.ts', site: 'BaseCLITool.requestExitAndKill', forget: 'via-kill-session-route' },
  { file: 'src/lib/cli-tools/opencode-v2.ts', site: 'OpenCodeV2Tool.killSession', count: 2, forget: 'via-kill-session-route' },
  { file: 'src/lib/cli-tools/opencode.ts', site: 'OpenCodeTool.killSession', count: 2, forget: 'via-kill-session-route' },
  { file: 'src/lib/session-key-sender.ts', site: 'stopSession', forget: 'via-kill-session-route' },
  { file: 'src/lib/session/claude-session.ts', site: 'ensureHealthySession', forget: 'inside-launch' },
  { file: 'src/lib/session-cleanup.ts', site: 'killWorktreeSession', forget: 'does-not-forget' },
  { file: 'src/lib/session-cleanup.ts', site: 'cleanupGlobalSessions', forget: 'does-not-forget' },
  { file: 'src/lib/tmux/control-mode-tmux-transport.ts', site: 'ControlModeTmuxTransport.killSession', forget: 'no-caller' },
  { file: 'src/lib/tmux/polling-tmux-transport.ts', site: 'PollingTmuxTransport.killSession', forget: 'no-caller' },
];

const KILL_ROUTE = 'src/app/api/worktrees/[id]/kill-session/route.ts';
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8');
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const keyOf = (r: { file: string; site: string }): string => `${r.file} :: ${r.site}`;

function scanKills(): KeySite[] {
  return candidateFiles().flatMap((f) => scanKeyWriters(f, read(f), ['killSession']));
}

function reconcileKills(sites: readonly KeySite[], table: readonly StopPath[] = STOP_PATHS): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, number>();
  for (const s of sites) byKey.set(keyOf(s), (byKey.get(keyOf(s)) ?? 0) + 1);
  const rows = new Map(table.map((r) => [keyOf(r), r]));
  for (const [key, n] of byKey) {
    const row = rows.get(key);
    if (row === undefined) problems.push(`kill not in the table: ${key}`);
    else if (n !== (row.count ?? 1)) problems.push(`kill count changed: ${key} has ${n}, the table says ${row.count ?? 1}`);
  }
  for (const key of rows.keys()) if (!byKey.has(key)) problems.push(`table row with no kill behind it: ${key}`);
  return problems;
}

describe('[#4032] every tmux kill-session in src, and whether it forgets the launch', () => {
  it('negative control: the kills in src are the table', () => {
    expect(reconcileKills(scanKills())).toEqual([]);
  });

  it('positive: a new kill anywhere in src fails until it is put in the table', () => {
    const text = "import { killSession } from '../tmux/tmux';\nexport async function reap(s: string) { await killSession(s); }\n";
    expect(reconcileKills([...scanKills(), ...scanKeyWriters('src/lib/reaper.ts', text, ['killSession'])])).toEqual([
      'kill not in the table: src/lib/reaper.ts :: reap',
    ]);
  });

  it('the tools’ killSession is called from the kill-session route only, which forgets after it', () => {
    const callers = srcFiles().filter((f) => /\bcliTool\.killSession\(|\btool\.killSession\(/.test(codeOf(read(f))));
    expect(callers).toEqual([KILL_ROUTE]);
    const route = codeOf(read(KILL_ROUTE));
    expect(route).toMatch(/clearSessionStarting\(id, cliToolId, instanceId\)/);
    expect(route.indexOf('cliTool.killSession(')).toBeLessThan(route.indexOf('clearSessionStarting(id, cliToolId, instanceId)'));
  });

  it('session-cleanup kills without forgetting — the constraint session-starting-state documents', () => {
    const cleanup = codeOf(read('src/lib/session-cleanup.ts'));
    expect(cleanup).not.toMatch(/\bclearSessionStarting\b|\bforgetSessionLaunch\b/);
    const doc = read('src/lib/session/session-starting-state.ts');
    expect(doc).toContain('The stops that do not forget (Issue #4032)');
    for (const site of STOP_PATHS.filter((r) => r.forget === 'does-not-forget')) expect(doc).toContain(site.site);
  });
});
