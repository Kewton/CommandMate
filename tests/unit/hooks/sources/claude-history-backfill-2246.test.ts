/**
 * Writing the turns nobody wrote (Issue #2246).
 *
 * #2121 wrote `built.turns.at(-1)` and nothing else, and the argument for it was
 * sound: every earlier turn already had a row the *scraper* wrote, and a second
 * Markdown row for it would put the same reply in History twice.
 *
 * What the argument did not cover is a turn **no writer recorded at all**. This
 * reader only runs when the poller judges a turn finished, so a misjudged
 * completion did not delay a turn — it lost it, because by the next judgement
 * "the newest turn" was the next one. Measured 2026-09-02: a reply the
 * transcript held in full and History never showed.
 *
 * So the unit of work is "every turn in the window that is not already a row",
 * and what preserves #2121's argument is the **anchor** — the newest turn this
 * reader has already written is where the backfill starts, and a window with no
 * anchor writes the newest turn alone, exactly as #2121 did. Both halves are
 * asserted here, because the second one is the whole duplicate guard.
 *
 * The transcript is `tests/fixtures/claude-transcript-2246`; see that
 * directory's README for what in it is Claude's and what is ours.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
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
const findUnkeyedUserMessages = vi.fn(() => [] as Array<Record<string, unknown>>);
const updateMessageContent = vi.fn();

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => findUnkeyedUserMessages(),
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
  resolveClaudeTranscriptPath,
} from '@/lib/hooks/sources/claude/history';
import {
  buildClaudeTurns,
  claudeProjectSlug,
  parseClaudeTranscript,
  renderClaudeTurn,
} from '@/lib/hooks/sources/claude/transcript';
import { claudePromptRequestId, claudeTurnRequestId } from '@/types/agent-transcript';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2246');
const WORKTREE_ID = 'wt-2246';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/** The three prompt uuids, oldest first. See the fixture README. */
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000005';
const C = '00000000-0000-4000-8000-000000000011';

let threeTurns: string;
let threeTurnsOpen: string;
let home: string;

async function writeTranscript(body: string): Promise<string> {
  const path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
}

/** The body a reader would write for this turn of the complete transcript. */
function bodyOf(promptUuid: string): string {
  const turn = buildClaudeTurns(parseClaudeTranscript(threeTurns).records, SESSION).turns.find(
    (candidate) => candidate.promptUuid === promptUuid
  );
  if (!turn) throw new Error(`no turn for ${promptUuid}`);
  return renderClaudeTurn(turn).body;
}

/**
 * Pretend an earlier run already wrote this turn's assistant row.
 *
 * The row carries the body the reader would render for it, rather than a bare
 * id, because #2264 gave the reader a second thing to do with an already-written
 * row: re-render the turn and replace the row if it has grown. A stub with no
 * `content` would make every one of these tests exercise that path instead of
 * the anchor rule they are about.
 */
function pretendSaved(promptUuid: string, content: string = bodyOf(promptUuid)): void {
  rows.set(`${WORKTREE_ID}::${claudeTurnRequestId(promptUuid)}`, {
    id: `pre-${promptUuid}`,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    requestId: claudeTurnRequestId(promptUuid),
  });
}

/** Every `request_id` this run wrote, in the order it wrote them. */
function writtenKeys(): string[] {
  return createMessage.mock.calls.map(([, message]) => String(message.requestId));
}

function writtenOf(role: string): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((message) => message.role === role);
}

beforeAll(async () => {
  threeTurns = await readFile(join(FIXTURE_DIR, 'three-turns.jsonl'), 'utf8');
  threeTurnsOpen = await readFile(join(FIXTURE_DIR, 'three-turns-open.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  updateMessageContent.mockReset();
  createMessage.mockImplementation(defaultCreateMessage);
  findUnkeyedUserMessages.mockReturnValue([]);
  resetClaudeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2246-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the turn the poller missed', () => {
  it('writes B and C, oldest first, when A is the anchor', async () => {
    // The Issue's own timeline. Before #2246 this wrote C and left B in the
    // transcript forever.
    await writeTranscript(threeTurns);
    pretendSaved(A);

    expect(await capture()).toBe(true);

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([
      claudeTurnRequestId(B),
      claudeTurnRequestId(C),
    ]);
  });

  it('writes each turn’s user row before its own reply', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(A);

    await capture();

    expect(writtenKeys()).toEqual([
      claudePromptRequestId(B),
      claudeTurnRequestId(B),
      claudePromptRequestId(C),
      claudeTurnRequestId(C),
    ]);
  });

  it('dates every backfilled row by the agent’s clock, not by the read', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(A);

    await capture();

    const at = (key: string) =>
      (createMessage.mock.calls.find(([, m]) => m.requestId === key)?.[1].timestamp as Date)
        .toISOString();
    // The prompt record's own instant, and the reply one millisecond after it —
    // `groupMessagesIntoPairs` orders by timestamp and nothing else.
    expect(at(claudePromptRequestId(B))).toBe('2026-09-02T14:38:24.117Z');
    expect(at(claudeTurnRequestId(B))).toBe('2026-09-02T14:38:24.118Z');
    expect(at(claudePromptRequestId(C))).toBe('2026-09-02T14:49:26.559Z');
    expect(at(claudeTurnRequestId(C))).toBe('2026-09-02T14:49:26.560Z');
  });

  it('writes each reply’s own text, and never the next turn’s', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(A);

    await capture();

    const bodies = writtenOf('assistant').map((m) => String(m.content));
    expect(bodies[0]).toContain('GitHub Release v0.30.0 を公開しました。');
    expect(bodies[0]).not.toContain('npm publish が完走しました。');
    expect(bodies[1]).toContain('npm publish が完走しました。');
  });

  it('backfills more than one missed turn in a row', async () => {
    // Two consecutive misses, which is what a poller stalled for a while
    // produces. Nothing about the rule is "one".
    await writeTranscript(threeTurns);

    // No anchor at all would be the guard below; anchor at the very first turn
    // by writing A's key only.
    pretendSaved(A);
    await capture();

    expect(writtenOf('assistant')).toHaveLength(2);
  });
});

