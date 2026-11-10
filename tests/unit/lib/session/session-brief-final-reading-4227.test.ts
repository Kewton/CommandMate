/**
 * H21 (pr3d): the final reading's invariant for the screen's strict choice (Issue #4227, design
 * `docs/design/mem-ui-4227.md` §3.2 table (b) and §11.22 #20).
 *
 * Whatever the plan left a `full` / `decline` send with ({@link STRICT_PLAN_OUTCOMES}: planned,
 * used up, empty, refused, a command), the claim reads the instance's current row again under the
 * input lock, right before the body. The table: every plan outcome × {the same boundary, A → B
 * while the send waited for the lock (a `/clear` typed by the send holding it)} × {full, decline}.
 *  - the same boundary: as the design's table says (the brief, the body alone, `consumed`,
 *    `empty`, the plan's abort, the command typed as it is);
 *  - A → B: 409 `brief_choice`, the body not typed, B still `pending`.
 * The rows are built from {@link STRICT_PLAN_OUTCOMES}: an outcome added there with no scenario
 * here fails the type check (`satisfies Record<StrictPlanOutcome, …>`).
 *
 * Positive control (recorded in the commit): before pr3d, the row "empty × A → B × full" (codex
 * P2, review-4227-pr3b) typed the body into B's conversation (the plan had used A up as `empty`).
 * Negative controls: the first send and the resend on the same boundary (rows "planned × same"
 * and "used up × same"), and sends with no boundary chosen (`auto`, no `briefBoundary`).
 * PM Claude P3-2: command-code (outside `SUPPORTED_COMPOSER_TOOLS`, under the outer lock only by
 * `needsOuterLock`) runs the "used up × A → B" row too.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => globalThis.__briefTools?.[id] }) },
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  isSessionRunning: vi.fn(async () => true),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));

import {
  FAKE_BRIEF,
  WT,
  bindWorld,
  closeWorld,
  fakeProvider,
  launch,
  makeWorld,
  send,
  setMem,
  typed,
  type BoundaryTool,
  type Sent,
  type SendOptions,
  type World,
} from './session-brief-4274-harness';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { getBoundaryById, getCurrentBoundary } from '@/lib/db/session-brief-db';
import { STRICT_PLAN_OUTCOMES, type StrictPlanOutcome } from '@/lib/session/session-brief';
import type { BriefRequest } from '@/lib/session/brief-provider';

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  addAgentInstance(world.db, WT, { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
});
afterEach(() => closeWorld(world));

function shown(tool: BoundaryTool = 'claude'): string {
  const row = getCurrentBoundary(world.db, WT, tool);
  if (!row) throw new Error('no boundary');
  return row.id;
}
const stateOf = (id: string) => getBoundaryById(world.db, id)?.state;
const skipReasonOf = (id: string) => getBoundaryById(world.db, id)?.skipReason;
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Choice = 'full' | 'decline';
const CHOICE_OPTIONS: Record<Choice, SendOptions> = { full: { briefDetail: 'full' }, decline: { brief: 'decline' } };
const CHOICES: Choice[] = ['full', 'decline'];
type Boundary = 'same' | 'a_to_b';
const BOUNDARIES: Boundary[] = ['same', 'a_to_b'];

function expectAborted(result: Sent['result'], reason?: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe('brief_choice');
  if (result.stage !== 'brief_choice') return;
  expect(result.code).toBe('boundary_changed');
  if (reason !== undefined) expect(result.reason).toBe(reason);
}

/** A send holding the input lock while its tool types `body` (a `/clear` opens B when it lands). */
async function holdTheLock(tool: BoundaryTool, body: string, options: SendOptions = {}): Promise<{ release: () => void; holder: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  world.tools[tool].sendMessage.mockImplementationOnce(async () => {
    await gate;
  });
  const before = world.tools[tool].sendMessage.mock.calls.length;
  const holder = send(tool, body, options);
  for (let i = 0; i < 200 && world.tools[tool].sendMessage.mock.calls.length === before; i++) await ticks(1);
  expect(world.tools[tool].sendMessage.mock.calls.length).toBe(before + 1);
  return { release, holder };
}

