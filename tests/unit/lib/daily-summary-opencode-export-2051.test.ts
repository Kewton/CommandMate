/**
 * The sanitized opencode export section of the daily report (Issue #2051).
 *
 * The claim under test is not "the JSON is attached" — it is that **nothing
 * unredacted can reach the report**, and that the section says what a sanitized
 * export actually is.
 *
 * That second half matters because of what the measurement found on opencode
 * 1.18.22 (`docs/design/opencode-server-live-verification.md` §23):
 * `--sanitize` removes *every* message text, from the operator and the agent
 * alike, along with every tool input and output. A sanitized export therefore
 * carries no conversation at all; it is a record of the shape of a session. The
 * section is a table of counts for exactly that reason, and pasting the JSON in
 * would add kilobytes of redaction tokens saying nothing.
 *
 * `exportOpencodeSessionSummary` re-audits every export before using it, so a
 * release that stopped redacting a field would drop rows rather than publish
 * them. The tests below drive both sides of that audit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { recordAgentSessionCost } from '@/lib/db/agent-session-cost-db';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

import {
  OPENCODE_EXPORT_MAX_SESSIONS,
  OPENCODE_EXPORT_SECTION_HEADING,
  OPENCODE_EXPORT_TOTAL_BUDGET_MS,
  buildOpencodeExportSection,
  collectOpencodeExportEntries,
  exportOpencodeSessionSummary,
  type OpencodeExportEntry,
} from '@/lib/daily-summary-generator';
import { summarizeOpencodeExport } from '@/types/opencode-export';

const DATE = '2026-08-26';
const SESSION = 'ses_fc36974d1ffeD1cvPY7zlYJnhs';
const FIXTURE = join(
  process.cwd(),
  'tests/fixtures/opencode-share-2051/export-sanitized.json'
);

/** The real `opencode export --sanitize` output captured on 1.18.22. */
function sanitizedJson(): string {
  return readFileSync(FIXTURE, 'utf8');
}

/**
 * Make the mocked `execFile` behave like the real command: callback-style, with
 * the JSON on stdout and the `Exporting session:` progress line on stderr.
 */
function stubExport(result: { stdout?: string; error?: Error }) {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (result.error) callback(result.error, '', 'Error: Session not found');
      else callback(null, result.stdout ?? '', `Exporting session: ${SESSION}\n`);
    }
  );
}

let db: Database.Database;

beforeEach(() => {
  execFileMock.mockReset();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)')
    .run('wt-a', 'feature/2051', '/repos/wt-a', Date.now());
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('exportOpencodeSessionSummary', () => {
  it('summarises the real sanitized export', async () => {
    stubExport({ stdout: sanitizedJson() });

    const summary = await exportOpencodeSessionSummary(SESSION);

    expect(summary).toMatchObject({
      agent: 'build',
      model: 'github-copilot/claude-sonnet-4.6',
      version: '1.18.22',
      tools: ['read'],
      toolCalls: 1,
    });
  });

  it('always passes the session id, because the command hangs without one', async () => {
    // Measured: `opencode export` with no positional does not fail — it opens
    // an interactive picker and waits. This is the assertion that keeps a
    // future refactor from making the report block for ever.
    stubExport({ stdout: sanitizedJson() });

    await exportOpencodeSessionSummary(SESSION);

    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('opencode');
    expect(args).toEqual(['export', '--sanitize', SESSION]);
  });

  it('always passes --sanitize', async () => {
    stubExport({ stdout: sanitizedJson() });
    await exportOpencodeSessionSummary(SESSION);
    expect((execFileMock.mock.calls[0] as [string, string[]])[1]).toContain('--sanitize');
  });

  it('bounds the call with a timeout and a buffer cap', async () => {
    stubExport({ stdout: sanitizedJson() });
    await exportOpencodeSessionSummary(SESSION);

    const options = (execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>])[2];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });

  it('drops an export that still contains readable text', async () => {
    // The audit is the point. This is the shape of a *plain* export — what the
    // report would attach if `--sanitize` silently stopped applying.
    const unsanitized = JSON.stringify({
      info: {
        id: SESSION,
        directory: '/Users/someone/work/private-repo',
        title: 'Refactor the billing module',
        agent: 'build',
      },
      messages: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'the DB password is hunter2' }],
        },
      ],
    });
    stubExport({ stdout: unsanitized });

    await expect(exportOpencodeSessionSummary(SESSION)).resolves.toBeNull();
  });

  it('drops an export whose tool output survived redaction', async () => {
    const partlySanitized = JSON.parse(sanitizedJson()) as {
      messages: { parts: { type: string; state?: { output?: string } }[] }[];
    };
    for (const message of partlySanitized.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool' && part.state) {
          part.state.output = '<content>\n1: AWS_SECRET_ACCESS_KEY=…\n</content>';
        }
      }
    }
    stubExport({ stdout: JSON.stringify(partlySanitized) });

    await expect(exportOpencodeSessionSummary(SESSION)).resolves.toBeNull();
  });

  it('answers null for a session opencode does not have', async () => {
    // Measured: exit 1, empty stdout, `Error: Session not found: <id>` on
    // stderr. A session sampled into the ledger and later deleted lands here.
    stubExport({ error: new Error('Command failed: opencode export') });

    await expect(exportOpencodeSessionSummary(SESSION)).resolves.toBeNull();
  });

  it('answers null rather than throwing when stdout is not JSON', async () => {
    stubExport({ stdout: 'Error: something went wrong' });
    await expect(exportOpencodeSessionSummary(SESSION)).resolves.toBeNull();
  });
});

