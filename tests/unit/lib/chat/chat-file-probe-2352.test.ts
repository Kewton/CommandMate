/**
 * The file-existence probe both chat surfaces share (Issue #2352).
 *
 * #2274 put this probe inside `ChatTranscript.tsx` as a private function, and
 * #2352 moved it here so the History column can ask the same question. Moving
 * code is the moment it is easiest to change it by accident, so this file pins
 * the two things a caller depends on:
 *
 *  1. the request is the one the file panel would make — same URL, `HEAD`,
 *     `cache: 'no-store'` — because a probe that is less capable than the open
 *     it gates is a second, differently-wrong opinion about which paths work;
 *  2. the status → verdict table is exactly `404 / 400 / 403 → 'missing'` and
 *     everything else `'unknown'`. Widening it (500 → "not here") would hide an
 *     internal error behind a not-found toast — the trap #2349 named.
 *
 * `fetch` is injected, so none of this touches the network or a global.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chatFileProbeUrl,
  classifyChatFileProbeResponse,
  probeChatFilePath,
  type ChatFileProbeFetch,
} from '@/lib/chat/chat-file-probe';

const WORKTREE_ID = 'commandagent-develop';

/** A fetch stand-in that answers every request with `response`. */
function answering(response: { ok: boolean; status: number }): ReturnType<typeof vi.fn> & ChatFileProbeFetch {
  return vi.fn().mockResolvedValue(response) as ReturnType<typeof vi.fn> & ChatFileProbeFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('[#2352] chatFileProbeUrl builds the file panel’s own URL', () => {
  it('encodes segment by segment and keeps the separators', () => {
    expect(chatFileProbeUrl(WORKTREE_ID, 'docs/design notes/a.md')).toBe(
      '/api/worktrees/commandagent-develop/files/docs/design%20notes/a.md',
    );
  });

  it('encodes the worktree id as one component', () => {
    expect(chatFileProbeUrl('a/b', 'x.md')).toBe('/api/worktrees/a%2Fb/files/x.md');
  });

  it('leaves an absolute path with its leading slash, as the panel does', () => {
    // #2345 hands the probe a worktree-RELATIVE path whenever it knows the
    // root; when it does not, the absolute path goes through verbatim, exactly
    // as `FilePanelContent` would send it. The probe does not second-guess.
    expect(chatFileProbeUrl(WORKTREE_ID, '/private/tmp/x.md')).toBe(
      '/api/worktrees/commandagent-develop/files//private/tmp/x.md',
    );
  });
});

describe('[#2352] probeChatFilePath asks with HEAD and no cache', () => {
  it('sends exactly the request the file panel would, as a HEAD', async () => {
    const fetchImpl = answering({ ok: true, status: 200 });
    await probeChatFilePath(WORKTREE_ID, 'workspace/tmp/notes.md', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/worktrees/commandagent-develop/files/workspace/tmp/notes.md',
      { method: 'HEAD', cache: 'no-store' },
    );
  });

  it('goes through the injected fetch and never the global one', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const fetchImpl = answering({ ok: true, status: 200 });

    await probeChatFilePath(WORKTREE_ID, 'a.md', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('falls back to the global fetch, resolved at call time', async () => {
    // The default is what both surfaces use in production. It must be read
    // when the probe runs, not when the module loaded, or a test that stubs
    // `fetch` (every component suite does) would hit the real one.
    const globalFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', globalFetch);

    await expect(probeChatFilePath(WORKTREE_ID, 'a.md')).resolves.toBe('missing');
    expect(globalFetch).toHaveBeenCalledWith(
      '/api/worktrees/commandagent-develop/files/a.md',
      { method: 'HEAD', cache: 'no-store' },
    );
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('[#2352] the status → verdict table is unchanged from #2274', () => {
  it.each([
    [200, 'present'],
    [204, 'present'],
  ])('%i → %s', (status, verdict) => {
    expect(classifyChatFileProbeResponse({ ok: true, status })).toBe(verdict);
  });

  it.each([
    [404, 'nothing is at that path, or it is a directory'],
    [400, 'the path is outside this worktree'],
    [403, 'the path is deny-tier (#2014)'],
  ])('%i → missing (%s)', (status) => {
    expect(classifyChatFileProbeResponse({ ok: false, status })).toBe('missing');
  });

  it.each([
    [401, 'not signed in — the panel says so itself'],
    [405, 'HEAD not routed — the GET may still work'],
    [429, 'rate limited'],
    [500, 'a server error is not evidence of absence'],
    [502, 'a gateway error is not evidence of absence'],
    [503, 'unavailable'],
    [0, 'an opaque response'],
  ])('%i → unknown (%s)', (status) => {
    // This is the line #2349 is about: a 500 shown as "not in this worktree"
    // would hide the internal error the panel would otherwise report.
    expect(classifyChatFileProbeResponse({ ok: false, status })).toBe('unknown');
  });

  it('is what probeChatFilePath returns for the same statuses', async () => {
    for (const [status, ok, verdict] of [
      [200, true, 'present'],
      [404, false, 'missing'],
      [400, false, 'missing'],
      [403, false, 'missing'],
      [500, false, 'unknown'],
      [502, false, 'unknown'],
    ] as const) {
      await expect(
        probeChatFilePath(WORKTREE_ID, 'a.md', answering({ ok, status })),
        `status ${status}`,
      ).resolves.toBe(verdict);
    }
  });

  it('is unknown when the request rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network down')) as ChatFileProbeFetch;
    await expect(probeChatFilePath(WORKTREE_ID, 'a.md', fetchImpl)).resolves.toBe('unknown');
  });

  it('is unknown when the transport throws before returning a promise', async () => {
    const fetchImpl = (() => {
      throw new Error('no fetch here');
    }) as unknown as ChatFileProbeFetch;
    await expect(probeChatFilePath(WORKTREE_ID, 'a.md', fetchImpl)).resolves.toBe('unknown');
  });
});
