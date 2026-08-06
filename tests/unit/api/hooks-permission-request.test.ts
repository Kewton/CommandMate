/**
 * POST /api/hooks/permission-request (Issue #1724).
 *
 * Real SQLite, real worktree rows, real Auto-Yes state; only tmux is absent,
 * because this route never touches it — which is itself one of the properties
 * under test.
 *
 * The response body is checked byte-for-byte against what §5.4 of
 * `docs/design/agent-hooks-live-verification.md` measured Claude obeying. A
 * decision Claude does not recognise is a *silent* failure: the agent falls
 * back to the dialog and looks exactly like a working no-decision, so a
 * "contains allow somewhere" assertion would pass on a body that does nothing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { recordAnsweredPrompt } from '@/lib/db/chat-db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';

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
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

/** The contract policy is a task lookup behind a TTL cache; drive it directly. */
let policy: AutoYesPolicy | null = null;
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => policy,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');
const ONE_HOUR_MS = 3_600_000;
const WT = 'wt-permission';
/**
 * The fixtures ship `"cwd": "<CWD>"` as a placeholder, and the route validates
 * `cwd` whenever it is sent, so every request needs a real absolute path. The
 * repository root is one, and using it lets the cwd-resolution test exercise
 * the same row.
 */
const WT_PATH = process.cwd();
const ROUTE = '/api/hooks/permission-request';

let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

/** The captured Bash permission request, with a caller-chosen command. */
function bashPayload(command: string): Record<string, unknown> {
  const base = fixture('permission-request.json');
  return { ...base, cwd: WT_PATH, tool_input: { command, description: 'run a command' } };
}

