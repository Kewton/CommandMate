/**
 * Issue #4534 r5, INV-catch at run time (R12, the human's decision (iv)): on
 * every path of the four entries, a refusal of the fence — wherever it falls —
 * never ends in a success, its reason (`send target changed: <reason>` or the
 * fence's own type) reaches the send's answer, and nothing more is changed
 * after it (but inside a retraction).
 *
 * The table is not written by hand. Each PATH (entry × tool × screen) is run
 * once with nothing moving, on the G-境 footing (real from the entry down to
 * the drivers; fake: the process boundary, recorded screens, and reads nothing
 * here judges). Every change that run made behind a gate of the open ticket is
 * one ROW: the path is run again with the target changed right before that
 * gate (the roster row of the instance gets another tool after the process call
 * that preceded it), and the row's three properties are checked. Each row is
 * classified by what its gate guarded; every kind of gate place must have at
 * least one row.
 *
 * agy is only ever the recorded screen and the fake process: no real agy, no
 * `~/.gemini` (HOME and PATH are private directories, set before any import).
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence4534-table-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const wt = path.join(root, 'wt');
  for (const d of [home, bin, wt]) fs.mkdirSync(d);
  for (const name of ['claude', 'codex', 'copilot', 'gemini', 'agy', 'opencode', 'opencode2', 'command-code', 'cmd', 'vibe-local', 'vibe']) {
    fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  }
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CM_ANTIGRAVITY_USAGE: process.env.CM_ANTIGRAVITY_USAGE };
  process.env.HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  // The relay and timer origins of agy are refused by the tool policy before any key; declared, so its paths reach the fence.
  process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
  return { root, wt, saved };
});

vi.mock('child_process', async () => (await import('./send-fence-process')).fakeChildProcess());
vi.mock('@/lib/db/db-instance', () => {
  let current: unknown = null;
  return {
    getDbInstance: () => {
      if (current === null) throw new Error('no test db');
      return current;
    },
    setTestDb: (db: unknown) => {
      current = db;
    },
    closeDbInstance: () => {
      current = null;
    },
  };
});
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: vi.fn(() => []) }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));
vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>()),
  getAssignedOpencodePort: vi.fn(() => null),
}));
vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>()),
  getOpencodeLiveness: vi.fn(() => ({ state: 'absent' })),
  getOpencodePrimarySession: vi.fn(() => null),
}));

import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createTimer, getTimerById } from '@/lib/db/timer-db';
import { createRelay, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { addPane, fakeFetch, gateObserver, resetWorld, world, type Out } from './send-fence-process';
import { asRetraction, isFenceRefusal, resetFenceForTests, runWithSendTicket, setFenceObserver } from '@/lib/session/terminal-fence';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { pumpRelayDeliveries, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { getActiveTimerCount, scheduleTimer, stopAllTimers } from '@/lib/timer-manager';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { clearStartupTrust } from '@/lib/cli-tools/antigravity-startup-trust';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { getOpencodeLiveness, getOpencodePrimarySession } from '@/lib/hooks/sources/opencode/subscription';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { buildCopilotFolderTrustFrame, buildCopilotReadyFrame } from '@tests/fixtures/copilot-folder-trust-1080';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';
import { CODEX_TRUST_DIALOG_PANE } from '@tests/fixtures/codex-hooks-review-0148';

registerIsolatedAgentHooksDir('fence4534-table');

afterAll(() => {
  process.env.HOME = sandbox.saved.HOME;
  process.env.PATH = sandbox.saved.PATH;
  if (sandbox.saved.CM_ANTIGRAVITY_USAGE === undefined) delete process.env.CM_ANTIGRAVITY_USAGE;
  else process.env.CM_ANTIGRAVITY_USAGE = sandbox.saved.CM_ANTIGRAVITY_USAGE;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:fs') as typeof import('node:fs')).rmSync(sandbox.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const fixture = (...p: string[]): string => readFileSync(resolve(__dirname, '../../fixtures', ...p), 'utf8');
const SEP = '─'.repeat(40);
const ESC = '\u001b';

/** The idle screen each tool's readiness reads as ready, with `composer` in its input when it shows one. */
const READY: Record<CLIToolType, (composer: string) => string> = {
  claude: (c) => ['⏺ ready', SEP, `${ESC}[39m❯ ${c}`, SEP, '  ⏵⏵ auto mode on'].join('\n'),
  codex: (c) => ['• a reply', '', c ? `${ESC}[1m›${ESC}[0m ${c}` : `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`, '', '  gpt-5.6-sol xhigh · /repo'].join('\n'),
  copilot: () => buildCopilotReadyFrame(),
  gemini: () => '> Type your message or @path/to/file',
  antigravity: () => fixture('antigravity-live-2364', 'boot-idle.txt'),
  opencode: () => buildOpencodeComposerFrame(),
  'opencode-v2': () => fixture('opencode-v2-live-2934', 'boot-idle.txt'),
  'command-code': () => fixture('command-code-live-2250', 'boot-idle.txt'),
  'vibe-local': () => fixture('vibe-local-readiness-4040', 'boot-ready.txt'),
};

