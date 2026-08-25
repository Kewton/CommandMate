/**
 * The approval id, carried the last step to the browser (Issue #2031).
 *
 * ## What was half-built
 *
 * #1898 taught the payload to publish the three verdicts an out-of-band
 * approval accepts. #1932 taught `PromptPanel` to turn them into buttons — and
 * gated those buttons on a `decisionId` read off the same payload, because a
 * number without an id reaches the keystroke path, where a bare "1" selects
 * whatever a cursor-navigated picker happens to be highlighting (#1681 / #1725).
 *
 * Nothing wrote that field. `buildStructuredPromptData` copied `source` /
 * `message` / `toolName` / `askUserQuestion` / `decisionOptions` and stopped, so
 * `readPromptDecisionId` answered null for every payload ever published and the
 * three buttons were unreachable code. A browser looking at an opencode
 * approval had the arrow-key safety net and nothing else.
 *
 * ## The property this suite exists to hold
 *
 * Not "the id is published" — that is one assertion and a later refactor can
 * satisfy it while breaking the thing that matters. The property is the
 * **biconditional**:
 *
 *     decisionOptions published  ⇔  decisionId non-null
 *
 * Both halves are dangerous alone. Options with no id is #1681 wearing a REST
 * verdict's clothes. An id with no options is a payload claiming to be
 * addressable that offers nothing to address it with. `current-output-builder`
 * therefore derives both from ONE expression, and the tests below drive
 * `buildCurrentOutput` across every source and every id shape rather than
 * asserting the expression's text.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

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
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2031:opencode'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  buildStructuredPromptData,
  isAddressableDecision,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import { readPromptDecisionId } from '@/components/worktree/prompt-decision-id';
import type { CLIToolType } from '@/lib/cli-tools/types';

const DECISION_ID = 'per_0000000000000000000000000';
const WT = 'wt-2031';

/** Every source the registry answers for. Five of them publish no id at all. */
const EVERY_TOOL: readonly CLIToolType[] = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'antigravity',
  'opencode',
];

describe('what `buildStructuredPromptData` copies', () => {
  it('puts the id on the payload the browser reads', () => {
    const data = buildStructuredPromptData(WT, {
      source: 'notification',
      message: 'touch /tmp/marker.txt',
      toolName: 'bash',
      decisionId: DECISION_ID,
      decisionOptions: STRUCTURED_DECISION_OPTIONS,
    });

    // MUTATION TARGET. Deleting the `decisionId` line from
    // `buildStructuredPromptData` fails here first, and then again in every
    // biconditional case below — which is the point: the copy is not an
    // isolated field, it is what makes `decisionOptions` mean a verdict.
    expect(data.decisionId).toBe(DECISION_ID);
    // Read through the receiving end rather than off the object, so the pin
    // covers the pair rather than this builder's spelling of it. #1932 shipped
    // this reader against a field nothing wrote.
    expect(readPromptDecisionId(data)).toBe(DECISION_ID);
  });

  it('says `null` rather than nothing when there is no approval to address', () => {
    const data = buildStructuredPromptData(WT, {
      source: 'notification',
      message: 'Claude needs your permission to use Bash',
      toolName: 'Bash',
    });

    // Absent would be a third state — "this build does not publish the field" —
    // and it is the state #1932 had to work around. `null` is an answer.
    expect(data.decisionId).toBeNull();
    expect('decisionId' in data).toBe(true);
  });

  it('refuses an id that is not one, instead of publishing an empty string', () => {
    const data = buildStructuredPromptData(WT, {
      source: 'notification',
      message: null,
      decisionId: '',
    });
    expect(data.decisionId).toBeNull();
    expect(isAddressableDecision('')).toBe(false);
  });

  it('carries the rules `Allow always` would save, and omits them when there are none', () => {
    const withRules = buildStructuredPromptData(WT, {
      source: 'notification',
      message: null,
      patterns: ['/tmp/*', 'bash(git *)'],
    });
    expect(withRules.patterns).toEqual(['/tmp/*', 'bash(git *)']);

    const without = buildStructuredPromptData(WT, { source: 'notification', message: null });
    expect(without.patterns).toBeUndefined();
    // Empty and absent must not be two different renderings of "no rules".
    expect(buildStructuredPromptData(WT, {
      source: 'notification',
      message: null,
      patterns: [],
    }).patterns).toBeUndefined();
  });
});

