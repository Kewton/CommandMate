/**
 * Issue #4480 (review-4452-3 P3-2): a use of antigravity inside the version list's
 * TTL adds the antigravity row without probing claude and codex again.
 *
 * #4452 made a use (or a declaration) drop the cached list at once so the
 * antigravity row shows without waiting out the TTL — but the drop re-ran every
 * tool's `--version`, one more claude / codex probe than the TTL allows. The
 * detector and the catalog already add only the tool that became probeable; the
 * version list now does the same. After the TTL, and with `force`, every tool is
 * probed as before.
 *
 * Fake binaries only (tests/helpers/fake-agy-path.ts): the real agy never runs.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeAgyPath, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import {
  AGENT_VERSIONS_CACHE_TTL_MS,
  clearAgentVersionsCache,
  getAgentVersions,
} from '@/lib/updates/agent-versions';
import { noteAntigravityUse, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

let fake: FakeAgyPath;

beforeEach(() => {
  fake = installFakeAgyPath();
  clearAgentVersionsCache();
  resetAntigravityUseForTest();
});

afterEach(() => {
  clearAgentVersionsCache();
  resetAntigravityUseForTest();
  fake.restore();
});

describe('[#4480] agents version list after a use', () => {
  it('4480 (I4): a use inside the TTL adds the antigravity row without re-running claude or codex', async () => {
    const before = await getAgentVersions({ now: 1_000 });
    expect(before.find((row) => row.tool === 'antigravity')).toBeUndefined();

    noteAntigravityUse();
    const after = await getAgentVersions({ now: 1_001 });

    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(after.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    // Same rows as before plus antigravity, in the list's order (by tool id).
    expect(after.map((row) => row.tool)).toEqual([...before.map((row) => row.tool), 'antigravity'].sort());
    expect(after.find((row) => row.tool === 'claude')).toEqual(before.find((row) => row.tool === 'claude'));

    // And the merged list is what the cache now answers inside the TTL.
    await getAgentVersions({ now: 1_002 });
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
  });

  it('4480 (I4): concurrent callers right after the use share one agy probe', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();

    const [a, b] = await Promise.all([getAgentVersions({ now: 1_001 }), getAgentVersions({ now: 1_001 })]);

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(a).toEqual(b);
  });

  it('4480: after the TTL every tool is probed again, as before', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();
    await getAgentVersions({ now: 1_001 });

    await getAgentVersions({ now: 1_001 + AGENT_VERSIONS_CACHE_TTL_MS + 1 });

    expect(fake.callsOf('claude')).toEqual(['claude --version', 'claude --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version', 'agy --version']);
  });

  it('4480: force re-probes every tool, as before', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();

    await getAgentVersions({ now: 1_001, force: true });

    expect(fake.callsOf('claude')).toEqual(['claude --version', 'claude --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
  });

  it('4480: without a use or declaration, the cached list is reused and agy never runs', async () => {
    await getAgentVersions({ now: 1_000 });
    await getAgentVersions({ now: 1_001 });

    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('agy')).toEqual([]);
  });
});