/** The screen a launch's wait answers with a key. */
const STARTUP: Partial<Record<CLIToolType, () => string>> = {
  claude: () => fixture('launch-dialog-live-3790', 'claude-trust-2-1-302.txt'),
  codex: () => CODEX_TRUST_DIALOG_PANE,
  copilot: () => buildCopilotFolderTrustFrame(),
  gemini: () => fixture('gemini-live-3776', 'trust-dialog.txt'),
  antigravity: () => fixture('antigravity-live-2364', 'trust-dialog.txt'),
};

const NUDGE = (): string => fixture('claude-auto-default-nudge-4134', 'cursor-yes.txt');

// ---------------------------------------------------------------------------
// The world of one run
// ---------------------------------------------------------------------------

const WT = 'wt-fence-table';
const WT_WORKER = 'wt-fence-table-worker';
const NOW = Date.now();
let db: Database.Database;

const ALL_TOOLS: readonly CLIToolType[] = ['claude', 'codex', 'copilot', 'gemini', 'antigravity', 'opencode', 'opencode-v2', 'command-code', 'vibe-local'];
const OTHER: Record<CLIToolType, CLIToolType> = Object.fromEntries(ALL_TOOLS.map((t) => [t, t === 'claude' ? 'codex' : 'claude'])) as Record<CLIToolType, CLIToolType>;

type Entry = 'send' | 'terminal' | 'relay' | 'timer';
/** What the pane shows besides the tool's idle screen. */
type Screen = 'idle' | 'residue' | 'startup' | 'nudge-launch' | 'nudge-send' | 'stale-shell' | 'dispatch';

interface PathSpec {
  entry: Entry;
  tool: CLIToolType;
  /** Not running before the send: the send's own launch. */
  launch: boolean;
  screen: Screen;
}

const instanceOf = (tool: CLIToolType): string => `${tool}-tbl`;
const sessionOf = (tool: CLIToolType): string => resolveSessionName(tool, WT, instanceOf(tool));

/** What the screen is doing now, per session: drives the frames and names the rows. */
interface ScreenState {
  launched: boolean;
  /** A screen still waiting for its key (startup / nudge). */
  pending: 'startup' | 'nudge' | null;
}
let screenState: ScreenState = { launched: false, pending: null };

