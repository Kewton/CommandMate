/**
 * `structuredEvents.toolInputNormalization` — the operator-facing end of
 * Issue #1902.
 *
 * Reading copilot's string `tool_input` as a patch is an automatic rewrite of
 * what the agent sent, and §7 of `docs/design/multi-agent-state-architecture.md`
 * is explicit that a judgement or automatic action visible only in the server
 * log does not exist: it has to reach the operator with a reason code. This is
 * that wire. `commandmate capture --json` prints this response verbatim
 * (`src/cli/commands/capture.ts`) and `commandmate wait` polls it, so a field
 * that is not on this payload is not observable from the CLI at all.
 *
 * The suite is deliberately about the *wiring* rather than about the
 * normalisation itself — `tests/unit/hooks/copilot-string-tool-input-1902.test.ts`
 * pins what gets recorded. Dropping the `getLastToolInputNormalization` call
 * from `buildCurrentOutput` leaves that suite entirely green, which is why this
 * one exists.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { freezeClock, unfreezeClock } from '../../helpers/frozen-clock';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1902:copilot'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearToolInputNormalizations,
  recordToolInputNormalization,
} from '@/lib/hooks/tool-input-normalization-state';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';

const db = {} as Database.Database;

/** What `parseCopilotPermissionRequest` records for the Issue's payload. */
const EDIT_NORMALIZATION = {
  reason: 'string-tool-input-as-patch',
  key: 'patch',
  receivedType: 'string',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  clearToolInputNormalizations();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue('some agent output\n> ');
});

// Only the case that freezes it does; this is the unconditional restore.
afterEach(() => unfreezeClock());

describe('buildCurrentOutput exposure (Issue #1902)', () => {
  it('is null on a session whose tool_input never needed rewriting', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');

    // Present and null, not absent: `capture --json | jq` has to be able to
    // read "nothing was normalised" rather than "this server is too old".
    expect(payload.structuredEvents).toHaveProperty('toolInputNormalization');
    expect(payload.structuredEvents.toolInputNormalization).toBeNull();
  });

  it('publishes the reason code once a request has been normalised', async () => {
    recordToolInputNormalization(
      'wt-1902',
      'copilot',
      'copilot',
      EDIT_NORMALIZATION,
      'Edit',
      1_700_000_000_000
    );

    const payload = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');

    expect(payload.structuredEvents.toolInputNormalization).toEqual({
      ...EDIT_NORMALIZATION,
      toolName: 'Edit',
      at: 1_700_000_000_000,
    });
  });

  it('reports it on a session that is no longer running', async () => {
    // The `promptDedup` rule, not the `model` rule: this is a record of
    // something that already happened, and an operator who comes back after the
    // session ended to ask why an edit was adjudicated the way it was must
    // still find the answer. Zeroing it would erase the evidence exactly then.
    recordToolInputNormalization(
      'wt-1902',
      'copilot',
      'copilot',
      EDIT_NORMALIZATION,
      'Edit',
      1_700_000_000_000
    );
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');

    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents.toolInputNormalization).toMatchObject({
      reason: 'string-tool-input-as-patch',
      toolName: 'Edit',
    });
  });

  it('does not leak one instance’s normalisation into another', async () => {
    recordToolInputNormalization(
      'wt-1902',
      'copilot',
      'copilot-2',
      EDIT_NORMALIZATION,
      'Edit',
      1_700_000_000_000
    );

    const primary = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');
    const alias = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot-2');

    expect(primary.structuredEvents.toolInputNormalization).toBeNull();
    expect(alias.structuredEvents.toolInputNormalization).toMatchObject({ toolName: 'Edit' });
  });

  it('leaves the rest of the payload untouched', async () => {
    // Frozen for the reason the two `agent-event-state` cases are: this whole-
    // payload equality includes `lastKnownStatusAt` (Issue #1926), which is
    // `Date.now()` read at the poll, so the assertion is time-dependent unless
    // both builds see one instant. Found by auditing for this shape after CI
    // hit it on PR #1964, not by a failure here.
    freezeClock();

    const before = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');
    recordToolInputNormalization(
      'wt-1902',
      'copilot',
      'copilot',
      EDIT_NORMALIZATION,
      'Edit',
      1_700_000_000_000
    );
    const after = await buildCurrentOutput(db, 'wt-1902', 'copilot', 'copilot');

    // Exposure only. Recording a normalisation must not move `sessionStatus`,
    // `isPromptWaiting` or anything else a verdict reads.
    expect({ ...after, structuredEvents: null }).toEqual({ ...before, structuredEvents: null });
    expect({ ...after.structuredEvents, toolInputNormalization: null }).toEqual(
      before.structuredEvents
    );
  });
});
