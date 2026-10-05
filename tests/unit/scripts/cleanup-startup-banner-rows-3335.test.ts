/**
 * The one-off cleanup for startup-screen rows (Issue #3335).
 *
 * Seeded into a throwaway database under `os.tmpdir()` — never the server's —
 * with the startup screens of the real tools
 * (`tests/fixtures/startup-screen-3293/`) as each path saved them, next to
 * ordinary replies and other tools' rows. What is asserted is that the
 * candidates are the startup-screen rows and nothing else, that the dry run
 * changes nothing, and that `--apply` deletes exactly the candidates.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@/lib/db/db-migrations';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  hasStartupBanner,
  parseArgs,
  planCleanup,
  run,
} from '../../../scripts/cleanup-startup-banner-rows.mjs';

const FIXTURES = join(process.cwd(), 'tests/fixtures/startup-screen-3293');
const rowsOf = (file: string, from: number, to: number): string =>
  readFileSync(join(FIXTURES, file), 'utf8').split('\n').slice(from, to).join('\n');

/** codex 0.160.0's banner and logo, raw: what path A (the poller) saved. */
const CODEX_BANNER_RAW = rowsOf('codex-0.160.0-boot-idle.txt', 0, 508).replace(/\n{3,}/g, '\n\n');
/** The same, cleaned: what path B (the pre-send flush) saved. */
const CODEX_BANNER_CLEAN = stripAnsi(CODEX_BANNER_RAW);
/** vibe-local 1.3.3's startup screen, raw and cleaned. */
const VIBE_BANNER_RAW = rowsOf('vibe-local-1.3.3-boot-idle.txt', 0, 31);
const VIBE_BANNER_CLEAN = stripAnsi(VIBE_BANNER_RAW);
/** A finished codex turn whose banner is still on the pane: banner, echo, reply. */
const CODEX_BANNER_WITH_TURN = rowsOf('codex-0.160.0-first-turn-reply.txt', 0, 14);
/** The reply rows of that turn, raw. */
const CODEX_REPLY_RAW = rowsOf('codex-0.160.0-first-turn-reply.txt', 10, 14);

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

let dir: string;
let dbPath: string;

type Seed = { id: string; role: 'user' | 'assistant'; tool: string; content: string; at: number; instance?: string };

