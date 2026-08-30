/**
 * The join: status capture → extractor → latch → `sessionStatusByInstance`
 * (Issue #1784).
 *
 * The extractor suite and the retention suite can both be green while nothing
 * reaches a client, because the wiring between them lives here and in nothing
 * either of them imports: `detectInstanceSessionStatus` has to hand the captured
 * text to `extractModelInfo`, and has to read the resolved pair back out onto
 * the status object. Drop either half and the pipeline is a chain of passing
 * tests that shows an empty header.
 *
 * The other half of this suite is the *absence*: the key must not appear when
 * there is nothing to say. `worktree-status-helper-status-mapping.test.ts` and
 * `-waiting-1786.test.ts` compare these objects whole, so an unconditional
 * `reasoningEffort: null` would break them — which is the contract #1783 set for
 * `model` and this Issue is required to keep.
 *
 * Nothing here issues a real capture; `captureSessionOutput` is mocked, which is
 * also the assertion that the feature adds no tmux round-trip of its own (the
 * mock is called exactly once per instance per probe).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

// One tool per run keeps the assertions about "which keys exist" readable; the
// tool under test is swapped per describe block via `setToolUnderTest`.
let toolUnderTest: CLIToolType = 'codex';
vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    get CLI_TOOL_IDS() {
      return [toolUnderTest] as readonly CLIToolType[];
    },
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

// Issue #2070: the health check is no longer claude's, so it is no longer
// reached through `claude-session`. Every tool's session is probed through
// `probeToolSessionLiveness`; `{ alive: true }` here is what the old
// `{ healthy: true }` meant.
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`
  ),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13,
  CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232,
  CODEX_FOOTER_CAPTURE_V0_147,
} from '../../fixtures/model-info-captures';

const WT = 'wt-1784-join';
const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

function setToolUnderTest(tool: CLIToolType): void {
  toolUnderTest = tool;
}

/** Run one probe with a live session whose pane shows `capture`. */
async function probe(tool: CLIToolType, capture: string) {
  setToolUnderTest(tool);
  vi.mocked(captureSessionOutput).mockResolvedValue(capture);
  return detectWorktreeSessionStatus(
    WT,
    new Set([`${tool}-${WT}`]),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances
  );
}

beforeEach(() => {
  clearAgentStopEvents();
  vi.mocked(captureSessionOutput).mockClear();
});
afterEach(() => {
  clearAgentStopEvents();
  setToolUnderTest('codex');
});

describe('sessionStatusByInstance[…].reasoningEffort', () => {
  it('publishes model and effort scraped from a real codex footer', async () => {
    const result = await probe('codex', CODEX_FOOTER_CAPTURE_V0_147);
    expect(result.sessionStatusByInstance.codex).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    });
  });

  it('publishes the effort claude only ever prints in its startup banner', async () => {
    const result = await probe('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232);
    expect(result.sessionStatusByInstance.claude).toMatchObject({
      model: 'Opus 5 (1M context)',
      reasoningEffort: 'xhigh',
    });
  });

  it('lets the hook-reported model win while keeping the scraped effort', async () => {
    recordAgentEvent(WT, 'codex', 'codex', {
      event: 'session_start',
      at: Date.now(),
      detail: null,
      sessionId: 'ses-1784',
      model: 'gpt-5.6-sol-2026-08-01',
    });
    const result = await probe('codex', CODEX_FOOTER_CAPTURE_V0_147);
    expect(result.sessionStatusByInstance.codex).toMatchObject({
      model: 'gpt-5.6-sol-2026-08-01',
      reasoningEffort: 'xhigh',
    });
  });

  it('derives antigravity\'s effort from the id it reports', async () => {
    recordAgentEvent(WT, 'antigravity', 'antigravity', {
      event: 'session_start',
      at: Date.now(),
      detail: null,
      sessionId: 'ses-1784',
      model: 'gemini-3.5-flash-low',
    });
    const result = await probe('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13);
    expect(result.sessionStatusByInstance.antigravity).toMatchObject({
      model: 'gemini-3.5-flash-low',
      reasoningEffort: 'low',
    });
  });

  it('omits both keys entirely when the frame shows no chrome it knows', async () => {
    // The exact-shape assertion, not a falsy check: `undefined` and `null` both
    // satisfy `toBeUndefined`-adjacent checks, and only the absence keeps the
    // whole-object suites (#1550, #1786) green.
    const result = await probe('codex', 'just some conversation\n› \n');
    expect(result.sessionStatusByInstance.codex).toEqual({
      isRunning: true,
      isWaitingForResponse: false,
      isProcessing: false,
      waitingKind: null,
      waitingSince: null,
      awaitingInstruction: false,
      // Issue #1926: the frame WAS read here — an idle codex composer — so the
      // reason and the evidence are present. Only the model keys are absent,
      // which is what this case is about.
      statusEvidence: 'positive',
      sessionStatusReason: 'input_prompt',
      lastKnownStatus: 'ready',
      lastKnownStatusAt: expect.any(Number),
    });
  });

  it('omits the effort but keeps the model for a legacy codex footer', async () => {
    const result = await probe('codex', 'conversation\n  o4-mini            50% left · /a/b');
    const status = result.sessionStatusByInstance.codex;
    expect(status?.model).toBe('o4-mini');
    expect(status).not.toHaveProperty('reasoningEffort');
  });

  it('adds no capture of its own — one capture per instance per probe', async () => {
    await probe('codex', CODEX_FOOTER_CAPTURE_V0_147);
    expect(vi.mocked(captureSessionOutput)).toHaveBeenCalledTimes(1);
  });

  it('keeps a dead session free of both keys, and never captures for it', async () => {
    setToolUnderTest('codex');
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_FOOTER_CAPTURE_V0_147);
    const result = await detectWorktreeSessionStatus(
      WT,
      new Set<string>(),
      mockDb,
      mockGetMessages,
      mockMarkPending,
      mockGetAgentInstances
    );
    expect(vi.mocked(captureSessionOutput)).not.toHaveBeenCalled();
    expect(result.sessionStatusByInstance.codex).not.toHaveProperty('reasoningEffort');
  });

  it('holds the effort across a later frame that no longer shows the banner', async () => {
    await probe('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232);
    // The banner has scrolled out of tmux's 2000-line history — the normal
    // state of a session that has been working for a while.
    const later = await probe('claude', '  Done.\n\n❯ \n');
    expect(later.sessionStatusByInstance.claude).toMatchObject({
      model: 'Opus 5 (1M context)',
      reasoningEffort: 'xhigh',
    });
  });
});

describe('the per-CLI aggregate', () => {
  it('drops both keys when a tool has more than one instance', async () => {
    setToolUnderTest('codex');
    mockGetAgentInstances.mockReturnValueOnce([
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ] as AgentInstance[]);
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_FOOTER_CAPTURE_V0_147);

    const result = await detectWorktreeSessionStatus(
      WT,
      new Set([`codex-${WT}`, `codex-${WT}-codex-2`]),
      mockDb,
      mockGetMessages,
      mockMarkPending,
      mockGetAgentInstances
    );

    // Per-instance keeps them; two instances of one tool can be on different
    // models, so the fold has no honest answer and publishes neither.
    expect(result.sessionStatusByInstance['codex-2']).toMatchObject({ reasoningEffort: 'xhigh' });
    expect(result.sessionStatusByCli.codex).not.toHaveProperty('reasoningEffort');
    expect(result.sessionStatusByCli.codex).not.toHaveProperty('model');
  });
});
