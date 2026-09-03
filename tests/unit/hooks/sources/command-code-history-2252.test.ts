/**
 * Finding and writing one Command Code turn (Issue #2252, Epic #2249 Phase C).
 *
 * The half of the reader that touches the world: which transcript belongs to
 * this instance, what happens when it is missing, unreadable or points somewhere
 * it must not, and what the poller is told afterwards. The rendering is pinned
 * in `./command-code-transcript-2252.test.ts` against the same live capture this
 * file copies onto disk.
 *
 * The return value is the whole contract, so it is what nearly every assertion
 * here reads. **True** means History holds the turn as Markdown and the poller
 * must drop its scrape; **false** means it does not, for any reason at all, and
 * the scrape is the only record there will be. Every failure path is asserted to
 * answer false, because that is the fail-open the acceptance criteria require and
 * a "safe default" nobody tested is not one.
 *
 * ## The one thing that is Command Code's own
 *
 * The project directory name is `slugify(cwd)` and is **not** computed here —
 * Epic #2249 決定 4. So `locateCommandCodeTranscript` finds the file by session
 * id, and the directory it lives in is deliberately given a name no rule could
 * have produced (`some-unguessable-slug`) so that a future "optimisation" that
 * derived the path would fail every test below.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
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
 * Named so `beforeEach` can put it back: `vi.clearAllMocks()` clears recorded
 * calls and leaves implementations in place, so a test that makes this throw
 * would otherwise make every later test in the file throw too.
 */
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
const findUnkeyedUserMessages = vi.fn(() => [] as Array<Record<string, unknown>>);
const setMessageRequestId = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
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
  acceptCommandCodeTranscriptHint,
  captureCommandCodeTranscriptTurn,
  commandCodeProjectsRoot,
  findCommandCodeTranscriptPath,
  resetCommandCodeTranscriptSessions,
  resolveCommandCodeSessionId,
  resolveCommandCodeTranscriptPath,
  COMMAND_CODE_TRANSCRIPT_TAIL_BYTES,
  COMMAND_CODE_TURN_RECHECK_LIMIT,
} from '@/lib/hooks/sources/command-code/history';
import { TRANSCRIPT_TAIL_BYTES } from '@/lib/history/transcript-tail';
import {
  commandCodePromptRequestId,
  commandCodeTurnRequestId,
  isAgentAuthoredMarkdown,
} from '@/types/agent-transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/command-code');
const THREE_TURNS = readFileSync(join(FIXTURES, 'three-turns-1401.jsonl'), 'utf8');
const OPEN_TURN = readFileSync(join(FIXTURES, 'open-turn-1401.jsonl'), 'utf8');
const TURN_A_BODY = readFileSync(join(FIXTURES, 'three-turns-1401.turn-a.md'), 'utf8').replace(
  /\n$/,
  ''
);
const TURN_B_BODY = readFileSync(join(FIXTURES, 'three-turns-1401.turn-b.md'), 'utf8').replace(
  /\n$/,
  ''
);

const WORKTREE_ID = 'wt-2252';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** A second uuid, standing for a second instance in the same worktree. */
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
/**
 * The directory Command Code would have used.
 *
 * Deliberately not `slugify` of anything: the reader must find this by session
 * id, and a rule that computed a slug would answer a path that does not exist.
 */
const SLUG = 'some-unguessable-slug';
const OTHER_SLUG = 'private-tmp-my-code-branch-desk-probe';

const TURN_A = 'cb06ab09';
const TURN_B = 'c1c8338e';
const TURN_C = 'e37e1055';

const TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'command-code',
  instanceId: 'command-code',
} as const;

let commandCodeHome: string;

/** Put a transcript where Command Code would have put it. */
async function writeTranscript(
  slug: string,
  sessionId: string,
  body: string
): Promise<string> {
  const dir = join(commandCodeProjectsRoot(commandCodeHome), slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, body, 'utf8');
  return path;
}

function savedRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls.map(([, message]) => message);
}

function savedOf(role: string): Array<Record<string, unknown>> {
  return savedRows().filter((row) => row.role === role);
}

