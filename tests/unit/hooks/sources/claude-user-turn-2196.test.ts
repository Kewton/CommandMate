/**
 * Reading the operator's own prompt out of Claude's transcript (Issue #2196).
 *
 * Two questions, and the first one decides the second.
 *
 * **Which `type: "user"` record is a person?** `tests/fixtures/claude-transcript-2196`
 * holds one real example of each shape a live transcript actually contains —
 * nine that are not the operator and two that are — so the classification below
 * is asserted against Claude's own field names rather than against a record
 * invented from the Issue text. The census that produced the rule is in that
 * directory's README; the short version is that of 4,943 candidate records in
 * 744 transcripts, 4,909 carried `origin` or `promptSource` and the 34 that did
 * not were `/compact` and interruption markers, never a prompt.
 *
 * **Does the pair come out in the right order?** A user row and an assistant row
 * are written for one turn, and `groupMessagesIntoPairs` orders by `timestamp`
 * and nothing else — so "user first" has to be a property of the data, not of
 * the order the rows were inserted in. The last describe block asserts the thing
 * the Issue is actually for: the reply stops being an `orphan`.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (value: Database.Database | null) => {
      mockDb = value;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { groupMessagesIntoPairs, isOrphanPair } from '@/lib/conversation-grouper';
import {
  captureClaudeTranscriptTurn,
  claudeTranscriptPath,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import {
  claudeProjectSlug,
  isClaudeOperatorPromptRecord,
  isClaudePromptRecord,
  parseClaudeTranscript,
  type ClaudeTranscriptRecord,
} from '@/lib/hooks/sources/claude/transcript';
import {
  claudePromptRequestId,
  claudeTurnRequestId,
  isAgentAuthoredMarkdown,
} from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2196');
const WORKTREE_ID = 'wt-2196';

let operatorTurnText: string;
let operatorTurnRecords: readonly ClaudeTranscriptRecord[];
let operatorRecords: readonly ClaudeTranscriptRecord[];
let nonOperatorRecords: readonly ClaudeTranscriptRecord[];

/** The prompt record of the fixture turn — the one the operator typed. */
let prompt: ClaudeTranscriptRecord;
/** The worktree path and session id the fixture was captured under. */
let worktreePath: string;
let sessionId: string;

let db: Database.Database;
let home: string;

async function fixture(name: string): Promise<readonly ClaudeTranscriptRecord[]> {
  const text = await readFile(join(FIXTURE_DIR, name), 'utf8');
  const parsed = parseClaudeTranscript(text);
  expect(parsed.malformedLines).toBe(0);
  return parsed.records;
}

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

async function writeTranscript(body: string): Promise<string> {
  const path = claudeTranscriptPath(home, worktreePath, sessionId);
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(worktreePath)), {
    recursive: true,
  });
  await writeFile(path, body, 'utf8');
  return path;
}