describe('the duplicate guard', () => {
  it('writes the newest turn alone when this reader has written nothing here', async () => {
    // The scraper-era session: A and B already have rows nobody keyed, and
    // writing Markdown for them would show each reply twice. There is no
    // evidence in the window that the reader was ever live, so #2121's rule
    // stands.
    await writeTranscript(threeTurns);

    expect(await capture()).toBe(true);

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([claudeTurnRequestId(C)]);
  });

  it('starts after the newest written turn, not after the oldest', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(A);
    pretendSaved(B);

    await capture();

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([claudeTurnRequestId(C)]);
  });

  it('answers true and writes nothing when the newest turn is already a row', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(C);

    expect(await capture()).toBe(true);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('finds the anchor by transcript order and not by timestamp', async () => {
    // The rows carry a `timestamp` that is the prompt's instant plus one
    // millisecond, so the newest row is not a reliable answer to "which turn did
    // we last write". Saving the *middle* turn and nothing else must still leave
    // exactly one turn to write.
    await writeTranscript(threeTurns);
    pretendSaved(B);

    await capture();

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([claudeTurnRequestId(C)]);
  });
});

describe('reading the same transcript twice', () => {
  it('leaves the anchor’s row alone when it already holds the whole turn', async () => {
    // #2264 re-renders the newest already-written turns and replaces a row whose
    // body has grown. "Has not grown" has to cost nothing, or every poll of an
    // idle session would rewrite the same rows.
    await writeTranscript(threeTurns);
    pretendSaved(A);

    await capture();

    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('adds no rows the second time', async () => {
    await writeTranscript(threeTurns);
    pretendSaved(A);

    expect(await capture()).toBe(true);
    const first = writtenKeys();

    createMessage.mockClear();
    expect(await capture()).toBe(true);

    expect(first).toHaveLength(4);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('the newest turn is what the answer is about', () => {
  it('answers false when the newest turn has no body yet, even after backfilling', async () => {
    // The Stop-hook race: turn C's prompt is written and its reply is not. B is
    // still backfilled — it is finished and nobody has it — but the poller is
    // holding a scrape of C, and dropping that would lose C.
    await writeTranscript(threeTurnsOpen);
    pretendSaved(A);

    expect(await capture()).toBe(false);

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([claudeTurnRequestId(B)]);
    // C's prompt is still recorded: the operator typed it, and #2196's rows are
    // worth having next to a scraped reply just as much as a Markdown one.
    expect(writtenOf('user').map((m) => m.requestId)).toEqual([
      claudePromptRequestId(B),
      claudePromptRequestId(C),
    ]);
  });
});

describe('the tail window', () => {
  it('never backfills a turn whose prompt fell outside it', async () => {
    // The trap the Issue names: a window that opens mid-turn holds assistant
    // records with no prompt to key them on. They are counted as orphans and
    // dropped — writing them would invent a key no later run could recognise.
    const filler = `${'x'.repeat(64)}\n`;
    await writeTranscript(threeTurns);
    const path = claudeTranscriptPath(home, WORKTREE_PATH, SESSION);
    // A head that is not JSON stands in for the cut line; the reader drops the
    // first line of a windowed read for exactly this reason.
    await writeFile(path, filler + threeTurns, 'utf8');
    pretendSaved(A);

    await capture();

    expect(writtenOf('assistant').map((m) => m.requestId)).toEqual([
      claudeTurnRequestId(B),
      claudeTurnRequestId(C),
    ]);
  });
});

describe('resolveClaudeTranscriptPath', () => {
  it('names the file the reader would open', async () => {
    const path = await writeTranscript(threeTurns);
    await expect(resolveClaudeTranscriptPath(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home }))
      .resolves.toBe(path);
  });

  it('is null when no hook has ever named a session', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(threeTurns);

    await expect(
      resolveClaudeTranscriptPath(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })
    ).resolves.toBeNull();
  });

  it('is null when the file does not exist', async () => {
    await expect(
      resolveClaudeTranscriptPath(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })
    ).resolves.toBeNull();
  });

  it('writes nothing — it is a lookup, not a read', async () => {
    await writeTranscript(threeTurns);
    await resolveClaudeTranscriptPath(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
    expect(createMessage).not.toHaveBeenCalled();
  });
});
