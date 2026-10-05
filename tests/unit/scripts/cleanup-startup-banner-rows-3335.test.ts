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
import { extractResponse } from '@/lib/polling/response-checker';
import { cleanScrollbackResponse } from '@/lib/response-cleaner';
import {
  hasBannerText,
  isStartupScreenOnly,
  parseArgs,
  planCleanup,
  run,
} from '../../../scripts/cleanup-startup-banner-rows.mjs';

const FIXTURES = join(process.cwd(), 'tests/fixtures/startup-screen-3293');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

const CODEX_BOOT = read('codex-0.160.0-boot-idle.txt');
const CODEX_TURN_REPLY = read('codex-0.160.0-first-turn-reply.txt');
const VIBE_BOOT = read('vibe-local-1.3.3-boot-idle.txt');

/**
 * What path A (the poller) saved for a pane read from cursor 0: the real
 * `extractResponse`. The window is the capture's own length, so the capture
 * counts as clipped and #3293's startup-screen defense — which is what stopped
 * these rows — does not answer; the rows go through the same skip patterns they
 * went through before it. The poller does not clean codex or vibe-local further.
 */
const pathA = (capture: string, tool: 'codex' | 'vibe-local'): string =>
  extractResponse(capture, 0, tool, capture.split('\n').length)!.response;

/** What path B (the pre-send flush) saved: the real cleaner, without the pane #3293 gave it. */
const pathB = (capture: string, tool: 'codex' | 'vibe-local'): string => cleanScrollbackResponse(capture, tool);

const CODEX_A = pathA(CODEX_BOOT, 'codex');
const CODEX_B = pathB(CODEX_BOOT, 'codex');
const VIBE_A = pathA(VIBE_BOOT, 'vibe-local');
const VIBE_B = pathB(VIBE_BOOT, 'vibe-local');
/** A finished turn flushed from cursor 0: banner, echo and reply in one row. */
const CODEX_GLUED_TURN = pathB(CODEX_TURN_REPLY, 'codex');
/** The shape of the 52 rows from the codex 0.118 days: shell rows, banner, echo and the first reply. */
const CODEX_0118_GLUED = [
  '% codex',
  '>_ OpenAI Codex (v0.118.0)',
  'model: gpt-5 · directory: ~/repo',
  '› hello',
  '• Hello! How can I help?',
].join('\n');

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

let dir: string;
let dbPath: string;

type Seed = {
  id: string;
  role: 'user' | 'assistant';
  tool: string;
  content: string;
  at: number;
  instance?: string;
  requestId?: string;
};

