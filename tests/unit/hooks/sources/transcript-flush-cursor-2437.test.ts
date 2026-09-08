/**
 * A transcript write moves the pre-send flush's cursor (Issue #2437).
 *
 * ## What was wrong
 *
 * `savePendingAssistantResponse` — the flush that runs immediately before a
 * `/send` — saves **everything in the pane past `session_states.
 * last_captured_line`** as the pending assistant reply. The Stop path that
 * writes the agent's own Markdown into History never touched that cursor:
 * `updateSessionState` appeared **zero times** across `hooks/sources` and
 * `stop-history-capture.ts`. Only the poller moved it, on its 2-second tick.
 *
 * So this ordering, which costs nothing to hit:
 *
 * ```text
 * 1. turn ends → the Stop path writes the turn as a Markdown row   (cursor unmoved)
 * 2. `/send` arrives BEFORE the next poll tick
 * 3. the flush saves "everything since the cursor" = the whole finished turn
 * ```
 *
 * The duplicate is the pane's scrape of the same words, so the chat surface
 * shows one reply twice. #2437's other half — the cleaner — cannot touch this:
 * what is duplicated is the real body, not chrome.
 *
 * ## What this file pins
 *
 * That **all four** pull readers park the cursor, and only when History really
 * holds the turn. A fix that lands on one of four structurally identical
 * readers is a fix that will be re-reported against the other three — the same
 * argument `./pull-reader-backfill-2246.test.ts` and
 * `./turn-timestamp-2273.test.ts` are written on, and their fixtures and
 * harness are what this file reuses.
 *
 * The cursor arithmetic itself — the trim, the never-backwards rule, the
 * alternate-screen refusal, and the `/send` that then saves nothing — lives in
 * `tests/unit/lib/assistant-response-saver.test.ts`, against a real database.
 * Here the advance is mocked, because what is under test is the *wiring*.
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
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
});
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: vi.fn(),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => [],
  setMessageRequestId: () => true,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

/** The seam under test. */
const advanceCapturedLineForTranscriptTurn = vi.fn(async () => 0);
vi.mock('@/lib/assistant-response-saver', () => ({
  advanceCapturedLineForTranscriptTurn: (...a: unknown[]) =>
    advanceCapturedLineForTranscriptTurn(...(a as [])),
}));

import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import {
  captureCodexTranscriptTurn,
  codexSessionsRoot,
  resetCodexTranscriptSessions,
} from '@/lib/hooks/sources/codex/history';
import {
  antigravityTranscriptPath,
  captureAntigravityTranscriptTurn,
  resetAntigravityTranscriptConversations,
} from '@/lib/hooks/sources/antigravity/history';
import {
  captureCommandCodeTranscriptTurn,
  commandCodeProjectsRoot,
  resetCommandCodeTranscriptSessions,
} from '@/lib/hooks/sources/command-code/history';

const WORKTREE_ID = 'wt-2437';

const CLAUDE_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/claude-transcript-2246/three-turns.jsonl'),
  'utf8'
);
const CODEX_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/codex/rollout-three-turns-01510.jsonl'),
  'utf8'
);
const AGY_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/antigravity/transcript-three-turns-1118.jsonl'),
  'utf8'
);
// 1.49.0's captured session rather than `three-turns-1401.jsonl`: the latter
// ends on a bare prompt, i.e. on a turn Command Code has not closed, and the
// reader answers false for that by design (#2264). This one ends on the
// agent's prose, which is the shape a Stop hook actually fires on.
const COMMAND_CODE_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/transcripts/command-code/hook-session-1490.jsonl'),
  'utf8'
);

const CLAUDE_WORKTREE_PATH = '/Users/operator/repos/commandmate-issue-2196';
const CLAUDE_SESSION = '5f3a1c00-2246-4a00-9000-0000000000aa';
const CODEX_SESSION = '01a05a82-d71b-7bc3-8901-487b0db19d40';
const AGY_CONVERSATION = '1ce50bef-fc2a-4039-8114-5aae518678e6';
const COMMAND_CODE_SESSION = 'ce63472c-d5ed-4af6-85a2-c93ae35a81f6';

let home: string;

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  advanceCapturedLineForTranscriptTurn.mockResolvedValue(0);
  resetClaudeTranscriptSessions();
  resetCodexTranscriptSessions();
  resetAntigravityTranscriptConversations();
  resetCommandCodeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2437-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** One reader, reduced to what this file needs from it. */
