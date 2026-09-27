/**
 * Test helper (Issue #2865): a `session-ownership` module that decides by
 * session NAME only — the pre-#2865 behaviour — for suites written before the
 * `#{session_path}` ownership check existed.
 *
 * Those suites mock `@/lib/tmux/tmux` with factories that carry `hasSession`
 * but not `getSessionWorkingDirectory`, or mock `listSessions` with names only,
 * and assert on what a route or poller does with a session that exists. They
 * are not about ownership; `tests/unit/tmux/session-ownership.test.ts` and the
 * `*-2865` suites are. Use as:
 *
 * ```ts
 * vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
 *   (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
 * );
 * ```
 *
 * `checkSessionOwnership` answers `owned` when the suite's own (mocked)
 * `hasSession` says the session exists, `absent` otherwise — and never reaches
 * a real tmux server: an unmocked `hasSession` counts as "absent".
 */

import { vi } from 'vitest';
import * as tmux from '@/lib/tmux/tmux';
import type * as OwnershipModule from '@/lib/tmux/session-ownership';
import type { SessionOwnership } from '@/lib/tmux/session-ownership';

async function existsByName(sessionName: string): Promise<boolean> {
  try {
    const hasSession = tmux.hasSession;
    // The real implementation shells out to `tmux has-session`; a suite that did
    // not mock it must not reach the operator's tmux server through here.
    if (!vi.isMockFunction(hasSession) && String(hasSession).includes('has-session')) return false;
    return (await hasSession(sessionName)) === true;
  } catch {
    // The suite's tmux mock has no `hasSession` at all.
    return false;
  }
}

export async function nameOnlySessionOwnership(
  importOriginal: <T = unknown>() => Promise<T>
): Promise<typeof OwnershipModule> {
  const actual = await importOriginal<typeof OwnershipModule>();
  return {
    ...actual,
    checkSessionOwnership: vi.fn(
      async (sessionName: string): Promise<SessionOwnership> => ({
        verdict: (await existsByName(sessionName)) ? 'owned' : 'absent',
        sessionPath: null,
      })
    ),
    assertSessionNotForeign: vi.fn(
      async (sessionName: string): Promise<SessionOwnership> => ({
        verdict: (await existsByName(sessionName)) ? 'owned' : 'absent',
        sessionPath: null,
      })
    ),
    ownedSessionNameSet: vi.fn(
      (tmuxSessions: ReadonlyArray<{ name: string }>) => new Set(tmuxSessions.map((s) => s.name))
    ),
  };
}