/** Put a row in the table without going through the writer. */
function pretendSaved(requestId: string, content = 'already there'): void {
  rows.set(`${WORKTREE_ID}::${requestId}`, {
    id: `pre-${requestId}`,
    worktreeId: WORKTREE_ID,
    requestId,
    role: 'assistant',
    content,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetCommandCodeTranscriptSessions();
  commandCodeHome = await mkdtemp(join(tmpdir(), 'cmate-2252-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
  findUnkeyedUserMessages.mockReturnValue([]);
});

afterEach(async () => {
  await rm(commandCodeHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('[#2252] the session pointer', () => {
  it('reads the id off the structured event and latches it', async () => {
    expect(await resolveCommandCodeSessionId(TARGET)).toBe(SESSION);
    // An event that carries no id must not blank the pointer: Command Code sends
    // `session_id` on all four of its events today, and a later one that did not
    // would otherwise take the reader offline mid-session.
    getLastAgentEvent.mockReturnValue({ sessionId: null });
    expect(await resolveCommandCodeSessionId(TARGET)).toBe(SESSION);
  });

  it('is null when nothing has ever reported a session', async () => {
    getLastAgentEvent.mockReturnValue(null);
    expect(await resolveCommandCodeSessionId(TARGET)).toBeNull();
  });

  it('asks about this instance rather than about the tool', async () => {
    await resolveCommandCodeSessionId({
      worktreeId: WORKTREE_ID,
      cliToolId: 'command-code',
      instanceId: 'command-code-2',
    });
    expect(getLastAgentEvent).toHaveBeenCalledWith(WORKTREE_ID, 'command-code', 'command-code-2');
  });
});

describe('[#2252] finding the file without computing the slug', () => {
  it('finds a session under a directory name no rule could have derived', async () => {
    const path = await writeTranscript(SLUG, SESSION, THREE_TURNS);
    expect(await findCommandCodeTranscriptPath(commandCodeHome, SESSION)).toBe(path);
  });

  it('is null for a session with no file, and for a home with no projects at all', async () => {
    await writeTranscript(SLUG, SESSION, THREE_TURNS);
    expect(await findCommandCodeTranscriptPath(commandCodeHome, OTHER_SESSION)).toBeNull();
    expect(await findCommandCodeTranscriptPath(join(commandCodeHome, 'nope'), SESSION)).toBeNull();
  });

  it('refuses a session id that is not a uuid, because it reaches a file name', async () => {
    for (const id of ['../../etc/passwd', 'not-a-uuid', '', '*']) {
      expect(await findCommandCodeTranscriptPath(commandCodeHome, id), id).toBeNull();
    }
  });

  it('keeps two instances in one worktree on separate transcripts', async () => {
    // Both instances share a `cwd` and therefore a project directory, so the
    // session pointer is the only thing that tells them apart.
    getLastAgentEvent.mockImplementation((...args: unknown[]) =>
      args[2] === 'command-code-2' ? { sessionId: OTHER_SESSION } : { sessionId: SESSION }
    );
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));
    await writeTranscript(
      SLUG,
      OTHER_SESSION,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: OTHER_SESSION,
          timestamp: '2026-09-03T08:00:00.000Z',
          cwd: '/w',
        }),
        JSON.stringify({
          type: 'message',
          id: 'aa11bb22',
          parentId: null,
          timestamp: '2026-09-03T08:00:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'ping' }],
            meta: { source: 'user', createdAt: 1788423601000 },
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'cc33dd44',
          parentId: 'aa11bb22',
          timestamp: '2026-09-03T08:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'PONG-FROM-SECOND-INSTANCE' }],
            meta: { source: 'model', createdAt: 1788423602000 },
          },
        }),
      ].join('\n')
    );

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(
      await captureCommandCodeTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'command-code', instanceId: 'command-code-2' },
        { commandCodeHome }
      )
    ).toBe(true);

    const bodies = savedOf('assistant').map((row) => row.content);
    expect(bodies).toContain(TURN_B_BODY);
    expect(bodies).toContain('PONG-FROM-SECOND-INSTANCE');
  });
});

