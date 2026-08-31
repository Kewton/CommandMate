/**
 * `POST /api/agents/update` (Issue #2069).
 *
 * The invariants here are the same three `/api/app/update` rests on (#1198
 * 決定2), restated for a route that causes a *different* global install:
 *
 *  - a fixed argv that no part of the request body can reach;
 *  - the in-flight lock;
 *  - no route-level auth, and no `AUTH_EXCLUDED_PATHS` entry.
 *
 * The Issue's central claim — the update must run OUTSIDE the agent pane — is
 * NOT assertable from here: a route that also typed into the pane would emit
 * the same `plan` / `output` / `done` stream and every test below would stay
 * green. It is measured structurally instead, by walking this route's
 * transitive import closure, in
 * `tests/unit/updates/agent-update-not-in-pane-2069.test.ts`.
 *
 * The lock moved out of this file in review: `commandmate agents update` and
 * (after #2068) codex's own in-pane `Update now` reach the same global install
 * without passing through this route, so the acquisition lives inside
 * `runAgentUpdate` and what remains here is the READ that picks the status code.
 * That is why the 409 tests below take the lock through the real primitive
 * rather than by starting a first request.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { resolveAgentUpdatePlan, runAgentUpdate, getAgentVersions } = vi.hoisted(() => ({
  resolveAgentUpdatePlan: vi.fn(),
  runAgentUpdate: vi.fn(),
  getAgentVersions: vi.fn(),
}));

vi.mock('@/lib/updates/agent-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/updates/agent-updater')>();
  return { ...actual, resolveAgentUpdatePlan, runAgentUpdate };
});

vi.mock('@/lib/updates/agent-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/updates/agent-versions')>();
  return { ...actual, getAgentVersions };
});

import { NextRequest } from 'next/server';
import { POST, dynamic } from '@/app/api/agents/update/route';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';
import {
  acquireAgentUpdateLock,
  isAgentUpdateInProgress,
  releaseAgentUpdateLock,
} from '@/lib/updates/agent-updater';

const PLAN = {
  tool: 'codex' as const,
  strategy: 'native' as const,
  command: '/opt/isolated/bin/codex',
  args: ['update'] as const,
  display: 'codex update',
  installed: '0.149.0',
  reason: 'native-subcommand' as const,
};

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Drain an NDJSON response body into parsed events. */
async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseAgentUpdateLock('codex');
  resolveAgentUpdatePlan.mockResolvedValue({ ok: true, plan: PLAN });
  runAgentUpdate.mockResolvedValue({ ok: true, exitCode: 0, signal: null });
  getAgentVersions.mockResolvedValue([{ tool: 'codex', installed: '0.151.0' }]);
});

