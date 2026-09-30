/**
 * `POST /api/worktrees/:id/respond` in OpenCode V2's own words (Issue #2951).
 *
 * `commandmate respond <wt> "Always allow" --instance opencode-v2` reaches this
 * route with the label v2's TUI draws; v1's spelling still resolves to the same
 * verdict. A question whose field takes a typed answer (`custom: true`) is
 * answered with the text the panel's input sends.
 *
 * The harness is `respond-opencode-v2-2945.test.ts`'s.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

const PORT = 4345;
const PASSWORD = 'pw-2945';

vi.mock('@/lib/hooks/sources/opencode-v2/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/client')>();
  return {
    ...actual,
    fetchOpencodeV2PendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodeV2PendingForms: vi.fn().mockResolvedValue([]),
    replyOpencodeV2Permission: vi.fn().mockResolvedValue(true),
    replyOpencodeV2Form: vi.fn().mockResolvedValue(true),
  };
});
vi.mock('@/lib/hooks/sources/opencode-v2/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/ports')>();
  return { ...actual, getAssignedOpencodeV2Port: vi.fn(() => PORT) };
});
vi.mock('@/lib/hooks/sources/opencode-v2/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/secrets')>();
  return { ...actual, readOpencodeV2Password: vi.fn(() => PASSWORD) };
});

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

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
    setMockDb: (database: Database.Database) => { mockDb = database; },
    closeDbInstance: () => { mockDb = null; },
  };
});

import { POST as respond } from '@/app/api/worktrees/[id]/respond/route';
import {
  fetchOpencodeV2PendingForms,
  fetchOpencodeV2PendingPermissions,
  replyOpencodeV2Form,
  replyOpencodeV2Permission,
} from '@/lib/hooks/sources/opencode-v2/client';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';

const SESSION = 'ses_2945probeSession000000000';
const PERMISSION_ID = 'per_2945probePermission0000000';
const FORM_ID = 'frm_2945probeForm00000000000000';

const PERMISSION = {
  id: PERMISSION_ID,
  sessionID: SESSION,
  action: 'edit',
  resources: ['hello.txt'],
  save: ['*'],
  metadata: { files: [{ file: 'hello.txt', patch: '@@ -0,0 +1,1 @@\n+hi\n' }] },
};

const FORM = {
  id: FORM_ID,
  sessionID: SESSION,
  title: 'Questions',
  fields: [
    {
      key: 'q0',
      title: 'Favourite colour?',
      type: 'string',
      options: [
        { value: 'blue', label: 'Blue' },
        { value: 'red', label: 'Red' },
      ],
      custom: true,
    },
  ],
};

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request('http://localhost:3000/api/worktrees/wt-2945/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, { params: Promise.resolve({ id: 'wt-2945' }) }) as unknown as Promise<Response>;
}

let db: Database.Database;

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  resetPendingDecisions();
  upsertWorktree(db, {
    id: 'wt-2945',
    name: 'wt-2945',
    path: '/tmp/wt-2945',
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'opencode-v2',
  });
  vi.mocked(replyOpencodeV2Permission).mockResolvedValue(true);
  vi.mocked(replyOpencodeV2Form).mockResolvedValue(true);
  vi.mocked(fetchOpencodeV2PendingPermissions).mockResolvedValue([]);
  vi.mocked(fetchOpencodeV2PendingForms).mockResolvedValue([]);
});

afterEach(() => {
  db.close();
});

describe('an OpenCode V2 approval answered by label', () => {
  beforeEach(() => {
    vi.mocked(fetchOpencodeV2PendingPermissions).mockResolvedValue([PERMISSION]);
  });

  it.each([['Always allow'], ['always allow'], ['Allow always'], ['always']])(
    '`%s` POSTs `always`, labelled `Always allow`',
    async (answer) => {
      const response = await post({ answer, cliTool: 'opencode-v2' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        resolved: { via: 'structured-decision', optionNumber: 2, optionLabel: 'Always allow' },
      });
      expect(vi.mocked(replyOpencodeV2Permission)).toHaveBeenCalledWith(
        PORT,
        PASSWORD,
        SESSION,
        PERMISSION_ID,
        'always',
        undefined
      );
    }
  );

  it('named by id, `Always allow` is accepted too', async () => {
    const response = await post({
      decisionId: PERMISSION_ID,
      answer: 'Always allow',
      cliTool: 'opencode-v2',
    });
    expect((await response.json()).success).toBe(true);
    expect(vi.mocked(replyOpencodeV2Permission)).toHaveBeenCalledWith(
      PORT,
      PASSWORD,
      SESSION,
      PERMISSION_ID,
      'always',
      undefined
    );
  });

  it('a refusal lists the verdicts in v2 words', async () => {
    const response = await post({ decisionId: PERMISSION_ID, answer: 'maybe', cliTool: 'opencode-v2' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('2 = Always allow (always)');
    expect(body.error).not.toContain('Allow always');
    expect(vi.mocked(replyOpencodeV2Permission)).not.toHaveBeenCalled();
  });
});

describe('an OpenCode V2 question that takes a typed answer', () => {
  beforeEach(() => {
    vi.mocked(fetchOpencodeV2PendingForms).mockResolvedValue([FORM]);
  });

  it('the typed text is sent as {answer: {q0: <text>}}', async () => {
    const response = await post({ decisionId: FORM_ID, answer: 'purple', cliTool: 'opencode-v2' });
    expect(await response.json()).toMatchObject({ success: true });
    expect(vi.mocked(replyOpencodeV2Form)).toHaveBeenCalledWith(PORT, PASSWORD, SESSION, FORM_ID, {
      q0: 'purple',
    });
  });
});
