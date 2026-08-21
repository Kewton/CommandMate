/**
 * Tests for the E2E port rule (Issues #1180, #1771, #1871).
 *
 * The rule is what stops two worktrees verified in parallel from both booting
 * their E2E dev server on 3177 and reporting the loser as a code failure. It is
 * tested here rather than through `playwright.config.ts` because importing that
 * module has side effects — it mkdirs `~/.commandmate-e2e` and shells out to git.
 *
 * `resolveE2EPort` takes its environment as an argument for the same reason:
 * these cases must not depend on, or disturb, the shell the suite runs in.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_E2E_PORT,
  E2E_PORT_ENV,
  FORBIDDEN_PORT,
  WORKTREE_INDEX_ENV,
  resolveE2EPort,
} from '@tests/e2e/fixtures/e2e-port';

describe('Issue #1871: the port is derived from CM_WORKTREE_INDEX', () => {
  it('offsets the base port by the worktree index', () => {
    expect(resolveE2EPort({ [WORKTREE_INDEX_ENV]: '0' })).toBe(DEFAULT_E2E_PORT);
    expect(resolveE2EPort({ [WORKTREE_INDEX_ENV]: '1' })).toBe(DEFAULT_E2E_PORT + 1);
    expect(resolveE2EPort({ [WORKTREE_INDEX_ENV]: '42' })).toBe(DEFAULT_E2E_PORT + 42);
  });

  it('gives two worktrees two different ports', () => {
    // The whole point. Equal ports here is the collision, not a detail of it.
    const a = resolveE2EPort({ [WORKTREE_INDEX_ENV]: '40' });
    const b = resolveE2EPort({ [WORKTREE_INDEX_ENV]: '41' });
    expect(a).not.toBe(b);
  });

  it('defaults to offset 0 when the runner did not set the variable', () => {
    // Required, not cosmetic: without a default every worktree collapses onto
    // one port the moment the variable is missing — the exact collision this
    // derivation exists to remove.
    expect(resolveE2EPort({})).toBe(DEFAULT_E2E_PORT);
    expect(resolveE2EPort({ [WORKTREE_INDEX_ENV]: '' })).toBe(DEFAULT_E2E_PORT);
    expect(resolveE2EPort({ [WORKTREE_INDEX_ENV]: '   ' })).toBe(DEFAULT_E2E_PORT);
  });

  it('refuses a malformed index instead of silently reading it as worktree 0', () => {
    // Falling back to 0 would put every broken-index worktree back on one port
    // and leave nothing in the log to say why.
    for (const bad of ['-1', '1.5', 'abc', '0x10', '1 2']) {
      expect(() => resolveE2EPort({ [WORKTREE_INDEX_ENV]: bad })).toThrow(WORKTREE_INDEX_ENV);
    }
  });

  it('still rejects an index that would push the port out of range', () => {
    expect(() => resolveE2EPort({ [WORKTREE_INDEX_ENV]: '999999' })).toThrow(/between 1024 and 65535/);
  });
});

describe('Issue #1180: an explicit CM_E2E_PORT wins and is validated', () => {
  it('beats the derived port', () => {
    // Explicit beats derived, which is also what makes the Issue #1871 control
    // case expressible: pin both worktrees to one port and watch them collide.
    expect(resolveE2EPort({ [E2E_PORT_ENV]: '3300', [WORKTREE_INDEX_ENV]: '7' })).toBe(3300);
  });

  it('is ignored when empty, so the derived port still applies', () => {
    expect(resolveE2EPort({ [E2E_PORT_ENV]: '', [WORKTREE_INDEX_ENV]: '5' })).toBe(
      DEFAULT_E2E_PORT + 5
    );
  });

  it('rejects a non-integer or out-of-range port', () => {
    for (const bad of ['abc', '80.5', '1023', '65536', '-1']) {
      expect(() => resolveE2EPort({ [E2E_PORT_ENV]: bad })).toThrow(/between 1024 and 65535/);
    }
  });

  it('rejects the live CommandMate port', () => {
    // Pointing E2E at 3000 would drive a developer's real server and its DB.
    expect(() => resolveE2EPort({ [E2E_PORT_ENV]: String(FORBIDDEN_PORT) })).toThrow(
      /must not be 3000/
    );
  });
});
