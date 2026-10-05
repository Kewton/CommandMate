/**
 * Hook event sequences, replayed on a virtual clock from the receiver to the
 * `wait` verdict (Issue #3309).
 *
 * #3289 (the `stop` of a short turn the agent resumed by itself was dropped as
 * a copy) and #3301 (the start of the turn right after a short one was dropped)
 * were decided by the ORDER and SPACING in which hook deliveries arrive, and
 * both were found on a real machine. The units are covered function by
 * function; what only this file covers is the whole path a sequence takes:
 *
 *   `POST /api/hooks/agent-event` → `agent-event-state` → `buildCurrentOutput`
 *   (the payload `GET /api/worktrees/:id/current-output` serves) → the CLI's
 *   `pollWorktree`, fed that payload, exactly as `commandmate wait` polls it.
 *
 * ## How to read the table
 *
 * Every case is one row of {@link SEQUENCES}, and every row is replayed by the
 * same body. A row is the deliveries — event, offset from the first one,
 * session, subtype, the shape it was posted in and whether it carries the
 * queued-notice mark — and what each of them must do (applied or dropped as a
 * duplicate, and which turn the payload shows afterwards), the payload the last
 * one leaves behind, and whether `wait` completes on it. Adding a sequence is
 * adding a row.
 *
 * Turns are written as letters: `'A'` is whatever `structuredEvents.turnId` the
 * payload showed first, `'B'` the next distinct one, and `null` no turn. The
 * letters say "same turn" / "another turn" without pinning an id format. A
 * `stop` that finds no open turn of its session records a closed turn of its
 * own whose opening was never seen (`openedAt: null`, `applyStopToTurn`), so it
 * takes a letter too.
 *
 * #3289, #3301 and #3330 are merged, so every row is pinned to the behaviour
 * AFTER those fixes (each row names its Issue). Rows marked `knownLimitation`
 * pin a sequence this server cannot tell from a legitimate one; the reason is
 * on the row, and a change that alters one of them should be a decision rather
 * than an accident.
 *
 * ## The clock
 *
 * The receiver stamps every delivery with `Date.now()`, so "inside the
 * three-second window" has to be a fact of the row rather than of how fast the
 * machine ran it. Only `Date` is faked while events are delivered
 * (`freezeClock`); the `wait` step also fakes `setTimeout`, so its 5-second
 * poll interval is advanced rather than slept through.
 *
 * ## The `wait` step
 *
 * `pollWorktree` is the function `commandmate wait` (and `ask`) runs. It is
 * given a client that answers every `current-output` poll with the payload the
 * last delivery left — serialized and parsed, as on the wire — and an empty
 * message ledger, and a 1-second `--timeout`. It either completes on its first
 * poll (exit 0) or is still holding when the second poll's deadline check runs
 * (exit 124). No CLI process is started.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { freezeClock, FROZEN_NOW_MS, unfreezeClock } from '@tests/helpers/frozen-clock';
import { WaitExitCode } from '../../src/cli/types';
import type { ApiClient } from '../../src/cli/utils/api-client';

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

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: async () => true }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(async () => true),
}));

// The real module, with the receiver's duplicate check observed: its verdict is
// the "applied or dropped" column of the table. Nothing about it is changed.
vi.mock('@/lib/session/agent-event-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/agent-event-state')>();
  return { ...actual, isDuplicateAgentEvent: vi.fn(actual.isDuplicateAgentEvent) };
});

import { POST as agentEvent } from '@/app/api/hooks/agent-event/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, isDuplicateAgentEvent } from '@/lib/session/agent-event-state';
import { pollWorktree } from '../../src/cli/commands/wait';

const WORKTREE_ID = 'wt-3309';
const T = FROZEN_NOW_MS;
const SESSION = 'sess-3309';
const OTHER_SESSION = 'sess-3309-other';

type Tool = 'claude' | 'antigravity' | 'command-code';

/** The prompt of a queued background-task notice (Issue #3330). */
const NOTICE_PROMPT = '<task-notification>\n<status>completed</status>\n</task-notification>';

