/**
 * Every worktree route that can reach tmux refuses a session another server
 * created (Issue #3290).
 *
 * ## What happened
 *
 * Issue #2865 gave the worktree routes a session-ownership check: a tmux
 * session with the right NAME but another server's `#{session_path}` is
 * answered 409 and left alone. Which routes needed it was decided by a grep for
 * the functions that touch tmux, and the completeness claim in that commit was
 * "all 12 routes the grep returns import session-ownership".
 * `direct-input/route.ts` reaches tmux through `sendDirectInput(`, one wrapper
 * away from every name in the grep, so it was never returned and went on
 * finding its session by name alone: a key typed into the direct-input bar
 * would go to whichever server owned that name, and the answer would be
 * `{ success: true }`.
 *
 * Both halves of that claim were the wrong kind of evidence. A list of function
 * names misses the next wrapper, and "imports the module" says nothing about
 * whether the check runs before the send. So this guard has two stages and
 * neither of them reads a name:
 *
 * 1. **Enumerate by reachability.** `route-tmux-reach.ts` walks the import
 *    graph from each `route.ts` under `src/app/api/worktrees/[id]/` and returns
 *    the handlers whose file can reach a module that runs the tmux binary.
 * 2. **Judge by behaviour.** Each enumerated handler is called with the same
 *    case — the session it would address exists and belongs to another server —
 *    and has to answer 409 with the ownership code, having asked tmux whose
 *    session it is and having sent tmux nothing else. "Nothing else" is read at
 *    the process boundary (`fake-tmux-child-process.ts`), below every wrapper.
 *
 * A handler stage 1 returns that is neither in the table nor in the written
 * exemption list fails the suite, so a new route cannot arrive unexamined.
 *
 * ## Why it cannot pass for the wrong reason
 *
 * - The route as it shipped before this fix is kept as a fixture and run
 *   through both stages; each has to object to it.
 * - The pre-#3290 grep is run on that same fixture and has to miss it, which is
 *   the accident itself, restated as an assertion.
 * - The same request against a session this worktree owns goes through and its
 *   keys are seen arriving, so "nothing was sent" is not what the recorder says
 *   about everything.
 *
 * @vitest-environment node
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

vi.mock('child_process', async (importOriginal) =>
  (await import('@tests/unit/guards/fake-tmux-child-process')).fakeChildProcess(importOriginal)
);

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, upsertWorktree } from '@/lib/db';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { FOREIGN_SESSION_ERROR_CODE } from '@/lib/cli-tools/session-ownership';
import { resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';
import { clearAllAutoYesStates, getAutoYesState, stopAllAutoYesPolling } from '@/lib/polling/auto-yes-manager';
import { MIN_DELAY_MS } from '@/config/timer-constants';
import type { Worktree } from '@/types/models';
import { fakeTmux } from '@tests/unit/guards/fake-tmux-child-process';
import {
  REPO_ROOT,
  WORKTREE_ROUTES_DIR,
  analyseSource,
  createModuleGraph,
  enumerateTmuxReachingHandlers,
  repoRelative,
  routeFiles,
} from '@tests/unit/guards/route-tmux-reach';

// =============================================================================
// The case every handler is given
// =============================================================================

const WORKTREE_ID = 'wt-3290';
const WORKTREE_PATH = '/nonexistent-3290/this-server/wt-3290';
const OTHER_SERVER_PATH = '/nonexistent-3290/other-server/wt-3290';
/** The session every request below resolves to: the worktree's claude primary. */
const CLAUDE_SESSION = resolveSessionName('claude', WORKTREE_ID);

type Handler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;

function request(method: string, route: string, body?: unknown, query = ''): NextRequest {
  const suffix = route === '' ? '' : `/${route}`;
  return new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}${suffix}${query}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const params = () => ({ params: Promise.resolve({ id: WORKTREE_ID }) });

/** Let fire-and-forget work finish before reading what reached tmux. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A stored prompt of the claude session that nobody has answered yet. */
function pendingPromptId(db: Database.Database): string {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    role: 'assistant',
    content: 'Do you want to proceed?',
    messageType: 'prompt',
    promptData: {
      type: 'yes_no',
      question: 'Do you want to proceed?',
      options: ['yes', 'no'],
      status: 'pending',
    },
    timestamp: new Date(),
  }).id;
}