describe('[#2069] POST /api/agents/update — request validation', () => {
  it('is force-dynamic (it spawns a child per request)', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('rejects a tool it has no flow for', async () => {
    const response = await POST(request({ tool: 'claude' }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_tool');
    expect(resolveAgentUpdatePlan).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing body', ''],
    ['a non-object body', '"codex"'],
    ['an array body', '["codex"]'],
    ['a body with no tool', '{}'],
  ])('rejects %s', async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
  });

  it('rejects a shell-shaped tool string rather than passing it on', async () => {
    // The whole defence: the id is validated and then DISCARDED — the argv is a
    // literal selected by it. This asserts the first half; the second half is
    // asserted in agent-updater-2069.test.ts.
    const response = await POST(request({ tool: 'codex; touch /tmp/pwned' }));
    expect(response.status).toBe(400);
    expect(runAgentUpdate).not.toHaveBeenCalled();
  });

  it('reports a machine with nothing to update with as a 400', async () => {
    resolveAgentUpdatePlan.mockResolvedValue({
      ok: false,
      code: 'no-executable',
      message: 'Neither codex nor npm is on PATH.',
    });
    const response = await POST(request({ tool: 'codex' }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('no_executable');
  });
});

describe('[#2069] POST /api/agents/update — the stream', () => {
  it('answers NDJSON, not JSON', async () => {
    const response = await POST(request({ tool: 'codex' }));
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await response.text();
  });

  it('emits plan, every output chunk, then done', async () => {
    runAgentUpdate.mockImplementation(async (_plan, options) => {
      options?.onChunk?.({ stream: 'stdout', text: 'Updating Codex via npm...\n' });
      options?.onChunk?.({ stream: 'stderr', text: 'npm warn\n' });
      return { ok: true, exitCode: 0, signal: null };
    });

    const events = await readEvents(await POST(request({ tool: 'codex' })));

    expect(events[0]).toMatchObject({ type: 'plan', command: 'codex update', installed: '0.149.0' });
    expect(events[1]).toMatchObject({ type: 'output', stream: 'stdout' });
    expect(events[2]).toMatchObject({ type: 'output', stream: 'stderr' });
    expect(events[3]).toMatchObject({
      type: 'done',
      ok: true,
      previousVersion: '0.149.0',
      installed: '0.151.0',
    });
  });

  it('re-probes the installed version after a successful update', async () => {
    await readEvents(await POST(request({ tool: 'codex' })));
    // Forced, because the whole question the caller just asked is whether the
    // version changed — the 30s TTL would answer with the old one.
    expect(getAgentVersions).toHaveBeenCalledWith({ force: true });
  });

  it('does NOT claim a new version when the updater failed', async () => {
    runAgentUpdate.mockResolvedValue({
      ok: false,
      exitCode: 1,
      signal: null,
      error: 'npm ERR! EACCES',
    });

    const events = await readEvents(await POST(request({ tool: 'codex' })));
    const done = events.at(-1);

    expect(done).toMatchObject({ type: 'done', ok: false, error: 'npm ERR! EACCES' });
    expect(done?.installed).toBe('0.149.0');
    expect(getAgentVersions).not.toHaveBeenCalled();
  });

  it('reports a thrown updater as a done event rather than an unhandled rejection', async () => {
    runAgentUpdate.mockRejectedValue(new Error('spawn exploded'));
    const events = await readEvents(await POST(request({ tool: 'codex' })));
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, error: 'spawn exploded' });
  });
});

describe('[#2069] POST /api/agents/update — the lock', () => {
  afterEach(() => releaseAgentUpdateLock('codex'));

  it('answers 409 while any holder has the marker', async () => {
    // Taken through the primitive, which is how the two callers this route
    // cannot see take it: `commandmate agents update` (via `runAgentUpdate`)
    // and #2068's in-pane update path.
    expect(acquireAgentUpdateLock('codex')).toBe(true);

    const response = await POST(request({ tool: 'codex' }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('in_progress');
    // Refused before anything was started.
    expect(runAgentUpdate).not.toHaveBeenCalled();
  });

  it('does not release a lock it never took (the lost-race path)', async () => {
    // The shape this reproduces: the pre-check finds the marker free, and
    // between that read and the run somebody else takes it — the CLI in another
    // process, or #2068 answering codex's in-pane dialog. `runAgentUpdate`
    // then refuses. If this route released in its `finally` it would clear the
    // OTHER holder's marker, and the next double-click would start a second
    // `npm install -g` on top of a running one.
    runAgentUpdate.mockImplementation(async () => {
      acquireAgentUpdateLock('codex'); // the interloper wins the race
      return {
        ok: false,
        exitCode: null,
        signal: null,
        code: 'in_progress' as const,
        error: 'An update for codex is already running.',
      };
    });

    const events = await readEvents(await POST(request({ tool: 'codex' })));

    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
    expect(
      isAgentUpdateInProgress('codex'),
      'the route must not release a marker it never acquired'
    ).toBe(true);
  });

  it('reports a lost race as a done event rather than a broken stream', async () => {
    runAgentUpdate.mockResolvedValue({
      ok: false,
      exitCode: null,
      signal: null,
      code: 'in_progress',
      error: 'An update for codex is already running.',
    });

    const events = await readEvents(await POST(request({ tool: 'codex' })));
    const done = events.at(-1);

    expect(done).toMatchObject({ type: 'done', ok: false });
    expect(done?.error).toContain('already running');
    // No version was claimed for a run that never happened.
    expect(done?.installed).toBe('0.149.0');
    expect(getAgentVersions).not.toHaveBeenCalled();
  });

  it('leaves the marker clear when nothing held it', async () => {
    await readEvents(await POST(request({ tool: 'codex' })));
    expect(isAgentUpdateInProgress('codex')).toBe(false);
  });
});

describe('[#2069] POST /api/agents/update — auth posture', () => {
  it('is not excluded from middleware auth', () => {
    // Auth is middleware's job; this route implements none of its own, so an
    // exclusion entry would make it reachable unauthenticated.
    for (const path of AUTH_EXCLUDED_PATHS) {
      expect(path.startsWith('/api/agents')).toBe(false);
    }
  });
});
