/**
 * Finding and writing one antigravity turn (Issue #2198).
 *
 * The half of the writer that touches the world: which transcript belongs to
 * this instance, what happens when it is missing or unreadable, and what the
 * poller is told afterwards. The rendering is pinned in
 * `./antigravity-transcript-2198.test.ts`, against the same captured fixture
 * this file copies onto disk.
 *
 * The return value is the whole contract, so it is what nearly every assertion
 * here reads. **True** means History holds the turn as Markdown and the poller
 * must drop its scrape; **false** means it does not, for any reason at all, and
 * the scrape is the only record there will be. Every failure path is asserted to
 * answer false, because that is the fail-open the acceptance criteria require
 * and a "safe default" nobody tested is not one.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();
/**
 * Named so `beforeEach` can put it back.
 *
 * `vi.clearAllMocks()` clears recorded calls and leaves implementations in
 * place, so a test that makes this throw would otherwise make every later test
 * in the file throw too — a leak that reads as a defect in whatever runs next.
 */
function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, ...message, timestamp: message.timestamp };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}
const createMessage = vi.fn(defaultCreateMessage);
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);
const findUnkeyedUserMessages = vi.fn(() => [] as Array<Record<string, unknown>>);
const setMessageRequestId = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => findUnkeyedUserMessages(),
  setMessageRequestId: () => setMessageRequestId(),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));

import {
  acceptAntigravityTranscriptPath,
  antigravityBrainRoot,
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
  resolveAntigravityConversationId,
  resolveAntigravityHome,
  ANTIGRAVITY_TRANSCRIPT_TAIL_BYTES,
} from '@/lib/hooks/sources/antigravity/history';
import { TRANSCRIPT_TAIL_BYTES } from '@/lib/history/transcript-tail';
import {
  antigravityPromptRequestId,
  antigravityTurnRequestId,
  isAgentAuthoredMarkdown,
} from '@/types/agent-transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/antigravity');
const THREE_TURNS = readFileSync(join(FIXTURES, 'transcript-three-turns-1118.jsonl'), 'utf8');

const WORKTREE_ID = 'wt-2198';
const CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
/** A second uuid, standing for the IDE's conversation or a second instance's. */
const OTHER_CONVERSATION = '2b7c1d90-4e33-4f21-9a55-6d0c8f2e4a11';
const LAST_STEP = 12;
const LAST_PROMPT =
  'Reply with exactly: THIRD TURN OK. Use **bold** markdown in your reply and a bullet list of two items. No tools.';

const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity' } as const;

let antigravityHome: string;

