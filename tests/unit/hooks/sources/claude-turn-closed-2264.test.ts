/**
 * Writing a turn only once the agent has finished it (Issue #2264).
 *
 * #2246 gave the reader a second trigger — the agent's own `stop` hook — on the
 * argument that the agent knows the turn boundary exactly. It does. What it does
 * not know is when the *file* will have caught up: the last assistant record is
 * appended around, not necessarily before, the moment the hook fires.
 *
 * The reader that arrives in that gap used to write the turn anyway, and the row
 * it wrote was permanent — keyed on the prompt's `uuid`, so every later read
 * answered "already saved" and the scrape that held the full reply was
 * suppressed two seconds later. Measured 2026-09-03: **9 of 20 turns** of one
 * instance saved as 236 characters of `> **Tool calls (1)**` with no answer in
 * them at all.
 *
 * The emptiness guard #2121 left behind cannot catch this, and that is the whole
 * subtlety: `renderClaudeTurn` draws tool calls as a trailing section, so a turn
 * cut off after its `tool_use` records has a **non-empty** body. What tells the
 * two apart is `message.stop_reason`, which the reader had never read.
 *
 * The transcript is `tests/fixtures/claude-transcript-2264`; see that
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
const updateMessageContent = vi.fn();
const broadcastMessage = vi.fn();

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));

import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  CLAUDE_TURN_RECHECK_LIMIT,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import {
  buildClaudeTurns,
  claudeProjectSlug,
  parseClaudeTranscript,
  renderClaudeTurn,
  type ClaudeTurnAccumulator,
} from '@/lib/hooks/sources/claude/transcript';
import { claudeTurnRequestId } from '@/types/agent-transcript';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2264');
const WORKTREE_ID = 'wt-2264';
const WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

/** The three prompt uuids, oldest first. See the fixture README. */
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000005';
const C = '00000000-0000-4000-8000-000000000011';

let open: string;
let closed: string;
let thinkingOnly: string;
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

function turnsOf(text: string): readonly ClaudeTurnAccumulator[] {
  return buildClaudeTurns(parseClaudeTranscript(text).records, SESSION).turns;
}

/** The turn keyed on `promptUuid`, as this transcript holds it. */
function turnOf(text: string, promptUuid: string): ClaudeTurnAccumulator {
  const turn = turnsOf(text).find((candidate) => candidate.promptUuid === promptUuid);
  if (!turn) throw new Error(`no turn for ${promptUuid}`);
  return turn;
}

/** The body a reader would write for this turn of this transcript. */
function bodyOf(text: string, promptUuid: string): string {
  return renderClaudeTurn(turnOf(text, promptUuid)).body;
}

/** Pretend an earlier run wrote this turn's assistant row with `content`. */
function pretendSaved(promptUuid: string, content: string): void {
  rows.set(`${WORKTREE_ID}::${claudeTurnRequestId(promptUuid)}`, {
    id: `pre-${promptUuid}`,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content,
    requestId: claudeTurnRequestId(promptUuid),
  });
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
  thinkingOnly = await readFile(join(FIXTURE_DIR, 'turn-thinking-only.jsonl'), 'utf8');
});

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetClaudeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2264-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('what the fixture is, before anything is asserted about it', () => {
  it('renders the open turn to a non-empty body — which is why the empty guard misses it', () => {
    // The load-bearing property of the whole Issue. If a cut-off turn rendered
    // to nothing, #2121's emptiness guard would already have caught it and there
    // would be no bug.
    expect(bodyOf(open, C).length).toBeGreaterThan(0);
    expect(bodyOf(open, C)).toContain('Tool calls');
  });

  it('has no answer in that body, and the answer in the closed one', () => {
    expect(bodyOf(open, C)).not.toContain('npm publish が完走しました。');
    expect(bodyOf(closed, C)).toContain('npm publish が完走しました。');
    expect(bodyOf(closed, C).length).toBeGreaterThan(bodyOf(open, C).length);
  });
});

describe('buildClaudeTurns decides whether the agent finished', () => {
  it('is closed on `end_turn` with a text block', () => {
    expect(turnOf(closed, C).closed).toBe(true);
  });

  it('is open on `tool_use`', () => {
    expect(turnOf(open, C).closed).toBe(false);
  });

  it('is open on `end_turn` whose only block is thinking', () => {
    // Measured once in the sampled session, and Claude Code resumes after it.
    // `end_turn` alone would have called this finished.
    expect(turnOf(thinkingOnly, C).closed).toBe(false);
  });

  it('marks every turn but the newest as superseded', () => {
    // The second proof, and the one that keeps #2246's backfill alive: a later
    // prompt means the agent moved on, whatever the last record says.
    expect(turnsOf(open).map((turn) => turn.superseded)).toEqual([true, true, false]);
  });

  it('records that a `stop_reason` was seen at all', () => {
    // The evidence check. Every assistant record of every turn here carries one,
    // which is what the 7,147-record census on 2026-09-03 found in production.
    expect(turnsOf(open).every((turn) => turn.stopReasonObserved)).toBe(true);
  });

  it('treats a transcript with no `stop_reason` anywhere as writable', () => {
    // Unreachable against every Claude version measured, and deliberately
    // fail-open: a release that dropped the field must degrade to the pre-#2264
    // behaviour rather than switch the reader off in silence.
    const noField = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        sessionId: SESSION,
        isSidechain: false,
        origin: { kind: 'human' },
        message: { role: 'user', content: 'q' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        sessionId: SESSION,
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      }),
    ].join('\n');
    const turn = turnsOf(noField)[0];
    expect(turn.closed).toBe(false);
    expect(turn.stopReasonObserved).toBe(false);
  });
});