/**
 * A frame per tool that its scraper reads as busy on positive evidence, so a
 * structured `stop` lands on a frame that was understood (Issue #1927) and no
 * turn is ever closed by the scraper's own evidence of a composer. A pane is
 * not what this file is about; these only keep it out of the way.
 *
 * claude's is the interrupt affordance still on the chrome — the frame
 * `current-output-structured-status-1723.test.ts` uses. antigravity's is its
 * spinner and `esc to cancel` (`ANTIGRAVITY_THINKING_PATTERN`). Command Code
 * reads claude's the same way.
 */
const CLAUDE_BUSY_FRAME = [
  'writing files',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏸ manual mode on · esc to interrupt · ⇥ for agents',
].join('\n');
const BUSY_FRAMES: Record<Tool, string> = {
  claude: CLAUDE_BUSY_FRAME,
  'command-code': CLAUDE_BUSY_FRAME,
  antigravity: ['writing files', '', '⠋ Generating… (esc to cancel)'].join('\n'),
};

type EventWord = 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use' | 'stop';
type TurnLabel = 'A' | 'B' | 'C' | null;

interface Delivery {
  /** Event, in CommandMate's vocabulary. */
  event: EventWord;
  /** Milliseconds after the row's first delivery. */
  at: number;
  /** Defaults to {@link SESSION}. */
  session?: string;
  /** The subtype (a tool event's tool name). */
  detail?: string;
  /**
   * How it was posted. `relay` (default) is `scripts/hooks/cmate-agent-event.sh`'s
   * rebuilt body (`{ tool, event, sessionId }`); `hook` is the injected
   * `type: "http"` hook, which posts the agent's own payload — claude only.
   */
  via?: 'relay' | 'hook';
  /**
   * The queued-notice mark on a `user_prompt_submit` (Issue #3330): a
   * `<task-notification>` prompt on `hook`, `queuedNotice: true` on `relay`.
   */
  notice?: boolean;
  /** What the receiver must do with it. */
  expect: 'applied' | 'dropped';
  /** The turn `current-output` shows right after it. */
  turn: TurnLabel;
}

interface Sequence {
  name: string;
  tool: Tool;
  deliveries: readonly Delivery[];
  final: {
    sessionStatus: 'running' | 'ready';
    sessionStatusReason: string;
    /** `structuredEvents.closedBy` — null while the turn is open. */
    closedBy: 'stop' | null;
  };
  /** Whether `commandmate wait` completes on the last payload. */
  wait: 'completes' | 'holds';
  /** Set on a row that pins a sequence this server cannot tell apart; says why. */
  knownLimitation?: string;
}

type ProductionFixture = {
  observedAt: string;
  tool: Tool;
  deliveries: Array<{ event: EventWord; afterMs: number }>;
};

const PRODUCTION = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/hooks/event-sequences-3309/production.json'), 'utf8')
) as Record<'issue-3289' | 'issue-3301', ProductionFixture>;

/** A production sequence's deliveries, with the table's expectations laid over them in order. */
function fromProduction(
  key: keyof typeof PRODUCTION,
  expectations: ReadonlyArray<Pick<Delivery, 'expect' | 'turn'>>
): Delivery[] {
  const { deliveries } = PRODUCTION[key];
  if (deliveries.length !== expectations.length) {
    throw new Error(`${key}: ${deliveries.length} deliveries, ${expectations.length} expectations`);
  }
  return deliveries.map(({ event, afterMs }, i) => ({ event, at: afterMs, ...expectations[i] }));
}

const READY = { sessionStatus: 'ready', sessionStatusReason: 'hook_stop', closedBy: 'stop' } as const;
const RUNNING = {
  sessionStatus: 'running',
  sessionStatusReason: 'hook_prompt_submit',
  closedBy: null,
} as const;

