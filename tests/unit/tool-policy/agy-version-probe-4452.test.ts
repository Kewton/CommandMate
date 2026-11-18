/**
 * Issue #4452: nothing the user did not aim at antigravity may start `agy`.
 *
 * Before this Issue the agents version list (`GET /api/agents/versions`, the
 * settings card and the agent pane, and `GET /api/asks/capabilities` through the
 * same fan-out), the slash-command catalog's staleness probe and the detector's
 * freshness probe (the pane poll `GET /current-output`, `commandmate status`) ran
 * `agy --version` next to `claude --version` / `codex --version` on the first
 * requests after every server start. The rule now: antigravity's version is read
 * only with the usage declaration (`CM_ANTIGRAVITY_USAGE=api-key|enterprise`) or
 * after antigravity was used in this process (a launch or a send).
 *
 * Every probe here is a real child process, but of a FAKE binary
 * (tests/helpers/fake-agy-path.ts): `PATH` holds only a private directory whose
 * `agy` / `claude` / `codex` record their argv, and `HOME` is private too. The real
 * agy is never run and `~/.gemini` is never read (I4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  installFakeAgyPath,
  settleBackgroundProbes,
  type FakeAgyPath,
} from '@tests/helpers/fake-agy-path';
import { clearAgentVersionsCache, getAgentVersions } from '@/lib/updates/agent-versions';
import {
  clearCatalogCache,
  getCatalogStaleness,
  getCatalogStalenessSnapshot,
} from '@/lib/slash-command-catalog';
import {
  clearDetectorVersionProbeCache,
  getDetectorFreshness,
  getDetectorStalenessSnapshot,
} from '@/lib/detection/version-probes';
import { GET as getVersionsRoute } from '@/app/api/agents/versions/route';
import { noteAntigravityUse, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

let fake: FakeAgyPath;
const callsOf = (name: string): string[] => fake.callsOf(name);

function clearAllCaches(): void {
  clearAgentVersionsCache();
  clearCatalogCache();
  clearDetectorVersionProbeCache();
  resetAntigravityUseForTest();
}

beforeEach(() => {
  fake = installFakeAgyPath();
  clearAllCaches();
});

afterEach(() => {
  clearAllCaches();
  fake.restore();
});

describe('[#4452] agents version list (lib/updates/agent-versions)', () => {
  it('4452: without the declaration, agy is started 0 times and antigravity has no row', async () => {
    const rows = await getAgentVersions({ force: true });

    expect(callsOf('agy')).toEqual([]);
    expect(rows.find((row) => row.tool === 'antigravity')).toBeUndefined();
  });

  it('4452 (I2): claude and codex are still probed once each with `--version`', async () => {
    const rows = await getAgentVersions({ force: true });

    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
    expect(rows.find((row) => row.tool === 'claude')?.installed).toBe('2.1.0');
    expect(rows.find((row) => row.tool === 'codex')?.installed).toBe('0.100.0');
  });

  it.each(['api-key', 'enterprise', ' api-key '])(
    '4452 (I3): with CM_ANTIGRAVITY_USAGE=%j the antigravity version is returned',
    async (declaration) => {
      process.env.CM_ANTIGRAVITY_USAGE = declaration;
      const rows = await getAgentVersions({ force: true });

      expect(callsOf('agy')).toEqual(['agy --version']);
      expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    }
  );

  it.each(['API-KEY', 'yes', 'true', 'apikey', 'personal', ''])(
    '4452: CM_ANTIGRAVITY_USAGE=%j (not api-key / enterprise) starts agy 0 times',
    async (declaration) => {
      process.env.CM_ANTIGRAVITY_USAGE = declaration;
      const rows = await getAgentVersions({ force: true });

      expect(callsOf('agy')).toEqual([]);
      expect(rows.find((row) => row.tool === 'antigravity')).toBeUndefined();
    }
  );

  it('4452 (I3): after antigravity is used in this process, its version is returned', async () => {
    noteAntigravityUse();

    const rows = await getAgentVersions({ force: true });

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
  });

  it('4452 (I3): a use drops the cached list, so the row shows at once (not after the TTL)', async () => {
    const before = await getAgentVersions({ now: 1_000 });
    expect(before.find((row) => row.tool === 'antigravity')).toBeUndefined();

    noteAntigravityUse();
    // Well inside the TTL: the cached rows would be returned without the use.
    const after = await getAgentVersions({ now: 1_001 });

    expect(after.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    expect(callsOf('agy')).toEqual(['agy --version']);
  });
});

describe('[#4452] GET /api/agents/versions', () => {
  const request = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest;

  it('4452: without the declaration, the route starts agy 0 times', async () => {
    const response = await getVersionsRoute(request);
    const body = (await response.json()) as { tools: { tool: string }[] };

    expect(response.status).toBe(200);
    expect(callsOf('agy')).toEqual([]);
    expect(body.tools.map((row) => row.tool)).not.toContain('antigravity');
    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
  });

  it('4452 (I3): with the declaration, the route returns the antigravity version', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
    const response = await getVersionsRoute(request);
    const body = (await response.json()) as { tools: { tool: string; installed: string | null }[] };

    expect(body.tools.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    expect(callsOf('agy')).toEqual(['agy --version']);
  });
});

describe('[#4452] slash-command catalog staleness (lib/slash-command-catalog)', () => {
  it('4452: without the declaration, the catalog probe starts agy 0 times', async () => {
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual([]);
    expect(staleness.antigravity).toBeUndefined();
  });

  it('4452 (I2): claude and codex are still probed once each with `--version`', async () => {
    const staleness = await getCatalogStaleness();

    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
    expect(staleness.claude?.current).toBe('2.1.0');
    expect(staleness.codex?.current).toBe('0.100.0');
  });

  it('4452 (I3): with the declaration, the antigravity version is returned', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'enterprise';
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(staleness.antigravity?.current).toBe('1.1.18');
  });

  it('4452 (I3): a use after the cache was filled adds antigravity without re-probing the others', async () => {
    await getCatalogStaleness();
    expect(callsOf('agy')).toEqual([]);

    noteAntigravityUse();
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(staleness.antigravity?.current).toBe('1.1.18');
    // I2: claude and codex were not asked a second time.
    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
  });

  // The slash-commands route reads the SNAPSHOT, not the awaiting entry point.
  it('4452: the snapshot (the route\'s entry point) starts agy 0 times however often it is called', async () => {
    for (let i = 0; i < 5; i += 1) getCatalogStalenessSnapshot();
    await getCatalogStaleness(); // joins the background probe the first snapshot started
    for (let i = 0; i < 5; i += 1) getCatalogStalenessSnapshot();
    await getCatalogStaleness();

    expect(callsOf('agy')).toEqual([]);
    expect(callsOf('claude')).toEqual(['claude --version']);
  });

  it('4452 (I3): after a use, the snapshot probes agy once in the background, and only once', async () => {
    getCatalogStalenessSnapshot();
    await getCatalogStaleness();
    expect(callsOf('agy')).toEqual([]);

    noteAntigravityUse();
    // Only the snapshot from here on: the awaiting entry point would probe on its own.
    getCatalogStalenessSnapshot(); // warm cache + newly probeable tool → background probe
    getCatalogStalenessSnapshot(); // joins the same in-flight probe
    await vi.waitFor(() => expect(getCatalogStalenessSnapshot().antigravity?.current).toBe('1.1.18'));
    for (let i = 0; i < 5; i += 1) getCatalogStalenessSnapshot();
    await settleBackgroundProbes();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(callsOf('claude')).toEqual(['claude --version']);
  });
});

describe('[#4452] detector freshness (lib/detection/version-probes: pane poll, `commandmate status`)', () => {
  it('4452: without the declaration, getDetectorFreshness starts agy 0 times and has no antigravity row', async () => {
    const rows = await getDetectorFreshness();

    expect(callsOf('agy')).toEqual([]);
    expect(rows.find((row) => row.tool === 'antigravity')).toBeUndefined();
  });

  it('4452 (I2): claude and codex are still probed once each with `--version`', async () => {
    const rows = await getDetectorFreshness();

    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
    expect(rows.find((row) => row.tool === 'claude')?.installed).toBe('2.1.0');
    // Rows stay sorted by tool id, as before.
    const tools = rows.map((row) => row.tool);
    expect(tools).toEqual([...tools].sort());
  });

  it('4452 (I3): with the declaration, the antigravity row carries its version', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
    const rows = await getDetectorFreshness();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
  });

  it('4452: the snapshot starts agy 0 times however often it is called', async () => {
    for (let i = 0; i < 5; i += 1) getDetectorStalenessSnapshot();
    await getDetectorFreshness();
    for (let i = 0; i < 5; i += 1) getDetectorStalenessSnapshot();
    await getDetectorFreshness();

    expect(callsOf('agy')).toEqual([]);
    expect(callsOf('claude')).toEqual(['claude --version']);
  });

  it('4452 (I3): after a use, the snapshot probes agy alone in the background, once', async () => {
    await getDetectorFreshness();
    expect(callsOf('agy')).toEqual([]);

    noteAntigravityUse();
    // Only the snapshot until the probe has run: the awaiting entry point would probe on its own.
    getDetectorStalenessSnapshot();
    getDetectorStalenessSnapshot();
    await vi.waitFor(() => expect(callsOf('agy')).toEqual(['agy --version']));
    await settleBackgroundProbes();
    for (let i = 0; i < 5; i += 1) getDetectorStalenessSnapshot();
    await settleBackgroundProbes();
    const rows = await getDetectorFreshness(); // the cache now holds antigravity: no new probe

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
  });
});
