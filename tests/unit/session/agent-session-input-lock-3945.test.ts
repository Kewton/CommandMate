/**
 * Issue #3945 (review #7): a session that is (re)created is a new composer. The
 * agent session start boundary (`beginAgentSession`) expires the old one's
 * carried paste mark, its waiting sends and an in-flight owner's ticket — while
 * a send that relaunches its own pane keeps its own ticket.
 *
 * @vitest-environment node
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session/session-generation-archive', () => ({
  archiveSupersededSessionMessages: vi.fn(),
}));

import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import {
  InstanceInputSessionReplacedError,
  getCarriedPasteMark,
  leaveCarriedPasteMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const TARGET = { worktreeId: 'wt-3945', cliToolId: 'codex' as const };

describe('beginAgentSession expires the old composer\'s input state (Issue #3945)', () => {
  beforeEach(() => resetInstanceInputLocks());
  afterEach(() => resetInstanceInputLocks());

  it('drops the mark, rejects the waiters and revokes the in-flight owner', async () => {
    const session = resolveSessionName(TARGET.cliToolId, TARGET.worktreeId);
    let release!: () => void;
    let owner: { isCurrent(): boolean } | null = null;
    const held = withInstanceInputLock(session, async (ticket) => {
      owner = ticket;
      leaveCarriedPasteMark(ticket);
      await new Promise<void>((resolve) => (release = resolve));
    });
    const waiter = withInstanceInputLock(session, async () => 'typed').catch((error: unknown) => error);
    await Promise.resolve();

    beginAgentSession(TARGET);

    expect(await waiter).toBeInstanceOf(InstanceInputSessionReplacedError);
    expect(owner!.isCurrent()).toBe(false);
    expect(getCarriedPasteMark(session)).toBeNull();
    release();
    await held;
  });

  it('negative: another instance of the same worktree is untouched', async () => {
    const other = resolveSessionName(TARGET.cliToolId, TARGET.worktreeId, 'codex-2');
    await withInstanceInputLock(other, async (ticket) => leaveCarriedPasteMark(ticket));
    beginAgentSession(TARGET);
    expect(getCarriedPasteMark(other)).not.toBeNull();
  });

  it('a send relaunching its own pane keeps its ticket', async () => {
    const session = resolveSessionName(TARGET.cliToolId, TARGET.worktreeId);
    await withInstanceInputLock(session, async (ticket) => {
      beginAgentSession(TARGET);
      expect(ticket.isCurrent()).toBe(true);
    });
  });
});