interface Reader {
  /** The tool's id, and the instance the target names. */
  readonly cliToolId: 'claude' | 'codex' | 'antigravity' | 'command-code';
  /** The session id the structured event would carry. */
  readonly sessionId: string;
  /** Put the captured transcript where the reader will find it. */
  readonly writeFixture: () => Promise<void>;
  /**
   * Run the reader. The session pointer is set by the caller, not here, so a
   * test can run the same reader with no pointer at all.
   */
  readonly run: () => Promise<boolean>;
}

const READERS: readonly Reader[] = [
  {
    cliToolId: 'claude',
    sessionId: CLAUDE_SESSION,
    writeFixture: async () => {
      await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(CLAUDE_WORKTREE_PATH)), {
        recursive: true,
      });
      await writeFile(
        claudeTranscriptPath(home, CLAUDE_WORKTREE_PATH, CLAUDE_SESSION),
        CLAUDE_FIXTURE,
        'utf8'
      );
    },
    run: () =>
      captureClaudeTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' },
        { worktreePath: CLAUDE_WORKTREE_PATH, homeDir: home }
      ),
  },
  {
    cliToolId: 'codex',
    sessionId: CODEX_SESSION,
    writeFixture: async () => {
      const dir = join(codexSessionsRoot(home), '2026', '09', '01');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `rollout-2026-09-01T10-08-39-${CODEX_SESSION}.jsonl`),
        CODEX_FIXTURE,
        'utf8'
      );
    },
    run: () =>
      captureCodexTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' },
        { codexHome: home }
      ),
  },
  {
    cliToolId: 'antigravity',
    sessionId: AGY_CONVERSATION,
    writeFixture: async () => {
      const path = antigravityTranscriptPath(home, AGY_CONVERSATION);
      if (!path) throw new Error('not a conversation id');
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, AGY_FIXTURE, 'utf8');
    },
    run: () =>
      captureAntigravityTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity' },
        { antigravityHome: home }
      ),
  },
  {
    cliToolId: 'command-code',
    sessionId: COMMAND_CODE_SESSION,
    writeFixture: async () => {
      // Command Code names the project directory itself, so the reader finds
      // the file by session id rather than by a slug it could compute.
      const dir = join(commandCodeProjectsRoot(home), 'some-unguessable-slug');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${COMMAND_CODE_SESSION}.jsonl`), COMMAND_CODE_FIXTURE, 'utf8');
    },
    run: () =>
      captureCommandCodeTranscriptTurn(
        { worktreeId: WORKTREE_ID, cliToolId: 'command-code', instanceId: 'command-code' },
        { commandCodeHome: home }
      ),
  },
];

describe.each(READERS)('[#2437] $cliToolId', (reader) => {
  const target = {
    worktreeId: WORKTREE_ID,
    cliToolId: reader.cliToolId,
    instanceId: reader.cliToolId,
  };

  /** Run the reader with the structured event reporting a live session. */
  function capture(): Promise<boolean> {
    getLastAgentEvent.mockReturnValue({ sessionId: reader.sessionId });
    return reader.run();
  }

  beforeEach(async () => {
    await reader.writeFixture();
  });

  it('parks the pre-send flush cursor once the turn is History', async () => {
    expect(await capture()).toBe(true);

    expect(advanceCapturedLineForTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(advanceCapturedLineForTranscriptTurn).toHaveBeenCalledWith(target);
  });

  it('parks it again when a second Stop finds the turn already written', async () => {
    // The early `return true`: the poller judged the same finished turn twice
    // — which it does, since a Stop and a poll tick are independent — and the
    // pane rows are still the flush's to pick up. Answering "already saved" and
    // leaving the cursor behind is the exact ordering the Issue was opened for.
    expect(await capture()).toBe(true);
    expect(createMessage).toHaveBeenCalled();
    advanceCapturedLineForTranscriptTurn.mockClear();
    createMessage.mockClear();

    expect(await capture()).toBe(true);

    // Nothing new was written — this really is the already-saved branch.
    expect(createMessage).not.toHaveBeenCalled();
    expect(advanceCapturedLineForTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(advanceCapturedLineForTranscriptTurn).toHaveBeenCalledWith(target);
  });

  it('leaves the cursor alone when History does not hold the turn', async () => {
    // The fail-open. A pane started without hooks has no session pointer, so
    // the reader writes nothing and the scrape is the only record there will
    // be — moving the cursor here would delete the reply rather than
    // de-duplicate it.
    getLastAgentEvent.mockReturnValue(null);

    expect(await reader.run()).toBe(false);

    expect(createMessage).not.toHaveBeenCalled();
    expect(advanceCapturedLineForTranscriptTurn).not.toHaveBeenCalled();
  });
});
