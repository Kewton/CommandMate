/**
 * Integration tests for the user extension + staleness surface of the
 * worktree slash-commands API (Issue #1476).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

// Redirect the user-catalog directory to a controlled temp dir.
let mockConfigDir = '';
vi.mock('@/cli/utils/install-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/utils/install-context')>();
  return { ...actual, getConfigDir: () => mockConfigDir };
});

// Deterministic CLI version probes for staleness.
type ExecTable = Record<string, { stdout?: string; error?: boolean }>;
let execTable: ExecTable = {};
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      command: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const entry = execTable[command];
      if (!entry || entry.error) {
        cb(new Error('ENOENT'), '', '');
        return;
      }
      cb(null, entry.stdout ?? '', '');
    },
  };
});

const VALID_WORKTREE = {
  id: 'test-id',
  name: 'test',
  path: '/Users/test/projects/my-project',
  repositoryPath: '/Users/test/projects/my-project',
  repositoryName: 'my-project',
  cliToolId: 'claude',
};

function writeUserCatalog(fileName: string, json: unknown): void {
  writeUserCatalogRaw(fileName, JSON.stringify(json));
}

function writeUserCatalogRaw(fileName: string, contents: string): void {
  const dir = path.join(mockConfigDir, 'slash-commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), contents, 'utf8');
}

type CommandEntry = { name: string; source?: string; description?: string; cliTools?: string[] };

async function runGet(cliTool = 'claude') {
  const { getWorktreeById } = await import('@/lib/db');
  vi.mocked(getWorktreeById).mockReturnValue(VALID_WORKTREE as never);
  // Reset the memoized user-catalog + staleness caches so each test's
  // temp files and execTable take effect.
  const { clearCatalogCache } = await import('@/lib/slash-command-catalog');
  clearCatalogCache();

  const { GET } = await import('@/app/api/worktrees/[id]/slash-commands/route');
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/test-id/slash-commands?cliTool=${cliTool}`
  );
  const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });
  return response;
}

let originalHome: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-usercat-int-'));
  // Isolate HOME so global codex/agents skills don't leak into the result.
  originalHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  execTable = {};
});

afterEach(() => {
  fs.rmSync(mockConfigDir, { recursive: true, force: true });
  if (process.env.HOME) fs.rmSync(process.env.HOME, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe('GET /api/worktrees/[id]/slash-commands (Issue #1476)', () => {
  it('surfaces a user extension command (/loop) in the claude list with source=user-catalog', async () => {
    writeUserCatalog('extra.json', {
      commands: [{ name: 'loop', description: 'Run on a recurring interval', category: 'standard-util', cliTools: ['claude'] }],
    });

    const response = await runGet('claude');
    expect(response.status).toBe(200);
    const data = await response.json();

    const all: CommandEntry[] = data.groups.flatMap((g: { commands: CommandEntry[] }) => g.commands);
    const loop = all.find((c) => c.name === 'loop');
    expect(loop).toBeDefined();
    expect(loop?.source).toBe('user-catalog');
    expect(data.sources.userCatalog).toBeGreaterThanOrEqual(1);
  });

  it('lets a user entry override a bundled command with the same name + scope', async () => {
    // /focus is a bundled claude-only command; override its description.
    writeUserCatalog('override.json', {
      commands: [{ name: 'focus', description: 'my custom focus', category: 'standard-session', cliTools: ['claude'] }],
    });

    const response = await runGet('claude');
    const data = await response.json();
    const all: CommandEntry[] = data.groups.flatMap((g: { commands: CommandEntry[] }) => g.commands);
    const focus = all.filter((c) => c.name === 'focus');
    expect(focus).toHaveLength(1);
    expect(focus[0].source).toBe('user-catalog');
    expect(focus[0].description).toBe('my custom focus');
  });

  it('does not surface a user command scoped to another CLI tool', async () => {
    writeUserCatalog('extra.json', {
      commands: [{ name: 'loop', description: 'claude only', category: 'standard-util', cliTools: ['claude'] }],
    });

    const response = await runGet('codex');
    const data = await response.json();
    const all: CommandEntry[] = data.groups.flatMap((g: { commands: CommandEntry[] }) => g.commands);
    expect(all.find((c) => c.name === 'loop')).toBeUndefined();
    expect(data.sources.userCatalog).toBe(0);
  });

  it('continues to serve the list when a user extension file is broken', async () => {
    writeUserCatalogRaw('broken.json', '{ this is not valid json');
    const response = await runGet('claude');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sources.standard).toBeGreaterThan(0);
  });

  it('includes catalogStaleness and flags a stale tool when the CLI is newer', async () => {
    execTable = {
      claude: { stdout: '9.9.9 (Claude Code)' },
      codex: { error: true },
      agy: { error: true },
    };

    const response = await runGet('claude');
    const data = await response.json();
    expect(data).toHaveProperty('catalogStaleness');
    expect(data.catalogStaleness.claude).toEqual({ current: '9.9.9', verifiedAgainst: '2.1.218', stale: true });
    // Undetectable tools are omitted.
    expect(data.catalogStaleness.antigravity).toBeUndefined();
  });

  it('returns an empty catalogStaleness when no CLI version can be read', async () => {
    execTable = { claude: { error: true }, codex: { error: true }, agy: { error: true } };
    const response = await runGet('claude');
    const data = await response.json();
    expect(data.catalogStaleness).toEqual({});
  });
});
