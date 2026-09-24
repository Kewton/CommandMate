/**
 * Issue #2843 — a screen `waiting` on a turn the agent's `Stop` closed is
 * logged, once per turn, and changes no verdict.
 *
 * Three layers of claims:
 *  1. `classifyLayerDisagreement` — the table (tools whose hooks deliver both
 *     ends of a turn, scraper `waiting`, newest hook event `stop` that is not a
 *     self-resume; answerable prompt vs. selection list);
 *  2. `reportLayerDisagreement` — one line per (session, turn, kind), with the
 *     frame's ANSI-stripped tail;
 *  3. the wiring — `buildCurrentOutput` feeds it the SCRAPER's verdict, and the
 *     published status is the same with or without the log line.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));
vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { recordAgentEvent, clearAgentStopEvents } from '@/lib/session/agent-event-state';
import {
  classifyLayerDisagreement,
  reportLayerDisagreement,
  resetLayerDisagreementForTests,
  DISAGREEMENT_FRAME_TAIL_ROWS,
} from '@/lib/session/layer-disagreement';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const APPROVAL = fs.readFileSync(
  path.join(FIXTURES, 'codex-dialogs-0155/dialog-approval-run-command.txt'),
  'utf8',
);
const MODEL_PICKER = fs.readFileSync(
  path.join(FIXTURES, 'codex-dialogs-0155/dialog-model-picker.txt'),
  'utf8',
);

const disagreementLines = () =>
  mockLogger.warn.mock.calls.filter(([event]) => event === 'layerDisagreement');

/** The vocabulary a tool's registered source really declares — not a copy of it. */
const supportedEventsOf = (cliToolId: Parameters<typeof getAgentEventSource>[0]) =>
  getAgentEventSource(cliToolId).capabilities.supportedEvents;

beforeEach(() => {
  vi.clearAllMocks();
  resetLayerDisagreementForTests();
  clearAgentStopEvents();
});

describe('classifyLayerDisagreement', () => {
  const base = {
    supportedEvents: supportedEventsOf('codex'),
    scraperStatus: 'waiting',
    scraperReason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    lastEventType: 'stop',
    lastEventDetail: null,
  };

  it('an answerable prompt after stop is approval-after-stop', () => {
    expect(classifyLayerDisagreement(base)).toBe('approval-after-stop');
  });

  it('a selection list after stop is menu-after-stop', () => {
    expect(
      classifyLayerDisagreement({
        ...base,
        scraperReason: STATUS_REASON.CODEX_SELECTION_LIST,
        hasActivePrompt: false,
      }),
    ).toBe('menu-after-stop');
  });

  it.each(['claude', 'codex', 'copilot', 'gemini', 'opencode'] as const)(
    'records for %s: its hooks deliver both the start and the end of a turn',
    (cliToolId) => {
      expect(
        classifyLayerDisagreement({ ...base, supportedEvents: supportedEventsOf(cliToolId) }),
      ).toBe('approval-after-stop');
    },
  );

  it.each(['antigravity', 'command-code'] as const)(
    'null for %s: its hooks never announce the start of a turn',
    (cliToolId) => {
      const supportedEvents = supportedEventsOf(cliToolId);
      expect(supportedEvents).not.toContain('user_prompt_submit');
      expect(classifyLayerDisagreement({ ...base, supportedEvents })).toBeNull();
    },
  );

  it('null for a stop that says the agent resumes itself', () => {
    expect(
      classifyLayerDisagreement({ ...base, lastEventDetail: SELF_RESUME_PENDING_DETAIL }),
    ).toBeNull();
  });

  it.each([
    ['the tool declares no hook events', { supportedEvents: [] }],
    ['the tool declares no stop', { supportedEvents: ['session_start', 'user_prompt_submit'] }],
    ['the scraper is not waiting', { scraperStatus: 'ready' }],
    ['the turn is open', { lastEventType: 'user_prompt_submit' }],
    ['no hook event yet', { lastEventType: null }],
    [
      'waiting for a reason that is neither',
      { scraperReason: 'some_other_reason', hasActivePrompt: false },
    ],
  ])('null when %s', (_name, patch) => {
    expect(classifyLayerDisagreement({ ...base, ...patch })).toBeNull();
  });
});

describe('reportLayerDisagreement', () => {
  const report = {
    compositeKey: 'wt:codex:codex',
    worktreeId: 'wt',
    cliToolId: 'codex',
    instanceId: 'codex',
    turnId: 'turn-1',
    kind: 'approval-after-stop' as const,
    scraperReason: STATUS_REASON.PROMPT_DETECTED,
    frame: APPROVAL,
  };

  it('writes one line per (session, turn, kind)', () => {
    expect(reportLayerDisagreement(report)).toBe(true);
    expect(reportLayerDisagreement(report)).toBe(false);
    expect(reportLayerDisagreement({ ...report, turnId: 'turn-2' })).toBe(true);
    expect(reportLayerDisagreement({ ...report, kind: 'menu-after-stop' })).toBe(true);
    expect(disagreementLines()).toHaveLength(3);
  });

  it('carries the ANSI-stripped, non-blank tail of the frame', () => {
    reportLayerDisagreement(report);
    const [, data] = disagreementLines()[0];
    expect(data.kind).toBe('approval-after-stop');
    expect(data.turnId).toBe('turn-1');
    expect(data.frameTail).not.toContain('\x1b');
    expect(data.frameTail.split('\n').length).toBeLessThanOrEqual(DISAGREEMENT_FRAME_TAIL_ROWS);
    expect(data.frameTail).toContain('Press enter to confirm');
  });
});

describe('buildCurrentOutput wiring', () => {
  const WT = 'wt-layer-disagreement';

  async function payloadFor(frame: string) {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame);
    return buildCurrentOutput({} as Database.Database, WT, 'codex', 'codex');
  }

  function stop(at: number) {
    recordAgentEvent(WT, 'codex', 'codex', {
      event: 'user_prompt_submit',
      at: at - 1_000,
      detail: null,
      sessionId: null,
    });
    recordAgentEvent(WT, 'codex', 'codex', { event: 'stop', at, detail: null, sessionId: null });
  }

  it('logs approval-after-stop for an approval frame on a stopped turn, status unchanged', async () => {
    stop(Date.now() - 5_000);
    const payload = await payloadFor(APPROVAL);

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.isPromptWaiting).toBe(true);
    const lines = disagreementLines();
    expect(lines).toHaveLength(1);
    expect(lines[0][1].kind).toBe('approval-after-stop');
  });

  it('logs menu-after-stop for a /model picker on a stopped turn', async () => {
    stop(Date.now() - 5_000);
    await payloadFor(MODEL_PICKER);

    expect(disagreementLines().map(([, d]) => d.kind)).toEqual(['menu-after-stop']);
  });

  it('logs nothing while the turn is open', async () => {
    recordAgentEvent(WT, 'codex', 'codex', {
      event: 'user_prompt_submit',
      at: Date.now() - 5_000,
      detail: null,
      sessionId: null,
    });
    await payloadFor(APPROVAL);

    expect(disagreementLines()).toHaveLength(0);
  });

  it('logs once across repeated polls of the same turn', async () => {
    stop(Date.now() - 5_000);
    await payloadFor(APPROVAL);
    await payloadFor(APPROVAL);
    await payloadFor(APPROVAL);

    expect(disagreementLines()).toHaveLength(1);
  });
});