describe('the writer refuses a turn the agent has not finished', () => {
  it('answers false and writes no assistant row for it', async () => {
    await writeTranscript(open);

    expect(await capture()).toBe(false);

    expect(writtenKeys()).not.toContain(claudeTurnRequestId(C));
  });

  it('writes it once the last record arrives', async () => {
    await writeTranscript(closed);

    expect(await capture()).toBe(true);

    expect(writtenKeys()).toContain(claudeTurnRequestId(C));
    const saved = createMessage.mock.calls
      .map(([, message]) => message)
      .find((message) => message.requestId === claudeTurnRequestId(C));
    expect(String(saved?.content)).toContain('npm publish が完走しました。');
  });

  it('refuses an `end_turn` that only thought', async () => {
    await writeTranscript(thinkingOnly);

    expect(await capture()).toBe(false);

    expect(writtenKeys()).not.toContain(claudeTurnRequestId(C));
  });

  it('still records the prompt, so the operator’s message is not lost with it', async () => {
    // The reply goes back to the scraper; the user row is #2196's and is worth
    // having next to a scraped reply just as much as next to a Markdown one.
    await writeTranscript(open);

    await capture();

    expect(
      createMessage.mock.calls.map(([, message]) => message).some((m) => m.role === 'user')
    ).toBe(true);
  });

  it('still backfills the finished turns before it', async () => {
    // The turn that is open is the newest one. B is finished, nobody has it, and
    // refusing C must not refuse B — that would be a #2246 regression.
    await writeTranscript(open);
    pretendSaved(A, bodyOf(open, A));

    await capture();

    expect(writtenKeys()).toEqual([claudeTurnRequestId(B)]);
  });
});

describe('a row that was written short is repaired', () => {
  it('replaces it when the closed turn renders longer', async () => {
    // The nine rows the Issue measured, and what happens to them on the next
    // read: the transcript beside them holds the paragraph they are missing.
    await writeTranscript(closed);
    pretendSaved(C, bodyOf(open, C));

    expect(await capture()).toBe(true);

    expect(updateMessageContent).toHaveBeenCalledWith({}, `pre-${C}`, bodyOf(closed, C));
  });

  it('delivers the replacement as `message_updated`, never as `message`', async () => {
    // The row already existed and was already delivered when it was created
    // (#2195); a client that appended instead of replacing would show it twice.
    await writeTranscript(closed);
    pretendSaved(C, bodyOf(open, C));

    await capture();

    expect(broadcastMessage).toHaveBeenCalledWith('message_updated', {
      worktreeId: WORKTREE_ID,
      message: expect.objectContaining({
        id: `pre-${C}`,
        content: bodyOf(closed, C),
      }),
    });
  });

  it('does nothing when the row already holds the same body', async () => {
    await writeTranscript(closed);
    pretendSaved(C, bodyOf(closed, C));

    expect(await capture()).toBe(true);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalledWith('message_updated', expect.anything());
  });

  it('never shortens a row', async () => {
    // A body that got shorter between two reads is a window that slid, not a
    // turn that grew, and overwriting a full reply with less of it is the one
    // outcome worse than the bug.
    await writeTranscript(open);
    pretendSaved(C, `${bodyOf(closed, C)} and then some`);

    await capture();

    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('does not repair a turn that is still open', async () => {
    // Its body is by definition not the final one, and repairing on every poll
    // of a long turn would rewrite the row for the length of the turn.
    await writeTranscript(open);
    pretendSaved(C, 'short');

    await capture();

    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('repairs an older turn too, while it is inside the recheck window', async () => {
    await writeTranscript(closed);
    pretendSaved(A, 'short');
    pretendSaved(B, bodyOf(closed, B));
    pretendSaved(C, bodyOf(closed, C));

    await capture();

    expect(updateMessageContent).toHaveBeenCalledTimes(1);
    expect(updateMessageContent).toHaveBeenCalledWith({}, `pre-${A}`, bodyOf(closed, A));
  });

  it('looks no further back than the recheck limit', () => {
    // Three, because the poller runs every two seconds and re-rendering the whole
    // window on every tick would turn a repair into the most expensive thing the
    // poll does. The fixture has exactly three turns, so the assertions above
    // reach all of them — this is what pins the bound itself.
    expect(CLAUDE_TURN_RECHECK_LIMIT).toBe(3);
  });
});
