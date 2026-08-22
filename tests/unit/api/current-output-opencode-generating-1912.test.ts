/**
 * Issue #1912 item 3: opencode generating produced `isGenerating: false`.
 *
 * `current-output-builder` derived `thinking` from a single comparison —
 * `reason === STATUS_REASON.THINKING_INDICATOR` — but branch A of the opencode
 * block in `status-detector` answers `opencode_processing_indicator` for the
 * `esc interrupt` footer, and that footer is opencode's ONLY signal between the
 * submitted prompt and the first transcript row. On a scraper-only session (no
 * hooks — the state #1891 L1 leaves behind) `MessageList` therefore showed no
 * thinking indicator at all for that stretch.
 *
 * Driven through the route rather than asserted on the helper alone, because
 * the defect was in the wiring: `detectSessionStatus` was already right.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const fixture = (name: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../lib/detection/fixtures', name), 'utf-8');

/** Swapped per test; the mock below reads it at call time. */
let paneFrame = '';

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return {
    ...actual,
    captureSessionOutput: vi.fn(async () => paneFrame),
  };
});

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';

const WORKTREE_ID = 'wt-1912';

interface CurrentOutputBody {
  isRunning: boolean;
  sessionStatus?: string;
  sessionStatusReason?: string;
  isGenerating?: boolean;
  thinking?: boolean;
  thinkingMessage?: string | null;
}

function call(query: string): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/current-output${query}`,
    { method: 'GET' },
  );
  return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

function everythingRunning(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockResolvedValue(true);
  }
}

async function setUpDb(cliToolId: CLIToolType): Promise<Database.Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'opencode generating',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId,
  };
  upsertWorktree(db, worktree);
  return db;
}

describe('GET /api/worktrees/:id/current-output — opencode isGenerating (Issue #1912)', () => {
  beforeEach(async () => {
    await setUpDb('opencode');
    everythingRunning();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  it('sets isGenerating on the live `esc interrupt` frame', async () => {
    paneFrame = fixture('opencode-live-1883/turn-running.txt');

    const body = (await (await call('')).json()) as CurrentOutputBody;

    expect(body.sessionStatus).toBe('running');
    expect(body.sessionStatusReason).toBe('opencode_processing_indicator');
    expect(body.isGenerating).toBe(true);
    expect(body.thinking).toBe(true);
    expect(body.thinkingMessage).not.toBeNull();
  });

  it('sets isGenerating while opencode works on an answered numbered prompt', async () => {
    paneFrame = fixture('opencode-live-1896/numbered-answer-running.txt');

    const body = (await (await call('')).json()) as CurrentOutputBody;

    expect(body.sessionStatusReason).toBe('opencode_processing_indicator');
    expect(body.isGenerating).toBe(true);
  });

  it('leaves isGenerating false once the turn is complete', async () => {
    paneFrame = fixture('opencode-live-1883/turn-complete.txt');

    const body = (await (await call('')).json()) as CurrentOutputBody;

    expect(body.sessionStatus).toBe('ready');
    expect(body.isGenerating).toBe(false);
    expect(body.thinkingMessage).toBeNull();
  });

  it('leaves isGenerating false while a permission dialog is open', async () => {
    paneFrame = fixture('opencode-live-1893/permission-bash.txt');

    const body = (await (await call('')).json()) as CurrentOutputBody;

    expect(body.sessionStatus).toBe('waiting');
    expect(body.isGenerating).toBe(false);
  });
});