const SEEDS: readonly Seed[] = [
  // --- startup screens, as each path saved them (the candidates) ---
  { id: 'codex-a', role: 'assistant', tool: 'codex', content: CODEX_A, at: BASE },
  { id: 'codex-b', role: 'assistant', tool: 'codex', content: CODEX_B, at: BASE + 60_000 - 1 },
  { id: 'codex-b-user', role: 'user', tool: 'codex', content: 'first message', at: BASE + 60_000 },
  { id: 'vibe-a', role: 'assistant', tool: 'vibe-local', content: VIBE_A, at: BASE + 120_000 },
  { id: 'vibe-b', role: 'assistant', tool: 'vibe-local', content: VIBE_B, at: BASE + 180_000 - 1 },
  { id: 'vibe-b-user', role: 'user', tool: 'vibe-local', content: 'hello', at: BASE + 180_000 },
  // a second instance: its next user row is its own, not the primary's
  { id: 'codex2-b', role: 'assistant', tool: 'codex', content: CODEX_B, at: BASE + 240_000 - 1, instance: 'codex-2' },
  { id: 'codex2-b-user', role: 'user', tool: 'codex', content: 'second instance', at: BASE + 240_000, instance: 'codex-2' },

  // --- ordinary replies (never looked at: no banner text) ---
  { id: 'codex-reply', role: 'assistant', tool: 'codex', content: 'UAT-OK-CODEX', at: BASE + 300_000 },
  { id: 'vibe-reply', role: 'assistant', tool: 'vibe-local', content: 'assistant: OK-3293', at: BASE + 330_000 },

  // --- replies that quote the banner, dated 1 ms before the next message (left: has-body) ---
  {
    id: 'codex-quote-top',
    role: 'assistant',
    tool: 'codex',
    content: ['>_ OpenAI Codex (v0.160.0)', '~/repo', 'That is the banner codex draws first.', 'It was saved as a reply before #3293.'].join('\n'),
    at: BASE + 360_000 - 1,
  },
  { id: 'codex-quote-top-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 360_000 },
  {
    id: 'codex-quote-middle',
    role: 'assistant',
    tool: 'codex',
    content: ['The startup screen reads:', '', '>_ OpenAI Codex (v0.160.0)', '', 'and nothing else.'].join('\n'),
    at: BASE + 390_000 - 1,
  },
  { id: 'codex-quote-middle-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 390_000 },
  {
    id: 'vibe-quote',
    role: 'assistant',
    tool: 'vibe-local',
    content: ['The banner says 🌴 O F F L I N E  A I  C O D I N G  A G E N T 🌴', 'and the model name.'].join('\n'),
    at: BASE + 420_000 - 1,
  },
  { id: 'vibe-quote-user', role: 'user', tool: 'vibe-local', content: 'next', at: BASE + 420_000 },

  // --- transcript rows: keyed, also dated 1 ms before the next message (left: keyed-row) ---
  {
    id: 'codex-transcript-quote',
    role: 'assistant',
    tool: 'codex',
    content: '>_ OpenAI Codex (v0.160.0)\n~/repo\nThe banner.',
    at: BASE + 450_000 - 1,
    requestId: 'codex-turn:t1',
  },
  { id: 'codex-transcript-quote-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 450_000 },
  { id: 'codex-transcript-banner', role: 'assistant', tool: 'codex', content: CODEX_B, at: BASE + 480_000 - 1, requestId: 'codex-turn:t2' },
  { id: 'codex-transcript-banner-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 480_000 },

  // --- banner with a turn glued under it (left: holds-echo) ---
  { id: 'codex-glued-turn', role: 'assistant', tool: 'codex', content: CODEX_GLUED_TURN, at: BASE + 540_000 },
  { id: 'codex-0118-glued', role: 'assistant', tool: 'codex', content: CODEX_0118_GLUED, at: BASE + 545_000 - 1 },
  { id: 'codex-0118-glued-user', role: 'user', tool: 'codex', content: 'next', at: BASE + 545_000 },

  // --- the startup screen, but neither path's shape (left: no-path-match) ---
  { id: 'codex-no-path', role: 'assistant', tool: 'codex', content: CODEX_B, at: BASE + 600_000 },
  { id: 'codex-no-path-user', role: 'user', tool: 'codex', content: 'five seconds later', at: BASE + 605_000 },

  // --- other tools (never looked at, whatever they hold) ---
  { id: 'claude-quoting-codex', role: 'assistant', tool: 'claude', content: `\x1b[1m${CODEX_B}\x1b[0m`, at: BASE + 660_000 },
  { id: 'gemini-reply', role: 'assistant', tool: 'gemini', content: 'Gemini reply', at: BASE + 720_000 },
];

const STARTUP_SCREEN_IDS = ['codex-a', 'codex-b', 'vibe-a', 'vibe-b', 'codex2-b'];

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt', 'wt', '/p', '/r', 'R')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, message_type, cli_tool_id, instance_id, request_id)
     VALUES (?, 'wt', ?, ?, ?, 'normal', ?, ?, ?)`
  );
  for (const row of SEEDS) {
    insert.run(row.id, row.role, row.content, row.at, row.tool, row.instance ?? row.tool, row.requestId ?? null);
  }
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
  it('the fixture premise: each path saved the startup screen, in the shape the saving code left', () => {
    expect(CODEX_A).toContain('\x1b[');
    expect(VIBE_A).toContain('\x1b[');
    expect(CODEX_B).not.toContain('\x1b[');
    expect(VIBE_B).not.toContain('\x1b[');
    expect(stripAnsi(CODEX_A).trim().split('\n')[0]).toBe('>_ OpenAI Codex (v0.160.0)');
    expect(CODEX_B.split('\n')[0]).toBe('>_ OpenAI Codex (v0.160.0)');
    // The skip patterns drop vibe-local's `vibe-local (vibe-coder)` row, and the
    // `O F F L I N E` row is further down than the first five rows.
    for (const saved of [VIBE_A, VIBE_B]) {
      const rows = stripAnsi(saved).split('\n').map(row => row.trim()).filter(Boolean);
      expect(rows.some(row => row.includes('vibe-local (vibe-coder)'))).toBe(false);
      expect(rows.findIndex(row => row.includes('O F F L I N E'))).toBeGreaterThanOrEqual(5);
    }
    expect(stripAnsi(CODEX_GLUED_TURN)).toContain('› Reply with exactly');
  });

  it('every saved startup screen reads as the startup screen and nothing else', () => {
    for (const [content, tool] of [
      [CODEX_A, 'codex'],
      [CODEX_B, 'codex'],
      [VIBE_A, 'vibe-local'],
      [VIBE_B, 'vibe-local'],
    ] as const) {
      const row = { id: 'x', worktree_id: 'wt', role: 'assistant', cli_tool_id: tool, instance_id: tool, request_id: null, content, timestamp: 0 };
      expect(hasBannerText(row)).toBe(true);
      expect(isStartupScreenOnly(row)).toBe(true);
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

  it('rows with the banner text that are keyed, hold an echo, have a body of their own or match neither path are left and listed', () => {
    const plan = run(['--db', dbPath], () => {});

    expect(plan.left).toEqual([
      { id: 'codex-quote-top', reason: 'has-body' },
      { id: 'codex-quote-middle', reason: 'has-body' },
      { id: 'vibe-quote', reason: 'has-body' },
      { id: 'codex-transcript-quote', reason: 'keyed-row' },
      { id: 'codex-transcript-banner', reason: 'keyed-row' },
      { id: 'codex-glued-turn', reason: 'holds-echo' },
      { id: 'codex-0118-glued', reason: 'holds-echo' },
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
    const banner = { worktree_id: 'wt', role: 'assistant' as const, cli_tool_id: 'codex', instance_id: 'codex', request_id: null, content: CODEX_B };
    const user = (id: string, timestamp: number, instance = 'codex') => ({
      id, worktree_id: 'wt', role: 'user' as const, cli_tool_id: 'codex', instance_id: instance, request_id: null, content: 'm', timestamp,
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