interface Scenario {
  /** The choosing send's body. */
  body: string;
  /** After the launch, before the choosing send: the world in which the plan reads this outcome. */
  arrange: () => Promise<void> | void;
  /** The same boundary under the lock: the design's table (b), as before pr3d. */
  same: (sent: Sent, a: string) => void;
}
const NOT_REACHABLE = 'not reachable' as const;

const provided = (body: string) => (): void =>
  void fakeProvider({ build: vi.fn((request: BriefRequest) => ({ body, includedNoticeIds: [], mode: request.membership.mode })) });

/**
 * One scenario per plan outcome and choice. `decline` builds nothing, so its brief is never empty.
 * An outcome added to {@link STRICT_PLAN_OUTCOMES} without a scenario fails the type check here.
 */
const SCENARIOS = {
  planned: {
    full: {
      body: 'x',
      arrange: () => void fakeProvider(),
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe(`${FAKE_BRIEF}\n\nx`);
        expect(report).toEqual({ state: 'attached', boundaryId: a });
        expect(stateOf(a)).toBe('sent');
      },
    },
    decline: {
      body: 'x',
      arrange: () => void fakeProvider(),
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('x');
        expect(report).toEqual({ state: 'skipped', reason: 'declined', boundaryId: a });
        expect(skipReasonOf(a)).toBe('declined');
      },
    },
  },
  used_up: {
    full: {
      body: 'x',
      arrange: async () => {
        fakeProvider();
        await send('claude', 'first');
      },
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('x');
        expect(report).toEqual({ state: 'consumed', boundaryId: a });
        expect(stateOf(a)).toBe('sent');
      },
    },
    decline: {
      body: 'x',
      arrange: async () => {
        fakeProvider();
        await send('claude', 'first');
      },
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('x');
        expect(report).toEqual({ state: 'consumed', boundaryId: a });
        expect(stateOf(a)).toBe('sent');
      },
    },
  },
  empty: {
    full: {
      body: 'x',
      arrange: provided(''),
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('x');
        expect(report).toEqual({ state: 'skipped', reason: 'empty', boundaryId: a });
        expect(stateOf(a)).toBe('skipped');
        expect(skipReasonOf(a)).toBe('empty');
      },
    },
    decline: NOT_REACHABLE,
  },
  refused: {
    full: {
      body: 'x',
      arrange: () => {
        fakeProvider();
        setMem(world, 'on', false);
      },
      same: ({ result }, a) => {
        expectAborted(result, 'disabled');
        expect(typed(world, 'claude')).not.toContain('x');
        expect(stateOf(a)).toBe('pending');
      },
    },
    decline: {
      body: 'x',
      arrange: () => {
        fakeProvider();
        setMem(world, 'on', false);
      },
      same: ({ result }, a) => {
        expectAborted(result, 'disabled');
        expect(typed(world, 'claude')).not.toContain('x');
        expect(stateOf(a)).toBe('pending');
      },
    },
  },
  slash_command: {
    full: {
      body: '/model',
      arrange: () => void fakeProvider(),
      same: ({ result }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('/model');
        expect(stateOf(a)).toBe('pending');
      },
    },
    decline: {
      body: '/model',
      arrange: () => void fakeProvider(),
      same: ({ result, report }, a) => {
        expect(result.ok).toBe(true);
        expect(typed(world, 'claude').at(-1)).toBe('/model');
        expect(report).toEqual({ state: 'skipped', reason: 'slash_command' });
        expect(stateOf(a)).toBe('pending');
      },
    },
  },
} satisfies Record<StrictPlanOutcome, Record<Choice, Scenario | typeof NOT_REACHABLE>>;

interface Row {
  outcome: StrictPlanOutcome;
  choice: Choice;
  boundary: Boundary;
  scenario: Scenario;
}
const ROWS: Row[] = STRICT_PLAN_OUTCOMES.flatMap((outcome) =>
  CHOICES.flatMap((choice) => {
    const scenario: Scenario | typeof NOT_REACHABLE = SCENARIOS[outcome][choice];
    if (scenario === NOT_REACHABLE) return [];
    return BOUNDARIES.map((boundary) => ({ outcome, choice, boundary, scenario }));
  })
);