async function post(
  body: unknown,
  query = `?tool=claude&worktreeId=${WT}&instanceId=claude`,
  raw?: string
) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  return POST(
    asReq(
      new Request(`http://localhost${ROUTE}${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      })
    )
  );
}

async function postJson(body: unknown, query?: string) {
  const response = await post(body, query);
  return { status: response.status, body: await response.json() };
}

/** The exact body §5.4 measured Claude executing without a dialog. */
const ALLOW_BODY = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
};

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  policy = null;
  clearAllAutoYesStates();
  clearPolicySuppressions();

  upsertWorktree(db, {
    id: WT,
    name: 'feature/1724',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('the response schema Claude obeys', () => {
  it('answers an allow with exactly the measured decision JSON', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    const { status, body } = await postJson(bashPayload('touch /tmp/marker'));

    expect(status).toBe(200);
    expect(body).toEqual(ALLOW_BODY);
  });

  it('answers a no-decision with an empty object and no decision field', async () => {
    // D5: `{}` is what falls back to the TUI dialog. A body carrying a decision
    // key with a null value is not the same thing.
    const { status, body } = await postJson(bashPayload('touch /tmp/marker'));

    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(JSON.stringify(body)).toBe('{}');
  });

  it('never answers deny, whatever the contract says', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    policy = { mode: 'off', allowPromptTypes: [], denyPatterns: ['rm\\s+-rf'] };

    for (const command of ['rm -rf /', 'git status']) {
      const { body } = await postJson(bashPayload(command));
      expect(JSON.stringify(body)).not.toContain('deny');
    }
  });

  it('accepts the captured payload with only its cwd placeholder resolved', async () => {
    // The fixture is a real session's bytes: no tool_use_id, no
    // permission_requirements, a permission_suggestions array instead (D2).
    // Only `cwd`/`transcript_path` were redacted to placeholders at capture
    // time, so `cwd` is the one field a test has to fill in.
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    const captured: Record<string, unknown> = {
      ...fixture('permission-request.json'),
      cwd: WT_PATH,
    };

    expect(captured.tool_use_id).toBeUndefined();
    expect(captured.permission_requirements).toBeUndefined();
    expect(Array.isArray(captured.permission_suggestions)).toBe(true);
    expect((await postJson(captured)).body).toEqual(ALLOW_BODY);
  });

  it('makes no decision on the captured AskUserQuestion payload', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    const captured = { ...fixture('permission-request-ask-user-question.json'), cwd: WT_PATH };

    expect((await postJson(captured)).body).toEqual({});
  });
});

describe('input validation', () => {
  it('rejects a body that is not a JSON object', async () => {
    expect((await post(undefined, undefined, 'not json')).status).toBe(400);
    expect((await post([bashPayload('ls')])).status).toBe(400);
    expect((await post(undefined, undefined, 'null')).status).toBe(400);
  });

  it('rejects a tool that is not a known CLI tool id', async () => {
    expect((await post(bashPayload('ls'), `?tool=rm+-rf&worktreeId=${WT}`)).status).toBe(400);
    expect((await post(bashPayload('ls'), `?worktreeId=${WT}`)).status).toBe(400);
  });

  it('rejects an unsafe instanceId', async () => {
    const query = `?tool=claude&worktreeId=${WT}&instanceId=${encodeURIComponent('../etc')}`;
    expect((await post(bashPayload('ls'), query)).status).toBe(400);
  });

  it('rejects a malformed cwd even when a worktreeId was given', async () => {
    const body = { ...bashPayload('ls'), cwd: '/repo/../../etc' };
    expect((await post(body)).status).toBe(400);
  });

  it('makes no decision — not an error — when the worktree is unknown', async () => {
    // A hook left configured after a worktree was removed is a normal state,
    // and a distinguishable answer would make this endpoint a probe for which
    // worktrees are registered.
    setAutoYesEnabled('wt-gone', 'claude', true, ONE_HOUR_MS);

    const { status, body } = await postJson(bashPayload('ls'), '?tool=claude&worktreeId=wt-gone');

    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('makes no decision for a body that is an object but not a PermissionRequest', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    for (const body of [
      {},
      { hook_event_name: 'Stop', session_id: 'abc' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    ] as Record<string, unknown>[]) {
      expect((await postJson(body)).body, JSON.stringify(body)).toEqual({});
    }
  });

  it('resolves the worktree from cwd when the URL carries no worktreeId', async () => {
    // Hand-configured hooks (the #1549 guide) have no query parameters.
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    expect((await postJson(bashPayload('ls'), '?tool=claude')).body).toEqual(ALLOW_BODY);
  });
});

describe('the instance the verdict applies to', () => {
  it('does not let one instance answer for another', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    const other = `?tool=claude&worktreeId=${WT}&instanceId=claude-2`;
    expect((await postJson(bashPayload('ls'), other)).body).toEqual({});
  });

  it('answers for the alias instance when that is the one armed', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS, undefined, 'claude-2');

    const other = `?tool=claude&worktreeId=${WT}&instanceId=claude-2`;
    expect((await postJson(bashPayload('ls'), other)).body).toEqual(ALLOW_BODY);
    expect((await postJson(bashPayload('ls'))).body).toEqual({});
  });
});

describe('coexistence with the screen-based Auto-Yes path', () => {
  it('leaves exactly one history row when a no-decision is answered on screen', async () => {
    // The sequence the Issue asks to pin: the hook stands down, the dialog is
    // drawn, the poller answers it. If the hook had also recorded a row, or
    // recorded a *pending* one, the poller's recordAnsweredPrompt would stamp
    // the synthetic row and the trail would show the answer twice or against
    // the wrong prompt.
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    policy = { mode: null, allowPromptTypes: [], denyPatterns: ['rm\\s+-rf'] };

    expect((await postJson(bashPayload('rm -rf ./build'))).body).toEqual({});
    expect(getMessages(db, WT)).toHaveLength(0);

    recordAnsweredPrompt(db, {
      worktreeId: WT,
      cliToolId: 'claude',
      promptData: {
        type: 'multiple_choice',
        question: 'Do you want to proceed?',
        options: [{ number: 1, label: 'Yes' }],
        status: 'pending',
      },
      answer: '1',
      answeredBy: 'human',
    });

    const messages = getMessages(db, WT);
    expect(messages).toHaveLength(1);
    expect(messages[0].promptData).toMatchObject({ answer: '1', answeredBy: 'human' });
  });

  it('records the allow itself, because no dialog will ever be drawn', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    expect((await postJson(bashPayload('touch /tmp/marker'))).body).toEqual(ALLOW_BODY);

    const messages = getMessages(db, WT);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageType).toBe('prompt');
    expect(messages[0].promptData).toMatchObject({
      status: 'answered',
      answer: 'allow',
      answeredBy: 'auto',
    });
  });

  it('publishes why it stood down, so capture --json can say what is waiting', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    policy = { mode: null, allowPromptTypes: [], denyPatterns: ['rm\\s+-rf'] };

    await postJson(bashPayload('rm -rf ./build'));

    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({
      reason: 'deny-pattern',
      pattern: 'rm\\s+-rf',
    });
  });

  it('does not suppress the next unrelated request (Issue #1699)', async () => {
    // End to end over HTTP, not just the service: whatever the route adds
    // around the adjudicator must not reintroduce cross-request state.
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    policy = { mode: null, allowPromptTypes: [], denyPatterns: ['rm\\s+-rf'] };

    expect((await postJson(bashPayload('rm -rf ./build'))).body).toEqual({});
    expect((await postJson(bashPayload('git status'))).body).toEqual(ALLOW_BODY);
    expect((await postJson(bashPayload('npm run lint'))).body).toEqual(ALLOW_BODY);
  });
});

describe('authentication', () => {
  it('is not in the excluded-path list', async () => {
    // The route has no auth code of its own; absence from this list is the
    // whole of its access control, exactly as for /api/hooks/agent-event.
    expect(AUTH_EXCLUDED_PATHS as readonly string[]).not.toContain(ROUTE);
  });
});
