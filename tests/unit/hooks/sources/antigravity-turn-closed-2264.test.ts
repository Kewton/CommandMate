/**
 * antigravity follows claude's closed rule (Issue #2264).
 *
 * #2264 was reported against claude, and the hole it names is structural rather
 * than claude's: a turn cut off after its tool calls renders a **non-empty**
 * body, so the writer's emptiness guard cannot see anything wrong with it, and
 * the row it writes is keyed and therefore permanent. `writeAntigravityTurn` had
 * that guard and nothing else. A fix that lands on one of three structurally
 * identical readers is a fix that will be re-reported against the other two.
 *
 * What is genuinely agy's, and what this file is really about, is that **there is
 * no record that closes a turn** — fact 4 of
 * `tests/fixtures/transcripts/antigravity/README.md`, established over a 41-file,
 * 1,024-record corpus, and the reason codex's `task_complete` has no counterpart
 * here. So the evidence has to be the shape of agy's last word: prose, and no
 * `tool_calls` on the same record.
 *
 * The transcripts are `tests/fixtures/antigravity-transcript-2264`; see that
 * directory's README for what in them is agy's and what is ours.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

const rows = new Map<string, Record<string, unknown>>();
function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}
const createMessage = vi.fn(defaultCreateMessage);
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import {
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
} from '@/lib/hooks/sources/antigravity/history';
import {
  buildAntigravityTurns,
  parseAntigravityTranscript,
  renderAntigravityTurn,
  type AntigravityTurnAccumulator,
} from '@/lib/hooks/sources/antigravity/transcript';
import { antigravityTurnRequestId } from '@/types/agent-transcript';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/antigravity-transcript-2264');
const WORKTREE_ID = 'wt-2264';
const CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
const TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
} as const;

/** The capture's own `step_index`es, oldest turn first. */
const A = 0;
const B = 2;
const C = 12;

let open: string;
let closed: string;
let home: string;

async function writeTranscript(body: string): Promise<string> {
  const path = antigravityTranscriptPath(home, CONVERSATION);
  if (!path) throw new Error('not a conversation id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureAntigravityTranscriptTurn(TARGET, { antigravityHome: home });
}

function turnsOf(text: string): readonly AntigravityTurnAccumulator[] {
  return buildAntigravityTurns(parseAntigravityTranscript(text).records, CONVERSATION).turns;
}

function turnOf(text: string, stepIndex: number): AntigravityTurnAccumulator {
  const turn = turnsOf(text).find((candidate) => candidate.stepIndex === stepIndex);
  if (!turn) throw new Error(`no turn for step ${stepIndex}`);
  return turn;
}

function writtenKeys(): string[] {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === 'assistant')
    .map((message) => String(message.requestId));
}

beforeAll(async () => {
  open = await readFile(join(FIXTURE_DIR, 'turn-open.jsonl'), 'utf8');
  closed = await readFile(join(FIXTURE_DIR, 'turn-closed.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetAntigravityTranscriptConversations();
  home = await mkdtemp(join(tmpdir(), 'cmate-2264-agy-'));
  getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('what the fixture is, before anything is asserted about it', () => {
  it('renders the open turn to a non-empty body — which is why the empty guard misses it', () => {
    const body = renderAntigravityTurn(turnOf(open, C)).body;
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('list_dir');
    expect(body).not.toContain('THIRD TURN OK');
  });
});

describe('buildAntigravityTurns decides whether agy finished', () => {
  it('is closed on a `PLANNER_RESPONSE` that is prose and no call', () => {
    expect(turnOf(closed, C).closed).toBe(true);
  });

  it('is open when the last thing agy wrote was a tool call', () => {
    expect(turnOf(open, C).closed).toBe(false);
  });

  it('is open when the last `MODEL` record is a tool’s own output', () => {
    // agy mid-loop: the call was made, the result came back, and the answer has
    // not been written. `GENERIC` is a tool result, not agy speaking.
    expect(turnOf(open, B).closed).toBe(false);
  });

  it('marks every turn but the newest as superseded', () => {
    expect(turnsOf(open).map((turn) => turn.superseded)).toEqual([true, true, false]);
  });
});

describe('the writer refuses a turn agy has not finished', () => {
  it('answers false and writes no assistant row for it', async () => {
    await writeTranscript(open);

    expect(await capture()).toBe(false);

    expect(writtenKeys()).not.toContain(antigravityTurnRequestId(CONVERSATION, C));
  });

  it('writes it once the reply arrives', async () => {
    await writeTranscript(closed);

    expect(await capture()).toBe(true);

    expect(writtenKeys()).toContain(antigravityTurnRequestId(CONVERSATION, C));
  });

  it('still writes the interrupted turn before it', async () => {
    // Turn B of the real capture ends on a `list_dir` with no reply after it —
    // the operator typed the next prompt while agy was still hunting. It is a
    // finished turn nobody else will write, and `superseded` is what keeps it.
    await writeTranscript(open);
    rows.set(`${WORKTREE_ID}::${antigravityTurnRequestId(CONVERSATION, A)}`, {
      id: 'pre-a',
      content: 'x',
    });

    await capture();

    expect(writtenKeys()).toEqual([antigravityTurnRequestId(CONVERSATION, B)]);
  });
});
