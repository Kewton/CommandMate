/**
 * `OpenCodeTool.killSession` writes down the session before the pane that knows
 * it goes (Issue #2038).
 *
 * The ordering is the whole test. `releaseOpencodeEventStream` calls
 * `forgetOpencodePort`, and the port is what addresses the server that can
 * answer "which session, in which directory, with which title" — so a capture
 * placed after the release reads `no-port` and records nothing, silently, for
 * every kill. The release mock below therefore forgets the port for real, which
 * is what makes moving the capture down a red test rather than an equivalent
 * rewrite.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: (name: string) => `=${name}`,
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  const ports = await import('@/lib/hooks/sources/opencode/ports');
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    // Production's release gives the port back; so does this one, on purpose.
    releaseOpencodeEventStream: vi.fn(async (target) => {
      ports.forgetOpencodePort(target);
    }),
  };
});

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { hasSession } from '@/lib/tmux/tmux';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { discardAgentEventState, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  getRememberedOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const WORKTREE_ID = 'wt-capture-2038';
const PORT = 4244;
const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';
const target: AgentInstanceRef = { worktreeId: WORKTREE_ID, cliToolId: 'opencode' };

let sandbox: string;
let worktreePath: string;
const MANAGED_ENV = ['CM_OPENCODE_SESSION_FILE', 'CM_OPENCODE_PORT_FILE'] as const;
const savedEnv: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  sandbox = makeTempDir('opencode-capture-2038-');
  worktreePath = join(sandbox, 'worktree');
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  process.env.CM_OPENCODE_SESSION_FILE = join(sandbox, 'opencode-sessions.json');
  process.env.CM_OPENCODE_PORT_FILE = join(sandbox, 'opencode-ports.json');
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  discardAgentEventState(WORKTREE_ID, 'opencode');

  // The pane is gone by the time the postcondition is checked, and its port has
  // stopped answering: the ordinary, successful `/exit`.
  vi.mocked(hasSession).mockResolvedValueOnce(true).mockResolvedValue(false);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.18.22' });
      if (url.endsWith(`/session/${SESSION_ID}`)) {
        return jsonResponse({
          id: SESSION_ID,
          slug: 'slug',
          projectID: 'global',
          directory: worktreePath,
          title: 'Fix the launcher',
          version: '1.18.22',
          time: { created: 1, updated: 2 },
        });
      }
      return jsonResponse({ name: 'NotFoundError' }, 404);
    })
  );
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  discardAgentEventState(WORKTREE_ID, 'opencode');
  removeTempDir(sandbox);
});

describe('OpenCodeTool.killSession records the session it is about to end', () => {
  it('captures id, title and directory while the server can still be asked', async () => {
    rememberOpencodePort(target, PORT, worktreePath);
    recordAgentEvent(WORKTREE_ID, 'opencode', undefined, {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: SESSION_ID,
    });

    await new OpenCodeTool().killSession(WORKTREE_ID);

    expect(getRememberedOpencodeSession(target)).toMatchObject({
      sessionId: SESSION_ID,
      title: 'Fix the launcher',
      worktreePath,
    });
  });

  it('kills cleanly when there is nothing to capture', async () => {
    await expect(new OpenCodeTool().killSession(WORKTREE_ID)).resolves.toBeUndefined();
    expect(getRememberedOpencodeSession(target)).toBeNull();
  });
});