async function setupRun(path: PathSpec): Promise<void> {
  resetWorld();
  world.path = sandbox.wt;
  resetFenceForTests();
  resetInstanceInputLocks();
  resetRelayDeliveryState();
  resetSessionLaunchFlightsForTest();
  clearSendAttempts();
  clearCachedClaudePath();
  clearStartupTrust();
  stopAllTimers();
  setFenceObserver(gateObserver);
  const execAnswer = world.execAnswer;
  world.execAnswer = (line) => versionAnswer(line) ?? execAnswer(line);
  db?.close();
  db = new Database(':memory:');
  runMigrations(db);
  const instance = (await import('@/lib/db/db-instance')) as unknown as { setTestDb: (d: unknown) => void };
  instance.setTestDb(db);
  for (const [id, p] of [[WT, sandbox.wt], [WT_WORKER, `${sandbox.wt}-worker`]] as const) {
    upsertWorktree(db, { id, name: id, path: p, repositoryPath: sandbox.wt, repositoryName: 'repo', cliToolId: 'claude' } as Worktree);
  }
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, '', 0, ?)`,
  ).run(WT, instanceOf(path.tool), path.tool, NOW);

  const session = sessionOf(path.tool);
  const composer = path.screen === 'residue' ? 'echo PREFILLED' : '';
  screenState = {
    launched: !path.launch,
    pending: path.screen === 'startup' || path.screen === 'nudge-launch' ? 'startup' : path.screen === 'nudge-send' ? 'nudge' : null,
  };
  if (path.screen === 'nudge-launch') screenState.pending = 'nudge';
  if (!path.launch) {
    addPane(session, (path.screen === 'stale-shell' ? 'shell' : path.tool) as never, composer);
  }
  if (path.screen === 'stale-shell') screenState.launched = false;
  const typed = (): string => world.panes.get(session)?.composer ?? '';
  world.display = (s, format) =>
    format.replace(/#\{(\w+)\}/g, (_m, key: string) => {
      if (key === 'session_path' || key === 'pane_current_path') return world.path;
      if (key === 'pane_current_command') return s === session && screenState.launched ? 'node' : 'zsh';
      if (key === 'pane_pid') return '4242';
      if (key === 'window_width') return '200';
      if (key === 'window_height') return '1000';
      return '';
    });
  world.frame = (s) => {
    if (s !== session) return null;
    if (!screenState.launched) return `user@host repo % ${typed()}`;
    if (screenState.pending === 'startup') return (STARTUP[path.tool] ?? (() => READY[path.tool]('')))();
    if (screenState.pending === 'nudge') return NUDGE();
    return READY[path.tool](typed());
  };
  world.onCall = (o: Out) => {
    if (o.cls !== 'change' || o.session !== session) return;
    if (!screenState.launched && o.line.startsWith('send-keys') && / C-m$/.test(o.line) && !/unset CLAUDECODE/.test(o.line) && !/^send-keys \S+ \S+ $/.test(o.line)) {
      screenState.launched = true;
      return;
    }
    // A key while a startup screen or the nudge is up answers it (the next frame is the idle screen).
    if (screenState.launched && screenState.pending !== null && o.line.startsWith('send-keys') && !/ -l /.test(o.line)) {
      screenState.pending = null;
    }
  };
  if (path.screen === 'dispatch') {
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4835);
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
    vi.mocked(getOpencodePrimarySession).mockReturnValue('ses_tbl');
  } else {
    vi.mocked(getAssignedOpencodePort).mockReturnValue(null);
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'absent' } as never);
    vi.mocked(getOpencodePrimarySession).mockReturnValue(null);
  }
}

/** `--version` answers the drivers' executable probes read (to the fake process). */
function versionAnswer(line: string): string | null {
  if (!/\s--version$/.test(line)) return null;
  const bin = line.split(' ')[0].split('/').pop() ?? '';
  if (bin === 'copilot') return 'GitHub Copilot CLI 1.0.91.';
  if (bin === 'opencode') return '1.18.33';
  if (bin === 'opencode2') return '2.1.0';
  return '1.0.0';
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = fakeFetch((_url, init) =>
    init?.method === 'POST'
      ? { ok: true, status: 204, headers: new Headers(), json: async () => undefined }
      : {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ info: { id: 'msg', role: 'user' }, parts: [{ type: 'text', text: BODY }] }),
        },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setFenceObserver(null);
  stopAllTimers();
});

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

const BODY = 'table body';

/** What the send answered, as each entry answers. */
interface Answer {
  ok: boolean;
  /** Where the reason must be: the route's text, the timer's failure, the error the entry's call into the tools threw. */
  texts: string[];
  /** The error the tool's own method threw, when one did (read before the entry turns it into its answer). */
  toolError: unknown;
  status?: number;
  code?: string;
  lastSendReason?: string;
}

function spyTool(tool: CLIToolType): { error: () => unknown; restore: () => void } {
  const cliTool = CLIToolManager.getInstance().getTool(tool) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let caught: unknown = undefined;
  const spies = (['sendMessage', 'startSession'] as const).map((method) => {
    const original = cliTool[method].bind(cliTool);
    return vi.spyOn(cliTool, method).mockImplementation((...args: unknown[]) =>
      original(...args).catch((error: unknown) => {
        caught ??= error;
        throw error;
      }),
    );
  });
  return { error: () => caught, restore: () => spies.forEach((s) => s.mockRestore()) };
}

async function routeCall(kind: 'send' | 'terminal', body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const mod = kind === 'send' ? await import('@/app/api/worktrees/[id]/send/route') : await import('@/app/api/worktrees/[id]/terminal/route');
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await mod.POST(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as Response;
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function runEntry(path: PathSpec): Promise<Answer> {
  const spy = spyTool(path.tool);
  const instanceId = instanceOf(path.tool);
  try {
    if (path.entry === 'send' || path.entry === 'terminal') {
      const { status, json } =
        path.entry === 'send'
          ? await routeCall('send', { content: BODY, cliToolId: path.tool, instanceId })
          : await routeCall('terminal', { cliToolId: path.tool, command: BODY, instanceId });
      const last = getLastSendAttempt({ worktreeId: WT, cliToolId: path.tool, instanceId } as never);
      return {
        ok: path.entry === 'send' ? status === 201 : status === 200,
        texts: [String(json.error ?? '')],
        toolError: spy.error(),
        status,
        code: typeof json.code === 'string' ? json.code : undefined,
        lastSendReason: last?.reason,
      };
    }
    if (path.entry === 'relay') {
      const relay = createRelay(db, { from: { worktreeId: WT, instanceId }, to: { worktreeId: WT_WORKER, instanceId: 'claude' }, hops: 1, expiresAt: NOW + 86_400_000, now: NOW });
      stashRelayPayload(db, relay.id, 'reply', BODY, NOW);
      await pumpRelayDeliveries();
      const state = (db.prepare('SELECT delivery_state FROM session_relays WHERE id = ?').get(relay.id) as { delivery_state: string | null }).delivery_state;
      return { ok: getRelayPendingPayload(db, relay.id) === null && state === null, texts: [], toolError: spy.error() };
    }
    const timer = createTimer(db, { worktreeId: WT, cliToolId: path.tool, instanceId, message: BODY, delayMs: 0 });
    scheduleTimer(timer.id, WT, 0);
    await vi.waitFor(
      () => {
        const status = getTimerById(db, timer.id)?.status;
        if (status === 'pending' || status === 'sending' || getActiveTimerCount() > 0) throw new Error('timer still running');
      },
      { timeout: 90_000, interval: 20 },
    );
    const row = getTimerById(db, timer.id);
    return { ok: row?.status === 'sent', texts: [row?.error ?? ''], toolError: spy.error() };
  } finally {
    spy.restore();
  }
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** Where a gate stood, by what it guarded. */
type Place = 'launch' | 'startup-answer' | 'nudge' | 'clear' | 'body' | 'enter' | 'dispatch' | 'stop' | 'other';
const REQUIRED_PLACES: readonly Place[] = ['launch', 'startup-answer', 'nudge', 'clear', 'body', 'enter', 'dispatch', 'stop'];

interface Row {
  /**
   * 1-based: the row's gate is the one in front of the k-th change a gate of
   * the open ticket confirmed. The target changes right after the change before
   * it (k-1) — or, for the first, after the run's first process call (after the
   * entry resolved its target).
   */
  k: number;
  /** The change the gate guarded. */
  change: string;
  place: Place;
}

function placeOf(o: Out, screen: { launched: boolean; pending: ScreenState['pending'] }, sawBody: boolean): Place {
  const line = o.line;
  if (o.via === 'fetch') return 'dispatch';
  if (/^kill-session /.test(line)) return 'stop';
  if (/^(new-session|set-option|new-window|respawn-pane|set-window-option|resize-window) /.test(line) || /set-environment/.test(line)) return 'launch';
  if (!screen.launched && /^send-keys /.test(line)) return 'launch';
  if (screen.pending === 'startup' && /^send-keys /.test(line)) return 'startup-answer';
  if (screen.pending === 'nudge' && /^send-keys /.test(line)) return 'nudge';
  if (/^paste-buffer /.test(line) || / -l -- /.test(line)) return 'body';
  if (/^send-keys .* (C-e|C-u|BSpace)( |$)/.test(line)) return 'clear';
  if (/^send-keys .* (Enter|C-m)$/.test(line) && sawBody) return 'enter';
  return 'other';
}

/** The control run, recorded: the rows its gates make. */
async function controlRows(path: PathSpec): Promise<{ rows: Row[]; answer: Answer }> {
  await setupRun(path);
  const rows: Row[] = [];
  let sawBody = false;
  const inner = world.onCall;
  world.onCall = (o) => {
    const screen = { ...screenState };
    if (o.cls === 'change' && (o.permit === 'ticketed' || o.permit === 'batch')) {
      const place = placeOf(o, screen, sawBody);
      if (place === 'body') sawBody = true;
      // A batch's further steps are not confirmed (R3): its rows are its head.
      if (o.permit === 'ticketed') rows.push({ k: rows.length + 1, change: o.line.slice(0, 70), place });
    }
    inner(o);
  };
  const answer = await runEntry(path);
  return { rows, answer };
}

/** The same path, with the target changed right after call `after`. */
async function refusedRun(path: PathSpec, row: Row): Promise<{ answer: Answer; after: string[] }> {
  await setupRun(path);
  const inner = world.onCall;
  let armedAt = -1;
  let confirmed = 0;
  world.onCall = (o) => {
    inner(o);
    if (o.cls === 'change' && o.permit === 'ticketed') confirmed += 1;
    if (armedAt === -1 && confirmed >= row.k - 1) {
      armedAt = world.out.length;
      db.prepare(`UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?`).run(OTHER[path.tool], WT, instanceOf(path.tool));
    }
  };
  const answer = await runEntry(path);
  const after = world.out
    .slice(Math.max(armedAt, 0))
    // A creation the refusal fell in finishes as one change (R3), and a retraction's keys go out (R7).
    .filter((o) => o.cls === 'change' && o.permit !== 'retraction' && o.permit !== 'batch')
    .map((o) => o.line.slice(0, 70));
  return { answer, after };
}

const REASON = /send target changed: (tool-changed|target-gone|worktree-gone|dispatch-changed|unreadable)/;

function reasonKept(answer: Answer): boolean {
  if (answer.texts.some((t) => REASON.test(t))) return true;
  for (let e: unknown = answer.toolError, depth = 0; e !== undefined && e !== null && depth < 10; e = (e as { cause?: unknown }).cause, depth++) {
    if (isFenceRefusal(e)) return true;
    if (e instanceof Error && REASON.test(e.message)) return true;
  }
  return false;
}

/** The row's three properties; the empty list when they hold. */
function rowFailures(path: PathSpec, row: Row, result: { answer: Answer; after: string[] }): string[] {
  const name = `${path.entry}×${path.tool}×${path.screen}${path.launch ? '+launch' : ''} @${row.place} (${row.change})`;
  const f: string[] = [];
  if (result.answer.ok) f.push(`${name}: returned a success`);
  if (!reasonKept(result.answer)) f.push(`${name}: the reason did not reach the answer (${JSON.stringify(result.answer.texts).slice(0, 220)})`);
  if (result.after.length > 0) f.push(`${name}: changed after the refusal: ${JSON.stringify(result.after)}`);
  if (path.entry === 'send' && (result.answer.code === 'SESSION_STARTING' || result.answer.status === 503)) f.push(`${name}: answered 503 SESSION_STARTING (a resend is advised)`);
  if (path.entry === 'send' && result.answer.lastSendReason === 'session-starting') f.push(`${name}: recorded not-sent as session-starting`);
  return f;
}

// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------

const PATHS: PathSpec[] = [
  ...ALL_TOOLS.map((tool): PathSpec => ({ entry: 'send', tool, launch: true, screen: 'idle' })),
  ...(Object.keys(STARTUP) as CLIToolType[]).map((tool): PathSpec => ({ entry: 'send', tool, launch: true, screen: 'startup' })),
  { entry: 'send', tool: 'claude', launch: true, screen: 'nudge-launch' },
  { entry: 'send', tool: 'claude', launch: false, screen: 'nudge-send' },
  { entry: 'send', tool: 'claude', launch: false, screen: 'stale-shell' },
  { entry: 'send', tool: 'claude', launch: false, screen: 'residue' },
  { entry: 'send', tool: 'codex', launch: false, screen: 'residue' },
  { entry: 'send', tool: 'opencode', launch: false, screen: 'dispatch' },
  ...ALL_TOOLS.map((tool): PathSpec => ({ entry: 'terminal', tool, launch: false, screen: tool === 'claude' || tool === 'codex' ? 'residue' : 'idle' })),
  ...ALL_TOOLS.map((tool): PathSpec => ({ entry: 'relay', tool, launch: false, screen: 'idle' })),
  ...ALL_TOOLS.map((tool): PathSpec => ({ entry: 'timer', tool, launch: false, screen: 'idle' })),
];

const placesSeen = new Map<Place, string[]>();
const rowCount = { rows: 0, paths: 0 };

describe('INV-catch (run time): a refusal anywhere on an entry’s path never ends in a success, keeps its reason, changes nothing after it', () => {
  it.each(PATHS.map((p) => [`${p.entry}×${p.tool}×${p.screen}${p.launch ? '+launch' : ''}`, p] as const))(
    '[refusal-table] %s',
    async (_name, path) => {
      const control = await controlRows(path);
      // The control run went through: otherwise the rows would be of a path that never happens.
      expect(control.answer.ok, `control of ${_name}: ${JSON.stringify(control.answer.texts).slice(0, 300)}`).toBe(true);
      expect(control.rows.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const row of control.rows) {
        const result = await refusedRun(path, row);
        failures.push(...rowFailures(path, row, result));
        placesSeen.set(row.place, [...(placesSeen.get(row.place) ?? []), `${_name}`]);
      }
      rowCount.rows += control.rows.length;
      rowCount.paths += 1;
      expect(failures).toEqual([]);
    },
    600_000,
  );

  it('[refusal-table] every kind of gate place has at least one row', () => {
    expect(REQUIRED_PLACES.filter((p) => !placesSeen.has(p))).toEqual([]);
    expect(rowCount.paths).toBe(PATHS.length);
  });
});

describe('the nudge rows, by their answers (claude-auto-default-nudge sendNudgeKey)', () => {
  const nudgeRow = async (path: PathSpec): Promise<{ answer: Answer; after: string[]; ms: number }> => {
    const control = await controlRows(path);
    const row = control.rows.find((r) => r.place === 'nudge');
    expect(row, 'the control run answered the nudge').toBeDefined();
    const started = Date.now();
    const result = await refusedRun(path, row as Row);
    return { ...result, ms: Date.now() - started };
  };

  it('[refusal-table] the launch path (claude.ts answerClaudeAutoDefaultNudgeUntil): the start failure’s 500 with the reason, never 503 SESSION_STARTING, recorded session-start-failed', async () => {
    const { answer, after } = await nudgeRow({ entry: 'send', tool: 'claude', launch: true, screen: 'nudge-launch' });
    // PR-A answered the start step's generic 500 `Failed to start … session: <the refusal>` with no code;
    // PR-B (#4534, C1) answers 409 SEND_TARGET_CHANGED and records `target-changed` (the name above is PR-A's).
    // PR-B (#4534): PR-A の途中の答え 500 は 409 SEND_TARGET_CHANGED に（設計 改 3 §6）
    expect(answer.status).toBe(409);
    expect(answer.code).toBe('SEND_TARGET_CHANGED');
    expect(answer.texts.join(' ')).toMatch(REASON);
    expect(answer.lastSendReason).toBe('target-changed');
    expect(after).toEqual([]);
  }, 600_000);

  it('[refusal-table] the send path (claude-session sendMessageToClaude): refused at once — no 10 s of reads — with the reason in the answer', async () => {
    const { answer, after, ms } = await nudgeRow({ entry: 'send', tool: 'claude', launch: false, screen: 'nudge-send' });
    // PR-B (#4534): PR-A の途中の答え 500 は 409 SEND_TARGET_CHANGED に（設計 改 3 §6）
    expect(answer.status).toBe(409);
    expect(answer.texts.join(' ')).toMatch(REASON);
    expect(ms).toBeLessThan(5_000);
    expect(after).toEqual([]);
  }, 600_000);
});

describe('the latent row: session-key-sender stopSession (claude’s stop) under an open ticket', () => {
  it('[refusal-table] outside a retraction: the stop does not return as done, and nothing is killed', async () => {
    await setupRun({ entry: 'send', tool: 'claude', launch: false, screen: 'idle' });
    const claude = CLIToolManager.getInstance().getTool('claude');
    const outcome = await runWithSendTicket(
      { target: { worktreeId: WT, instanceId: instanceOf('claude'), cliToolId: 'claude' }, resolvedBy: 'roster', kind: 'resolved', confirm: () => 'tool-changed', names: [sessionOf('claude')] },
      () => claude.killSession(WT, instanceOf('claude')),
    ).then((v) => v, (e: unknown) => e);
    expect(isFenceRefusal(outcome)).toBe(true);
    expect(world.out.filter((o) => o.cls === 'change')).toEqual([]);
  });

  it('[refusal-table] inside a retraction (#4115 role kill): the stop goes out as it does with no ticket', async () => {
    const run = async (ticketed: boolean): Promise<{ outcome: unknown; changes: string[] }> => {
      await setupRun({ entry: 'send', tool: 'claude', launch: false, screen: 'idle' });
      const claude = CLIToolManager.getInstance().getTool('claude');
      const stop = (): Promise<unknown> => claude.killSession(WT, instanceOf('claude'));
      const outcome = ticketed
        ? await runWithSendTicket(
            { target: { worktreeId: WT, instanceId: instanceOf('claude'), cliToolId: 'claude' }, resolvedBy: 'roster', kind: 'resolved', confirm: () => 'tool-changed', names: [sessionOf('claude')] },
            async () => {
              await Promise.resolve().then(() => undefined);
              return asRetraction('role-kill', stop);
            },
          )
        : await stop();
      return { outcome, changes: world.out.filter((o) => o.cls === 'change').map((o) => o.line) };
    };
    const bare = await run(false);
    const retracted = await run(true);
    expect(bare.changes.some((l) => l.startsWith('kill-session'))).toBe(true);
    expect(retracted).toEqual(bare);
  });
});

// ---------------------------------------------------------------------------
// INV-catch-after (r6): a record the refusal must not skip
// ---------------------------------------------------------------------------

describe('INV-catch-after: the records a refused key still owes are kept (agy’s owed trust Enter, command-code’s pending composer)', () => {
  /** A ticket for `tool` whose check refuses once `refuse()` says so. */
  const ticketFor = (tool: CLIToolType, refuse: () => boolean) => ({
    target: { worktreeId: WT, instanceId: instanceOf(tool), cliToolId: tool },
    resolvedBy: 'roster',
    kind: 'resolved' as const,
    confirm: () => (refuse() ? ('tool-changed' as const) : null),
    names: [sessionOf(tool)],
  });
  const settled = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (e: unknown) => e);
  const enterKeys = (): string[] => world.out.filter((o) => o.cls === 'change' && /^send-keys \S+ \S+ Enter$/.test(o.line)).map((o) => o.line);

  /** The next send with nothing refused: it answers the trust screen it finds and types the body. */
  async function nextSendAnswersTrust(): Promise<void> {
    const agy = CLIToolManager.getInstance().getTool('antigravity');
    const before = enterKeys().length;
    const outcome = await settled(runWithSendTicket(ticketFor('antigravity', () => false), () => agy.sendMessage(WT, 'after the refusal', instanceOf('antigravity'))));
    expect(outcome instanceof Error ? outcome.message : 'sent').toBe('sent');
    expect(enterKeys().length).toBeGreaterThan(before);
    expect(world.out.some((o) => o.cls === 'change' && o.line.includes('after the refusal'))).toBe(true);
  }

  it('[INV-catch-after] agy waitForReady: the launch window’s trust Enter refused → the Enter stays owed, and the next send answers it', async () => {
    await setupRun({ entry: 'send', tool: 'antigravity', launch: true, screen: 'startup' });
    const session = sessionOf('antigravity');
    const agy = CLIToolManager.getInstance().getTool('antigravity');
    // Refused from the first key after the launch line: the trust Enter of the launch window.
    const outcome = await settled(runWithSendTicket(ticketFor('antigravity', () => screenState.launched), () => agy.startSession(WT, sandbox.wt, instanceOf('antigravity'))));
    expect(isFenceRefusal(outcome)).toBe(true);
    expect(screenState.pending).toBe('startup');
    const { isStartupTrustPending } = await import('@/lib/cli-tools/antigravity-startup-trust');
    expect(isStartupTrustPending(session)).toBe(true);
    await nextSendAnswersTrust();
  }, 120_000);

  it('[INV-catch-after] agy waitForPrompt: the owed Enter claimed, then its key refused → the claim is given back, and the next send answers it', async () => {
    await setupRun({ entry: 'send', tool: 'antigravity', launch: false, screen: 'startup' });
    const session = sessionOf('antigravity');
    const { isStartupTrustPending } = await import('@/lib/cli-tools/antigravity-startup-trust');
    const { markStartupTrustPending } = await import('@/lib/cli-tools/antigravity-startup-trust');
    markStartupTrustPending(session);
    const agy = CLIToolManager.getInstance().getTool('antigravity');
    const outcome = await settled(runWithSendTicket(ticketFor('antigravity', () => true), () => agy.sendMessage(WT, 'refused body', instanceOf('antigravity'))));
    expect(isFenceRefusal(outcome)).toBe(true);
    expect(enterKeys()).toEqual([]);
    expect(isStartupTrustPending(session)).toBe(true);
    await nextSendAnswersTrust();
  }, 120_000);

  it('[INV-catch-after] command-code launchSession: a refused launch leaves no pending composer behind (a later send is not told “still starting”)', async () => {
    await setupRun({ entry: 'send', tool: 'command-code', launch: true, screen: 'idle' });
    const cc = CLIToolManager.getInstance().getTool('command-code') as unknown as { composerPendingSince: Map<string, number>; startSession: (w: string, p: string, i: string) => Promise<void> };
    const outcome = await settled(runWithSendTicket(ticketFor('command-code', () => true), () => cc.startSession(WT, sandbox.wt, instanceOf('command-code'))));
    expect(isFenceRefusal(outcome)).toBe(true);
    expect(cc.composerPendingSince.has(sessionOf('command-code'))).toBe(false);
  }, 120_000);
});
