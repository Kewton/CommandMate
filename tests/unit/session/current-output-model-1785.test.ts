/**
 * `model` / `reasoningEffort` on the current-output payload (Issue #1785).
 *
 * Phase 3 is exposure, not retention: Phase 1 (#1783) already latches the model
 * the agent reports about itself, and this suite's job is to prove the value
 * actually reaches the payload `commandmate capture --json` prints — the join
 * that `agent-model-state-1783` (the latch) cannot see from its side.
 *
 * Three things are pinned here that a careless version of this suite would miss:
 *
 *  - **not-running answers null**, and it has to be asserted *after* a model was
 *    latched. The latch deliberately never expires (an eight-hour turn is on the
 *    same model at the end as at the start), so "the session is dead" is the one
 *    thing that must override it, and a test that never latches anything first
 *    is green whether the override exists or not.
 *  - **`reasoningEffort` is checked as a schema, never as a value.** Its holding
 *    layer is Phase 2 (#1784), landing in parallel, so today the honest answer
 *    is null for every session. Asserting `toBeNull()` would turn #1784's
 *    arrival into a red suite in a file it has no business editing; asserting
 *    "present, and a string or null" is true before and after.
 *  - **the fields orchestrate-monitor parses are still there.** #1785 is
 *    additive by requirement, and the recipe that supervises parallel workers
 *    reads `content` / `realtimeSnippet` / `sessionStatus` / `sessionStatusReason`
 *    off this same payload.
 *
 * The state lives on `globalThis` and CI runs with `fileParallelism: false`, so
 * `clearAgentStopEvents` runs before *and* after each test — a model latched
 * here and read by an unrelated suite is a failure that only reproduces in CI,
 * in file order.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1785:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';

const WT = 'wt-1785';
const INSTANCE = 'claude-2';
const NOW = 1_800_000_000_000;

/** A frame with nothing interesting in it: no assertion here turns on detection. */
const PLAIN_FRAME = 'building the thing\nstill building the thing\n';

/** One hook delivery that carries a model, the way claude's `SessionStart` does. */
function reportModel(model: string, instanceId = INSTANCE): void {
  recordAgentEvent(WT, 'claude', instanceId, {
    event: 'session_start',
    at: NOW,
    detail: null,
    sessionId: 'ses-1785',
    model,
  });
}

async function build(): Promise<Awaited<ReturnType<typeof buildCurrentOutput>>> {
  return buildCurrentOutput({} as Database.Database, WT, 'claude', INSTANCE);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(PLAIN_FRAME);
});

afterEach(() => {
  clearAgentStopEvents();
});

describe('model', () => {
  it('publishes the model the agent reported about itself', async () => {
    reportModel('claude-opus-5[1m]');

    const payload = await build();

    expect(payload.model).toBe('claude-opus-5[1m]');
  });

  it('publishes it verbatim — no parsing, no prettifying', async () => {
    // The value is compared against what the agent says about itself (`/status`,
    // `agy models`, the codex footer). Anything the CLI "cleaned up" on the way
    // out would break that comparison exactly when someone is using it.
    reportModel('gpt-5.6-sol');

    expect((await build()).model).toBe('gpt-5.6-sol');
  });

  it('publishes null when nothing has ever reported one', async () => {
    // The ordinary state for gemini and copilot, which put no model in any hook
    // payload, and for any session that predates this server process.
    expect((await build()).model).toBeNull();
  });

  it("does not leak another instance's model", async () => {
    reportModel('claude-opus-5[1m]', 'claude-3');

    expect((await build()).model).toBeNull();
  });

  it('publishes null for a stopped session even after a model was latched', async () => {
    reportModel('claude-opus-5[1m]');
    expect((await build()).model).toBe('claude-opus-5[1m]');

    isRunning.mockResolvedValue(false);
    const payload = await build();

    expect(payload.isRunning).toBe(false);
    expect(payload.model).toBeNull();
  });
});

describe('reasoningEffort', () => {
  // Schema, never a value — see the file header. These two assertions hold
  // today (always null) and go on holding once #1784 starts filling it in.
  const isEffort = (value: unknown): boolean => value === null || typeof value === 'string';

  it('is always present on a running session', async () => {
    reportModel('gpt-5.6-sol');

    const payload = await build();

    expect(payload).toHaveProperty('reasoningEffort');
    expect(isEffort(payload.reasoningEffort)).toBe(true);
  });

  it('is always present on a stopped session', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await build();

    expect(payload).toHaveProperty('reasoningEffort');
    expect(isEffort(payload.reasoningEffort)).toBe(true);
  });

  it('is null while no layer holds an effort (pre-#1784 state, stated not asserted)', async () => {
    // Deliberately phrased as "the retention layer answers nothing yet" rather
    // than "the field is null": when #1784 lands it will report an effort for
    // codex/claude sessions, and this expectation is written to be *deleted*
    // then, not edited. Every other assertion in this file survives untouched.
    expect((await build()).reasoningEffort).toBeNull();
  });
});

