/**
 * Issue #1912 item 2: GET /api/worktrees/:id/logs/:filename searched only four
 * hard-coded CLI tool directories (`claude`, `codex`, `gemini`, `antigravity`).
 *
 * `log-manager.ts` writes under every id in `CLI_TOOL_IDS` and the list route
 * enumerates the same set, so a copilot/opencode/vibe-local log showed up in the
 * list and 404'd the moment it was opened.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { removeTempDir } from '@tests/helpers/temp-dir';

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
    setMockDb: (database: Database.Database) => {
      mockDb = database;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

let logRoot = '';
vi.mock('@/config/log-config', () => ({
  getLogDir: () => logRoot,
}));

let db: Database.Database;
const tempDirs: string[] = [];
const wtId = 'wt-logs';

const asReq = (req: Request) => req as unknown as NextRequest;

async function getLog(filename: string, query = '') {
  const { GET } = await import('@/app/api/worktrees/[id]/logs/[filename]/route');
  return GET(
    asReq(new Request(`http://localhost/api/worktrees/${wtId}/logs/${filename}${query}`)),
    { params: Promise.resolve({ id: wtId, filename }) },
  );
}

/** Write `<logRoot>/<tool>/<wtId>-2026-08-22.md` and return the filename. */
function seedLog(tool: string, body: string): string {
  const filename = `${wtId}-2026-08-22.md`;
  mkdirSync(join(logRoot, tool), { recursive: true });
  writeFileSync(join(logRoot, tool, filename), body);
  return filename;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  logRoot = realpathSync(mkdtempSync(join(tmpdir(), 'logs-route-1912-')));
  tempDirs.push(logRoot);

  upsertWorktree(db, {
    id: wtId,
    name: 'fix/1912',
    path: logRoot,
    repositoryPath: logRoot,
    repositoryName: 'fixture',
    cliToolId: 'copilot',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('GET /api/worktrees/:id/logs/:filename', () => {
  it.each(CLI_TOOL_IDS)('serves a log written under the %s directory', async (tool) => {
    const filename = seedLog(tool, `# ${tool} log\n`);

    const response = await getLog(filename);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.cliToolId).toBe(tool);
    expect(body.content).toBe(`# ${tool} log\n`);
  });

  it('still 404s when the file exists under no tool directory', async () => {
    mkdirSync(join(logRoot, 'copilot'), { recursive: true });

    const response = await getLog(`${wtId}-2026-08-22.md`);
    expect(response.status).toBe(404);
  });

  it('keeps the filename guards ahead of the directory sweep', async () => {
    seedLog('opencode', 'guarded');

    // Wrong worktree prefix / wrong extension / traversal all stay rejected.
    for (const [bad, status] of [
      [`other-2026-08-22.md`, 400],
      [`${wtId}-2026-08-22.txt`, 400],
      [`${wtId}-..%2Fescape.md`, 400],
    ] as Array<[string, number]>) {
      const response = await getLog(bad);
      expect(response.status, bad).toBe(status);
    }
  });
});