describe('[#2252] the transcript hint is bounded to ~/.commandcode/projects', () => {
  it('accepts a path inside the projects root', () => {
    const inside = join(commandCodeProjectsRoot(commandCodeHome), SLUG, `${SESSION}.jsonl`);
    expect(acceptCommandCodeTranscriptHint(commandCodeHome, inside)).toBe(inside);
  });

  it('refuses anything outside it, whatever shape the escape takes', () => {
    const root = commandCodeProjectsRoot(commandCodeHome);
    const cases = [
      '/etc/passwd',
      '/etc/passwd.jsonl',
      join(commandCodeHome, '.commandcode', 'auth.json'),
      // `..` out of the root, which is why containment is tested on the resolved
      // path rather than on the string.
      join(root, '..', '..', 'evil.jsonl'),
      // A NUL truncates the path at the syscall boundary on some platforms.
      `${join(root, SLUG, `${SESSION}.jsonl`)} /etc/passwd`,
      // A sibling directory whose name merely starts with the root's.
      `${root}-elsewhere/x.jsonl`,
    ];
    for (const hint of cases) {
      expect(acceptCommandCodeTranscriptHint(commandCodeHome, hint), hint).toBeNull();
    }
  });

  it('does not open a claude transcript handed to it by the shared capture field', async () => {
    // `transcriptPathHint` is shared with `../claude/history`; each reader
    // validates against its OWN root, so neither can be pointed at the other's
    // file. Here the hint is a real, readable file — and still refused.
    const claudeLike = join(commandCodeHome, '.claude', 'projects', 'slug');
    await mkdir(claudeLike, { recursive: true });
    const path = join(claudeLike, `${SESSION}.jsonl`);
    await writeFile(path, THREE_TURNS, 'utf8');

    getLastAgentEvent.mockReturnValue(null);
    expect(
      await captureCommandCodeTranscriptTurn(TARGET, {
        commandCodeHome,
        transcriptPathHint: path,
      })
    ).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('reads a hint inside the root even with no session pointer at all', async () => {
    // The path the hook payload's `transcript_path` will take once a receiver
    // plumbs it: a pointer-less instance is still readable when something names
    // the file.
    const path = await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));
    getLastAgentEvent.mockReturnValue(null);

    expect(
      await captureCommandCodeTranscriptTurn(TARGET, {
        commandCodeHome,
        transcriptPathHint: path,
      })
    ).toBe(true);
    expect(savedOf('assistant').map((row) => row.content)).toEqual([TURN_B_BODY]);
  });
});