describe('additivity (Issue #1785 requirement 3)', () => {
  it('leaves every field the orchestrate-monitor recipe parses in place', async () => {
    reportModel('claude-opus-5[1m]');

    const payload = await build();

    expect(payload.content).toContain('building the thing');
    expect(typeof payload.realtimeSnippet).toBe('string');
    expect(typeof payload.sessionStatus).toBe('string');
    expect(typeof payload.sessionStatusReason).toBe('string');
    expect(payload.fullOutput).toBe(PLAIN_FRAME);
  });
});

// =============================================================================
// Issue #2955 — `.model` is null on a freshly started claude 2.1.28x session
// =============================================================================

/**
 * The real claude 2.1.284 `SessionStart` payload and startup banner, captured
 * for #2955 (`tests/fixtures/claude-session-start-2955/README.md`).
 *
 * Claude still names its model on `SessionStart`; the value is lost on the way
 * in. `SessionStart` cannot be an http hook (#1721 D1), so the injected settings
 * deliver it through `scripts/hooks/cmate-agent-event.sh`, which rebuilds the
 * body from a fixed list of keys that does not include `model`. And the frame
 * fallback is blind too: the 2.1.28x banner dropped the `with <effort> effort`
 * half that `CLAUDE_STARTUP_BANNER_PATTERN` requires.
 *
 * The positive control proves the receiver is sound — the payload as claude
 * wrote it reaches `.model`. The two `it.fails` cases are the two broken
 * channels, stated as the behaviour that is wanted: each passes today BECAUSE
 * its assertion fails, and turns red the moment that channel is fixed, which is
 * the cue to turn it into a plain `it`. Both fixes are in files outside this
 * Issue's contract (`scripts/hooks/cmate-agent-event.sh`,
 * `src/lib/detection/model-info-extractor.ts`).
 */
describe('claude 2.1.284 SessionStart (Issue #2955)', () => {
  const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-session-start-2955');
  const RELAY = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');

  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cm-2955-'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function realPayload(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(FIXTURE_DIR, 'session-start-2.1.284.json'), 'utf8'));
  }

  /** Deliver a body to the claude source the way the agent-event route does. */
  function deliver(body: Record<string, unknown>): void {
    const explicit = body.event === 'session_start' ? 'session_start' : null;
    const normalized = claudeAgentEventSource.normalizeEvent({ payload: body, event: explicit, receivedAt: NOW });
    expect(normalized, 'the claude source refused the body').not.toBeNull();
    recordAgentEvent(WT, 'claude', INSTANCE, {
      event: normalized!.event,
      at: NOW,
      detail: normalized!.detail,
      sessionId: normalized!.conversationId,
      model: normalized!.model,
    });
  }

  /** What the relay script would POST for this payload, read off a fake `curl`. */
  function relayBody(payload: Record<string, unknown>): Record<string, unknown> {
    const argsFile = join(sandbox, 'curl-args.txt');
    const fakeCurl = join(sandbox, 'curl');
    writeFileSync(fakeCurl, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CURL_ARGS_FILE"\n');
    chmodSync(fakeCurl, 0o755);
    const result = spawnSync(
      'bash',
      [RELAY, '--tool', 'claude', '--event', 'session_start', '--worktree-id', WT, '--instance-id', INSTANCE, '--stdin-json'],
      {
        encoding: 'utf8',
        input: JSON.stringify({ ...payload, cwd: sandbox }),
        env: {
          ...process.env,
          PATH: `${sandbox}:${process.env.PATH ?? ''}`,
          CURL_ARGS_FILE: argsFile,
          CM_HOOK_URL: 'http://127.0.0.1:9/api/hooks/agent-event',
          CM_AUTH_TOKEN: '',
          CM_AGENT_CWD: '',
          CLAUDE_PROJECT_DIR: '',
        },
      }
    );
    expect(result.status).toBe(0);
    const args = readFileSync(argsFile, 'utf8').split('\n');
    return JSON.parse(args[args.indexOf('--data-binary') + 1]);
  }

  it('the payload claude writes still names the model', () => {
    expect(realPayload().model).toBe('claude-sonnet-5-5');
  });

  it('positive control: delivered as claude wrote it, the model reaches capture --json', async () => {
    deliver(realPayload());

    expect((await build()).model).toBe('claude-sonnet-5-5');
  });

  it.fails('through the injected SessionStart relay, the model reaches capture --json', async () => {
    // Fails today: the relay's body has no `model` key (see the header above).
    deliver(relayBody(realPayload()));

    expect((await build()).model).toBe('claude-sonnet-5-5');
  });

  it.fails('the 2.1.284 startup banner is read as a model by the frame fallback', () => {
    // Fails today: the banner is `Sonnet 5.5 · Claude Max`, with no
    // `with <effort> effort` for the banner pattern to anchor on.
    const banner = readFileSync(join(FIXTURE_DIR, 'banner-2.1.284.txt'), 'utf8');

    expect(extractModelInfo('claude', banner).model).toBe('Sonnet 5.5');
  });
});