// =============================================================================
// Stage 2's table: the smallest valid request for each handler
// =============================================================================

/**
 * What a handler owes a foreign session.
 *
 * - `refuses`: it would send to, read, stop or arm the session, so it answers
 *   409 with the ownership code.
 * - `reports`: it describes the worktree, and a session another server owns is
 *   simply not this worktree's — 200, with the session reported as not running.
 *   `why` says why 409 would be the wrong answer; `complaint` returns what is
 *   wrong with the body, or null.
 *
 * Either way nothing but read-only probes may reach tmux, and for a `reports`
 * row that is the half that carries the weight: a handler that read the foreign
 * pane and then called it "not running" would still be reading it.
 */
type Expectation =
  | { kind: 'refuses' }
  | { kind: 'reports'; why: string; complaint: (body: Record<string, unknown>) => string | null };

interface Row {
  /** `<path under src/app/api/worktrees/[id]/>#<METHOD>` — the key stage 1 produces. */
  handler: string;
  /** The smallest request that gets as far as the session. */
  request: (db: Database.Database) => NextRequest;
  expects: Expectation;
}

const REFUSES: Expectation = { kind: 'refuses' };

function reportsNotRunning(why: string): Expectation {
  return {
    kind: 'reports',
    why,
    complaint: (body) =>
      body.isSessionRunning === false ? null : `isSessionRunning is ${String(body.isSessionRunning)}, expected false`,
  };
}

