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
 * `session-starting-state.ts` and module-reference, not changed. A start that
 * comes in after them joins the killed launch until that launch settles, at
 * most the launch's own bound (#3981 P3-1).
 *
 * Positive controls: a new `killSession(` anywhere in src fails the table; a
 * forget added to `session-cleanup` fails the pin (and the doc then has to
 * change with it). Negative control: today's tree matches.
 *
 * Issue #4050: a kill composed for tmux outside the tmux module — an argv or a
 * shell line (`` exec(`tmux kill-session -t ${s}`) ``) — is a kill of the table
 * too, and the callers of `ICLITool.killSession` are every `x.killSession(…)`
 * in src, whatever `x` is called (`manager.getTool(id).killSession(…)`), not
 * the two variable names the route happens to use. The calls that are not the
 * tool's are listed with what they are ({@link OTHER_KILL_SESSION_CALLS}).
 *
 * Issue #4345 1b: the browser's and the CLI's stops reach the kill-session route by its URL, and
 * the page's stop no longer goes through `worktreeApi.killSession(…)` (it sends the same POST
 * itself, to report a 401 to the hand-off's gateway first). So the requests are counted by the
 * URL they compose — every `/api/worktrees/${id}/kill-session` literal in src, each listed with
 * its site ({@link KILL_ROUTE_REQUESTS}) — and the route they reach is the one that forgets.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../guards/route-tmux-reach';
import {
  candidateFiles,
  scanKeyWriters,
  scanLiterals,
  scanMemberCalls,
  scanRawTmuxCommands,
  srcFiles,
  TMUX_MODULE,
  type MemberCall,
  type TmuxCommandSet,
} from '../guards/pane-key-writers-scan';

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

/**
 * tmux's command that kills a session (it has no alias). Only where it goes to
 * tmux: `'kill-session'` alone also names an API (`session-kill-ledger.ts`).
 */
const KILL_COMMAND: TmuxCommandSet = { commands: ['kill-session'], aliases: {} };

/** A kill composed for tmux in `file` — an argv or a shell line (Issue #4050). */
const scanRawKills = (file: string, text: string): Array<{ file: string; site: string }> =>
  scanRawTmuxCommands(file, text, KILL_COMMAND);

function scanKills(): Array<{ file: string; site: string }> {
  return [
    ...candidateFiles().flatMap((f) => scanKeyWriters(f, read(f), ['killSession'])),
    ...srcFiles()
      .filter((f) => f !== TMUX_MODULE)
      .flatMap((f) => scanRawKills(f, read(f))),
  ];
}

/**
 * The `x.killSession(…)` calls in src that are not `ICLITool.killSession`
 * (Issue #4050), each with what it calls. Any other one is taken to be the
 * tool's, so a new caller cannot hide behind a name.
 */
const OTHER_KILL_SESSION_CALLS: readonly { file: string; site: string; receiver: string; calls: string }[] = [
  // Issue #4345 1b: the page's `worktreeApi.killSession(…)` (useWorktreeDetailController) was the one
  // row. The page now sends that POST itself (`killSessionThroughGateway`); it and api-client's
  // `killSession` are counted by their URL in {@link KILL_ROUTE_REQUESTS}.
];

/**
 * Issue #4345 1b: every request composed for the kill-session route in src (by its URL: a string or
 * template `/api/worktrees/${id}/kill-session[?…]`), with what sends it. Each reaches
 * {@link KILL_ROUTE}, the one that forgets the launch. A new one fails until it is listed.
 */
const KILL_ROUTE_REQUESTS: readonly { file: string; site: string; sends: string }[] = [
  { file: 'src/cli/commands/instances.ts', site: 'removeInstance', sends: 'the CLI’s `instances remove` (client.post)' },
  { file: 'src/cli/commands/instances.ts', site: 'killInstance', sends: 'the CLI’s instance kill (client.post)' },
  { file: 'src/components/roles/InstanceRolesSection.tsx', site: 'InstanceRoleRow', sends: 'the roles screen’s restart (fetch POST)' },
  { file: 'src/components/settings/AgentUpdatesCard.tsx', site: 'AgentUpdatesCard', sends: 'the settings’ restart after an update (fetch POST)' },
  {
    file: 'src/hooks/useWorktreeDetailController.ts',
    site: 'killSessionThroughGateway',
    sends: 'the detail page’s stop (fetchApiResponse POST, its 401 reported to the hand-off’s gateway first)',
  },
  { file: 'src/lib/api-client.ts', site: 'killSession', sends: '`worktreeApi.killSession` (fetchApi POST)' },
];