const SEEDS: readonly Seed[] = [
  // --- startup screens (the candidates) ---
  { id: 'codex-a', role: 'assistant', tool: 'codex', content: CODEX_BANNER_RAW, at: BASE },
  { id: 'codex-b', role: 'assistant', tool: 'codex', content: CODEX_BANNER_CLEAN, at: BASE + 60_000 - 1 },
  { id: 'codex-b-user', role: 'user', tool: 'codex', content: 'first message', at: BASE + 60_000 },
  { id: 'vibe-a', role: 'assistant', tool: 'vibe-local', content: VIBE_BANNER_RAW, at: BASE + 120_000 },
  { id: 'vibe-b', role: 'assistant', tool: 'vibe-local', content: VIBE_BANNER_CLEAN, at: BASE + 180_000 - 1 },
  { id: 'vibe-b-user', role: 'user', tool: 'vibe-local', content: 'hello', at: BASE + 180_000 },
  // a second instance: its next user row is its own, not the primary's
  { id: 'codex2-b', role: 'assistant', tool: 'codex', content: CODEX_BANNER_CLEAN, at: BASE + 240_000 - 1, instance: 'codex-2' },
  { id: 'codex2-b-user', role: 'user', tool: 'codex', content: 'second instance', at: BASE + 240_000, instance: 'codex-2' },

  // --- ordinary replies (never candidates) ---
  { id: 'codex-reply-a', role: 'assistant', tool: 'codex', content: CODEX_REPLY_RAW, at: BASE + 300_000 },
  { id: 'codex-reply-b', role: 'assistant', tool: 'codex', content: stripAnsi(CODEX_REPLY_RAW), at: BASE + 360_000 - 1 },
  { id: 'codex-reply-b-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 360_000 },
  {
    id: 'codex-reply-quoting-banner',
    role: 'assistant',
    tool: 'codex',
    content: ['The banner was saved as a reply.', '', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'It read:', '>_ OpenAI Codex (v0.160.0)'].join('\n'),
    at: BASE + 420_000,
  },
  { id: 'vibe-reply', role: 'assistant', tool: 'vibe-local', content: 'assistant: OK-3293', at: BASE + 480_000 },

  // --- banner text, but left for a person (never deleted) ---
  { id: 'codex-glued-turn', role: 'assistant', tool: 'codex', content: CODEX_BANNER_WITH_TURN, at: BASE + 540_000 },
  { id: 'codex-no-path', role: 'assistant', tool: 'codex', content: CODEX_BANNER_CLEAN, at: BASE + 600_000 },
  { id: 'codex-no-path-user', role: 'user', tool: 'codex', content: 'five seconds later', at: BASE + 605_000 },

  // --- other tools (never candidates, whatever they hold) ---
  { id: 'claude-quoting-codex', role: 'assistant', tool: 'claude', content: `\x1b[1m${CODEX_BANNER_CLEAN}\x1b[0m`, at: BASE + 660_000 },
  { id: 'gemini-reply', role: 'assistant', tool: 'gemini', content: 'Gemini reply', at: BASE + 720_000 },
];

const STARTUP_SCREEN_IDS = ['codex-a', 'codex-b', 'vibe-a', 'vibe-b', 'codex2-b'];

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt', 'wt', '/p', '/r', 'R')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, message_type, cli_tool_id, instance_id)
     VALUES (?, 'wt', ?, ?, ?, 'normal', ?, ?)`
  );
  for (const row of SEEDS) insert.run(row.id, row.role, row.content, row.at, row.tool, row.instance ?? row.tool);
}

function ids(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT id FROM chat_messages ORDER BY id').all() as { id: string }[]).map(row => row.id);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-3335-'));
  dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  runMigrations(db);
  seed(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('[#3335] cleanup-startup-banner-rows', () => {
  it('the fixture premise: the seeded startup screens carry the banner, the raw ones their escapes', () => {
    expect(CODEX_BANNER_RAW).toContain('\x1b[');
    expect(VIBE_BANNER_RAW).toContain('\x1b[');
    expect(CODEX_BANNER_CLEAN).not.toContain('\x1b[');
    expect(stripAnsi(CODEX_BANNER_WITH_TURN)).toContain('› Reply with exactly');
    for (const [content, tool] of [
      [CODEX_BANNER_RAW, 'codex'],
      [CODEX_BANNER_CLEAN, 'codex'],
      [VIBE_BANNER_RAW, 'vibe-local'],
      [VIBE_BANNER_CLEAN, 'vibe-local'],
    ] as const) {
      expect(hasStartupBanner({ id: 'x', worktree_id: 'wt', role: 'assistant', cli_tool_id: tool, instance_id: tool, content, timestamp: 0 })).toBe(true);
    }
  });

  it('the candidates are the startup-screen rows and only those', () => {
    const plan = run(['--db', dbPath], () => {});

    expect(plan.candidates.map(candidate => candidate.id).sort()).toEqual([...STARTUP_SCREEN_IDS].sort());
    expect(Object.fromEntries(plan.candidates.map(candidate => [candidate.id, candidate.path]))).toEqual({
      'codex-a': 'A',
      'codex-b': 'B',
      'vibe-a': 'A',
      'vibe-b': 'B',
      'codex2-b': 'B',
    });
  });

  it('rows with the banner text that match neither path, or hold an echo, are left and listed', () => {
    const plan = run(['--db', dbPath], () => {});

    expect(plan.left).toEqual([
      { id: 'codex-glued-turn', reason: 'holds-echo' },
      { id: 'codex-no-path', reason: 'no-path-match' },
    ]);
  });

  it('the dry run (the default) changes nothing, and prints the count and the ids', () => {
    const before = ids();
    const lines: string[] = [];

    run(['--db', dbPath], line => lines.push(line));

    expect(ids()).toEqual(before);
    const output = lines.join('\n');
    expect(output).toContain('dry-run');
    expect(output).toContain(`candidates (startup screen rows): ${STARTUP_SCREEN_IDS.length}`);
    for (const id of STARTUP_SCREEN_IDS) expect(output).toContain(id);
    // Only the count and the ids: no row content is printed.
    expect(output).not.toContain('OpenAI Codex');
  });

  it('--apply deletes exactly the candidates', () => {
    const before = ids();

    run(['--db', dbPath, '--apply'], () => {});

    expect(ids()).toEqual(before.filter(id => !STARTUP_SCREEN_IDS.includes(id)));
  });

  it('a second --apply finds nothing', () => {
    run(['--db', dbPath, '--apply'], () => {});

    expect(run(['--db', dbPath], () => {}).candidates).toEqual([]);
  });

  it('the path B rule asks for the next user row of the same instance, exactly 1 ms later', () => {
    const banner = { worktree_id: 'wt', role: 'assistant' as const, cli_tool_id: 'codex', instance_id: 'codex', content: CODEX_BANNER_CLEAN };
    const user = (id: string, timestamp: number, instance = 'codex') => ({
      id, worktree_id: 'wt', role: 'user' as const, cli_tool_id: 'codex', instance_id: instance, content: 'm', timestamp,
    });

    expect(planCleanup([{ ...banner, id: 'b', timestamp: 100 }, user('u', 101)]).candidates).toEqual([{ id: 'b', path: 'B' }]);
    expect(planCleanup([{ ...banner, id: 'b', timestamp: 100 }, user('u', 102)]).candidates).toEqual([]);
    // Another instance's row 1 ms later does not count.
    expect(planCleanup([{ ...banner, id: 'b', timestamp: 100 }, user('u', 101, 'codex-2')]).candidates).toEqual([]);
    // The NEXT user row decides: one 1 ms later behind an earlier one does not.
    expect(planCleanup([{ ...banner, id: 'b', timestamp: 100 }, user('u0', 100.5), user('u', 101)]).candidates).toEqual([]);
  });

  it('there is no default database: --db is required', () => {
    expect(() => parseArgs([])).toThrow(/--db/);
    expect(() => parseArgs(['--apply'])).toThrow(/--db/);
    expect(parseArgs(['--db', '/x.db'])).toEqual({ dbPath: '/x.db', apply: false });
    expect(parseArgs(['--db', '/x.db', '--apply'])).toEqual({ dbPath: '/x.db', apply: true });
    expect(() => parseArgs(['--db', '/x.db', '--force'])).toThrow(/unknown argument/);
  });
});
