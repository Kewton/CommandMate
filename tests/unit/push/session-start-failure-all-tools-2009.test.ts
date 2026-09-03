/**
 * A session that refuses to start rings for ALL SEVEN tools (Issue #2009).
 *
 * #2000 made "the session refused to start" reach a phone, and wired the call
 * at the line that established the fact — `claude-session`'s
 * `SessionStartFailedError`. Measured on this tree, that was also the only
 * place in the repository that threw it, so the other six agents failed in
 * silence. The Issue names two holes:
 *
 *  1. **the type hole** — all seven detect "not installed" and every one threw a
 *     bare `Error`, which carries no code for a notifier to classify;
 *  2. **the detection hole** — only claude fail-fasts on a *post-launch* terminal
 *     error (`findSessionErrorPattern`, #1637).
 *
 * This suite covers (1), which is what the Issue's acceptance list asks for.
 * (2) is deliberately out — see the commit message and
 * `dev-reports/module-reference/issue-2009.md`.
 *
 * ## What is driven, and why it is not a mock of the notifier
 *
 * Each tool's real `startSession()` runs against a PATH where nothing resolves,
 * with only `web-push` mocked. So what is asserted is a payload leaving the
 * process — the body a phone would show — rather than "a function was called".
 * Nothing here reaches tmux: every tool refuses before it creates a session,
 * which is the point of the gate.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

// Nothing may reach a real tmux server from a unit suite. These are also the
// witnesses for "the gate refuses before it creates anything".
const createSession = vi.fn();
const sendKeys = vi.fn();
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: (...args: unknown[]) => createSession(...args),
  sendKeys: (...args: unknown[]) => sendKeys(...args),
  capturePane: vi.fn().mockResolvedValue(''),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  setSessionEnvironment: vi.fn(),
}));

/**
 * An empty PATH, for every shape the seven tools ask the question in.
 *
 * `exec` is `which <cmd>` (BaseCLITool.isInstalled and claude's
 * `isClaudeInstalled`); `execFile` is what `resolveCopilotExecutable` uses
 * (#1907) — copilot is the one tool that demands positive evidence rather than
 * trusting `which`.
 */
vi.mock('child_process', () => {
  const fail = (...args: unknown[]) => {
    const callback = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    queueMicrotask(() => callback?.(new Error('command not found'), '', ''));
    return {};
  };
  return { exec: vi.fn(fail), execFile: vi.fn(fail), spawn: vi.fn(fail) };
});

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { ClaudeTool } from '@/lib/cli-tools/claude';
import { CodexTool } from '@/lib/cli-tools/codex';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import type { ICLITool } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
// Statically imported for its side effect on the module cache, NOT to call it:
// the seam reaches the notifier through `await import()`, and an uncached
// resolution takes an unbounded number of event-loop turns to settle. Loading it
// here makes the seam's import a cache hit, so `flush()` can be a bounded drain
// instead of a race this file would lose intermittently.
import '@/lib/push/failure-push-notifier';
import {
  SessionStartFailedError,
  SessionStartTimeoutError,
  isSessionStartUnavailableError,
} from '@/lib/session/session-start-error';
import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2009';
const WT_PATH = '/tmp/wt-2009';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

/** Every tool, and the display name its body has to carry. */
const TOOLS: ReadonlyArray<{ tool: () => ICLITool; name: string }> = [
  { tool: () => new ClaudeTool(), name: 'Claude Code' },
  { tool: () => new CodexTool(), name: 'Codex CLI' },
  { tool: () => new GeminiTool(), name: 'Gemini CLI' },
  { tool: () => new VibeLocalTool(), name: 'Vibe Local' },
  { tool: () => new OpenCodeTool(), name: 'OpenCode' },
  { tool: () => new CopilotTool(), name: 'Copilot' },
  { tool: () => new AntigravityTool(), name: 'Antigravity CLI' },
  { tool: () => new CommandCodeTool(), name: 'Command Code CLI' },
];

let savedEnv: Record<string, string | undefined>;

