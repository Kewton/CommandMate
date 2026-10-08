/**
 * A Claude Code `Stop` that leaves background work behind says so
 * (Issue #3430 — #2614 for Claude).
 *
 * Measured, not imagined: `tests/fixtures/claude-self-resume-3430/transcript.jsonl`
 * is the transcript of the 2026-10-08 worker that ended its turn at 23:37:53
 * "waiting for the related-tests run to finish" and committed in the turn the
 * notification opened. Each `stop_hook_summary` in it marks a `Stop`; what the
 * hook could read at that moment is every line before it.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import {
  claudeStopLeavesBackgroundWork,
  CLAUDE_TRANSCRIPT_PATH_FIELD,
  pendingClaudeBackgroundTasks,
} from '@/lib/hooks/sources/claude/self-resume';
import { claudeAgentEventSource, extractClaudeEventDetail } from '@/lib/hooks/sources/claude/source';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';

const FIXTURE_LINES = readFileSync(
  join(process.cwd(), 'tests/fixtures/claude-self-resume-3430/transcript.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line !== '');

/** Claude's captured `Stop` payload (2.1.223), `background_tasks: []`. */
const STOP_PAYLOAD = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/hooks/claude/stop.json'), 'utf8')
) as Record<string, unknown>;

/** 0-based indices of the `stop_hook_summary` records, in order. */
const STOP_LINES = FIXTURE_LINES.flatMap((line, i) =>
  (JSON.parse(line) as { subtype?: string }).subtype === 'stop_hook_summary' ? [i] : []
);

/** The transcript as the hook of the `n`-th stop (0-based) could read it. */
const atStop = (n: number): string => FIXTURE_LINES.slice(0, STOP_LINES[n]).join('\n') + '\n';

const FIRST_STOP_PENDING = ['beszxbdym', 'byg1hzzgl', 'b0rshf75w', 'binvvq8o9', 'b8f85vqi1', 'be0fb96mf'];