describe('H21 (pr3d) the final reading: every plan outcome × {same boundary, A → B while waiting for the lock} × {full, decline}', () => {
  it('the table covers every reachable cell (9 scenarios × 2 boundaries)', () => {
    expect(ROWS).toHaveLength(18);
  });

  it.each(ROWS.map((row) => [`${row.outcome} × ${row.boundary} × ${row.choice}`, row] as const))('%s', async (_name, row) => {
    launch('claude');
    const a = shown();
    await row.scenario.arrange();
    // The send holding the lock: a `/clear` opens B when it lands (A → B); otherwise a body that
    // takes no brief and leaves A as it is.
    const { release, holder } = row.boundary === 'a_to_b' ? await holdTheLock('claude', '/clear') : await holdTheLock('claude', 'hold', { brief: 'skip' });
    const choosing = send('claude', row.scenario.body, { ...CHOICE_OPTIONS[row.choice], briefBoundary: a });
    // The choosing send plans (A is still the current row) and queues behind the lock.
    await ticks(200);
    expect(shown()).toBe(a);
    release();
    await holder;
    const sent = await choosing;
    if (row.boundary === 'same') {
      expect(shown()).toBe(a);
      row.scenario.same(sent, a);
      return;
    }
    const b = shown();
    expect(b).not.toBe(a);
    // The plan's own abort keeps its reason (the first reason wins); every other outcome is `superseded`.
    expectAborted(sent.result, row.outcome === 'refused' ? undefined : 'superseded');
    expect(typed(world, 'claude')).not.toContain(row.scenario.body);
    expect(stateOf(b)).toBe('pending');
    // A is not used up by the choosing send (the plan decides nothing).
    expect(skipReasonOf(a)).not.toBe('empty');
    expect(skipReasonOf(a)).not.toBe('declined');
  });
});

describe('H21 (pr3d) negative: a send with no boundary chosen (auto, no briefBoundary) is not read again', () => {
  it.each(BOUNDARIES)('%s: the body is typed as before', async (boundary) => {
    fakeProvider();
    launch('claude');
    const a = shown();
    const { release, holder } = boundary === 'a_to_b' ? await holdTheLock('claude', '/clear') : await holdTheLock('claude', 'hold', { brief: 'skip' });
    const plain = send('claude', 'x');
    await ticks(200);
    release();
    await holder;
    const { result } = await plain;
    expect(result.ok).toBe(true);
    // A → B: D1's superseded (the brief planned for A is not put on B); the same: the brief on A.
    expect(typed(world, 'claude').at(-1)).toBe(boundary === 'a_to_b' ? 'x' : `${FAKE_BRIEF}\n\nx`);
    if (boundary === 'same') expect(stateOf(a)).toBe('sent');
  });
});

/**
 * PM Claude P3-2: command-code is not in `SUPPORTED_COMPOSER_TOOLS`; its send runs under the outer
 * input lock only when `needsOuterLock()` says so. A strict choice whose plan found the row used up
 * must still be read again under that lock: outside it, the final reading would run before the
 * holder's `/clear` lands and type the body into B's conversation.
 */
describe('H21 (b2) command-code: used up at the plan, A → B while waiting for the outer lock', () => {
  it.each(CHOICES)('%s: 409 superseded, the body not typed, B pending', async (choice) => {
    fakeProvider();
    launch('command-code');
    const a = shown('command-code');
    await send('command-code', 'first');
    expect(stateOf(a)).toBe('sent');
    const { release, holder } = await holdTheLock('command-code', '/clear');
    const choosing = send('command-code', 'x', { ...CHOICE_OPTIONS[choice], briefBoundary: a });
    await ticks(200);
    expect(shown('command-code')).toBe(a);
    release();
    await holder;
    const b = shown('command-code');
    expect(b).not.toBe(a);
    const { result } = await choosing;
    expectAborted(result, 'superseded');
    expect(typed(world, 'command-code')).not.toContain('x');
    expect(stateOf(b)).toBe('pending');
  });

  it.each(CHOICES)('negative %s: A still the current row → the body alone, reported consumed', async (choice) => {
    fakeProvider();
    launch('command-code');
    const a = shown('command-code');
    await send('command-code', 'first');
    const { result, report } = await send('command-code', 'x', { ...CHOICE_OPTIONS[choice], briefBoundary: a });
    expect(result.ok).toBe(true);
    expect(typed(world, 'command-code').at(-1)).toBe('x');
    expect(report).toEqual({ state: 'consumed', boundaryId: a });
  });
});