describe('the biconditional the published payload holds', () => {
  const db = {} as Database.Database;
  /** A frame the scraper reads as busy — it contributes no prompt of its own. */
  const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentStopEvents();
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
  });

  /** Open a dialog the structured layer can see, with or without an id. */
  function openDialog(
    cliToolId: CLIToolType,
    extra: { decisionId?: string; decisionPatterns?: readonly unknown[] } = {},
  ): void {
    recordAgentEvent(WT, cliToolId, cliToolId, {
      event: 'notification',
      at: Date.now() - 1_000,
      detail: 'permission_prompt',
      sessionId: 'ses-1',
      message: 'touch /tmp/marker.txt',
      ...extra,
    });
  }

  async function promptOf(cliToolId: CLIToolType): Promise<StructuredPromptWaitingData> {
    const payload = await buildCurrentOutput(db, WT, cliToolId, cliToolId);
    expect(payload.isPromptWaiting).toBe(true);
    return payload.promptData as StructuredPromptWaitingData;
  }

  /** The property, stated once and applied to every case below. */
  function expectInStep(promptData: StructuredPromptWaitingData): void {
    expect(promptData.decisionOptions !== undefined).toBe(promptData.decisionId !== null);
  }

  it('publishes both for the one source that can be answered by id', async () => {
    openDialog('opencode', { decisionId: DECISION_ID });
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBe(DECISION_ID);
    expect(promptData.decisionOptions).toEqual(STRUCTURED_DECISION_OPTIONS);
    expectInStep(promptData);
    // The #1725 safety property is untouched: nothing that answers a prompt by
    // typing an option number at a pane may find one here.
    expect(promptData.options).toEqual([]);
  });

  it('publishes neither when the frame named no approval', async () => {
    // Same source, same capability, no `properties.id`. The capability alone
    // used to be the whole gate, which would have drawn three buttons with
    // nothing behind them.
    openDialog('opencode');
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBeNull();
    expect(promptData.decisionOptions).toBeUndefined();
    expectInStep(promptData);
  });

  it('publishes neither when the id was refused as unusable', async () => {
    // `acceptExternalId` DISCARDS rather than truncates (#1930/S1), so an
    // over-long id leaves the record anonymous. The gate has to follow it: the
    // verdicts would otherwise be offered against an approval this server can
    // no longer name.
    openDialog('opencode', { decisionId: `per_${'x'.repeat(200)}` });
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBeNull();
    expect(promptData.decisionOptions).toBeUndefined();
    expectInStep(promptData);
  });

  it('holds for every source, with an id and without one', async () => {
    for (const tool of EVERY_TOOL) {
      for (const decisionId of [DECISION_ID, undefined]) {
        clearAgentStopEvents();
        openDialog(tool, decisionId ? { decisionId } : {});
        expectInStep(await promptOf(tool));
      }
    }
  });
});

describe('the four hook sources are left exactly as they were', () => {
  const db = {} as Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentStopEvents();
    vi.mocked(captureSessionOutput).mockResolvedValue('writing files\n');
  });

  it('adds `decisionId: null` to claude and changes nothing else', async () => {
    recordAgentEvent(WT, 'claude', 'claude', {
      event: 'notification',
      at: Date.now() - 1_000,
      detail: 'permission_prompt',
      sessionId: 'ses-1',
      message: 'Claude needs your permission to use Bash',
      // A hook source cannot set these two, and this pins that passing them
      // anyway does not smuggle an addressable approval past the capability
      // gate: `eventIdentity` is null for claude, so the gate is shut whatever
      // the record says.
      decisionId: DECISION_ID,
      decisionPatterns: ['/tmp/*'],
    });

    const payload = await buildCurrentOutput(db, WT, 'claude', 'claude');
    const promptData = payload.promptData as StructuredPromptWaitingData;

    expect(promptData.decisionId).toBeNull();
    expect(promptData.decisionOptions).toBeUndefined();
    // The whole shape, not just the new field: the panel renders off these keys
    // and `decisionId` is the only one this Issue is allowed to add. `patterns`
    // is absent because a source with no addressable approval has no
    // `Allow always` button to scope.
    expect(Object.keys(promptData).sort()).toEqual([
      'decisionId',
      'message',
      'options',
      'question',
      'source',
      'status',
      'type',
    ]);
    expect(readPromptDecisionId(promptData)).toBeNull();
  });
});
