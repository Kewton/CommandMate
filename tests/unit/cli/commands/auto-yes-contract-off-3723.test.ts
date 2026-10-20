/**
 * The CLI says when a contract keeps Auto-Yes from answering (Issue #3723).
 *
 * `auto-yes --enable` and `send --auto-yes` printed "enabled" and exited 0 for
 * an instance whose running contract says `autoYes.mode: 'off'`; `ls` printed a
 * countdown and `instances` printed `yes`. Now:
 *
 *  - both arming paths print a warning on stderr and still exit 0 — the
 *    `auto-yes` case is driven through the real route over a real task row;
 *  - `safe` / `allow-listed` get one line naming what is answered;
 *  - no contract / a null mode prints exactly what it did (negative controls);
 *  - `ls` / `instances` print `blocked`, and `--json` carries the reason.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import type { Worktree } from '@/types/models';

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

vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);

vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return {
    ...actual,
    startAutoYesPolling: vi.fn(() => ({ started: true })),
    stopAutoYesPolling: vi.fn(() => true),
    stopAutoYesPollingByWorktree: vi.fn(() => 0),
  };
});

vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

import { GET, POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { GET as RESOLVE_TARGET } from '@/app/api/worktrees/[id]/resolve-target/route';
import { GET as CAPABILITIES } from '@/app/api/capabilities/route';
import { clearAllAutoYesStates } from '@/lib/polling/auto-yes-manager';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { describeContractPolicy } from '../../../../src/cli/commands/auto-yes';

const WT = 'wt-cli-3723';
const originalFetch = global.fetch;

let db: Database.Database;
let mockExit: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

function stderrLines(): string[] {
  return consoleErrorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function seedTask(autoYesBlock: string): string {
  const contract = parseTaskContract(
    `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYesBlock}`,
    'task.yaml'
  );
  return createTask(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract,
    status: 'running',
  }).id;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'main',
    path: '/nonexistent-3723/wt',
    repositoryPath: '/nonexistent-3723',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  global.fetch = originalFetch;
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  vi.restoreAllMocks();
});

describe('[#3723] commandmate auto-yes --enable against the real route', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const params = { params: Promise.resolve({ id: WT }) };
      if (url.pathname === '/api/capabilities') return CAPABILITIES() as unknown as Response;
      if (url.pathname.endsWith('/resolve-target')) {
        return RESOLVE_TARGET(new NextRequest(url, { method: 'GET' }), params) as unknown as Response;
      }
      if (url.pathname.endsWith('/auto-yes')) {
        const method = (init?.method ?? 'GET').toUpperCase();
        const request = new NextRequest(url, { method, body: init?.body as string | undefined });
        return (method === 'POST' ? POST(request, params) : GET(request, params)) as unknown as Response;
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
  });

  async function runAutoYes(...args: string[]): Promise<void> {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    await createAutoYesCommand().parseAsync(['node', 'auto-yes', WT, ...args]);
  }

  it("warns on stderr and exits 0 when the running contract says mode 'off'", async () => {
    const taskId = seedTask("autoYes:\n  mode: 'off'\n");

    await runAutoYes('--enable');

    const lines = stderrLines();
    expect(lines).toContain(`Auto-yes enabled for ${WT} (claude).`);
    const warning = lines.find((line) => line.startsWith('Warning:'));
    expect(warning).toContain(`task ${taskId}`);
    expect(warning).toContain('autoYes.mode: off');
    expect(warning).toContain('will answer no prompt');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('prints only the enabled line when no contract governs the instance (negative control)', async () => {
    await runAutoYes('--enable');

    expect(stderrLines()).toEqual([`Auto-yes enabled for ${WT} (claude).`]);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('prints only the enabled line when the contract states no mode (negative control)', async () => {
    seedTask('autoYes:\n  denyPatterns: []\n');

    await runAutoYes('--enable');

    expect(stderrLines()).toEqual([`Auto-yes enabled for ${WT} (claude).`]);
  });

  it('adds one note naming what mode: safe answers, and no warning', async () => {
    seedTask('autoYes:\n  mode: safe\n');

    await runAutoYes('--enable');

    const lines = stderrLines();
    expect(lines.some((line) => line.startsWith('Warning:'))).toBe(false);
    expect(lines.filter((line) => line.startsWith('Note:'))).toEqual([
      expect.stringContaining('answers yes_no prompts only'),
    ]);
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('[#3723] describeContractPolicy', () => {
  it('is empty for a missing or mode-less policy', () => {
    expect(describeContractPolicy(undefined)).toEqual([]);
    expect(describeContractPolicy(null)).toEqual([]);
    expect(describeContractPolicy({ taskId: 't', mode: null, allowPromptTypes: [], denyPatternCount: 2 })).toEqual([]);
  });

  it('names the allow-listed prompt types and the deny patterns on one line', () => {
    expect(
      describeContractPolicy({ taskId: 't1', mode: 'allow-listed', allowPromptTypes: ['yes_no', 'approval'], denyPatternCount: 2 })
    ).toEqual([
      'Note: the contract of task t1 sets autoYes.mode: allow-listed; Auto-Yes answers only: yes_no, approval. ' +
        '2 deny pattern(s) also escalate matching prompts to a human.',
    ]);
  });
});

describe('[#3723] commandmate send --auto-yes reads the arming response', () => {
  function stubSend(autoYesBody: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auto-yes')) return jsonResponse(200, autoYesBody);
      if (url.pathname.endsWith('/send')) return jsonResponse(201, { id: 1 });
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  async function runSend(): Promise<void> {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', WT, 'hello', '--auto-yes']);
  }

  it("warns on stderr, still sends and exits 0 under mode 'off'", async () => {
    const fn = stubSend({
      enabled: true,
      expiresAt: Date.now() + 3_600_000,
      contractPolicy: { taskId: 'task-1', mode: 'off', allowPromptTypes: [], denyPatternCount: 0 },
    });

    await runSend();

    const lines = stderrLines();
    expect(lines).toContain('Auto-yes enabled.');
    expect(lines.find((line) => line.startsWith('Warning:'))).toContain('autoYes.mode: off');
    expect(lines).toContain('Message sent.');
    expect(fn.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      `/api/worktrees/${WT}/auto-yes`,
      `/api/worktrees/${WT}/send`,
    ]);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    ['contractPolicy: null', { enabled: true, expiresAt: 1, contractPolicy: null }],
    ['a server older than #3723', { enabled: true, expiresAt: 1 }],
  ])('prints what it did before under %s (negative control)', async (_label, body) => {
    stubSend(body);

    await runSend();

    expect(stderrLines()).toEqual(['Auto-yes enabled.', 'Message sent.']);
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('[#3723] send --contract --auto-yes warns before the task runs', () => {
  type AutoYesBlock = { mode: string | null; allowPromptTypes: string[]; denyPatterns: string[] } | undefined;

  /**
   * The server is the one #3723 shipped against: arming a `--contract` send
   * answers `contractPolicy: null`, because the task is still `pending` and
   * ACTIVE_TASK_STATUSES does not count it. `serverPolicy` overrides that.
   */
  function stubContractSend(autoYes: AutoYesBlock, serverPolicy: unknown = null): string[] {
    const paths: string[] = [];
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      paths.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith('/tasks') && method === 'POST') {
        return jsonResponse(201, {
          task: { id: 'task-3723', contract: autoYes === undefined ? {} : { autoYes } },
          message: 'the composed message',
        });
      }
      if (url.pathname.startsWith('/api/tasks/')) return jsonResponse(200, {});
      if (url.pathname.endsWith('/auto-yes')) {
        return jsonResponse(200, { enabled: true, expiresAt: 1, contractPolicy: serverPolicy });
      }
      if (url.pathname.endsWith('/send')) return jsonResponse(201, { id: 1 });
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    }) as unknown as typeof fetch;
    return paths;
  }

  async function runSend(...args: string[]): Promise<void> {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', WT, '--contract', '.commandmate/tasks/t.yaml', '--auto-yes', ...args,
    ]);
  }

  function warnings(): string[] {
    return stderrLines().filter((line) => line.startsWith('Warning:') && line.includes('autoYes.mode'));
  }

  it("warns once, before the message goes out, under mode 'off'", async () => {
    const paths = stubContractSend({ mode: 'off', allowPromptTypes: [], denyPatterns: [] });

    await runSend();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('task task-3723');
    const lines = stderrLines();
    expect(lines.indexOf(warnings()[0])).toBeLessThan(lines.indexOf('Message sent.'));
    expect(paths.indexOf(`POST /api/worktrees/${WT}/auto-yes`)).toBeLessThan(
      paths.indexOf(`POST /api/worktrees/${WT}/send`)
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("warns once on the --model path, which arms after the send, under mode 'off'", async () => {
    const paths = stubContractSend({ mode: 'off', allowPromptTypes: [], denyPatterns: [] });

    await runSend('--agent', 'copilot', '--model', 'gpt-5-mini');

    expect(warnings()).toHaveLength(1);
    expect(paths.indexOf(`POST /api/worktrees/${WT}/send`)).toBeLessThan(
      paths.indexOf(`POST /api/worktrees/${WT}/auto-yes`)
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("prefers the server's policy when it has one", async () => {
    stubContractSend(
      { mode: 'off', allowPromptTypes: [], denyPatterns: [] },
      { taskId: 'task-server', mode: 'safe', allowPromptTypes: [], denyPatternCount: 0 }
    );

    await runSend();

    expect(warnings()).toEqual([]);
    expect(stderrLines().filter((line) => line.startsWith('Note:'))).toEqual([
      expect.stringContaining('task task-server'),
    ]);
  });

  it('adds the same Note: for an allow-listed contract', async () => {
    stubContractSend({ mode: 'allow-listed', allowPromptTypes: ['yes_no'], denyPatterns: [] });

    await runSend();

    expect(stderrLines().filter((line) => line.startsWith('Note:'))).toEqual([
      expect.stringContaining('answers only: yes_no'),
    ]);
  });

  it.each([
    ['no autoYes block', undefined],
    ['mode null', { mode: null, allowPromptTypes: [], denyPatterns: [] }],
  ])('prints nothing extra with %s (negative control)', async (_label, block) => {
    stubContractSend(block as AutoYesBlock);

    await runSend();

    expect(stderrLines().filter((line) => line.startsWith('Warning:') || line.startsWith('Note:'))).toEqual([]);
    expect(stderrLines()).toContain('Auto-yes enabled.');
  });

  it('prints no warning without --auto-yes, and arms nothing (negative control)', async () => {
    const paths = stubContractSend({ mode: 'off', allowPromptTypes: [], denyPatterns: [] });
    const { createSendCommand } = await import('../../../../src/cli/commands/send');

    await createSendCommand().parseAsync(['node', 'send', WT, '--contract', '.commandmate/tasks/t.yaml']);

    expect(stderrLines().filter((line) => line.startsWith('Warning:') || line.startsWith('Note:'))).toEqual([]);
    expect(paths.some((path) => path.endsWith('/auto-yes'))).toBe(false);
    expect(stderrLines()).toContain('Message sent.');
  });
});

describe('[#3723] ls / instances print blocked', () => {
  const NOW = Date.now();

  function lsRow(autoYesByInstance: Record<string, unknown>): Record<string, unknown> {
    return {
      id: WT,
      name: 'main',
      cliToolId: 'claude',
      isSessionRunning: false,
      isWaitingForResponse: false,
      isProcessing: false,
      autoYesByInstance,
      sessionStatusByInstance: {},
    };
  }

  async function runLs(rows: Record<string, unknown>[], ...args: string[]): Promise<string> {
    global.fetch = vi.fn(async () => jsonResponse(200, { worktrees: rows, repositories: [] })) as unknown as typeof fetch;
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    await createLsCommand().parseAsync(['node', 'ls', ...args]);
    return String(consoleLogSpy.mock.calls.at(-1)?.[0]);
  }

  it('ls prints blocked for an armed instance its contract blocks', async () => {
    const out = await runLs([
      lsRow({ claude: { enabled: true, expiresAt: NOW + 3_600_000, blockedByContract: true } }),
    ]);

    const dataLine = out.split('\n')[2];
    expect(dataLine.trimEnd().endsWith('blocked')).toBe(true);
  });

  it('ls still prints the countdown without the flag (negative control)', async () => {
    const out = await runLs([lsRow({ claude: { enabled: true, expiresAt: NOW + 3_600_000 } })]);

    const dataLine = out.split('\n')[2];
    expect(dataLine).not.toContain('blocked');
    expect(dataLine.trimEnd()).toMatch(/\d:\d\d:\d\d$|\d\d:\d\d$/);
  });

  it('ls --json carries blockedByContract verbatim', async () => {
    const out = await runLs(
      [lsRow({ claude: { enabled: true, expiresAt: NOW + 3_600_000, blockedByContract: true } })],
      '--json'
    );

    const rows = JSON.parse(out) as Array<{ autoYesByInstance: Record<string, { blockedByContract?: boolean }> }>;
    expect(rows[0].autoYesByInstance.claude.blockedByContract).toBe(true);
  });

  async function runInstances(
    autoYesInstances: Record<string, unknown>,
    ...args: string[]
  ): Promise<string> {
    const base = `/api/worktrees/${WT}`;
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === base) {
        return jsonResponse(200, {
          id: WT,
          name: 'main',
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
          ],
        });
      }
      if (url.pathname === `${base}/current-output`) return jsonResponse(200, { isRunning: false });
      if (url.pathname === `${base}/auto-yes`) return jsonResponse(200, { instances: autoYesInstances });
      throw new Error(`unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WT, ...args]);
    return String(consoleLogSpy.mock.calls.at(-1)?.[0]);
  }

  const MAP = {
    claude: { enabled: true, expiresAt: NOW + 3_600_000 },
    'claude-2': { enabled: true, expiresAt: NOW + 3_600_000, blockedByContract: true },
  };

  it('instances prints blocked in AUTO_YES for the blocked instance only', async () => {
    const lines = (await runInstances(MAP)).split('\n');
    const header = lines[0];
    const col = header.indexOf('AUTO_YES');
    const cell = (line: string): string => line.slice(col).split(/\s+/)[0];

    expect(cell(lines.find((line) => line.startsWith('claude-2'))!)).toBe('blocked');
    expect(cell(lines.find((line) => line.startsWith('claude '))!)).toBe('yes');
  });

  it('instances --json keeps autoYes boolean and adds autoYesBlockedByContract only when blocked', async () => {
    const rows = JSON.parse(await runInstances(MAP, '--json')) as Array<Record<string, unknown>>;

    expect(rows.find((r) => r.instanceId === 'claude-2')).toMatchObject({
      autoYes: true,
      autoYesBlockedByContract: true,
    });
    const free = rows.find((r) => r.instanceId === 'claude');
    expect(free).toMatchObject({ autoYes: true });
    expect(free).not.toHaveProperty('autoYesBlockedByContract');
  });
});
