/**
 * The other five tools' push counts did not move (Issue #2045).
 *
 * This is the Issue's second acceptance criterion, and it is the reason the new
 * producer lives in `sources/opencode/` instead of being a hook on
 * `notification` / `error` in the shared receiver. The claim — "opencode gained
 * notifications and nobody else did" — is only worth anything if it is measured
 * against the path claude and codex actually take, so this file posts their own
 * captured payloads at the real `POST /api/hooks/agent-event` with a real
 * database, a configured VAPID pair and a registered subscription, and counts
 * what reaches `web-push`.
 *
 * The last test is the control. Without it a green file would be equally
 * consistent with "the harness cannot see a push at all", which is the failure
 * mode a parity test is most likely to have.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => db,
  closeDbInstance: () => {},
}));

/** The contract policy is a task lookup behind a TTL cache; keep it out of the way. */
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

import { upsertWorktree, upsertPushSubscription } from '@/lib/db';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import {
  clearAgentStopEvents,
  discardAgentEventState,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions, resetUnknownEventTallies } from '@/lib/hooks/sources';
import type { NormalizedAgentEvent } from '@/lib/hooks/sources';
import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  resetNotificationDedup,
  resetWaitingPushDedup,
} from '@/lib/push/notification-dedup';
import { clearAllPromptCards } from '@/lib/push/prompt-card-state';
import { clearWaitingEpisodes, clearWaitingTransitionListeners } from '@/lib/session/waiting-episode-state';

const HOOK_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');
const WT = 'wt-parity-2045';
/** The fixtures ship `"cwd": "<CWD>"`; the route validates every cwd it is sent. */
const WT_PATH = process.cwd();
const T0 = 1_800_000_000_000;
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let savedEnv: Record<string, string | undefined>;

const asReq = (req: Request) => req as unknown as NextRequest;

function fixture(tool: string, name: string): Record<string, unknown> {
  return {
    ...JSON.parse(readFileSync(join(HOOK_FIXTURES, tool, `${name}.json`), 'utf8')),
    cwd: WT_PATH,
  };
}

/** What `scripts/hooks/cmate-agent-event.sh` sends, given the generated hook. */
function relayBody(tool: string, event: string, detail?: string) {
  return {
    tool,
    event,
    cwd: WT_PATH,
    worktreeId: WT,
    instanceId: tool,
    ...(detail === undefined ? {} : { detail }),
  };
}

async function postEvent(body: unknown, query = '') {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return response.status;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function opencodeEvent(name: string): NormalizedAgentEvent {
  const payload = JSON.parse(
    readFileSync(join(HOOK_FIXTURES, 'opencode', `${name}.json`), 'utf8')
  ) as Record<string, unknown>;
  const event = opencodeAgentEventSource.normalizeEvent({ payload, receivedAt: T0 });
  if (!event) throw new Error(`fixture ${name} did not normalise`);
  return event;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'feature-2045',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
  upsertPushSubscription(db, { endpoint: 'https://push.example/parity', p256dh: 'p', auth: 'a' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  clearAllAutoYesStates();
  clearAgentStopEvents();
  resetPendingDecisions();
  resetUnknownEventTallies();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllPromptCards();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  for (const tool of ['claude', 'codex', 'opencode'] as const) {
    discardAgentEventState(WT, tool, tool);
  }
});

afterEach(() => {
  clearAllAutoYesStates();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  db.close();
});

describe('claude and codex push counts are unchanged by #2045', () => {
  it('sends nothing for a claude turn, dialog included', async () => {
    // claude's own hook payloads, at the URL `startSession` injects.
    const q = `?tool=claude&worktreeId=${WT}&instanceId=claude`;
    expect(await postEvent(fixture('claude', 'session-start'), q)).toBe(202);
    expect(await postEvent(fixture('claude', 'user-prompt-submit'), q)).toBe(202);
    // The nearest claude analogue of `question.asked` — the frame that opens the
    // prompt-waiting record — and of `session.error`, a turn that just ends.
    expect(await postEvent(fixture('claude', 'notification-permission-prompt'), q)).toBe(202);
    expect(await postEvent(fixture('claude', 'notification-idle-prompt'), q)).toBe(202);
    expect(await postEvent(fixture('claude', 'stop'), q)).toBe(202);
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends nothing for a codex turn', async () => {
    expect(await postEvent(relayBody('codex', 'session_start'))).toBe(202);
    expect(await postEvent(relayBody('codex', 'user_prompt_submit'))).toBe(202);
    expect(await postEvent(relayBody('codex', 'notification', 'permission_prompt'))).toBe(202);
    expect(await postEvent(relayBody('codex', 'stop'))).toBe(202);
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('still sends for opencode — the control for the two above', async () => {
    // Without this, the two tests above would pass just as happily against a
    // harness that cannot observe a push at all.
    await ingestOpencodeEvent(
      { worktreeId: WT, cliToolId: 'opencode', instanceId: 'opencode' },
      opencodeEvent('question-asked')
    );
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
