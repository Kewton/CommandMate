/**
 * Finding and writing one Claude turn (Issue #2121).
 *
 * The half of the writer that touches the world: which file belongs to this
 * instance, what happens when it is missing or unreadable, and what the poller
 * is told afterwards. The rendering is pinned in
 * `./claude-transcript-2121.test.ts` and the database round trip in
 * `tests/integration/claude-history-2121.test.ts`.
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
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
});
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) => rows.get(`${worktreeId}::${requestId}`) ?? null
);
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));

import {
  acceptClaudeTranscriptHint,
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  CLAUDE_TRANSCRIPT_TAIL_BYTES,
  resetClaudeTranscriptSessions,
  resolveClaudeSessionId,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import { claudeTurnRequestId } from '@/types/agent-transcript';

const WORKTREE_ID = 'wt-2121';
const WORKTREE_PATH = '/repos/commandmate-issue-2121';
const SESSION = '0572eeb1-f7f8-4b39-8be5-e71ef93958ef';
const PROMPT = 'ユーザーのプロンプト。これが assistant 行に混入してはならない。';
const REPLY = 'The transcript reader is wired into the poller.';

const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

let home: string;

function transcript(promptUuid = 'u-1', reply: string = REPLY): string {
  return [
    JSON.stringify({
      type: 'user',
      uuid: promptUuid,
      sessionId: SESSION,
      cwd: WORKTREE_PATH,
      isSidechain: false,
      timestamp: '2026-08-31T10:00:00.000Z',
      message: { role: 'user', content: PROMPT },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      requestId: 'req_011CeaxJfj4kTpNVS8UshdHT',
      sessionId: SESSION,
      cwd: WORKTREE_PATH,
      isSidechain: false,
      timestamp: '2026-08-31T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
    }),
    '',
  ].join('\n');
}

/** Put a transcript where `claudeTranscriptPath` will look for it. */
async function writeTranscript(
  sessionId: string,
  body: string,
  worktreePath: string = WORKTREE_PATH
): Promise<string> {
  const path = claudeTranscriptPath(home, worktreePath, sessionId);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(worktreePath)), {
    recursive: true,
  });
  await writeFile(path, body, 'utf8');
  return path;
}

function savedBodies(): string[] {
  return createMessage.mock.calls.map(([, message]) => String(message.content));
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  resetClaudeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2121-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the happy path', () => {
  it('writes the transcript body and tells the poller to stand down', async () => {
    await writeTranscript(SESSION, transcript());

    const captured = await captureClaudeTranscriptTurn(TARGET, {
      worktreePath: WORKTREE_PATH,
      homeDir: home,
    });

    expect(captured).toBe(true);
    expect(savedBodies()).toEqual([REPLY]);
  });

  it('marks the row as the agent’s own Markdown', async () => {
    await writeTranscript(SESSION, transcript());
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    const [, message] = createMessage.mock.calls[0];
    expect(message.requestId).toBe(claudeTurnRequestId('u-1'));
    expect(message.role).toBe('assistant');
    expect(message.cliToolId).toBe('claude');
    expect(message.instanceId).toBe('claude');
  });

  it('dates the row by the prompt record’s clock, not by the read', async () => {
    await writeTranscript(SESSION, transcript());
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    const [, message] = createMessage.mock.calls[0];
    expect((message.timestamp as Date).toISOString()).toBe('2026-08-31T10:00:00.000Z');
  });

  it('broadcasts the row so an open browser sees it without a reload', async () => {
    await writeTranscript(SESSION, transcript());
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    expect(broadcastMessage).toHaveBeenCalledWith('message', expect.objectContaining({
      worktreeId: WORKTREE_ID,
    }));
  });

  it('never writes the operator’s prompt — the #2121 regression', async () => {
    await writeTranscript(SESSION, transcript());
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    expect(savedBodies()[0]).not.toContain(PROMPT);
  });
});