const KILL_ROUTE_URL = /^\/api\/worktrees\/\u0000\/kill-session(?:$|[?\u0000])/;

/** The kill-session route's URL composed in src (and in `extra`, the controls' fixtures). */
function scanKillRouteRequests(extra: ReadonlyArray<{ file: string; text: string }> = []): Array<{ file: string; site: string }> {
  const files = [...srcFiles().map((f) => ({ file: f, text: read(f) })), ...extra];
  return files.flatMap(({ file, text }) => scanLiterals(file, text, (literal) => KILL_ROUTE_URL.test(literal)));
}

function reconcileKillRouteRequests(found: readonly { file: string; site: string }[]): string[] {
  const problems: string[] = [];
  const listed = new Set(KILL_ROUTE_REQUESTS.map(keyOf));
  const seen = new Set(found.map(keyOf));
  for (const key of [...seen].sort()) if (!listed.has(key)) problems.push(`request to the kill-session route not in the table: ${key}`);
  for (const key of [...listed].sort()) if (!seen.has(key)) problems.push(`table row with no request behind it: ${key}`);
  return problems;
}

/** Every `x.killSession(…)` in src, but a tool calling its own (`this` / `super` inside `src/lib/cli-tools/`). */
function scanKillSessionCalls(extra: ReadonlyArray<{ file: string; text: string }> = []): MemberCall[] {
  const files = [...srcFiles().filter((f) => f !== TMUX_MODULE).map((f) => ({ file: f, text: read(f) })), ...extra];
  return files
    .flatMap(({ file, text }) => scanMemberCalls(file, codeOf(text), 'killSession'))
    .filter((c) => !(c.file.startsWith('src/lib/cli-tools/') && (c.receiver === 'this' || c.receiver === 'super')));
}

const isOtherKillSessionCall = (c: MemberCall): boolean =>
  OTHER_KILL_SESSION_CALLS.some((o) => o.file === c.file && o.site === c.site && o.receiver === c.receiver);

/** The files calling `ICLITool.killSession`: every call that is not listed as another's, sorted. */
const toolKillSessionCallers = (calls: readonly MemberCall[]): string[] =>
  [...new Set(calls.filter((c) => !isOtherKillSessionCall(c)).map((c) => c.file))].sort();