const SEQUENCES: readonly Sequence[] = [
  {
    // #3289 + #3301: two short turns of one session inside three seconds. Each
    // boundary releases the other side's claim, so all four are first deliveries.
    name: 'start → stop → next start → stop, inside 3 s, one session',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 1500, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2500, expect: 'applied', turn: 'B' },
    ],
    final: READY,
    wait: 'completes',
  },
  {
    // #1722: a host with the manual relay beside the injected hook delivers
    // every event twice, milliseconds apart. One of each is applied.
    name: 'a stop delivered twice, ms apart',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 2000, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 2004, expect: 'dropped', turn: 'A' },
    ],
    final: READY,
    wait: 'completes',
  },
  {
    // #1722 / #3301: the copy of a start does not open a second turn.
    name: 'a start delivered twice, ms apart',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 6, expect: 'dropped', turn: 'A' },
    ],
    final: RUNNING,
    wait: 'holds',
  },
  {
    // #1722 across a boundary: two turns, every event twice.
    name: 'every event of two short turns delivered twice',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 20, expect: 'dropped', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1020, expect: 'dropped', turn: 'A' },
      { event: 'user_prompt_submit', at: 1500, expect: 'applied', turn: 'B' },
      { event: 'user_prompt_submit', at: 1520, expect: 'dropped', turn: 'B' },
      { event: 'stop', at: 2500, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2520, expect: 'dropped', turn: 'B' },
    ],
    final: READY,
    wait: 'completes',
  },
  {
    name: 'a late copy of a stop, arriving after the next start',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 1500, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2000, expect: 'applied', turn: 'B' },
    ],
    final: READY,
    wait: 'completes',
    knownLimitation:
      'The copy names the same session and carries nothing a real stop of turn B would not, so it ' +
      'is read as stop(B): turn B is closed early and `wait` completes on it. The start between them ' +
      'released the stop claim (#3289), which is what lets a real short turn B be closed at all.',
  },
  {
    name: 'a late copy of a start, arriving after its stop',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 1500, expect: 'applied', turn: 'B' },
    ],
    final: RUNNING,
    wait: 'holds',
    knownLimitation:
      'Indistinguishable from the start of a real next turn (#3301 is exactly that sequence), so it ' +
      'opens a turn no stop is coming for and `wait` holds on it. Takes an async command hook beside ' +
      'the injected one on a turn shorter than its delay (isDuplicateAgentEvent, "What this cannot tell apart").',
  },
  {
    name: 'order reversed: the stop arrives before its start',
    tool: 'claude',
    deliveries: [
      { event: 'stop', at: 0, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 50, expect: 'applied', turn: 'B' },
    ],
    final: RUNNING,
    wait: 'holds',
    knownLimitation:
      'The receiver orders deliveries by arrival — it stamps each one with its own clock — so a stop ' +
      'that overtakes its start is read as the end of an earlier turn whose opening was never seen, ' +
      'and the start then opens a turn of its own that nothing closes.',
  },
  {
    // #3289 + #3301 for a tool that never sends `user_prompt_submit`: an
    // antigravity turn is opened by `post_tool_use`, and a short turn can call
    // the tool the previous one did.
    name: 'antigravity: turns opened by a tool event, inside 3 s',
    tool: 'antigravity',
    deliveries: [
      { event: 'post_tool_use', detail: 'run_command', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'post_tool_use', detail: 'run_command', at: 1500, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2500, expect: 'applied', turn: 'B' },
    ],
    final: { sessionStatus: 'ready', sessionStatusReason: 'hook_stop', closedBy: 'stop' },
    wait: 'completes',
  },
  {
    // The same for Command Code, whose turns are opened by `pre_tool_use`; the
    // second tool event of a turn continues it.
    name: 'command-code: turns opened by a tool event, inside 3 s',
    tool: 'command-code',
    deliveries: [
      { event: 'pre_tool_use', detail: 'Bash', at: 0, expect: 'applied', turn: 'A' },
      { event: 'pre_tool_use', detail: 'Read', at: 300, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'pre_tool_use', detail: 'Bash', at: 1500, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2500, expect: 'applied', turn: 'B' },
    ],
    final: { sessionStatus: 'ready', sessionStatusReason: 'hook_stop', closedBy: 'stop' },
    wait: 'completes',
  },
  {
    // #3289, from the production log (fixture). Before the fix the second stop
    // was dropped, the turn stayed open and `wait` never returned.
    name: `#3289 in production (${PRODUCTION['issue-3289'].observedAt})`,
    tool: PRODUCTION['issue-3289'].tool,
    deliveries: fromProduction('issue-3289', [
      { expect: 'applied', turn: 'A' },
      { expect: 'applied', turn: 'B' },
      { expect: 'applied', turn: 'B' },
    ]),
    final: READY,
    wait: 'completes',
  },
  {
    // #3301, from the production log (fixture). Pinned AFTER the fix: the
    // second start opens the turn the agent is in, so `wait` holds. Before it,
    // that start was dropped and `ready` was published for a working agent.
    name: `#3301 in production (${PRODUCTION['issue-3301'].observedAt})`,
    tool: PRODUCTION['issue-3301'].tool,
    deliveries: fromProduction('issue-3301', [
      { expect: 'applied', turn: 'A' },
      { expect: 'applied', turn: 'A' },
      { expect: 'applied', turn: 'B' },
    ]),
    final: RUNNING,
    wait: 'holds',
  },
  {
    // #3330: a queued notice Claude attaches to its running turn fires
    // `UserPromptSubmit`. It joins the turn rather than re-opening it, and the
    // turn's stop closes it.
    name: '#3330: a queued notice mid-turn joins the running turn',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', via: 'hook', at: 0, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', via: 'hook', notice: true, at: 63_500, expect: 'applied', turn: 'A' },
      { event: 'stop', via: 'hook', at: 90_000, expect: 'applied', turn: 'A' },
    ],
    final: READY,
    wait: 'completes',
  },
  {
    // #3330: the notice delivered twice — first by an older relay that sends
    // no mark (applied: it re-opens the turn), then by the injected hook with
    // the mark (dropped as its duplicate, and its mark puts the turn back).
    name: '#3330: unmarked relay copy first, then the marked injected hook',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', via: 'hook', at: 0, expect: 'applied', turn: 'A' },
      { event: 'user_prompt_submit', at: 8, expect: 'dropped', turn: 'A' },
      { event: 'user_prompt_submit', at: 63_500, expect: 'applied', turn: 'B' },
      { event: 'user_prompt_submit', via: 'hook', notice: true, at: 63_506, expect: 'dropped', turn: 'A' },
      { event: 'stop', via: 'hook', at: 90_000, expect: 'applied', turn: 'A' },
    ],
    final: READY,
    wait: 'completes',
  },
  {
    // Control for the release rules: a stop of ANOTHER session releases
    // nothing of this one, and a second stop of this session with no start in
    // between is still a copy. (The other session's stop finds no open turn of
    // its own and records one, B.)
    name: 'control: a second stop with no start between them is still a copy',
    tool: 'claude',
    deliveries: [
      { event: 'user_prompt_submit', at: 0, expect: 'applied', turn: 'A' },
      { event: 'stop', at: 1000, expect: 'applied', turn: 'A' },
      { event: 'stop', session: OTHER_SESSION, at: 1200, expect: 'applied', turn: 'B' },
      { event: 'stop', at: 2473, expect: 'dropped', turn: 'B' },
    ],
    final: READY,
    wait: 'completes',
  },
];