describe('writing the same turn twice', () => {
  it('writes one row however many times the poller asks', async () => {
    await writeTranscript(SESSION, transcript());

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(true);
    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(true);

    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('still answers true on the repeat, so the scrape stays suppressed', async () => {
    // The direction that matters: a second poll of a finished turn must not be
    // told "nobody has this", or the pane's copy lands on top of the row this
    // path already wrote.
    await writeTranscript(SESSION, transcript());
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    createMessage.mockClear();
    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(true);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('falling back to the scraper', () => {
  it('when no hook has ever named a session', async () => {
    getLastAgentEvent.mockReturnValue(null);
    await writeTranscript(SESSION, transcript());

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('when the transcript file does not exist', async () => {
    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('when the agent has written the prompt but no reply yet', async () => {
    await writeTranscript(
      SESSION,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        sessionId: SESSION,
        isSidechain: false,
        timestamp: '2026-08-31T10:00:00.000Z',
        message: { role: 'user', content: PROMPT },
      })}\n`
    );

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('when the file holds nothing this reader recognises', async () => {
    await writeTranscript(SESSION, 'not json at all\nnor this\n');

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
  });

  it('when the worktree path is missing, as it is in a half-built target', async () => {
    expect(
      await captureClaudeTranscriptTurn(TARGET, {
        worktreePath: undefined as unknown as string,
        homeDir: home,
      })
    ).toBe(false);
  });

  it('when the database write throws, rather than taking the poller down with it', async () => {
    await writeTranscript(SESSION, transcript());
    createMessage.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
  });

  it('when the agent’s cwd is not the worktree root', async () => {
    // The slug is a function of `cwd`, so an agent the operator moved writes to
    // a directory this reader does not derive. Nothing is mis-read; the turn is
    // simply the scraper's.
    await writeTranscript(SESSION, transcript(), `${WORKTREE_PATH}/src`);

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(false);
  });
});

describe('the session pointer', () => {
  it('follows the newest event, which is what makes /clear correct', async () => {
    // `/clear` ends the agent session and opens a new one with a different id
    // while the pane, the worktree and the instance are untouched (#1721 D7
    // §1.1). The conversation really did change, so the pointer moving is the
    // right answer rather than a problem to work around.
    const cleared = 'ffffffff-0000-4000-8000-000000000000';
    await writeTranscript(SESSION, transcript('u-before', 'before the clear'));
    await writeTranscript(cleared, transcript('u-after', 'after the clear'));

    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
    getLastAgentEvent.mockReturnValue({ sessionId: cleared });
    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });

    expect(savedBodies()).toEqual(['before the clear', 'after the clear']);
  });

  it('is latched, so an event carrying no session id does not blank it', async () => {
    getLastAgentEvent.mockReturnValueOnce({ sessionId: SESSION });
    expect(await resolveClaudeSessionId(TARGET)).toBe(SESSION);

    getLastAgentEvent.mockReturnValue({ sessionId: null });
    expect(await resolveClaudeSessionId(TARGET)).toBe(SESSION);
  });

  it('is per instance, so two Claudes in one worktree do not swap replies', async () => {
    // Both instances share the project directory — the slug is a function of
    // `cwd` and they have the same one — so the session id is the only thing
    // keeping them apart. The hook URL carries `instanceId`, which is why there
    // is one to keep them apart with.
    const second = '11111111-2222-4333-8444-555555555555';
    await writeTranscript(SESSION, transcript('u-primary', 'primary instance reply'));
    await writeTranscript(second, transcript('u-secondary', 'secondary instance reply'));

    getLastAgentEvent.mockImplementation((_wt, _tool, instanceId) =>
      instanceId === 'claude-2' ? { sessionId: second } : { sessionId: SESSION }
    );

    await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
    await captureClaudeTranscriptTurn(
      { ...TARGET, instanceId: 'claude-2' },
      { worktreePath: WORKTREE_PATH, homeDir: home }
    );

    expect(savedBodies()).toEqual(['primary instance reply', 'secondary instance reply']);
    expect(createMessage.mock.calls.map(([, m]) => m.instanceId)).toEqual(['claude', 'claude-2']);
  });

  it('survives a state module that cannot be reached', async () => {
    getLastAgentEvent.mockImplementation(() => {
      throw new Error('module graph not ready');
    });
    expect(await resolveClaudeSessionId(TARGET)).toBeNull();
  });
});

describe('the pane’s own claim about where the transcript is', () => {
  it('is used when the session pointer names no file that exists', async () => {
    getLastAgentEvent.mockReturnValue({ sessionId: null });
    const path = await writeTranscript(SESSION, transcript());

    expect(
      await captureClaudeTranscriptTurn(TARGET, {
        worktreePath: WORKTREE_PATH,
        transcriptPathHint: path,
        homeDir: home,
      })
    ).toBe(true);
    expect(savedBodies()).toEqual([REPLY]);
  });

  it('is refused when it points outside ~/.claude/projects', async () => {
    // The line is text the agent printed, so it is text an agent could print.
    const outside = join(home, 'escape.jsonl');
    await writeFile(outside, transcript(), 'utf8');
    expect(acceptClaudeTranscriptHint(home, outside)).toBeNull();
  });

  it('is refused when it climbs out with ..', () => {
    expect(
      acceptClaudeTranscriptHint(home, join(home, '.claude', 'projects', '..', '..', 'etc.jsonl'))
    ).toBeNull();
  });

  it('is refused when it is not a .jsonl', () => {
    expect(
      acceptClaudeTranscriptHint(home, join(home, '.claude', 'projects', 'x', 'passwd'))
    ).toBeNull();
  });

  it('is accepted when it really is a transcript under the projects root', () => {
    const path = join(home, '.claude', 'projects', 'slug', `${SESSION}.jsonl`);
    expect(acceptClaudeTranscriptHint(home, path)).toBe(path);
  });
});

describe('reading a transcript larger than the window', () => {
  it('reads the tail and drops the line the window cut in half', async () => {
    // A session that has been running for hours. Only the newest turn is ever
    // written, so only the newest turn has to be inside the window — and the
    // line the window starts inside of has to go, because half a JSON object is
    // not a record.
    const filler = JSON.stringify({
      type: 'assistant',
      uuid: 'a-old',
      sessionId: SESSION,
      isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(CLAUDE_TRANSCRIPT_TAIL_BYTES) }] },
    });
    await writeTranscript(SESSION, `${filler}\n${transcript()}`);

    expect(await captureClaudeTranscriptTurn(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home })).toBe(true);
    expect(savedBodies()).toEqual([REPLY]);
    expect(savedBodies()[0]).not.toContain('xxxx');
  });
});
