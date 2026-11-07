/**
 * `relays` prints why the last delivery attempt stopped (Issue #4105).
 *
 * The same relay is read through the list and through `--id`, text and JSON:
 * the text line carries `pending=<kind>` and `blocked=<reason>@<iso>`, JSON is
 * the API's answer as is. An older server (no field) and `null` print nothing —
 * neither is "deliverable". Positive cases fail before the change (the line
 * had no such columns); the negative controls pass before and after.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const RELAY_ID = '11111111-2222-4333-8444-555555555555';
const OBSERVED = Date.UTC(2026, 10, 6, 1, 2, 3);
const COUNTS = { pending: 1, delivered: 0, prompt: 0, expired: 0, cancelled: 0 };

function relay(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELAY_ID,
    from: { worktreeId: 'wt-a', instanceId: 'claude' },
    to: { worktreeId: 'wt-b', instanceId: 'codex' },
    state: 'pending',
    hops: 1,
    sentRequestId: null,
    pendingKind: 'reply',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: OBSERVED + 1000,
    deliveredAt: null,
    deliveryHold: null,
    ...overrides,
  };
}

const BLOCK = { reason: 'prompt_waiting', kind: 'reply', payloadId: 'p1', observedAt: OBSERVED };

function serve(one: Record<string, unknown>): void {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    let data: unknown = {};
    if (url.includes(`/api/relays/${RELAY_ID}`)) data = { relay: one };
    else if (url.includes('/api/relays')) {
      data = { owed: [], awaiting: [one], open: [one], held: [], counts: COUNTS, heldCount: 0 };
    } else if (url.includes('/api/worktrees/wt-a')) {
      data = { worktree: { id: 'wt-a', cliToolId: 'claude' }, cliToolId: 'claude', instanceId: 'claude' };
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
}

const logged = () => mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');

async function relays(argv: string[]) {
  const { createRelaysCommand } = await import('../../../../src/cli/commands/relays');
  await createRelaysCommand().parseAsync(['node', 'relays', ...argv]);
}

describe('relays --id (Issue #4105)', () => {
  it('text: pending= and blocked=<reason>@<iso>', async () => {
    serve(relay({ lastDeliveryBlock: BLOCK }));
    await relays(['--id', RELAY_ID]);
    const line = logged();
    expect(line).toContain('pending=reply');
    expect(line).toContain(`blocked=prompt_waiting@${new Date(OBSERVED).toISOString()}`);
    // Not one of the ledger's own hold columns.
    expect(line).not.toContain('hold=');
    expect(line).not.toContain('delivery=');
  });

  it('JSON: the field as the API answered it', async () => {
    serve(relay({ lastDeliveryBlock: BLOCK }));
    await relays(['--id', RELAY_ID, '--json']);
    expect(JSON.parse(logged()).relay.lastDeliveryBlock).toEqual(BLOCK);
  });

  it('negative controls: null and an older server (absent) print no blocked=', async () => {
    for (const overrides of [{ lastDeliveryBlock: null }, {}]) {
      mockConsoleLog.mockClear();
      serve(relay(overrides));
      await relays(['--id', RELAY_ID]);
      expect(logged()).not.toContain('blocked=');
      expect(logged()).toContain('pending=reply');
    }
  });

  it('a held payload keeps its own payload= column instead of pending=', async () => {
    serve(
      relay({
        deliveryHold: {
          state: 'uncertain',
          payloadId: 'p1',
          attemptId: 't1',
          kind: 'reply',
          reason: 'send-error',
          at: 1,
          checkCommand: 'commandmate capture wt-a --instance claude --pane',
        },
      })
    );
    await relays(['--id', RELAY_ID]);
    expect(logged()).toContain('payload=reply:p1');
    expect(logged()).not.toContain('pending=');
  });
});

describe('relays list (Issue #4105)', () => {
  it('the listed line says the same as --id for the same relay', async () => {
    serve(relay({ lastDeliveryBlock: BLOCK }));
    await relays([]);
    const listed = logged();
    mockConsoleLog.mockClear();
    await relays(['--id', RELAY_ID]);
    const one = logged();
    expect(listed).toContain(`blocked=prompt_waiting@${new Date(OBSERVED).toISOString()}`);
    expect(listed.split('\n').find((l) => l.startsWith(RELAY_ID))).toBe(one);
  });

  it('--help documents the columns and the wording of `prompt`', async () => {
    const { createRelaysCommand } = await import('../../../../src/cli/commands/relays');
    let help = '';
    const cmd = createRelaysCommand();
    cmd.configureOutput({ writeOut: (text) => { help += text; } });
    cmd.outputHelp();
    expect(help).toContain('blocked=<reason>@<iso>');
    expect(help).toContain('prompt_waiting');
    expect(help).not.toContain('the requester was told');
  });
});
