/**
 * Reading Claude's transcript while it is still being written (Issue #2199).
 *
 * `captureClaudeTranscriptTurn` (#2121) reads the same file, but only ever at
 * one moment: the turn has ended and the row is about to be written. This reader
 * runs on the poller's *generating* tick, so every property below is about the
 * one thing that changes — the writer is mid-append.
 *
 *  1. **A fragment at the tail must not cost the read.** Claude appends a line at
 *     a time and this reader opens the file whenever it likes, so the last line
 *     of a window is routinely half a JSON object. `parseClaudeTranscript` counts
 *     it; nothing here may throw, and the complete records before it must still
 *     produce a body.
 *  2. **Nothing is written.** The write path is idempotent on a `requestId`
 *     derived from the prompt record's `uuid`, so writing a growing turn would
 *     freeze the row at whatever the first tick saw. The assertion is on the
 *     database mocks: zero calls, always.
 *  3. **The key is the one the settled row will carry.** That string is the whole
 *     swap mechanism — `ChatSurface` replaces the live body with the row by
 *     comparing it — so a key that merely *looks* stable is not enough.
 *  4. **A turn whose prompt fell outside the window is shown, and marked.** The
 *     transcript is read through a 4 MiB tail; a bigger turn has no prompt record
 *     in the window and `buildClaudeTurns` produces no turn at all for it. Issue
 *     #2199's trap is precisely that showing nothing, or showing the tail without
 *     saying so, are both wrong.
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

const createMessage = vi.fn();
const findMessageByRequestId = vi.fn(() => null);
vi.mock('@/lib/db', () => ({
  createMessage: (...a: unknown[]) => createMessage(...a),
  findMessageByRequestId: (...a: unknown[]) => findMessageByRequestId(...(a as [])),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));

import {
  claudeTranscriptPath,
  readClaudeTurnProgress,
  resetClaudeTranscriptSessions,
} from '@/lib/hooks/sources/claude/history';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';
import { claudeTurnRequestId } from '@/types/agent-transcript';

const WORKTREE_ID = 'wt-2199';
const WORKTREE_PATH = '/repos/commandmate-issue-2199';
const SESSION = '3f5b0d1c-9a2e-4c7b-8e11-6d4a0f9b2c33';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' } as const;

let home: string;

function userRecord(uuid: string, text = 'テストのプロンプト'): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId: SESSION,
    cwd: WORKTREE_PATH,
    isSidechain: false,
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'user', content: text },
  });
}

function assistantRecord(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: SESSION,
    cwd: WORKTREE_PATH,
    isSidechain: false,
    timestamp: '2026-09-01T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

async function writeTranscript(body: string): Promise<void> {
  await mkdir(join(home, '.claude', 'projects', claudeProjectSlug(WORKTREE_PATH)), {
    recursive: true,
  });
  await writeFile(claudeTranscriptPath(home, WORKTREE_PATH, SESSION), body, 'utf8');
}

function read() {
  return readClaudeTurnProgress(TARGET, { worktreePath: WORKTREE_PATH, homeDir: home });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetClaudeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2199-'));
  getLastAgentEvent.mockReturnValue({ sessionId: SESSION });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('[#2199] the open turn', () => {
  it('returns the assistant text written so far', async () => {
    await writeTranscript(
      [userRecord('u-1'), assistantRecord('a-1', 'First paragraph.'), ''].join('\n'),
    );

    const progress = await read();

    expect(progress?.body).toBe('First paragraph.');
    expect(progress?.partial).toBe(false);
  });

  it('grows as the file grows', async () => {
    await writeTranscript(
      [userRecord('u-1'), assistantRecord('a-1', 'First paragraph.'), ''].join('\n'),
    );
    const first = await read();

    await writeTranscript(
      [
        userRecord('u-1'),
        assistantRecord('a-1', 'First paragraph.'),
        assistantRecord('a-2', 'Second paragraph.'),
        '',
      ].join('\n'),
    );
    const second = await read();

    expect(first?.body).toBe('First paragraph.');
    expect(second?.body).toBe('First paragraph.\n\nSecond paragraph.');
    expect(second?.turnKey).toBe(first?.turnKey);
  });

  it('keys the body on the id the settled row will carry', async () => {
    await writeTranscript([userRecord('u-1'), assistantRecord('a-1', 'Hello.'), ''].join('\n'));

    const progress = await read();

    expect(progress?.turnKey).toBe(claudeTurnRequestId('u-1'));
  });

  it('follows the newest turn when the window holds several', async () => {
    await writeTranscript(
      [
        userRecord('u-1'),
        assistantRecord('a-1', 'Answer to the first prompt.'),
        userRecord('u-2'),
        assistantRecord('a-2', 'Answer to the second, still being written'),
        '',
      ].join('\n'),
    );

    const progress = await read();

    expect(progress?.turnKey).toBe(claudeTurnRequestId('u-2'));
    expect(progress?.body).toBe('Answer to the second, still being written');
  });

  it('never keeps the operator’s own prompt out of the body', async () => {
    // The one invariant #2121 asserts about this file, re-asserted on the read
    // path: the prompt travels on a `user` record and must not reach the reply.
    await writeTranscript(
      [userRecord('u-1', '秘密のプロンプト'), assistantRecord('a-1', 'The reply.'), ''].join('\n'),
    );

    const progress = await read();

    expect(progress?.body).not.toContain('秘密のプロンプト');
  });
});

describe('[#2199] mid-append', () => {
  it('reads through a truncated final line without throwing', async () => {
    const fragment = '{"type":"assistant","uuid":"a-2","message":{"role":"assist';
    await writeTranscript(
      [userRecord('u-1'), assistantRecord('a-1', 'Complete record.'), fragment].join('\n'),
    );

    const progress = await read();

    expect(progress?.body).toBe('Complete record.');
  });

  it('answers null while the turn has a prompt and no reply yet', async () => {
    // The bubble must not open on an empty body — a blank card that says nothing
    // is worse than the "Responding…" line it would be covering.
    await writeTranscript([userRecord('u-1'), ''].join('\n'));

    expect(await read()).toBeNull();
  });

  it('answers null when the file is not there', async () => {
    getLastAgentEvent.mockReturnValue({ sessionId: 'no-such-session' });
    expect(await read()).toBeNull();
  });

  it('answers null when no session pointer names a transcript', async () => {
    getLastAgentEvent.mockReturnValue(null);
    expect(await read()).toBeNull();
  });
});

describe('[#2199] writes nothing, ever', () => {
  it('leaves chat_messages and the broadcast untouched', async () => {
    await writeTranscript([userRecord('u-1'), assistantRecord('a-1', 'Hello.'), ''].join('\n'));

    await read();
    await read();

    expect(createMessage).not.toHaveBeenCalled();
    expect(findMessageByRequestId).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });
});

describe('[#2199] a turn bigger than the tail window', () => {
  it('publishes the readable tail and marks it partial', async () => {
    // What the window looks like when the prompt record has scrolled out of it:
    // assistant records and no `user` record at all.
    await writeTranscript(
      [assistantRecord('a-9', 'The middle of a very long reply.'), ''].join('\n'),
    );

    const progress = await read();

    expect(progress?.body).toBe('The middle of a very long reply.');
    expect(progress?.partial).toBe(true);
  });

  it('keys it so it can never collide with a prompt-derived key', async () => {
    await writeTranscript([assistantRecord('a-9', 'Headless.'), ''].join('\n'));

    const progress = await read();

    expect(progress?.turnKey).toBe(claudeTurnRequestId(`partial:${SESSION}`));
    expect(progress?.turnKey).not.toBe(claudeTurnRequestId(SESSION));
  });

  it('does NOT mark a complete newest turn partial just because the window opened mid-turn', async () => {
    // The trap this asserts against: `orphanedAssistantRecords > 0` is the normal
    // state of a 4 MiB window over a long session, and reporting it as "shown
    // from the middle" would leave the notice permanently on screen.
    await writeTranscript(
      [
        assistantRecord('a-0', 'Tail of the previous turn.'),
        userRecord('u-1'),
        assistantRecord('a-1', 'The current reply.'),
        '',
      ].join('\n'),
    );

    const progress = await read();

    expect(progress?.partial).toBe(false);
    expect(progress?.body).toBe('The current reply.');
  });
});