describe('[#2252] fail-open: everything that goes wrong answers false', () => {
  it('answers false with no session pointer and no hint', async () => {
    await writeTranscript(SLUG, SESSION, THREE_TURNS);
    getLastAgentEvent.mockReturnValue(null);

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('answers false when the pointer names a file that is not there', async () => {
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('answers false when the file holds no turn at all', async () => {
    await writeTranscript(SLUG, SESSION, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: SESSION,
      timestamp: '2026-09-03T07:00:00.000Z',
      cwd: '/w',
    })}\n`);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('answers false when the newest turn has a prompt and no reply yet', async () => {
    // The captured three-turn file ends exactly here: a prompt whose assistant
    // records were never flushed. An empty row would be a blank reply forever.
    await writeTranscript(SLUG, SESSION, THREE_TURNS);
    pretendSaved(commandCodeTurnRequestId(TURN_B));

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(savedOf('assistant')).toEqual([]);
  });

  it('answers false rather than throwing when the reader itself fails', async () => {
    await writeTranscript(SLUG, SESSION, THREE_TURNS);
    createMessage.mockImplementation(() => {
      throw new Error('table is gone');
    });
    await expect(
      captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })
    ).resolves.toBe(false);
  });

  it('locates without reading, for the Stop receiver’s retry decision (#2246)', async () => {
    expect(await resolveCommandCodeTranscriptPath(TARGET, { commandCodeHome })).toBeNull();
    const path = await writeTranscript(SLUG, SESSION, THREE_TURNS);
    expect(await resolveCommandCodeTranscriptPath(TARGET, { commandCodeHome })).toBe(path);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('[#2252] writing the turn', () => {
  it('writes the newest closed turn as the agent’s own Markdown', async () => {
    // The newest turn in this window is `TURN_C`, which is still open — so the
    // reader is asked about a window whose newest turn is `TURN_B`.
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);

    const assistant = savedOf('assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(TURN_B_BODY);
    expect(assistant[0].requestId).toBe(commandCodeTurnRequestId(TURN_B));
    expect(assistant[0].cliToolId).toBe('command-code');
    expect(assistant[0].instanceId).toBe('command-code');
    expect(broadcastMessage).toHaveBeenCalledWith('message', expect.anything());
  });

  it('marks the row as Markdown and the prompt row as not', () => {
    // The turn row renders as Markdown; the operator's own text never does —
    // a prompt containing `# ` or a table row must not change shape.
    expect(isAgentAuthoredMarkdown(commandCodeTurnRequestId(TURN_B))).toBe(true);
    expect(isAgentAuthoredMarkdown(commandCodePromptRequestId(TURN_B))).toBe(false);
  });

  it('writes the prompt as a user row, dated before the reply', async () => {
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));
    await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome });

    const [user] = savedOf('user');
    const [assistant] = savedOf('assistant');
    expect(user.requestId).toBe(commandCodePromptRequestId(TURN_B));
    expect(user.content).toContain("Run the shell command 'echo alpha'");
    // `meta.createdAt` of the prompt record, not the entry timestamp.
    expect((user.timestamp as Date).getTime()).toBe(1788419735534);
    expect((assistant.timestamp as Date).getTime()).toBeGreaterThan(
      (user.timestamp as Date).getTime()
    );
  });

  it('skips the user row for a prompt the agent loop appended', async () => {
    await writeTranscript(
      SLUG,
      SESSION,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: SESSION,
          timestamp: '2026-09-03T07:00:00.000Z',
          cwd: '/w',
        }),
        JSON.stringify({
          type: 'message',
          id: '11111111',
          parentId: null,
          timestamp: '2026-09-03T07:00:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'keep going' }],
            meta: { source: 'steering', createdAt: 1788419625705 },
          },
        }),
        JSON.stringify({
          type: 'message',
          id: '22222222',
          parentId: '11111111',
          timestamp: '2026-09-03T07:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'still going' }],
            meta: { source: 'model', createdAt: 1788419625805 },
          },
        }),
      ].join('\n')
    );

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(savedOf('user')).toEqual([]);
    expect(savedOf('assistant').map((row) => row.content)).toEqual(['still going']);
  });

  it('does not add a row when the same transcript is read twice', async () => {
    // `request_id` idempotency. The turn key comes off the prompt record's `id`,
    // which does not change between reads of the same file.
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);

    expect(savedOf('assistant')).toHaveLength(1);
    expect(savedOf('user')).toHaveLength(1);
  });

  it('backfills every turn the anchor does not cover, oldest first (#2246)', async () => {
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));
    // Nothing is anchored, so the first read takes the newest turn only…
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(savedOf('assistant').map((row) => row.requestId)).toEqual([
      commandCodeTurnRequestId(TURN_B),
    ]);

    // …and with the OLDEST turn anchored instead, the newer one is pending.
    rows.clear();
    createMessage.mockClear();
    pretendSaved(commandCodeTurnRequestId(TURN_A), TURN_A_BODY);

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(savedOf('assistant').map((row) => row.requestId)).toEqual([
      commandCodeTurnRequestId(TURN_B),
    ]);
  });

  it('reads only the tail of a very long transcript', async () => {
    expect(COMMAND_CODE_TRANSCRIPT_TAIL_BYTES).toBe(TRANSCRIPT_TAIL_BYTES);

    // A window that opens mid-turn must not write that turn from its middle —
    // there is no prompt record in front of it to key a row on.
    const filler = `${JSON.stringify({
      type: 'message',
      id: 'ffffffff',
      parentId: null,
      timestamp: '2026-09-03T06:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(4096) }],
        meta: { source: 'model', createdAt: 1788410000000 },
      },
    })}\n`;
    const padding = filler.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 1);
    await writeTranscript(SLUG, SESSION, padding + cutAfterTurnB(THREE_TURNS));

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    const assistant = savedOf('assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(TURN_B_BODY);
    // Nothing from outside the window leaked into the body.
    expect(String(assistant[0].content)).not.toContain('xxxx');
  });
});