function capture(): Promise<boolean> {
  return captureClaudeTranscriptTurn(
    { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' },
    { worktreePath, homeDir: home }
  );
}

/** Every row for the worktree, oldest first — the order History reads them in. */
function saved() {
  return getMessages(db, WORKTREE_ID, { limit: 200 })
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

beforeAll(async () => {
  operatorTurnText = await readFile(join(FIXTURE_DIR, 'operator-turn.jsonl'), 'utf8');
  operatorTurnRecords = await fixture('operator-turn.jsonl');
  operatorRecords = await fixture('operator-user-records.jsonl');
  nonOperatorRecords = await fixture('non-operator-user-records.jsonl');

  const first = operatorTurnRecords[0];
  prompt = first;
  worktreePath = first.cwd as string;
  sessionId = first.sessionId as string;
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  getLastAgentEvent.mockReturnValue({ sessionId });
  home = await mkdtemp(join(tmpdir(), 'cmate-2196-'));

  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2196',
    path: worktreePath,
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  resetClaudeTranscriptSessions();
  await setMockDb(null);
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('the fixtures are the real records', () => {
  it('holds one complete turn, prompt first and reply last', () => {
    expect(operatorTurnRecords.map((record) => record.type)).toEqual([
      'user',
      'attachment',
      'assistant',
      'user',
      'attachment',
      'assistant',
      'system',
      'file-history-snapshot',
    ]);
  });

  it('carries the markers the classification reads, verbatim from Claude', () => {
    expect(prompt.originKind).toBe('human');
    expect(prompt.promptSource).toBe('typed');
    expect(prompt.uuid).toBeTruthy();
    expect(prompt.timestampMs).toBeGreaterThan(0);
  });

  it('covers both ways a person’s prompt reaches the agent', () => {
    expect(operatorRecords.map((record) => record.promptSource)).toEqual(['typed', 'queued']);
    expect(operatorRecords.every((record) => record.originKind === 'human')).toBe(true);
  });

  it('covers the nine shapes that are not a person', () => {
    // Named so a future reader can tell which real shape went missing if the
    // list is ever regenerated.
    expect(nonOperatorRecords).toHaveLength(9);
    expect(nonOperatorRecords.filter((record) => record.isMeta)).toHaveLength(2);
    expect(nonOperatorRecords.filter((record) => record.isCompactSummary)).toHaveLength(1);
    expect(nonOperatorRecords.filter((record) => record.isInterruption)).toHaveLength(1);
    expect(nonOperatorRecords.filter((record) => record.originKind === 'task-notification'))
      .toHaveLength(1);
    expect(nonOperatorRecords.filter((record) => record.promptSource === 'sdk')).toHaveLength(1);
    expect(
      nonOperatorRecords.filter((record) =>
        record.blocks.some((block) => block.type === 'tool_result')
      )
    ).toHaveLength(1);
  });
});

describe('isClaudeOperatorPromptRecord', () => {
  it('accepts every record a person produced', () => {
    for (const record of [prompt, ...operatorRecords]) {
      expect(isClaudeOperatorPromptRecord(record)).toBe(true);
    }
  });

  it('rejects every record that is not, one real shape at a time', () => {
    for (const record of nonOperatorRecords) {
      expect({
        text: record.text.slice(0, 40),
        operator: isClaudeOperatorPromptRecord(record),
      }).toEqual({ text: record.text.slice(0, 40), operator: false });
    }
  });

  it('rejects the skill body a slash command injects, which is the costly one', () => {
    // Thousands of characters of instructions from `.claude/commands/*.md`,
    // arriving as `type: "user"`. Shown as a prompt it would be the largest
    // thing in the operator's own chat pane and none of it theirs.
    const injected = nonOperatorRecords.find(
      (record) => record.isMeta && record.text.startsWith('# ')
    );
    expect(injected).toBeDefined();
    expect(isClaudeOperatorPromptRecord(injected as ClaudeTranscriptRecord)).toBe(false);
  });

  it('is strictly narrower than the turn-keying predicate, and deliberately so', () => {
    // `isClaudePromptRecord` answers "does a turn start here", which a task
    // notification really does. Folding the two predicates together would either
    // stop those turns being saved at all or show the notification as a message.
    const notification = nonOperatorRecords.find(
      (record) => record.originKind === 'task-notification'
    ) as ClaudeTranscriptRecord;

    expect(isClaudePromptRecord(notification)).toBe(true);
    expect(isClaudeOperatorPromptRecord(notification)).toBe(false);
  });

  it('rejects a record that claims no origin at all', () => {
    // Fail-closed: the pre-#2196 behaviour is an orphan pair, which is untidy.
    // Inventing a user message is wrong, so an unattributable record gets none.
    const unmarked: ClaudeTranscriptRecord = {
      ...prompt,
      originKind: null,
      promptSource: null,
    };
    expect(isClaudePromptRecord(unmarked)).toBe(true);
    expect(isClaudeOperatorPromptRecord(unmarked)).toBe(false);
  });

  it('rejects a compaction summary even if a later Claude called it human', () => {
    // Not redundant with the marker rule: compaction is something the operator
    // starts, so `origin.kind: "human"` on the summary would be defensible from
    // Claude's side and wrong from ours.
    expect(
      isClaudeOperatorPromptRecord({ ...prompt, isCompactSummary: true })
    ).toBe(false);
    expect(isClaudeOperatorPromptRecord({ ...prompt, isInterruption: true })).toBe(false);
  });
});

describe('one turn, read off the fixture transcript', () => {
  it('writes the prompt as a user row and the reply as an assistant row', async () => {
    await writeTranscript(operatorTurnText);
    expect(await capture()).toBe(true);

    const rows = saved();
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows[0].content).toBe(prompt.text);
    expect(rows[0].requestId).toBe(claudePromptRequestId(prompt.uuid as string));
    expect(rows[1].requestId).toBe(claudeTurnRequestId(prompt.uuid as string));
  });

  it('dates the user row by the transcript’s own clock', async () => {
    await writeTranscript(operatorTurnText);
    await capture();

    expect(saved()[0].timestamp.getTime()).toBe(prompt.timestampMs);
  });

  it('puts the reply strictly after the prompt', async () => {
    // The ordering the acceptance criteria ask for, and it has to hold in the
    // data: `groupMessagesIntoPairs` sorts on `timestamp` alone, so two rows on
    // the same millisecond are ordered by whichever the database returns first.
    await writeTranscript(operatorTurnText);
    await capture();

    const rows = saved();
    expect(rows[1].timestamp.getTime()).toBeGreaterThan(rows[0].timestamp.getTime());
  });

  it('keeps the user row on the verbatim rendering path', async () => {
    // `ConversationPairCard` is untouched by this Issue. It decides how to draw a
    // row from this predicate alone, and the operator's own text has always been
    // drawn as typed — a prompt containing `# ` must not become a heading.
    await writeTranscript(operatorTurnText);
    await capture();

    const rows = saved();
    expect(isAgentAuthoredMarkdown(rows[0].requestId)).toBe(false);
    expect(isAgentAuthoredMarkdown(rows[1].requestId)).toBe(true);
  });

  it('files both rows against the instance that was prompted', async () => {
    await writeTranscript(operatorTurnText);
    await capture();

    for (const row of saved()) {
      expect(row.cliToolId).toBe('claude');
      expect(row.instanceId).toBe('claude');
    }
  });

  it('writes one pair however many times the poller reads the same turn', async () => {
    await writeTranscript(operatorTurnText);
    expect(await capture()).toBe(true);
    expect(await capture()).toBe(true);
    expect(await capture()).toBe(true);

    expect(saved().map((row) => row.role)).toEqual(['user', 'assistant']);
  });

  it('does not put the prompt in the assistant row — the #2121 guarantee', async () => {
    await writeTranscript(operatorTurnText);
    await capture();

    expect(saved()[1].content).not.toContain(prompt.text);
  });
});

describe('turns whose prompt was not the operator’s', () => {
  /** The fixture turn with its prompt record replaced by `record`. */
  function transcriptPromptedBy(record: ClaudeTranscriptRecord, raw: string): string {
    const lines = operatorTurnText.split('\n').filter((line) => line.trim().length > 0);
    const replacement = JSON.parse(raw) as Record<string, unknown>;
    replacement.uuid = record.uuid;
    replacement.sessionId = sessionId;
    replacement.cwd = worktreePath;
    replacement.timestamp = new Date(prompt.timestampMs as number).toISOString();
    return [JSON.stringify(replacement), ...lines.slice(1)].join('\n') + '\n';
  }

  it('saves the reply and writes no user row for a task notification', async () => {
    const raw = (await readFile(join(FIXTURE_DIR, 'non-operator-user-records.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .find((line) => line.includes('"task-notification"')) as string;
    const record = nonOperatorRecords.find(
      (candidate) => candidate.originKind === 'task-notification'
    ) as ClaudeTranscriptRecord;

    await writeTranscript(transcriptPromptedBy(record, raw));
    expect(await capture()).toBe(true);

    const rows = saved();
    expect(rows.map((row) => row.role)).toEqual(['assistant']);
    // Issue #2273: the turn's LAST assistant record, which is where a reply is
    // dated whether or not the turn produced a user row. Still the transcript's
    // own clock and still strictly after the prompt record it answers.
    expect(rows[0].timestamp.getTime()).toBe(Date.parse('2026-08-22T15:34:57.513Z'));
    expect(rows[0].timestamp.getTime()).toBeGreaterThan(prompt.timestampMs as number);
  });
});

describe('the tail window cutting a turn in half', () => {
  it('reports the orphaned assistant records instead of inventing a prompt', async () => {
    // A turn whose prompt fell outside CLAUDE_TRANSCRIPT_TAIL_BYTES arrives as
    // assistant records with nothing in front of them. The Issue's instruction
    // is that they must not be dropped in silence, and they are not — but no
    // user row can be written for a prompt that is not in the window, and none
    // is invented.
    const lines = operatorTurnText.split('\n').filter((line) => line.trim().length > 0);
    await writeTranscript(lines.slice(2).join('\n') + '\n');

    expect(await capture()).toBe(false);
    expect(saved()).toHaveLength(0);
  });
});

describe('the orphan pair this Issue exists to remove', () => {
  it('groups the turn into one completed pair, not an orphan', async () => {
    await writeTranscript(operatorTurnText);
    await capture();

    const pairs = groupMessagesIntoPairs(saved());
    expect(pairs).toHaveLength(1);
    expect(pairs.filter(isOrphanPair)).toHaveLength(0);
    expect(pairs[0].userMessage?.content).toBe(prompt.text);
    expect(pairs[0].assistantMessages).toHaveLength(1);
    expect(pairs[0].status).toBe('completed');
  });

  it('is an orphan without the user row — the state before this Issue', async () => {
    // The control. Without it the assertion above is compatible with the
    // grouper simply never producing orphans.
    await writeTranscript(operatorTurnText);
    await capture();

    const assistantOnly = saved().filter((row) => row.role === 'assistant');
    const pairs = groupMessagesIntoPairs(assistantOnly);
    expect(pairs.filter(isOrphanPair)).toHaveLength(1);
  });
});