const TABLE: readonly Row[] = [
  {
    handler: 'auto-yes/route.ts#POST',
    request: () => request('POST', 'auto-yes', { enabled: true, cliToolId: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'capture/route.ts#POST',
    request: () => request('POST', 'capture', { cliToolId: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'clear-composer/route.ts#POST',
    request: () => request('POST', 'clear-composer', { cliToolId: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'current-output/route.ts#GET',
    request: () => request('GET', 'current-output', undefined, '?cliTool=claude'),
    expects: REFUSES,
  },
  {
    handler: 'direct-input/route.ts#POST',
    request: () => request('POST', 'direct-input', { cliToolId: 'claude', events: [{ type: 'key', key: 'Enter' }] }),
    expects: REFUSES,
  },
  {
    handler: 'interrupt/route.ts#POST',
    request: () => request('POST', 'interrupt', { cliToolId: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'kill-session/route.ts#POST',
    request: () => request('POST', 'kill-session', {}, '?cliTool=claude'),
    expects: REFUSES,
  },
  {
    handler: 'prompt-response/route.ts#POST',
    request: () => request('POST', 'prompt-response', { answer: 'yes', cliTool: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'respond/route.ts#POST',
    request: (db) => request('POST', 'respond', { messageId: pendingPromptId(db), answer: 'yes' }),
    expects: REFUSES,
  },
  {
    handler: 'send/route.ts#POST',
    request: () => request('POST', 'send', { content: 'hello', cliToolId: 'claude' }),
    expects: REFUSES,
  },
  {
    handler: 'special-keys/route.ts#POST',
    request: () => request('POST', 'special-keys', { cliToolId: 'claude', keys: ['Enter'] }),
    expects: REFUSES,
  },
  {
    handler: 'terminal/route.ts#POST',
    request: () => request('POST', 'terminal', { cliToolId: 'claude', command: 'ls' }),
    expects: REFUSES,
  },
  {
    handler: 'timers/route.ts#POST',
    request: () => request('POST', 'timers', { cliToolId: 'claude', message: 'hello', delayMs: MIN_DELAY_MS }),
    expects: REFUSES,
  },
  {
    handler: 'route.ts#GET',
    request: () => request('GET', ''),
    expects: reportsNotRunning(
      'the worktree detail read: it lists what this worktree is running, and a session another ' +
        'server created is not part of that list (#2865 filters it out of the session-name set)'
    ),
  },
  {
    handler: 'route.ts#PATCH',
    request: () => request('PATCH', '', { description: 'edited' }),
    expects: reportsNotRunning(
      'a metadata edit that echoes the session status back: the edit is about the worktree row, ' +
        'so it succeeds, and the foreign session is reported as not running'
    ),
  },
];

/**
 * Handlers stage 1 returns that are deliberately not judged, each with the
 * reason. "Can reach" is an over-approximation — most of these arrive through
 * the CLI-tool manager's import graph without ever naming a session.
 *
 * `reachesOnly`, where given, is the exact set of tmux-running modules the
 * route file can reach. It is asserted, so an exemption written for "this only
 * lists session names" stops matching the day the route gains a path to
 * anything else, and has to be looked at again.
 */
interface Exemption {
  handler: string;
  reason: string;
  reachesOnly?: readonly string[];
}

const ENV_SNAPSHOT_ONLY = ['src/lib/verification/env-snapshot.ts'] as const;
const ENV_SNAPSHOT_REASON =
  'reaches tmux only through the env-clean snapshot, which runs `list-sessions` to count ' +
  'session names before and after a run; it never addresses a session';

const EXEMPT: readonly Exemption[] = [
  {
    handler: 'auto-yes/route.ts#GET',
    reason:
      'reads the in-memory Auto-Yes state for a target resolved from the roster; it derives no ' +
      'session name and sends nothing (arming is the POST, which is in the table)',
  },
  {
    handler: 'timers/route.ts#GET',
    reason: 'lists this worktree\'s timer rows from the database',
  },
  {
    handler: 'timers/route.ts#DELETE',
    reason:
      'cancels a pending timer (database row + in-memory schedule); the session is only addressed ' +
      'when a timer fires, and registering one is the POST, which is in the table',
  },
  {
    handler: 'instances/opencode/route.ts#GET',
    reason:
      'reads opencode launch settings from the database and the model catalogue from opencode\'s ' +
      'own HTTP port; no tmux session is named',
  },
  {
    handler: 'instances/opencode/route.ts#PUT',
    reason: 'writes one instance\'s opencode launch settings (database + launcher mirror); applies on the next launch',
  },
  {
    handler: 'skills/[skillId]/git-workflow/route.ts#POST',
    reason:
      'asks only whether a session by each instance\'s name exists, to refuse a branch switch under a ' +
      'live agent. A foreign session makes it refuse (fail closed); nothing is sent, read or stopped',
  },
  { handler: 'tasks/route.ts#GET', reason: ENV_SNAPSHOT_REASON, reachesOnly: ENV_SNAPSHOT_ONLY },
  { handler: 'tasks/route.ts#POST', reason: ENV_SNAPSHOT_REASON, reachesOnly: ENV_SNAPSHOT_ONLY },
  { handler: 'verify/config/route.ts#GET', reason: ENV_SNAPSHOT_REASON, reachesOnly: ENV_SNAPSHOT_ONLY },
  { handler: 'verify/config/route.ts#POST', reason: ENV_SNAPSHOT_REASON, reachesOnly: ENV_SNAPSHOT_ONLY },
  { handler: 'verify/route.ts#POST', reason: ENV_SNAPSHOT_REASON, reachesOnly: ENV_SNAPSHOT_ONLY },
  {
    handler: 'verify/runs/[runId]/cancel/route.ts#POST',
    reason: ENV_SNAPSHOT_REASON,
    reachesOnly: ENV_SNAPSHOT_ONLY,
  },
];

// =============================================================================
// Coverage: enumeration vs table + exemptions
// =============================================================================

interface CoverageGaps {
  /** Enumerated, and neither judged nor exempted. The failure this guard exists for. */
  unexamined: string[];
  /** In the table but no longer enumerated (renamed, removed, or no longer reaches tmux). */
  staleRows: string[];
  /** Exempted but no longer enumerated. */
  staleExemptions: string[];
  /** Listed on both sides: one of the two entries is wrong. */
  contradictory: string[];
}

function coverageGaps(enumerated: string[], judged: string[], exempted: string[]): CoverageGaps {
  const all = new Set(enumerated);
  const judgedSet = new Set(judged);
  const exemptedSet = new Set(exempted);
  return {
    unexamined: enumerated.filter((key) => !judgedSet.has(key) && !exemptedSet.has(key)),
    staleRows: judged.filter((key) => !all.has(key)),
    staleExemptions: exempted.filter((key) => !all.has(key)),
    contradictory: judged.filter((key) => exemptedSet.has(key)),
  };
}

const NO_GAPS: CoverageGaps = { unexamined: [], staleRows: [], staleExemptions: [], contradictory: [] };

// =============================================================================
// Stage 2's judge
// =============================================================================

/**
 * Call `handler` with `row`'s request and return everything that is wrong with
 * how it treated the session — empty when it behaved. Returned rather than
 * asserted so the same judge can be shown to object to the unguarded fixture.
 */
async function objections(row: Row, handler: Handler, db: Database.Database): Promise<string[]> {
  const response = await handler(row.request(db), params());
  await settle();
  const body = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const found: string[] = [];

  if (row.expects.kind === 'refuses') {
    if (response.status !== 409) found.push(`answered ${response.status}, expected 409`);
    if (body.code !== FOREIGN_SESSION_ERROR_CODE) {
      found.push(`code is ${JSON.stringify(body.code)}, expected ${JSON.stringify(FOREIGN_SESSION_ERROR_CODE)}`);
    }
    if (body.sessionName !== CLAUDE_SESSION) {
      found.push(`sessionName is ${JSON.stringify(body.sessionName)}, expected ${JSON.stringify(CLAUDE_SESSION)}`);
    }
    if (!fakeTmux.askedSessionPathOf(CLAUDE_SESSION)) {
      found.push(`never asked tmux for the #{session_path} of ${CLAUDE_SESSION}`);
    }
  } else {
    if (response.status !== 200) found.push(`answered ${response.status}, expected 200`);
    const complaint = row.expects.complaint(body);
    if (complaint) found.push(complaint);
  }

  for (const touch of fakeTmux.touches()) {
    found.push(`reached tmux: ${touch.subcommand} (target ${touch.target ?? 'none'}) via ${touch.via}`);
  }
  return found;
}

async function loadHandler(key: string): Promise<Handler> {
  const [route, method] = key.split('#');
  const module = (await import(/* @vite-ignore */ join(WORKTREE_ROUTES_DIR, route))) as Record<string, Handler>;
  const handler = module[method];
  if (typeof handler !== 'function') throw new Error(`${route} exports no ${method}`);
  return handler;
}

function rowFor(key: string): Row {
  const row = TABLE.find((entry) => entry.handler === key);
  if (!row) throw new Error(`no table row for ${key}`);
  return row;
}

// =============================================================================
// Stage 1
// =============================================================================

const FIXTURE = join(REPO_ROOT, 'tests/unit/guards/fixtures/unguarded-direct-input-route.ts');

/** The check Issue #2865 used to decide which routes needed the ownership check. */
const ISSUE_2865_GREP =
  /getSessionName\(|resolveSessionName\(|isRunning\(|hasSession\(|killSession\(|sendKeys\(|capturePane\(/;

const graph = createModuleGraph();
const enumerated = enumerateTmuxReachingHandlers(graph);

describe('[#3290] stage 1 — the worktree handlers that can reach tmux', () => {
  describe('the walk is not vacuous', () => {
    it('reads every form that loads a module, and skips the ones the compiler erases', () => {
      const facts = analyseSource(
        'sample.ts',
        [
          "import a from './static-default';",
          "import { b } from './static-named';",
          "import * as c from './static-namespace';",
          "import './side-effect';",
          "import { type T, d } from './mixed-type-and-value';",
          "export { e } from './re-export';",
          "export * from './re-export-star';",
          "const f = await import('./dynamic');",
          "const g = require('./required');",
          "import type { U } from './type-only-clause';",
          "import { type V, type W } from './type-only-specifiers';",
          "export type { X } from './type-only-re-export';",
          "// import { h } from './commented-out';",
        ].join('\n')
      );

      expect(facts.specifiers).toEqual([
        './static-default',
        './static-named',
        './static-namespace',
        './side-effect',
        './mixed-type-and-value',
        './re-export',
        './re-export-star',
        './dynamic',
        './required',
      ]);
    });

    it('calls a module a tmux sink only when it both loads child_process and names the binary', () => {
      const runs = "import { execFile } from 'child_process';\nexecFile('tmux', ['has-session']);";
      const shellString = "import { exec } from 'node:child_process';\nexec(`tmux set-environment ${name}`);";
      const otherBinary = "import { execFile } from 'child_process';\nexecFile('git', ['status']);";
      const mentionOnly = "// runs tmux via child_process\nexport const label = 'tmux';";
      const specifierOnly = "import { execFile } from 'child_process';\nimport { x } from './tmux';\nexecFile('git', [x]);";

      expect(analyseSource('a.ts', runs).runsTmux).toBe(true);
      expect(analyseSource('b.ts', shellString).runsTmux).toBe(true);
      expect(analyseSource('c.ts', otherBinary).runsTmux).toBe(false);
      expect(analyseSource('d.ts', mentionOnly).runsTmux).toBe(false);
      expect(analyseSource('e.ts', specifierOnly).runsTmux).toBe(false);
    });

    it('reads the exported HTTP methods of a route module, whichever way they are exported', () => {
      const facts = analyseSource(
        'route.ts',
        [
          'export async function GET() {}',
          'export const POST = async () => {};',
          'async function remove() {}',
          'export { remove as DELETE };',
          "export const dynamic = 'force-dynamic';",
          'function PATCH() {}',
        ].join('\n')
      );

      expect(facts.handlers).toEqual(['DELETE', 'GET', 'POST']);
    });

    it('resolves every repo import it meets — no edge is dropped silently', () => {
      // Forces the walk over everything any worktree route can reach.
      for (const file of routeFiles()) graph.closure(file);

      expect(graph.unresolved()).toEqual([]);
    });

    it('finds the module that owns send-keys / capture-pane among the sinks', () => {
      const sinks = new Set(enumerated.flatMap((handler) => handler.sinks));

      expect(sinks).toContain('src/lib/tmux/tmux.ts');
    });

    it('follows a deferred import() to the module it loads', () => {
      // `manager.ts` loads the response poller with `await import()` to cut a
      // load-time cycle (#1984). The call still happens, so the edge counts.
      const manager = join(REPO_ROOT, 'src/lib/cli-tools/manager.ts');
      expect(readFileSync(manager, 'utf-8')).toMatch(/await import\('\.\.\/polling\/response-poller'\)/);

      expect(graph.imports(manager).map(repoRelative)).toContain('src/lib/polling/response-poller.ts');
    });

    it('does not enumerate everything: a route that never loads the tmux graph is left out', () => {
      const all = routeFiles();
      const reaching = new Set(enumerated.map((handler) => handler.route));

      expect(all.length).toBeGreaterThan(60);
      expect(graph.tmuxSinks(join(WORKTREE_ROUTES_DIR, 'memos/route.ts'))).toEqual([]);
      expect(reaching.size).toBeLessThan(all.length / 2);
    });
  });

  describe('the route that was missed', () => {
    it('reaches tmux through the direct-input gateway, with no tmux import of its own', () => {
      const route = join(WORKTREE_ROUTES_DIR, 'direct-input/route.ts');
      const direct = graph.imports(route).map(repoRelative);

      expect(direct).toContain('src/lib/cli-tools/direct-input.ts');
      expect(direct.filter((file) => file.startsWith('src/lib/tmux/'))).toEqual([]);
      expect(graph.tmuxSinks(route)).toContain('src/lib/tmux/tmux.ts');
      expect(enumerated.map((handler) => handler.key)).toContain('direct-input/route.ts#POST');
    });

    it('is invisible to the #2865 grep as it shipped, and visible to the walk (positive control)', () => {
      const shipped = readFileSync(FIXTURE, 'utf-8');

      expect(ISSUE_2865_GREP.test(shipped)).toBe(false);
      expect(graph.tmuxSinks(FIXTURE)).toContain('src/lib/tmux/tmux.ts');
    });
  });

  describe('every enumerated handler is judged or exempted with a reason', () => {
    it('objects to a handler nobody listed (positive control)', () => {
      const gaps = coverageGaps(
        ['a/route.ts#POST', 'b/route.ts#POST', 'c/route.ts#GET'],
        ['a/route.ts#POST', 'gone/route.ts#POST'],
        ['c/route.ts#GET', 'a/route.ts#POST', 'removed/route.ts#GET']
      );

      expect(gaps).toEqual({
        unexamined: ['b/route.ts#POST'],
        staleRows: ['gone/route.ts#POST'],
        staleExemptions: ['removed/route.ts#GET'],
        contradictory: ['a/route.ts#POST'],
      });
    });

    it('leaves no enumerated handler unexamined, and lists none that is not enumerated', () => {
      const gaps = coverageGaps(
        enumerated.map((handler) => handler.key),
        TABLE.map((row) => row.handler),
        EXEMPT.map((exemption) => exemption.handler)
      );

      expect(
        gaps,
        'A worktree route handler can reach tmux and is neither in TABLE (judged against a foreign ' +
          'session) nor in EXEMPT (with the reason it never addresses a session). Add it to one of them.'
      ).toEqual(NO_GAPS);
    });

    it('gives every exemption a reason', () => {
      for (const exemption of EXEMPT) {
        expect(exemption.reason.trim().length, exemption.handler).toBeGreaterThan(20);
      }
    });

    it('holds each narrow exemption to the exact tmux modules it was written about', () => {
      const pinned = EXEMPT.filter((exemption) => exemption.reachesOnly !== undefined);
      expect(pinned.length).toBeGreaterThan(0);

      for (const exemption of pinned) {
        const handler = enumerated.find((entry) => entry.key === exemption.handler);
        expect(handler?.sinks, exemption.handler).toEqual([...(exemption.reachesOnly ?? [])]);
      }
    });
  });
});

// =============================================================================
// Stage 2
// =============================================================================

describe('[#3290] stage 2 — each of them leaves a foreign session alone', () => {
  let db: Database.Database;
  const handlers = new Map<string, Handler>();

  // Loading the routes pulls in the whole CLI-tool graph once; under a loaded
  // machine that alone can pass the default 5 s, so it is not left to a test.
  beforeAll(async () => {
    for (const row of TABLE) handlers.set(row.handler, await loadHandler(row.handler));
  }, 180_000);

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'develop',
      path: WORKTREE_PATH,
      repositoryPath: '/nonexistent-3290/this-server',
      repositoryName: 'this-server',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    resetForeignSessionWarningsForTesting();
    fakeTmux.reset();
    fakeTmux.addSession(CLAUDE_SESSION, OTHER_SERVER_PATH);
  });

  afterEach(async () => {
    await settle();
    stopAllAutoYesPolling();
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it.each(TABLE.map((row) => [row.handler, row.expects.kind] as const))(
    '%s %s a session another server owns, and sends tmux nothing',
    async (key) => {
      const handler = handlers.get(key) as Handler;

      expect(await objections(rowFor(key), handler, db)).toEqual([]);
    },
    30_000
  );

  it('does not leave Auto-Yes armed for the session it refused', async () => {
    const handler = handlers.get('auto-yes/route.ts#POST') as Handler;

    await handler(rowFor('auto-yes/route.ts#POST').request(db), params());

    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled ?? false).toBe(false);
  });

  describe('the judge is not vacuous', () => {
    it('objects to the direct-input route as it shipped before #3290 (positive control)', async () => {
      const { POST } = await import('@tests/unit/guards/fixtures/unguarded-direct-input-route');

      const found = await objections(rowFor('direct-input/route.ts#POST'), POST, db);

      expect(found).toContain('answered 200, expected 409');
      expect(found).toContain(`never asked tmux for the #{session_path} of ${CLAUDE_SESSION}`);
      expect(found).toContain(`reached tmux: send-keys (target ${CLAUDE_SESSION}) via execFile`);
    }, 30_000);

    it('sees the keys arrive when the session is this worktree\'s own (negative control)', async () => {
      fakeTmux.reset();
      fakeTmux.addSession(CLAUDE_SESSION, WORKTREE_PATH);
      const handler = handlers.get('direct-input/route.ts#POST') as Handler;

      const response = await handler(rowFor('direct-input/route.ts#POST').request(db), params());
      await settle();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target])).toEqual([
        ['send-keys', CLAUDE_SESSION],
      ]);
    }, 30_000);

    it('reads the pane when the session is this worktree\'s own (negative control)', async () => {
      // The two `reports` rows pass by touching nothing and saying "not
      // running". Shown here: with the same session owned, both handlers go on
      // to read its pane — so the silence above is the ownership check, not a
      // fake server that hides its sessions. (What they then report about a
      // blank pane is the liveness probe's business, not this guard's.)
      for (const key of ['route.ts#GET', 'route.ts#PATCH']) {
        fakeTmux.reset();
        fakeTmux.addSession(CLAUDE_SESSION, WORKTREE_PATH);

        const response = await (handlers.get(key) as Handler)(rowFor(key).request(db), params());
        await settle();

        expect(response.status, key).toBe(200);
        expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target]), key).toContainEqual([
          'capture-pane',
          CLAUDE_SESSION,
        ]);
      }
    }, 30_000);
  });
});