describe('[#2252] #2264 — a turn that is not closed is handed back', () => {
  it('refuses the open turn even though its body is not empty', async () => {
    await writeTranscript(SLUG, SESSION, OPEN_TURN);

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(savedOf('assistant')).toEqual([]);
    // The user row is still written: the prompt really was typed, and the turn
    // it opened is what the scraper is about to record.
    expect(savedOf('user').map((row) => row.requestId)).toEqual([
      commandCodePromptRequestId(TURN_B),
    ]);
  });

  it('refuses a turn whose last record answered AND reached for a tool', async () => {
    // The shape the `tool_use` half of the closing rule exists for, and the one
    // the open fixture cannot show: prose and a call on the SAME record. The
    // body is not merely non-empty, it is a paragraph — so a rule that read only
    // "did it say something" would freeze a half-written reply under the key.
    await writeTranscript(
      SLUG,
      SESSION,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: SESSION,
          timestamp: '2026-09-03T07:00:00.000Z',
          cwd: '/w',
        }),
        JSON.stringify({
          type: 'message',
          id: '11111111',
          parentId: null,
          timestamp: '2026-09-03T07:00:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'run both commands' }],
            meta: { source: 'user', createdAt: 1788419625705 },
          },
        }),
        JSON.stringify({
          type: 'message',
          id: '22222222',
          parentId: '11111111',
          timestamp: '2026-09-03T07:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: "I'll run them in order as requested." },
              {
                type: 'tool_use',
                id: 'call_00_x',
                name: 'shell_command',
                input: { command: 'echo alpha' },
              },
            ],
            meta: { source: 'model', createdAt: 1788419630880 },
          },
        }),
      ].join('\n')
    );

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(savedOf('assistant')).toEqual([]);
  });

  it('writes it once a later prompt has superseded it', async () => {
    await writeTranscript(
      SLUG,
      SESSION,
      `${OPEN_TURN.trimEnd()}\n${JSON.stringify({
        type: 'message',
        id: '99999999',
        parentId: 'ee4e93b1',
        timestamp: '2026-09-03T07:16:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'never mind' }],
          meta: { source: 'user', createdAt: 1788419760000 },
        },
      })}\n`
    );
    pretendSaved(commandCodeTurnRequestId(TURN_A), TURN_A_BODY);

    // The newest turn (`99999999`) has no reply, so the answer is false — but
    // the interrupted turn before it is written, which is the whole point of
    // `superseded`.
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(false);
    expect(savedOf('assistant').map((row) => row.requestId)).toEqual([
      commandCodeTurnRequestId(TURN_B),
    ]);
  });

  it('grows a row that was saved short, and only ever longer (#2264)', async () => {
    // The repair half. A row keyed on the turn is written once and every later
    // read answers "already saved", so without this the short body is permanent.
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));
    pretendSaved(commandCodeTurnRequestId(TURN_B), 'a short body');

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(updateMessageContent).toHaveBeenCalledWith(
      {},
      `pre-${commandCodeTurnRequestId(TURN_B)}`,
      TURN_B_BODY
    );
    expect(broadcastMessage).toHaveBeenCalledWith('message_updated', expect.anything());
  });

  it('never replaces a row with a shorter or equal body', async () => {
    await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));

    pretendSaved(commandCodeTurnRequestId(TURN_B), TURN_B_BODY);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(updateMessageContent).not.toHaveBeenCalled();

    rows.clear();
    pretendSaved(commandCodeTurnRequestId(TURN_B), `${TURN_B_BODY}\n\nand more from elsewhere`);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('does not repair a row for a turn that is still open', async () => {
    // A repair that raced the agent would rewrite the row on every poll.
    await writeTranscript(SLUG, SESSION, OPEN_TURN);
    pretendSaved(commandCodeTurnRequestId(TURN_B), 'short');

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('bounds how far back the repair looks', () => {
    // Three, so the poller's two-second tick does not re-render the whole window.
    expect(COMMAND_CODE_TURN_RECHECK_LIMIT).toBe(3);
  });
});

describe('[#2252] a file being appended to while it is read', () => {
  it('writes the turn anyway when the tail line is a fragment', async () => {
    const truncated = `${cutAfterTurnB(THREE_TURNS).trimEnd()}\n{"type":"message","id":"deadbee`;
    await writeTranscript(SLUG, SESSION, truncated);

    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
    expect(savedOf('assistant').map((row) => row.content)).toEqual([TURN_B_BODY]);
  });

  it('does not care which project directory the file turned up in', async () => {
    // Two directories, one of them the shape a slug rule would have produced and
    // holding nothing; the reader still finds the session.
    await mkdir(join(commandCodeProjectsRoot(commandCodeHome), OTHER_SLUG), { recursive: true });
    const path = await writeTranscript(SLUG, SESSION, cutAfterTurnB(THREE_TURNS));

    expect(await resolveCommandCodeTranscriptPath(TARGET, { commandCodeHome })).toBe(path);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome })).toBe(true);
  });
});

/**
 * The captured file with its trailing, reply-less prompt removed.
 *
 * The live capture ends on a turn Command Code never flushed a reply for (see
 * the fixture README, measurement 6). Most assertions here are about the turn
 * *before* it, so they read a window whose newest turn is `TURN_B`.
 */
function cutAfterTurnB(text: string): string {
  const lines = text.trimEnd().split('\n');
  const index = lines.findIndex((line) => line.includes(TURN_C));
  if (index < 0) throw new Error('fixture no longer ends on the open turn');
  return `${lines.slice(0, index).join('\n')}\n`;
}