const NATIVE_HOOK_NAME: Record<EventWord, string> = {
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  stop: 'Stop',
};

function bodyOf(tool: Tool, delivery: Delivery): Record<string, unknown> {
  const session = delivery.session ?? SESSION;
  if (delivery.via === 'hook') {
    if (tool !== 'claude') throw new Error('the `hook` shape is claude’s payload');
    return {
      hook_event_name: NATIVE_HOOK_NAME[delivery.event],
      session_id: session,
      ...(delivery.event === 'user_prompt_submit'
        ? { prompt: delivery.notice ? NOTICE_PROMPT : 'Implement the change' }
        : {}),
      ...(delivery.detail ? { tool_name: delivery.detail } : {}),
    };
  }
  return {
    tool,
    event: delivery.event,
    sessionId: session,
    ...(delivery.detail ? { detail: delivery.detail } : {}),
    ...(delivery.notice ? { queuedNotice: true } : {}),
  };
}

/** Post one delivery the way an injected hook URL addresses it, at `T + at`. */
async function deliver(tool: Tool, delivery: Delivery): Promise<'applied' | 'dropped'> {
  freezeClock(T + delivery.at);
  const url =
    `http://127.0.0.1:3000/api/hooks/agent-event` +
    `?tool=${tool}&worktreeId=${WORKTREE_ID}&instanceId=${tool}`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyOf(tool, delivery)),
  });
  const checked = vi.mocked(isDuplicateAgentEvent).mock.results.length;
  const response = await agentEvent(request as unknown as NextRequest);
  expect(response.status).toBe(202);

  const results = vi.mocked(isDuplicateAgentEvent).mock.results;
  expect(results.length, 'the receiver asked the duplicate check exactly once').toBe(checked + 1);
  return results[checked].value === true ? 'dropped' : 'applied';
}

