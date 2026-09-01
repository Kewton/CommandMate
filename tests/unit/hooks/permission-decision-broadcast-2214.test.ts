/**
 * The Auto-Yes audit row reaches open panes over the socket (Issue #2214).
 *
 * `recordAllowedPermission` writes the only record that an Auto-Yes approval
 * happened — an allowed request never draws a dialog, so no other writer runs
 * on this path — and until #2214 it wrote that row with no realtime frame
 * behind it. #2195 demoted the client's history poll to a 15 s fallback while a
 * socket is up, so the row simply arrived late.
 *
 * What this file pins is the *event type and its payload*, directly. It does
 * NOT try to prove the fix by asserting a client renders one card instead of
 * two: `useSplitMessages` funnels `message` and `message_updated` through the
 * same ID-upsert, so a duplicate-render assertion is green under either type
 * and would prove nothing about this producer.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  parsePermissionRequestPayload,
  type PermissionRequestPayload,
} from '@/lib/hooks/permission-request-payload';
import {
  resolvePermissionRequest,
  type PermissionRequestSession,
} from '@/lib/hooks/permission-decision-service';
import type { ChatMessage } from '@/types/models';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

/** The adjudicator's only database use is the allow audit row; stub it out. */
const created: Array<Record<string, unknown>> = [];
let auditFailure: Error | null = null;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => {
    if (auditFailure) throw auditFailure;
    created.push(message);
    return { id: 'msg-2214', ...message, archived: false };
  },
}));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...args),
}));

/** Policy lookup is a database read behind a TTL cache; drive it directly. */
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  clearAutoYesPolicyCache: () => {},
}));

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');
const ONE_HOUR_MS = 3_600_000;

/**
 * An alias instance, not the primary.
 *
 * Deliberate: `createMessage` defaults a missing `instanceId` to the CLI tool id
 * for the column it writes but hands the caller's own object back, so a producer
 * that dropped the field would still look right on a primary-instance session
 * and address the wrong instance here.
 */
const SESSION: PermissionRequestSession = {
  worktreeId: 'wt-2214',
  cliToolId: 'claude',
  instanceId: 'claude-2',
};

function bash(command: string): PermissionRequestPayload {
  const base = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'permission-request.json'), 'utf8')
  ) as Record<string, unknown>;
  const parsed = parsePermissionRequestPayload({
    ...base,
    tool_name: 'Bash',
    tool_input: { command, description: 'run a command' },
  });
  if (!parsed) throw new Error('fixture-derived payload failed to parse');
  return parsed;
}

/** The `(type, payload)` pairs published so far. */
function pushes(): Array<[string, { worktreeId: string; message: ChatMessage }]> {
  return broadcastMessage.mock.calls as Array<
    [string, { worktreeId: string; message: ChatMessage }]
  >;
}

beforeEach(() => {
  created.length = 0;
  auditFailure = null;
  broadcastMessage.mockReset();
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  setAutoYesEnabled(SESSION.worktreeId, SESSION.cliToolId, true, ONE_HOUR_MS, undefined, SESSION.instanceId);
});

afterEach(() => {
  clearAllAutoYesStates();
});

describe('the Auto-Yes audit row (Issue #2214)', () => {
  it('publishes the row it wrote as a new `message`', async () => {
    expect(resolvePermissionRequest(SESSION, bash('git status'))).toMatchObject({
      behavior: 'allow',
    });
    expect(created).toHaveLength(1);

    // The push is detached from the write on purpose (the hook's caller is an
    // agent waiting on the verdict), so the assertion waits for it.
    await vi.waitFor(() => {
      expect(pushes()).toHaveLength(1);
    });

    const [type, payload] = pushes()[0];
    // `'message'`, not `'message_updated'`: the row is a fresh INSERT that no
    // client has ever been told about.
    expect(type).toBe('message');
    expect(payload.worktreeId).toBe('wt-2214');
    expect(payload.message).toMatchObject({
      id: 'msg-2214',
      worktreeId: 'wt-2214',
      messageType: 'prompt',
      cliToolId: 'claude',
      instanceId: 'claude-2',
      promptData: { status: 'answered', answeredBy: 'auto', answer: 'allow' },
    });
  });

  it('publishes nothing when the row could not be written', async () => {
    auditFailure = new Error('database is locked');

    // The verdict still stands — the agent is unblocked either way.
    expect(resolvePermissionRequest(SESSION, bash('git status')).behavior).toBe('allow');

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'permission-request:audit-record-failed',
        expect.anything()
      );
    });
    expect(pushes()).toHaveLength(0);
  });

  it('keeps the verdict when the socket throws', async () => {
    broadcastMessage.mockImplementation(() => {
      throw new Error('socket is gone');
    });

    // The row is committed before the push is attempted, so a dead socket costs
    // the frame and nothing else: neither the verdict nor the audit row moves.
    expect(resolvePermissionRequest(SESSION, bash('git status')).behavior).toBe('allow');
    expect(created).toHaveLength(1);

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'permission-request:audit-broadcast-failed',
        expect.objectContaining({ worktreeId: 'wt-2214' })
      );
    });
  });

  it('publishes nothing when no allow was adjudicated', async () => {
    clearAllAutoYesStates();

    expect(resolvePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();

    // Nothing was written, so nothing may be published. Asserted after a turn of
    // the microtask queue, which is all a detached push needs.
    await Promise.resolve();
    expect(created).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
  });
});