/** Put a transcript where agy would have put it. */
async function writeTranscript(conversationId: string, body: string): Promise<string> {
  const path = antigravityTranscriptPath(antigravityHome, conversationId);
  if (!path) throw new Error(`not a conversation id: ${conversationId}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

function savedRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls.map(([, message]) => message);
}

function savedOf(role: string): Array<Record<string, unknown>> {
  return savedRows().filter((row) => row.role === role);
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetAntigravityTranscriptConversations();
  antigravityHome = await mkdtemp(join(tmpdir(), 'cmate-2198-'));
  getLastAgentEvent.mockReturnValue({ sessionId: CONVERSATION });
  findUnkeyedUserMessages.mockReturnValue([]);
});

afterEach(async () => {
  await rm(antigravityHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('[#2198] the conversation pointer', () => {
  it('reads the id off the structured event and latches it', async () => {
    expect(await resolveAntigravityConversationId(TARGET)).toBe(CONVERSATION);
    // An event that carries no id must not blank the pointer: agy sends
    // `conversationId` on every event it delivers today, and a later one that
    // did not would otherwise take the reader offline mid-session.
    getLastAgentEvent.mockReturnValue({ sessionId: null });
    expect(await resolveAntigravityConversationId(TARGET)).toBe(CONVERSATION);
  });

  it('is null when nothing has ever reported a conversation', async () => {
    getLastAgentEvent.mockReturnValue(null);
    expect(await resolveAntigravityConversationId(TARGET)).toBeNull();
  });

  it('asks about this instance rather than about the tool', async () => {
    await resolveAntigravityConversationId({
      worktreeId: WORKTREE_ID,
      cliToolId: 'antigravity',
      instanceId: 'antigravity-2',
    });
    expect(getLastAgentEvent).toHaveBeenCalledWith(WORKTREE_ID, 'antigravity', 'antigravity-2');
  });

  it('keeps two instances in one worktree on separate transcripts', async () => {
    // agy runs its hooks with `cwd` set to its own config directory, so a
    // cwd-based lookup would not merely be ambiguous between two instances — it
    // would point at the wrong directory for both.
    getLastAgentEvent.mockImplementation((...args: unknown[]) =>
      args[2] === 'antigravity-2' ? { sessionId: OTHER_CONVERSATION } : { sessionId: CONVERSATION }
    );
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await writeTranscript(
      OTHER_CONVERSATION,
      [
        '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-09-01T02:20:00Z","content":"<USER_REQUEST>\\nping\\n</USER_REQUEST>"}',
        '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-09-01T02:20:01Z","content":"PONG-FROM-SECOND-INSTANCE"}',
      ].join('\n')
    );

    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(true);
    expect(
      await captureAntigravityTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity-2' },
        { antigravityHome }
      )
    ).toBe(true);

    expect(savedOf('assistant').map((row) => String(row.content))).toEqual([
      expect.stringContaining('**THIRD TURN OK**'),
      'PONG-FROM-SECOND-INSTANCE',
    ]);
    expect(savedOf('assistant').map((row) => row.instanceId)).toEqual([
      'antigravity',
      'antigravity-2',
    ]);
  });

  it('answers false with no pointer, and writes nothing at all', async () => {
    // The fail-open. A pane started before the hooks config existed, or a server
    // restarted mid-session, has no pointer — and the scraper must stay the only
    // record rather than the reply being lost.
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(CONVERSATION, THREE_TURNS);
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('[#2198] finding the file', () => {
  it('roots at ~/.gemini/antigravity-cli, which is the CLI’s and not the IDE’s', () => {
    // The go/no-go's central worry was that agy shares state between the CLI and
    // an IDE backend. They share a parent and nothing else: the IDE writes under
    // `~/.gemini/antigravity`, and reading that would be reading somebody else's
    // session.
    expect(resolveAntigravityHome('/home/u')).toBe('/home/u/.gemini/antigravity-cli');
    expect(resolveAntigravityHome('/home/u')).not.toContain('/antigravity/');
    expect(resolveAntigravityHome()).toMatch(/\.gemini[/\\]antigravity-cli$/);
  });

  it('computes the path from the conversation id rather than scanning for it', () => {
    // This is the one place agy is easier to read than codex, whose rollout file
    // name embeds the wall-clock time the session started.
    expect(antigravityTranscriptPath('/agy', CONVERSATION)).toBe(
      join('/agy', 'brain', CONVERSATION, '.system_generated', 'logs', 'transcript_full.jsonl')
    );
  });

  it('refuses a conversation id that is not one', () => {
    // The value becomes a path segment. Anything that is not a UUID is treated
    // as "no pointer" rather than as a path expression.
    for (const bad of ['../../etc/passwd', '', 'antigravity', `${CONVERSATION}/x`, `${CONVERSATION}\0`]) {
      expect(antigravityTranscriptPath('/agy', bad), bad).toBeNull();
    }
  });

  it('answers false when the conversation has no transcript on disk', async () => {
    // agy has minted the id but not flushed the file yet, or the operator
    // cleared the directory.
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('answers false when the path is a directory rather than a file', async () => {
    const path = antigravityTranscriptPath(antigravityHome, CONVERSATION);
    await mkdir(path!, { recursive: true });
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
  });

  it('reads the shared 4 MiB tail bound rather than one of its own', () => {
    expect(ANTIGRAVITY_TRANSCRIPT_TAIL_BYTES).toBe(TRANSCRIPT_TAIL_BYTES);
  });
});

describe('[#2198] accepting a path', () => {
  it('accepts a transcript under the brain root', () => {
    const path = antigravityTranscriptPath(antigravityHome, CONVERSATION)!;
    expect(acceptAntigravityTranscriptPath(antigravityHome, path)).toBe(path);
  });

  it('refuses anything outside the brain root', () => {
    // The same discipline `acceptCodexRolloutPath` applies, and for the same
    // reason: containment is a second, independent barrier to the id that came
    // off the wire.
    expect(acceptAntigravityTranscriptPath(antigravityHome, '/etc/passwd')).toBeNull();
    expect(
      acceptAntigravityTranscriptPath(antigravityHome, join(antigravityHome, 'settings.json'))
    ).toBeNull();
    expect(
      acceptAntigravityTranscriptPath(
        antigravityHome,
        join(antigravityBrainRoot(antigravityHome), '..', 'settings.jsonl')
      )
    ).toBeNull();
  });

  it('refuses a climb that only resolves outside', () => {
    const climb = join(
      antigravityBrainRoot(antigravityHome),
      CONVERSATION,
      '..',
      '..',
      '..',
      'secrets.jsonl'
    );
    expect(acceptAntigravityTranscriptPath(antigravityHome, climb)).toBeNull();
  });

  it('refuses a NUL and a wrong extension', () => {
    const root = antigravityBrainRoot(antigravityHome);
    expect(acceptAntigravityTranscriptPath(antigravityHome, join(root, 'a.json'))).toBeNull();
    expect(acceptAntigravityTranscriptPath(antigravityHome, `${join(root, 'a')}\0.jsonl`)).toBeNull();
  });
});

describe('[#2198] writing the turn', () => {
  it('writes the newest turn as the agent’s own Markdown and says so', async () => {
    await writeTranscript(CONVERSATION, THREE_TURNS);
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(true);

    const assistant = savedOf('assistant');
    expect(assistant).toHaveLength(1);
    expect(String(assistant[0].content)).toContain('**THIRD TURN OK**\n\n- Item 1\n- Item 2');
    expect(assistant[0].requestId).toBe(antigravityTurnRequestId(CONVERSATION, LAST_STEP));
    expect(assistant[0].cliToolId).toBe('antigravity');
    expect(broadcastMessage).toHaveBeenCalledWith('message', expect.anything());
  });

  it('marks the row as Markdown, which is what the card reads', async () => {
    // `ConversationPairCard` names no prefix; it asks this predicate. A turn row
    // that failed it would be drawn verbatim, box-drawing and all.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });
    expect(isAgentAuthoredMarkdown(String(savedOf('assistant')[0].requestId))).toBe(true);
  });

  it('writes the prompt through the shared #2196 recorder, and not as Markdown', async () => {
    // agy has no `UserPromptSubmit` hook at all, so the transcript is the only
    // place its prompts are written down — and the operator's own text is drawn
    // verbatim, so its key must stay off the Markdown list.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });

    const user = savedOf('user');
    expect(user).toHaveLength(1);
    expect(user[0].requestId).toBe(antigravityPromptRequestId(CONVERSATION, LAST_STEP));
    expect(user[0].content).toBe(LAST_PROMPT);
    expect(isAgentAuthoredMarkdown(String(user[0].requestId))).toBe(false);
  });

  it('puts the reply after the prompt rather than on the same instant', async () => {
    // agy's `created_at` is second-resolution and a fast turn stamps the prompt
    // and the reply with the same value. `groupMessagesIntoPairs` orders by
    // timestamp and nothing else, so a tie is an ordering decided by the query
    // plan — and the losing arrangement is the `orphan` pair #2196 removes.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });

    const user = savedOf('user')[0].timestamp as Date;
    const assistant = savedOf('assistant')[0].timestamp as Date;
    expect(assistant.getTime()).toBeGreaterThan(user.getTime());
  });

  it('dates the turn by agy’s clock, not by the poll', async () => {
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });
    expect((savedOf('user')[0].timestamp as Date).toISOString()).toBe('2026-09-01T02:14:40.000Z');
  });

  it('writes one row however many times the same finished turn is read', async () => {
    await writeTranscript(CONVERSATION, THREE_TURNS);
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(true);
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(true);
    expect(savedOf('assistant')).toHaveLength(1);
    expect(savedOf('user')).toHaveLength(1);
  });

  it('leaves the earlier turns to the scraper that already wrote them', async () => {
    // Only the newest turn is ever written. The other two already have a scraped
    // row each, and writing Markdown for them as well would put the same reply
    // in History twice.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });
    expect(savedOf('assistant')).toHaveLength(1);
    for (const earlier of [0, 2]) {
      expect(savedRows().map((row) => row.requestId)).not.toContain(
        antigravityTurnRequestId(CONVERSATION, earlier)
      );
    }
  });

  it('keys the row on the conversation as well as the step', async () => {
    // `step_index` is unique inside one conversation and unique nowhere else, so
    // a bare index would collide with the twelfth step of every other agy
    // conversation the moment two instances shared a worktree.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await captureAntigravityTranscriptTurn(TARGET, { antigravityHome });
    expect(String(savedOf('assistant')[0].requestId)).toBe(
      `antigravity-turn:${CONVERSATION}#${LAST_STEP}`
    );
    expect(antigravityTurnRequestId(OTHER_CONVERSATION, LAST_STEP)).not.toBe(
      antigravityTurnRequestId(CONVERSATION, LAST_STEP)
    );
  });
});