const line = (record: Record<string, unknown>): string => JSON.stringify(record);
const bgBash = (id: string) => line({ type: 'user', toolUseResult: { backgroundTaskId: id } });
const notice = (id: string) =>
  line({
    type: 'user',
    message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>` },
  });

describe('pendingClaudeBackgroundTasks — the 2026-10-08 transcript', () => {
  it('has the seven stops the run made', () => {
    expect(STOP_LINES).toHaveLength(7);
  });

  it('counts the six unnotified tasks at the first stop, the one wait read as the end', () => {
    // The Bash moved to the background plus five Monitors; `b5svpm92a` was
    // notified inside the turn (an absorbed `queued_command`) and is not pending.
    expect(pendingClaudeBackgroundTasks(atStop(0))).toEqual(FIRST_STOP_PENDING);
  });

  it('retires one task per notification, down to none at the last stop', () => {
    expect(STOP_LINES.map((_, n) => pendingClaudeBackgroundTasks(atStop(n)).length)).toEqual([
      6, 5, 4, 3, 2, 1, 0,
    ]);
  });

  it('retires the task an expired Monitor reports, which names no tool-use id', () => {
    // byg1hzzgl's notice is `Monitor expired …` with a <task-id> and nothing else.
    expect(pendingClaudeBackgroundTasks(atStop(4))).not.toContain('byg1hzzgl');
    expect(pendingClaudeBackgroundTasks(atStop(3))).toContain('byg1hzzgl');
  });

  it('counts nothing before any work was sent to the background', () => {
    const firstBackground = FIXTURE_LINES.findIndex((l) => l.includes('"backgroundTaskId"'));
    expect(firstBackground).toBeGreaterThan(0);
    expect(pendingClaudeBackgroundTasks(FIXTURE_LINES.slice(0, firstBackground).join('\n'))).toEqual([]);
  });
});

describe('pendingClaudeBackgroundTasks — the shapes around it', () => {
  it('keeps a task pending while its notice is only enqueued', () => {
    // The session will open a turn on it: still work that resumes the agent.
    const enqueued = line({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification>\n<task-id>b1</task-id>',
    });
    expect(pendingClaudeBackgroundTasks([bgBash('b1'), enqueued].join('\n'))).toEqual(['b1']);
  });

  it('retires a task stopped with TaskStop, which is never notified', () => {
    const stopped = line({ type: 'user', toolUseResult: { task_id: 'b1', task_type: 'local_bash' } });
    expect(pendingClaudeBackgroundTasks([bgBash('b1'), stopped].join('\n'))).toEqual([]);
  });

  it('counts a non-persistent Monitor and a background subagent, not a persistent Monitor', () => {
    const text = [
      line({ type: 'user', toolUseResult: { taskId: 'm1', timeoutMs: 600000, persistent: false } }),
      line({ type: 'user', toolUseResult: { taskId: 'm2', persistent: true } }),
      line({ type: 'user', toolUseResult: { agentId: 'a1', isAsync: true, status: 'async_launched' } }),
      line({ type: 'user', toolUseResult: { agentId: 'a2', status: 'completed' } }),
    ].join('\n');
    expect(pendingClaudeBackgroundTasks(text)).toEqual(['m1', 'a1']);
  });

  it('retires on a notice delivered as a text block or a queued_command attachment', () => {
    const textBlock = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>b1</task-id>' }] },
    });
    const attachment = line({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>b2</task-id>' },
    });
    expect(pendingClaudeBackgroundTasks([bgBash('b1'), bgBash('b2'), textBlock, attachment].join('\n'))).toEqual(
      []
    );
  });

  it('does not take a mention of the tag for a notice', () => {
    const quoted = line({ type: 'user', message: { role: 'user', content: 'see <task-notification><task-id>b1</task-id>' } });
    expect(pendingClaudeBackgroundTasks([bgBash('b1'), quoted].join('\n'))).toEqual(['b1']);
  });

  it('ignores what a subagent wrote and lines that do not parse', () => {
    const sidechain = line({ type: 'user', isSidechain: true, toolUseResult: { backgroundTaskId: 'b9' } });
    expect(pendingClaudeBackgroundTasks([sidechain, '{"type":"user",', 'not json'].join('\n'))).toEqual([]);
  });
});

describe('the Claude source on a Stop (Issue #3430)', () => {
  let home: string;
  let transcriptDir: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cmate-claude-self-resume-3430-'));
    transcriptDir = join(home, '.claude', 'projects', claudeProjectSlug('/work/commandmate-issue-3423'));
    mkdirSync(transcriptDir, { recursive: true });
  });

  afterAll(() => removeTempDir(home));

  afterEach(() => vi.unstubAllEnvs());

  /** Write `text` as a transcript under the sandbox home and answer its path. */
  function transcript(name: string, text: string): string {
    const path = join(transcriptDir, `${name}.jsonl`);
    writeFileSync(path, text);
    return path;
  }

  const stopWith = (transcriptPath: unknown): Record<string, unknown> => ({
    ...STOP_PAYLOAD,
    [CLAUDE_TRANSCRIPT_PATH_FIELD]: transcriptPath,
  });

  /** `normalizeEvent` reads the real home directory; HOME is what `os.homedir()` returns. */
  function normalizedDetail(payload: Record<string, unknown>): string | null | undefined {
    vi.stubEnv('HOME', home);
    return claudeAgentEventSource.normalizeEvent({ payload })?.detail;
  }

  it('declares that its stop can say so', () => {
    expect(claudeAgentEventSource.capabilities.stopReportsSelfResume).toBe(true);
  });

  it('(a) marks the stop at which background work is still unnotified', () => {
    const path = transcript('first-stop', atStop(0));
    expect(normalizedDetail(stopWith(path))).toBe(SELF_RESUME_PENDING_DETAIL);
    expect(claudeStopLeavesBackgroundWork(stopWith(path), { homeDir: home })).toBe(true);
  });

  it('(b) does not mark the stop after every notification has arrived', () => {
    const path = transcript('last-stop', atStop(STOP_LINES.length - 1));
    expect(normalizedDetail(stopWith(path))).toBeNull();
  });

  it('(c) does not mark an ordinary stop with no background work', () => {
    const firstBackground = FIXTURE_LINES.findIndex((l) => l.includes('"backgroundTaskId"'));
    const path = transcript('ordinary', FIXTURE_LINES.slice(0, firstBackground).join('\n') + '\n');
    expect(normalizedDetail(stopWith(path))).toBeNull();
  });

  it('(d) does not mark a stop whose transcript cannot be read', () => {
    // The captured payload itself: `<TRANSCRIPT_PATH>` is not under ~/.claude/projects.
    expect(normalizedDetail(STOP_PAYLOAD)).toBeNull();
    // No field, a non-string, a file that is not there.
    expect(normalizedDetail(stopWith(undefined))).toBeNull();
    expect(normalizedDetail(stopWith(42))).toBeNull();
    expect(normalizedDetail(stopWith(join(transcriptDir, 'missing.jsonl')))).toBeNull();
    // Outside the projects root, even with pending work in it — and climbing out with `..`.
    const outside = join(home, 'elsewhere.jsonl');
    writeFileSync(outside, atStop(0));
    expect(normalizedDetail(stopWith(outside))).toBeNull();
    expect(normalizedDetail(stopWith(join(transcriptDir, '..', '..', '..', 'elsewhere.jsonl')))).toBeNull();
    // Not a transcript by name.
    const notJsonl = join(transcriptDir, 'first-stop.txt');
    writeFileSync(notJsonl, atStop(0));
    expect(normalizedDetail(stopWith(notJsonl))).toBeNull();
  });

  it('reads only the tail, dropping the line the window opens in', () => {
    const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } });
    const path = transcript('tail', [bgBash('old'), filler].join('\n') + '\n');
    // Read whole, `old` is pending.
    expect(claudeStopLeavesBackgroundWork(stopWith(path), { homeDir: home })).toBe(true);
    // A window that opens 5 bytes into `old`'s line drops that line: a start older
    // than the window is not seen — the "finished" direction.
    const tailBytes = Buffer.byteLength(filler + '\n') + 5;
    expect(claudeStopLeavesBackgroundWork(stopWith(path), { homeDir: home, tailBytes })).toBe(false);
    // A start inside the window is still seen.
    const recent = transcript('tail-recent', [filler, bgBash('new'), ''].join('\n'));
    expect(
      claudeStopLeavesBackgroundWork(stopWith(recent), { homeDir: home, tailBytes: Buffer.byteLength(bgBash('new')) + 10 })
    ).toBe(true);
    // And its notice retires it.
    const notified = transcript('tail-notified', [filler, bgBash('new'), notice('new'), ''].join('\n'));
    expect(claudeStopLeavesBackgroundWork(stopWith(notified), { homeDir: home })).toBe(false);
  });

  it('leaves every other event to the shared reading', () => {
    vi.stubEnv('HOME', home);
    const path = transcript('other-events', atStop(0));
    expect(extractClaudeEventDetail('pre_tool_use', { tool_name: 'Bash', transcript_path: path })).toBe('Bash');
    expect(extractClaudeEventDetail('user_prompt_submit', { transcript_path: path })).toBeNull();
    expect(extractClaudeEventDetail('session_end', { reason: 'clear', transcript_path: path })).toBe('clear');
  });
});