/** The `current-output` payload, as the CLI receives it off the wire. */
async function currentOutput(tool: Tool): Promise<Record<string, unknown>> {
  const payload = await buildCurrentOutput(db, WORKTREE_ID, tool, tool);
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

/** Run `wait`'s poll loop against one payload; see the module comment. */
async function judgeWait(tool: Tool, payload: Record<string, unknown>): Promise<'completes' | 'holds' | string> {
  vi.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const client = {
    get: async (path: string) => (path.includes('/messages') ? [] : payload),
  } as unknown as ApiClient;

  const promise = pollWorktree(client, WORKTREE_ID, { timeout: 1, instance: tool });
  await vi.advanceTimersByTimeAsync(6_000);
  const { exitCode } = await promise;
  if (exitCode === WaitExitCode.SUCCESS) return 'completes';
  if (exitCode === WaitExitCode.TIMEOUT) return 'holds';
  return `exit ${exitCode}`;
}

let db: Database.Database;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  (setMockDb as (d: Database.Database) => void)(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-3309',
    path: '/path/to/wt-3309',
    repositoryPath: '/path/to/repo',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);

  clearAgentStopEvents();
  vi.mocked(isDuplicateAgentEvent).mockClear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  unfreezeClock();
  consoleError.mockRestore();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
  clearAgentStopEvents();
});

describe('Issue #3309: hook event sequences, from the receiver to the wait verdict', () => {
  it('has a distinct name for every row', () => {
    const names = SEQUENCES.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SEQUENCES.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAMES[row.tool]);
    const turnIds = new Map<string, TurnLabel>();
    const labelOf = (turnId: unknown): TurnLabel => {
      if (typeof turnId !== 'string') return null;
      if (!turnIds.has(turnId)) turnIds.set(turnId, (['A', 'B', 'C'] as const)[turnIds.size] ?? null);
      return turnIds.get(turnId) ?? null;
    };

    const observed: Array<Pick<Delivery, 'event' | 'at' | 'expect' | 'turn'>> = [];
    let payload: Record<string, unknown> = {};
    for (const delivery of row.deliveries) {
      const verdict = await deliver(row.tool, delivery);
      payload = await currentOutput(row.tool);
      const events = payload.structuredEvents as Record<string, unknown> | undefined;
      observed.push({ event: delivery.event, at: delivery.at, expect: verdict, turn: labelOf(events?.turnId) });
    }

    // One comparison for the whole column, so a failure shows every delivery.
    expect(observed).toEqual(
      row.deliveries.map(({ event, at, expect: verdict, turn }) => ({ event, at, expect: verdict, turn }))
    );

    const events = payload.structuredEvents as Record<string, unknown>;
    expect({
      sessionStatus: payload.sessionStatus,
      sessionStatusReason: payload.sessionStatusReason,
      closedBy: events.closedBy ?? null,
    }).toEqual(row.final);
    // `wait` completes only on a frame that was understood (Issue #1708).
    expect(payload.isUnclassifiedActive).toBe(false);

    const verdict = await judgeWait(row.tool, payload);
    expect(
      verdict,
      `wait on "${row.name}":\n${consoleError.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')}`
    ).toBe(row.wait);
  });
});
