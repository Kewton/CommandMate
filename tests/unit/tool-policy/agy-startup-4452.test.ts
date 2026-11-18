/**
 * Issue #4452: a server start, and the requests a freshly opened screen sends right
 * after it, start `agy` 0 times without the usage declaration.
 *
 * The acceptance run's fake-agy calls.log showed `agy --version` "at every start".
 * `server.ts`'s own start sequence runs no version probe; the calls came from the
 * first requests after it. So this pins both halves against the fake agy
 * (tests/helpers/fake-agy-path.ts, private PATH and HOME — the real agy is never run):
 *
 *  1. loading every module `server.ts` loads (static and dynamic imports) runs no
 *     probe at import time, and `server.ts` imports none of the probe modules;
 *  2. the first requests — the pane poll (`/current-output` → detector snapshot),
 *     the slash-command palette (catalog snapshot), the settings card and agent
 *     pane (`/api/agents/versions`), `ask` (`/api/asks/capabilities`) and
 *     `commandmate status` (detector freshness) — start agy 0 times, however often
 *     they are repeated, while claude and codex are still probed (I2).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import {
  installFakeAgyPath,
  settleBackgroundProbes,
  type FakeAgyPath,
} from '@tests/helpers/fake-agy-path';
import { clearAgentVersionsCache } from '@/lib/updates/agent-versions';
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
import { getAskCapabilities } from '@/lib/ask/ask-correlation';
import { resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

const SERVER_SOURCE = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

/** Every `./src/...` module `server.ts` names, static or dynamic. */
const SERVER_MODULES = [...new Set(SERVER_SOURCE.match(/'\.\/src\/[^']+'/g) ?? [])].map((quoted) =>
  quoted.slice(1, -1)
);

let fake: FakeAgyPath;

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

describe('[#4452] server startup', () => {
  // Kept from the first round: a static pin that a startup warm-up cannot be added
  // by importing a probe module straight into server.ts.
  it('4452: server.ts imports none of the version probes', () => {
    for (const probeModule of [
      'updates/agent-versions',
      'slash-command-catalog',
      'detection/version-probes',
      'cli-tools/antigravity',
    ]) {
      expect(SERVER_SOURCE, probeModule).not.toContain(probeModule);
    }
  });

  it('4452: loading every module server.ts loads starts agy 0 times', async () => {
    expect(SERVER_MODULES.length).toBeGreaterThan(10);
    for (const specifier of SERVER_MODULES) {
      await import(/* @vite-ignore */ path.join(process.cwd(), specifier));
    }
    await settleBackgroundProbes();

    expect(fake.callsOf('agy')).toEqual([]);
  });

  it('4452: the first requests after a start (pane poll, palette, versions, ask, status) start agy 0 times', async () => {
    const request = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest;

    for (let round = 0; round < 3; round += 1) {
      getDetectorStalenessSnapshot(); // GET /current-output, every pane, every 5 s
      getCatalogStalenessSnapshot(); // GET /worktrees/:id/slash-commands
      await getVersionsRoute(request); // settings card, agent pane
      await getAskCapabilities(); // GET /api/asks/capabilities
      await getDetectorFreshness(); // commandmate status
      await getCatalogStaleness();
    }
    await settleBackgroundProbes();

    expect(fake.callsOf('agy')).toEqual([]);
    // I2: the other tools are still asked (the detector and catalog tables once
    // each per process; the versions list once inside its TTL).
    expect(fake.callsOf('claude').length).toBeGreaterThan(0);
    expect(fake.callsOf('codex').length).toBeGreaterThan(0);
    expect(fake.callsOf('claude').every((line) => line === 'claude --version')).toBe(true);
  });
});