describe('buildOpencodeExportSection', () => {
  function entry(worktreeId: string): OpencodeExportEntry {
    const summary = summarizeOpencodeExport(JSON.parse(sanitizedJson()));
    if (summary === null) throw new Error('fixture did not summarise');
    return { worktreeId, summary };
  }

  it('answers null when the day exported nothing', () => {
    expect(buildOpencodeExportSection([], new Map())).toBeNull();
  });

  it('renders a row per session under the section heading', () => {
    const section = buildOpencodeExportSection(
      [entry('wt-a')],
      new Map([['wt-a', 'feature/2051']])
    );

    expect(section).toContain(OPENCODE_EXPORT_SECTION_HEADING);
    expect(section).toContain('feature/2051');
    expect(section).toContain(SESSION);
    expect(section).toContain('read');
  });

  it('says what --sanitize removed, so the table is not read as a transcript', () => {
    const section = buildOpencodeExportSection([entry('wt-a')], new Map()) ?? '';

    expect(section).toMatch(/removes every message text/i);
    expect(section).toMatch(/operator and agent alike/i);
  });

  it('carries no redaction tokens into the report', () => {
    // If a `[redacted:…]` string reaches the report, the section is pasting the
    // export rather than summarising it.
    const section = buildOpencodeExportSection([entry('wt-a')], new Map()) ?? '';
    expect(section).not.toContain('[redacted:');
  });

  it('reports what the session cap left out instead of hiding it', () => {
    const section = buildOpencodeExportSection([entry('wt-a')], new Map(), 7) ?? '';
    expect(section).toContain('7 further opencode session');
    expect(section).toContain(String(OPENCODE_EXPORT_MAX_SESSIONS));
  });

  it('says nothing about a cap when nothing was capped', () => {
    const section = buildOpencodeExportSection([entry('wt-a')], new Map(), 0) ?? '';
    expect(section).not.toMatch(/further opencode session/);
  });

  it('falls back to the worktree id when there is no display name', () => {
    const section = buildOpencodeExportSection([entry('wt-unnamed')], new Map()) ?? '';
    expect(section).toContain('wt-unnamed');
  });
});

describe('collectOpencodeExportEntries', () => {
  function ledgerRow(sessionId: string, cliToolId: string) {
    recordAgentSessionCost(db, {
      sessionId,
      worktreeId: 'wt-a',
      cliToolId,
      instanceId: null,
      date: DATE,
      title: null,
      agent: 'build',
      model: 'claude-sonnet-4.6',
      provider: 'github-copilot',
      cost: 0.01,
      tokensInput: 1,
      tokensOutput: 1,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      observedAt: Date.now(),
    });
  }

  it('exports the day\'s opencode sessions and no others', async () => {
    ledgerRow(SESSION, 'opencode');
    ledgerRow('ses_claude_one', 'claude');
    stubExport({ stdout: sanitizedJson() });

    const { entries, skipped } = await collectOpencodeExportEntries(db, DATE);

    expect(entries).toHaveLength(1);
    expect(skipped).toBe(0);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0] as [string, string[]])[1]).toContain(SESSION);
  });

  it('skips a session whose export failed the audit rather than reporting it', async () => {
    ledgerRow(SESSION, 'opencode');
    stubExport({ stdout: JSON.stringify({ info: { id: SESSION, title: 'a real title' } }) });

    const { entries } = await collectOpencodeExportEntries(db, DATE);

    expect(entries).toEqual([]);
  });

  it('caps the number of spawns and reports the remainder', async () => {
    for (let index = 0; index < OPENCODE_EXPORT_MAX_SESSIONS + 3; index += 1) {
      ledgerRow(`ses_probe_${index}`, 'opencode');
    }
    stubExport({ stdout: sanitizedJson() });

    const { entries, skipped } = await collectOpencodeExportEntries(db, DATE);

    expect(entries).toHaveLength(OPENCODE_EXPORT_MAX_SESSIONS);
    expect(skipped).toBe(3);
    expect(execFileMock).toHaveBeenCalledTimes(OPENCODE_EXPORT_MAX_SESSIONS);
  });

  it('stops spawning when the wall-clock budget runs out, and counts the rest', async () => {
    // The bound that keeps an optional section from adding ten minutes to a
    // report that has already produced its text.
    for (let index = 0; index < 5; index += 1) ledgerRow(`ses_slow_${index}`, 'opencode');
    const start = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => start);
    stubExport({ stdout: sanitizedJson() });

    let calls = 0;
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        calls += 1;
        // Each export "takes" the whole budget, so the second iteration is past
        // the deadline.
        vi.spyOn(Date, 'now').mockImplementation(
          () => start + calls * OPENCODE_EXPORT_TOTAL_BUDGET_MS
        );
        callback(null, sanitizedJson(), '');
      }
    );

    const { entries, skipped } = await collectOpencodeExportEntries(db, DATE);

    expect(entries).toHaveLength(1);
    expect(skipped).toBe(4);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('runs nothing on a day with no opencode sessions', async () => {
    ledgerRow('ses_claude_one', 'claude');

    const { entries, skipped } = await collectOpencodeExportEntries(db, DATE);

    expect(entries).toEqual([]);
    expect(skipped).toBe(0);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