function reconcileKills(sites: readonly { file: string; site: string }[], table: readonly StopPath[] = STOP_PATHS): string[] {
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

/**
 * Issue #4163: this test walks all of src. 1.6 to 1.9 s alone and on CI, and 8.6 s at worst with
 * the CPU taken away (`taskpolicy -b`), where 5 s failed it three runs in three. The commit
 * message has the numbers. Sharing the walk is #4066's.
 */
const FULL_SCAN_TIMEOUT_MS = 30_000;

describe('[#4032] every tmux kill-session in src, and whether it forgets the launch', () => {
  it('negative control: the kills in src are the table', () => {
    expect(reconcileKills(scanKills())).toEqual([]);
  }, FULL_SCAN_TIMEOUT_MS);

  it('positive: a new kill anywhere in src fails until it is put in the table', () => {
    const text = "import { killSession } from '../tmux/tmux';\nexport async function reap(s: string) { await killSession(s); }\n";
    expect(reconcileKills([...scanKills(), ...scanKeyWriters('src/lib/reaper.ts', text, ['killSession'])])).toEqual([
      'kill not in the table: src/lib/reaper.ts :: reap',
    ]);
  });

  it('the tools’ killSession is called from the kill-session route only, which forgets after it', () => {
    // Issue #4050: by the method's name, not the variable's.
    const callers = toolKillSessionCallers(scanKillSessionCalls());
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

describe('[#4050] a kill or a tool kill written in a shape #4032’s table did not read', () => {
  it('positive: a shell line or an argv that kills through tmux fails until it is put in the table', () => {
    for (const [text, site] of [
      ['export async function reapShell(s: string) { await execAsync(`tmux kill-session -t ${s}`); }\n', 'reapShell'],
      ["export async function reapSock(s: string) { await execFile('tmux', ['-L', 'cm', 'kill-session', '-t', s]); }\n", 'reapSock'],
    ] as const) {
      expect(reconcileKills([...scanKills(), ...scanRawKills('src/lib/reaper.ts', text)]), text).toEqual([
        `kill not in the table: src/lib/reaper.ts :: ${site}`,
      ]);
    }
  });

  it('negative: a permission pattern, an API path and a log label are not kills', () => {
    const text =
      "const allow = ['Bash(tmux kill-session:*)'];\n" +
      "await client.post(`/api/worktrees/${id}/kill-session?instance=${i}`);\n" +
      "logger.error('kill-session-failed', {});\n";
    expect(scanRawKills('src/lib/x.ts', text)).toEqual([]);
  });

  it('positive: a tool’s killSession called through any other name is a caller', () => {
    for (const text of [
      'export async function stopAll(id: string) { await manager.getTool(id).killSession(id); }\n',
      'export async function stopOne(t: ICLITool, id: string) { await t.killSession(id); }\n',
      "export async function stopKeyed(t: ICLITool, id: string) { await t['killSession'](id); }\n",
    ]) {
      const callers = toolKillSessionCallers(scanKillSessionCalls([{ file: 'src/lib/stopper.ts', text }]));
      expect(callers, text).toEqual([KILL_ROUTE, 'src/lib/stopper.ts']);
    }
  });

  it('negative: a tool calling its own killSession, a declaration, and prose are not callers', () => {
    const text =
      'class T { async killSession(id: string) {} async restart(id: string) { await this.killSession(id); } }\n' +
      '// manager.getTool(id).killSession(id)\n';
    expect(scanKillSessionCalls([{ file: 'src/lib/cli-tools/t.ts', text }]).filter((c) => c.file === 'src/lib/cli-tools/t.ts')).toEqual([]);
  });

  it('every call listed as another’s is still there', () => {
    const calls = scanKillSessionCalls();
    for (const other of OTHER_KILL_SESSION_CALLS) {
      expect(calls.some((c) => c.file === other.file && c.site === other.site && c.receiver === other.receiver), other.file).toBe(true);
    }
  });
});

describe('[#4345 1b] every request to the kill-session route, whatever sends it', () => {
  it('negative control: the requests composed for the route in src are the table, and the route is a POST that forgets', () => {
    expect(reconcileKillRouteRequests(scanKillRouteRequests())).toEqual([]);
    const route = codeOf(read(KILL_ROUTE));
    expect(route).toMatch(/export async function POST\(/);
    expect(route).toMatch(/clearSessionStarting\(id, cliToolId, instanceId\)/);
  }, FULL_SCAN_TIMEOUT_MS);

  it('the page’s stop is one of them: sent by killSessionThroughGateway, which the stop calls', () => {
    const controller = codeOf(read('src/hooks/useWorktreeDetailController.ts'));
    expect(controller).toMatch(/await killSessionThroughGateway\(worktreeId, target, killAuthRequest\)/);
    expect(controller).toMatch(/method: 'POST'/);
  });

  it('positive: a new request to the route fails until it is listed', () => {
    for (const [text, site] of [
      ["export async function stopIt(id: string) { await fetch(`/api/worktrees/${id}/kill-session`, { method: 'POST' }); }\n", 'stopIt'],
      ["export async function stopOne(id: string, q: string) { await fetch(`/api/worktrees/${id}/kill-session?${q}`, { method: 'POST' }); }\n", 'stopOne'],
    ] as const) {
      expect(reconcileKillRouteRequests(scanKillRouteRequests([{ file: 'src/lib/stopper.ts', text }])), text).toEqual([
        `request to the kill-session route not in the table: src/lib/stopper.ts :: ${site}`,
      ]);
    }
  }, FULL_SCAN_TIMEOUT_MS);

  it('negative: a comment, a log label and another route are not requests to it', () => {
    const text =
      '// POST /api/worktrees/:id/kill-session\n' +
      "logger.error('kill-session-failed', {});\n" +
      'export const u = (id: string) => `/api/worktrees/${id}/kill-session-ledger`;\n';
    expect(scanLiterals('src/lib/x.ts', text, (literal) => KILL_ROUTE_URL.test(literal))).toEqual([]);
  });
});