/**
 * Drain the fire-and-forget notification.
 *
 * `BaseCLITool.startSession` does not await the notification (see its docblock),
 * so every assertion here has to let the chain settle first. The drain is
 * unconditional rather than "stop at the first payload": three of the cases
 * below assert that NOTHING arrives, and a helper that returned as soon as it
 * saw one would make those pass by not looking.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function failurePayloads(): Array<{ kind: string; body: string; title: string }> {
  return sendNotification.mock.calls
    .map(
      ([, payload]) =>
        JSON.parse(payload as string) as { kind: string; body: string; title: string }
    )
    .filter((p) => p.kind === 'failure');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', WT_PATH, '/tmp/repo', 'repo', 1);
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/2009',
    p256dh: 'p',
    auth: 'a',
    locale: 'en',
  });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  clearCachedClaudePath();
  resetNotificationDedup();
});

afterEach(() => {
  resetNotificationDedup();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2009: a missing CLI notifies for every tool', () => {
  it.each(TOOLS.map(({ tool, name }) => [name, tool] as const))(
    'notifies, and names %s in the body',
    async (name, makeTool) => {
      const tool = makeTool();

      await expect(tool.startSession(WT, WT_PATH)).rejects.toThrow(/not installed/i);
      await flush();

      expect(failurePayloads()).toHaveLength(1);
      expect(failurePayloads()[0].title).toBe(`feature-x (${tool.id})`);
      // The acceptance criterion: the reader can tell WHICH tool failed, and
      // what to do about it, from the body alone.
      expect(failurePayloads()[0].body).toContain(name);
      expect(failurePayloads()[0].body).toContain('is not installed');

      // The gate refuses before anything is created — no half-built session is
      // left behind for the operator to clean up.
      expect(createSession).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    }
  );

  it('covers every tool CLI_TOOL_IDS knows about', () => {
    // Without this, adding an eighth tool would leave this suite green while
    // the eighth agent went unnotified — the "片方だけ直る改修" the Issue names.
    expect(TOOLS.map(({ tool }) => tool().id).sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it('throws the typed error, not a bare Error, from every tool', async () => {
    // Hole (1) of the Issue: the seven detections existed, the TYPE did not, so
    // nothing downstream could tell "install it" from "something else broke".
    for (const { tool } of TOOLS) {
      const error = await tool()
        .startSession(WT, WT_PATH)
        .then(
          () => null,
          (caught: unknown) => caught
        );

      expect(isSessionStartUnavailableError(error)).toBe(true);
    }
  });
});

/**
 * The classification, driven through the seam with a fake tool.
 *
 * A stub subclass is the only way to reach the two post-launch verdicts without
 * a real CLI on the machine: `SessionStartTimeoutError` needs a session that
 * came up slowly and `SessionStartFailedError` needs one that printed an error,
 * and neither is reachable from an empty PATH.
 */
class StubTool extends BaseCLITool {
  readonly id: CLIToolType = 'codex';
  readonly name = 'Codex CLI';
  readonly command = 'codex';

  constructor(private readonly failure: unknown) {
    super();
  }

  async isRunning(): Promise<boolean> {
    return false;
  }
  async sendMessage(): Promise<void> {}
  async killSession(): Promise<void> {}
  protected async launchSession(): Promise<void> {
    throw this.failure;
  }
}

describe('Issue #2009: what the seam stays quiet about', () => {
  it('does NOT notify for a start that is merely slow', async () => {
    // #1637 defines this as "a slow start, not a failed one — nothing needs
    // repairing", and the Issue's third open question resolves the same way.
    // A phone that buzzed here would be reporting the opposite of the truth.
    const tool = new StubTool(new SessionStartTimeoutError('Codex CLI', 'mcbd-codex-wt-2009', 60000));

    await expect(tool.startSession(WT, WT_PATH)).rejects.toThrow('initialization timeout');
    await flush();

    expect(failurePayloads()).toHaveLength(0);
  });

  it('notifies for a terminal error, with the authored pattern quoted', async () => {
    const tool = new StubTool(
      new SessionStartFailedError('Codex CLI', 'mcbd-codex-wt-2009', 'stream error: stream disconnected')
    );

    await expect(tool.startSession(WT, WT_PATH)).rejects.toThrow('reported an error while starting');
    await flush();

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].body).toBe(
      'Could not start the session: Codex CLI: stream error: stream disconnected'
    );
  });

  it('notifies for an unclassifiable failure without quoting it', async () => {
    // A bare Error's message interpolates raw tmux/CLI output (every tool builds
    // `Failed to start X session: ${errorMessage}`). It still has to ring — the
    // session did not come up — but only the tool NAME may leave the machine.
    const tool = new StubTool(new Error('Failed to start Codex session: /Users/secret/path exploded'));

    await expect(tool.startSession(WT, WT_PATH)).rejects.toThrow('Failed to start Codex session');
    await flush();

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].body).toBe('Could not start the session: Codex CLI');
    expect(failurePayloads()[0].body).not.toContain('/Users/secret/path');
  });

  it('lets the caller see the original error, unchanged', async () => {
    // The seam reports and rethrows. If it swallowed or rewrapped, the send
    // route could no longer map SESSION_STARTING to 503 (#1637).
    const original = new SessionStartTimeoutError('Codex CLI', 'mcbd-codex-wt-2009', 60000);
    const tool = new StubTool(original);

    const caught = await tool.startSession(WT, WT_PATH).then(
      () => null,
      (error: unknown) => error
    );

    expect(caught).toBe(original);
  });
});
