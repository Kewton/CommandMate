/**
 * `resolvePermissionRequest` writes the allow's history row only where the
 * allow draws no dialog, and makes a hook request in the ledger only when the
 * hook route gave it an id (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §2.3・§5.1, N2).
 *
 * The verdict is not under test here and does not change: every case below is
 * an `allow`, on every tool.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerLog = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => (name === 'auto-yes-confirmation-ledger' ? ledgerLog : actual.createLogger(name)),
  };
});
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  clearAutoYesPolicyCache: () => {},
}));

import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { AgentEventSource, AgentSourceCapabilities } from '@/lib/hooks/sources/types';
import {
  beginLedgerHookRequest,
  closeLedgerHookRequest,
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WT = 'wt-allow-3820';
const ONE_HOUR_MS = 3_600_000;

const PAYLOAD = parsePermissionRequestPayload({
  hook_event_name: 'PermissionRequest',
  session_id: '00000000-0000-4000-8000-000000000000',
  prompt_id: '11111111-1111-4111-8111-111111111111',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'run the suite' },
});

const session = (cliToolId: CLIToolType) => ({ worktreeId: WT, cliToolId, instanceId: cliToolId });

function withCapabilities<T>(source: AgentEventSource, overrides: Partial<AgentSourceCapabilities>, body: () => T): T {
  const declared = source.capabilities;
  Object.defineProperty(source, 'capabilities', { value: { ...declared, ...overrides }, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(source, 'capabilities', { value: declared, configurable: true });
  }
}

/** Allow on `tool`, and report whether the history row was written. */
function allowWritesRow(tool: CLIToolType): boolean {
  setAutoYesEnabled(WT, tool, true, ONE_HOUR_MS);
  const recordAllow = vi.fn();
  const decision = resolvePermissionRequest(session(tool), PAYLOAD, { recordAllow, readPolicy: () => null });
  expect(decision.behavior).toBe('allow');
  return recordAllow.mock.calls.length === 1;
}

const ledgerLines = () => ledgerLog.info.mock.calls.filter(([name]) => String(name).startsWith('auto-yes-'));

beforeEach(() => {
  vi.clearAllMocks();
  clearAllAutoYesStates();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  clearAllAutoYesStates();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
});

describe('[#3820] the allow history row (design §5.1)', () => {
  it.each(['claude', 'codex', 'copilot', 'opencode', 'opencode-v2'] as const)(
    'is written for %s, as before',
    (tool) => {
      expect(allowWritesRow(tool)).toBe(true);
    }
  );

  it.each(['antigravity', 'command-code', 'gemini'] as const)('is not written for %s', (tool) => {
    expect(allowWritesRow(tool)).toBe(false);
  });

  it('follows the declared capability, not the tool id', () => {
    expect(
      withCapabilities(getAgentEventSource('antigravity'), { permissionAllowSuppressesDialog: true }, () =>
        allowWritesRow('antigravity')
      )
    ).toBe(true);
    expect(
      withCapabilities(getAgentEventSource('claude'), { permissionAllowSuppressesDialog: false }, () =>
        allowWritesRow('claude')
      )
    ).toBe(false);
  });
});

describe('[#3820] the hook request is the hook route’s alone (N2)', () => {
  it('writes no ledger line when called without a hook request id, as the API adjudication calls it', () => {
    allowWritesRow('claude');
    allowWritesRow('antigravity');

    expect(ledgerLines()).toEqual([]);
  });

  it('decides the request it is given, which the route then closes', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    const hookRequestId = beginLedgerHookRequest(session('claude'), Date.now());

    resolvePermissionRequest(session('claude'), PAYLOAD, { recordAllow: () => {}, readPolicy: () => null }, { hookRequestId });
    closeLedgerHookRequest(hookRequestId, { delivered: true });

    const names = ledgerLines().map(([name]) => name);
    expect(names).toContain(EV.hookRequestClosed);
    expect(names).toContain(EV.cliModeObserved);
    expect(names.filter((name) => name === EV.opened)).toHaveLength(1);
  });
});
