/**
 * Issue #2046: `POST /api/worktrees/[id]/special-keys` validates against the
 * REQUESTED TOOL'S vocabulary.
 *
 * The keys opencode's TUI is driven by include bare letters — `ctrl+x` then `a`
 * opens its agent list. A letter is a character on the wire, so a global
 * allow-list that accepted `a` would accept it for every tool, and `POST
 * {cliToolId:"claude", keys:["a"]}` would type an `a` into claude's composer.
 * That is the failure this suite exists to keep closed, and it is why the
 * vocabulary became `ICLITool.navigationKeys()`.
 *
 * **This suite uses the REAL `CLIToolManager` and the REAL `isAllowedSpecialKey`.**
 * `tests/unit/special-keys-route.test.ts` and the #2032 suite both stub
 * `getTool`, which means neither of them can see a divergence between what a
 * tool declares and what the route accepts — the same blind spot #2032 was
 * about, one layer up. Only tmux itself is mocked here.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', path: '/tmp/wt-1', branch: 'main' })),
}));

vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

// Partial mock: only what would reach a real tmux server. `isAllowedSpecialKey`
// and `isSendableSpecialKey` stay real, so the validation under test is the
// production one.
vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: vi.fn().mockResolvedValue(true),
    sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
    sendSpecialKeysAndInvalidate: vi.fn().mockResolvedValue(undefined),
  };
});

import { POST } from '@/app/api/worktrees/[id]/special-keys/route';
import { sendSpecialKeysAndInvalidate } from '@/lib/tmux/tmux';

function post(body: unknown) {
  const req = new NextRequest('http://localhost:3000/api/worktrees/wt-1/special-keys', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ id: 'wt-1' }) });
}

beforeEach(() => {
  vi.mocked(sendSpecialKeysAndInvalidate).mockClear();
});

describe('opencode chords reach the transport (Issue #2046)', () => {
  it('forwards the ctrl+x leader chord as TWO array entries in one request', async () => {
    const res = await post({ cliToolId: 'opencode', keys: ['C-x', 'a'] });

    expect(res.status).toBe(200);
    // Two entries, not a pre-joined string: `sendSpecialKeys()` is what puts
    // SPECIAL_KEY_DELAY_MS between them, and opencode's leader_timeout (2000 ms
    // by default on 1.18.22) is what makes that gap acceptable. Measured live at
    // the production 100 ms, 3/3.
    expect(sendSpecialKeysAndInvalidate).toHaveBeenCalledWith(
      expect.stringContaining('opencode'),
      ['C-x', 'a']
    );
  });

  it.each([['C-p'], ['C-t'], ['Tab'], ['BTab'], ['PageUp'], ['End']])(
    'forwards the direct key %s',
    async (key) => {
      const res = await post({ cliToolId: 'opencode', keys: [key] });
      expect(res.status).toBe(200);
    }
  );

  it.each([['a'], ['l'], ['n'], ['m'], ['t'], ['g'], ['u'], ['r'], ['c']])(
    'forwards the chord letter %s for opencode',
    async (letter) => {
      const res = await post({ cliToolId: 'opencode', keys: ['C-x', letter] });
      expect(res.status).toBe(200);
    }
  );
});

describe('another tool cannot be sent an opencode chord (Issue #2046)', () => {
  it.each([
    ['claude', ['C-x', 'a']],
    ['claude', ['a']],
    ['codex', ['C-p']],
    ['gemini', ['C-t']],
    ['copilot', ['C-x']],
    ['vibe-local', ['m']],
    ['antigravity', ['C-x', 'l']],
  ] as const)('answers 400 for %s + %j and never reaches the transport', async (cliToolId, keys) => {
    const res = await post({ cliToolId, keys: [...keys] });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid special key' });
    expect(sendSpecialKeysAndInvalidate).not.toHaveBeenCalled();
  });

  it('still accepts the base pad for those tools — the narrowing took nothing away', async () => {
    for (const cliToolId of ['claude', 'codex', 'gemini', 'copilot', 'vibe-local', 'antigravity']) {
      for (const key of ['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab', 'PageUp', 'PageDown', 'Home', 'End', 'q']) {
        const res = await post({ cliToolId, keys: [key] });
        expect(res.status, `${cliToolId} + ${key}`).toBe(200);
      }
    }
  });
});

describe('the keys #2046 measured and refused stay refused (Issue #2046)', () => {
  it('answers 400 for the sidebar chord `ctrl+x b`, for opencode itself', async () => {
    // Not an oversight: §22.3 of docs/design/opencode-server-live-verification.md.
    // At the 80-column default this chord turns opencode's sidebar on anyway,
    // and the same frame then reads `running` / `unknown_frame` instead of
    // `ready` / `opencode_response_complete`, with the sidebar saved as the
    // reply. The route refuses it so no future caller can reintroduce it by
    // POSTing directly.
    const res = await post({ cliToolId: 'opencode', keys: ['C-x', 'b'] });

    expect(res.status).toBe(400);
    expect(sendSpecialKeysAndInvalidate).not.toHaveBeenCalled();
  });

  it('answers 400 for `F2`, which this Issue could not measure', async () => {
    const res = await post({ cliToolId: 'opencode', keys: ['F2'] });

    expect(res.status).toBe(400);
    expect(sendSpecialKeysAndInvalidate).not.toHaveBeenCalled();
  });

  it('answers 400 for an arbitrary tmux key name, for every tool (injection guard)', async () => {
    for (const cliToolId of ['opencode', 'claude']) {
      for (const key of ['C-c', 'rm -rf /', 'Space', '']) {
        const res = await post({ cliToolId, keys: [key] });
        expect(res.status, `${cliToolId} + ${key}`).toBe(400);
      }
    }
    expect(sendSpecialKeysAndInvalidate).not.toHaveBeenCalled();
  });
});
