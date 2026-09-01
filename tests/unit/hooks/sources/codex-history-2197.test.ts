/**
 * Finding and writing one codex turn (Issue #2197).
 *
 * The half of the writer that touches the world: which rollout belongs to this
 * instance, what happens when it is missing or unreadable, and what the poller
 * is told afterwards. The rendering is pinned in
 * `./codex-transcript-2197.test.ts`, against the same captured fixtures this
 * file copies onto disk.
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

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));

import {
  acceptCodexRolloutPath,
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  findCodexRolloutPath,
  isCodexRolloutFileFor,
  resetCodexTranscriptSessions,
  resolveCodexHome,
  resolveCodexSessionId,
  CODEX_TRANSCRIPT_TAIL_BYTES,
} from '@/lib/hooks/sources/codex/history';
import { TRANSCRIPT_TAIL_BYTES } from '@/lib/history/transcript-tail';
import { codexPromptRequestId, codexTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/codex');
const THREE_TURNS = readFileSync(join(FIXTURES, 'rollout-three-turns-01510.jsonl'), 'utf8');
const SECOND_INSTANCE = readFileSync(
  join(FIXTURES, 'rollout-second-instance-01510.jsonl'),
  'utf8'
);

const WORKTREE_ID = 'wt-2197';
const SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
const SECOND_SESSION = '01a05a85-2e16-7253-96be-cd143be9049c';
const LAST_TURN = '01a05a84-76f2-7390-83f3-51ea1346a364';
const LAST_PROMPT_ITEM = '01a05a84-773a-7bc1-84b3-13ab3d89aedd';
const LAST_BODY = '## Result\n\n- alpha\n- beta\n\n**Done.**';

const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' } as const;

let codexHome: string;

/** Put a rollout where codex would have put it. */
async function writeRollout(
  sessionId: string,
  body: string,
  when = { year: '2026', month: '09', day: '01' }
): Promise<string> {
  const dir = join(codexSessionsRoot(codexHome), when.year, when.month, when.day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${when.year}-${when.month}-${when.day}T10-08-39-${sessionId}.jsonl`);
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
  resetCodexTranscriptSessions();
  codexHome = await mkdtemp(join(tmpdir(), 'cmate-2197-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  findUnkeyedUserMessages.mockReturnValue([]);
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('[#2197] the session pointer', () => {
  it('reads the id off the structured event and latches it', async () => {
    expect(await resolveCodexSessionId(TARGET)).toBe(SESSION);
    // An event that carries no session id must not blank the pointer: codex
    // sends one on every event it delivers today, and a later one that did not
    // would otherwise take the reader offline mid-session.
    getLastAgentEvent.mockReturnValue({ sessionId: null });
    expect(await resolveCodexSessionId(TARGET)).toBe(SESSION);
  });

  it('is null when nothing has ever reported a session', async () => {
    getLastAgentEvent.mockReturnValue(null);
    expect(await resolveCodexSessionId(TARGET)).toBeNull();
  });

  it('asks about this instance rather than about the tool', async () => {
    await resolveCodexSessionId({ worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex-2' });
    expect(getLastAgentEvent).toHaveBeenCalledWith(WORKTREE_ID, 'codex', 'codex-2');
  });

  it('keeps two instances in one worktree on separate pointers', async () => {
    // The measurement this whole design rests on: `codex` and `codex-2` share a
    // cwd and do not share a session id. A cwd-based lookup would file the
    // primary's turn under the second's conversation.
    getLastAgentEvent.mockImplementation((...args: unknown[]) =>
      args[2] === 'codex-2' ? { sessionId: SECOND_SESSION } : { sessionId: SESSION }
    );
    await writeRollout(SESSION, THREE_TURNS);
    await writeRollout(SECOND_SESSION, SECOND_INSTANCE);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);
    expect(
      await captureCodexTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex-2' },
        { codexHome }
      )
    ).toBe(true);

    const bodies = savedOf('assistant').map((row) => String(row.content));
    expect(bodies).toEqual([LAST_BODY, 'PONG-FROM-SECOND-INSTANCE']);
    expect(savedOf('assistant').map((row) => row.instanceId)).toEqual(['codex', 'codex-2']);
  });

  it('answers false with no pointer, and writes nothing at all', async () => {
    // The fail-open. A pane started without hooks — or with hooks codex has not
    // been told to trust, which it skips in silence (#1757 P4) — has no pointer,
    // and the scraper must stay the only record.
    getLastAgentEvent.mockReturnValue(null);
    await writeRollout(SESSION, THREE_TURNS);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('[#2197] finding the file', () => {
  it('defaults the root to $CODEX_HOME, and to ~/.codex without it', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/opt/codexhome' })).toBe('/opt/codexhome');
    expect(resolveCodexHome({})).toMatch(/\.codex$/);
    // Empty is not a root: it would resolve `sessions` against the cwd.
    expect(resolveCodexHome({ CODEX_HOME: '' })).toMatch(/\.codex$/);
  });

  it('finds the rollout under the dated directory codex writes it to', async () => {
    const path = await writeRollout(SESSION, THREE_TURNS);
    expect(await findCodexRolloutPath(codexHome, SESSION)).toBe(path);
  });

  it('prefers the newest date directory', async () => {
    // The scan descends name-descending, which is date-descending for
    // <year>/<month>/<day>. A long-lived machine has hundreds of these.
    await writeRollout(SESSION, THREE_TURNS, { year: '2026', month: '08', day: '01' });
    const newer = await writeRollout(SESSION, THREE_TURNS, { year: '2026', month: '09', day: '01' });
    expect(await findCodexRolloutPath(codexHome, SESSION)).toBe(newer);
  });

  it('is null when no file carries that session id', async () => {
    await writeRollout(SECOND_SESSION, SECOND_INSTANCE);
    expect(await findCodexRolloutPath(codexHome, SESSION)).toBeNull();
  });

  it('is null when the sessions root does not exist at all', async () => {
    expect(await findCodexRolloutPath(join(codexHome, 'nowhere'), SESSION)).toBeNull();
  });

  it('refuses a session id that is not one', async () => {
    // The value reaches a file-name comparison. Anything that is not a UUID is
    // treated as "no pointer" rather than as a path expression.
    for (const bad of ['../../etc/passwd', '', 'codex', `${SESSION}/x`, `${SESSION}\0`]) {
      expect(await findCodexRolloutPath(codexHome, bad)).toBeNull();
    }
  });

  it('matches only a file named for exactly that session', () => {
    expect(isCodexRolloutFileFor(`rollout-2026-09-01T10-08-39-${SESSION}.jsonl`, SESSION)).toBe(true);
    // A prefix of the id is not the id, and a sibling extension is not a rollout.
    expect(isCodexRolloutFileFor(`rollout-x-${SESSION.slice(0, 8)}.jsonl`, SESSION)).toBe(false);
    expect(isCodexRolloutFileFor(`rollout-x-${SESSION}.jsonl.bak`, SESSION)).toBe(false);
    expect(isCodexRolloutFileFor(`notes-${SESSION}.jsonl`, SESSION)).toBe(false);
  });
});

describe('[#2197] accepting a path', () => {
  it('accepts a rollout under the sessions root', () => {
    const path = join(codexSessionsRoot(codexHome), '2026', '09', '01', `rollout-a-${SESSION}.jsonl`);
    expect(acceptCodexRolloutPath(codexHome, path)).toBe(path);
  });

  it('refuses anything outside the sessions root', () => {
    // The same discipline `acceptClaudeTranscriptHint` applies, and for the same
    // reason: a path that reached this reader from anywhere but this module must
    // not be able to name an arbitrary file.
    expect(acceptCodexRolloutPath(codexHome, '/etc/passwd')).toBeNull();
    expect(acceptCodexRolloutPath(codexHome, join(codexHome, 'auth.json'))).toBeNull();
    expect(
      acceptCodexRolloutPath(codexHome, join(codexSessionsRoot(codexHome), '..', 'auth.json'))
    ).toBeNull();
  });

  it('refuses a climb that only resolves outside', () => {
    const climb = join(codexSessionsRoot(codexHome), '2026', '..', '..', '..', 'secrets.jsonl');
    expect(acceptCodexRolloutPath(codexHome, climb)).toBeNull();
  });

  it('refuses a NUL and a wrong extension', () => {
    const root = codexSessionsRoot(codexHome);
    expect(acceptCodexRolloutPath(codexHome, join(root, 'a.json'))).toBeNull();
    expect(acceptCodexRolloutPath(codexHome, `${join(root, 'a')}\0.jsonl`)).toBeNull();
  });
});

describe('[#2197] writing the turn', () => {
  it('writes the newest turn as the agent’s own Markdown and says so', async () => {
    await writeRollout(SESSION, THREE_TURNS);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);

    const assistant = savedOf('assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(LAST_BODY);
    expect(assistant[0].requestId).toBe(codexTurnRequestId(LAST_TURN));
    expect(assistant[0].cliToolId).toBe('codex');
    expect(broadcastMessage).toHaveBeenCalledWith('message', expect.anything());
  });

  it('writes the prompt through the shared #2196 recorder', async () => {
    await writeRollout(SESSION, THREE_TURNS);
    await captureCodexTranscriptTurn(TARGET, { codexHome });

    const user = savedOf('user');
    expect(user).toHaveLength(1);
    expect(user[0].requestId).toBe(codexPromptRequestId(LAST_PROMPT_ITEM));
    expect(String(user[0].content)).toContain('a level-2 heading "## Result"');
  });

  it('puts the reply after the prompt rather than on the same instant', async () => {
    // `groupMessagesIntoPairs` orders by timestamp and nothing else, so a tie is
    // an ordering decided by the query plan — and the losing arrangement is the
    // `orphan` pair #2196 exists to remove.
    await writeRollout(SESSION, THREE_TURNS);
    await captureCodexTranscriptTurn(TARGET, { codexHome });

    const user = savedOf('user')[0].timestamp as Date;
    const assistant = savedOf('assistant')[0].timestamp as Date;
    expect(assistant.getTime()).toBeGreaterThan(user.getTime());
  });

  it('dates the turn by codex’s clock, not by the poll', async () => {
    await writeRollout(SESSION, THREE_TURNS);
    await captureCodexTranscriptTurn(TARGET, { codexHome });
    const user = savedOf('user')[0].timestamp as Date;
    expect(user.toISOString()).toBe('2026-09-01T01:10:25.851Z');
  });

  it('writes one row however many times the same finished turn is read', async () => {
    await writeRollout(SESSION, THREE_TURNS);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);
    expect(savedOf('assistant')).toHaveLength(1);
    expect(savedOf('user')).toHaveLength(1);
  });

  it('leaves the earlier turns to the scraper that already wrote them', async () => {
    // Only the newest turn is ever written. The other two already have a scraped
    // row each, and writing Markdown for them as well would put the same reply
    // in History twice.
    await writeRollout(SESSION, THREE_TURNS);
    await captureCodexTranscriptTurn(TARGET, { codexHome });
    expect(savedOf('assistant')).toHaveLength(1);
    expect(savedRows().map((row) => row.requestId)).not.toContain(
      codexTurnRequestId('01a05a83-0933-7723-8eb2-2e459b5a1ebd')
    );
  });
});

describe('[#2197] refusing to write', () => {
  it('hands an unfinished turn back to the scraper', async () => {
    // No `task_complete` for the newest turn: what is in the file is a turn in
    // progress, and a truncated body would look finished forever.
    const lines = THREE_TURNS.trim().split('\n');
    const lastComplete = lines.findLastIndex((line) => line.includes('"task_complete"'));
    await writeRollout(SESSION, `${lines.slice(0, lastComplete).join('\n')}\n`);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(false);
    expect(savedOf('assistant')).toHaveLength(0);
  });

  it('still records the prompt of an unfinished turn', async () => {
    // The prompt happened, and it is worth recording next to a scraped reply
    // just as much as next to a Markdown one — that is the whole of #2196.
    const lines = THREE_TURNS.trim().split('\n');
    const lastComplete = lines.findLastIndex((line) => line.includes('"task_complete"'));
    await writeRollout(SESSION, `${lines.slice(0, lastComplete).join('\n')}\n`);

    await captureCodexTranscriptTurn(TARGET, { codexHome });
    expect(savedOf('user')).toHaveLength(1);
    expect(savedOf('user')[0].requestId).toBe(codexPromptRequestId(LAST_PROMPT_ITEM));
  });

  it('hands back a closed turn that said nothing', async () => {
    const empty = [
      JSON.stringify({
        timestamp: '2026-09-01T01:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: SESSION, cwd: '/tmp/x' },
      }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'empty-turn' },
      }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'empty-turn' },
      }),
      '',
    ].join('\n');
    await writeRollout(SESSION, empty);
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('hands back a session whose file is not there', async () => {
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('hands back a rollout with no turns in the window', async () => {
    await writeRollout(SESSION, '{"type":"session_meta","payload":{"session_id":"x"}}\n');
    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(false);
  });

  it('does not throw when the database refuses the write', async () => {
    // This runs inside the poller's save path. An exception escaping would cost
    // the scraped reply as well as the structured one.
    await writeRollout(SESSION, THREE_TURNS);
    createMessage.mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(captureCodexTranscriptTurn(TARGET, { codexHome })).resolves.toBe(false);
  });

  it('does not throw when the event state cannot be reached', async () => {
    getLastAgentEvent.mockImplementation(() => {
      throw new Error('registry not ready');
    });
    await expect(captureCodexTranscriptTurn(TARGET, { codexHome })).resolves.toBe(false);
  });
});

describe('[#2197] the tail window', () => {
  it('is the shared 4 MiB bound the other readers use', () => {
    expect(CODEX_TRANSCRIPT_TAIL_BYTES).toBe(TRANSCRIPT_TAIL_BYTES);
    expect(CODEX_TRANSCRIPT_TAIL_BYTES).toBe(4 * 1024 * 1024);
  });

  it('reads the newest turn out of a file far larger than the window', async () => {
    // A 273 MB rollout is not hypothetical — that was the largest on this
    // machine on 2026-09-01. Padding here is a comment line, which the parser
    // counts as malformed and drops, exactly as it would a real fragment.
    const padding = `${'#'.repeat(4096)}\n`.repeat(1200); // ≈ 4.9 MiB
    const path = await writeRollout(SESSION, padding + THREE_TURNS);
    expect((await readFile(path)).length).toBeGreaterThan(CODEX_TRANSCRIPT_TAIL_BYTES);

    expect(await captureCodexTranscriptTurn(TARGET, { codexHome })).toBe(true);
    expect(savedOf('assistant')[0].content).toBe(LAST_BODY);
  });
});