describe('[#2198] refusing to write', () => {
  it('hands a window with no prompt in it back to the scraper', async () => {
    // Measured on the corpus: one conversation's `transcript_full.jsonl` held a
    // single record while the truncated `transcript.jsonl` beside it held 133.
    // A turn cannot be named without the record that opened it.
    await writeTranscript(
      CONVERSATION,
      '{"step_index":139,"source":"MODEL","type":"GENERIC","created_at":"2026-09-01T02:20:00Z","content":"Created At: … "}'
    );
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('hands a turn that has said nothing yet back to the scraper', async () => {
    // agy writes nothing that closes a turn, so the body is the only evidence
    // there is. An empty row would show as a blank answer forever.
    await writeTranscript(
      CONVERSATION,
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-09-01T02:20:00Z","content":"<USER_REQUEST>\\nq\\n</USER_REQUEST>"}'
    );
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
    expect(savedOf('assistant')).toHaveLength(0);
  });

  it('still records the prompt when the reply is left to the scraper', async () => {
    // Deliberate rather than an oversight: a prompt typed into `tmux attach` is
    // exactly what #2196 exists to record, and it is worth recording next to a
    // *scraped* reply just as much as next to a Markdown one.
    await writeTranscript(
      CONVERSATION,
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-09-01T02:20:00Z","content":"<USER_REQUEST>\\ntyped into tmux\\n</USER_REQUEST>"}'
    );
    expect(await captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).toBe(false);
    expect(savedOf('user').map((row) => row.content)).toEqual(['typed into tmux']);
  });

  it('never throws, whatever the database does', async () => {
    // This runs inside the poller's save path. An exception escaping would cost
    // the scraped reply as well as the structured one.
    await writeTranscript(CONVERSATION, THREE_TURNS);
    createMessage.mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).resolves.toBe(false);
  });

  it('never throws when the event state module cannot be asked', async () => {
    getLastAgentEvent.mockImplementation(() => {
      throw new Error('registry not ready');
    });
    await writeTranscript(CONVERSATION, THREE_TURNS);
    await expect(captureAntigravityTranscriptTurn(TARGET, { antigravityHome })).resolves.toBe(false);
  });
});
