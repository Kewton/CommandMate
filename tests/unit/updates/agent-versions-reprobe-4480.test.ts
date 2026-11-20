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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeAgyPath, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import {
  AGENT_VERSIONS_CACHE_TTL_MS,
  clearAgentVersionsCache,
  getAgentVersions,
} from '@/lib/updates/agent-versions';
import { noteAntigravityUse, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';
import type { DetectorVersionProbe } from '@/lib/detection/version-probes';

/**
 * The force cases below (review-4480 r2) drive each probe from the test: while
 * `held` is set, `runDetectorVersionProbe` starts no process and answers through
 * {@link held}. Otherwise it is the real one (which runs the fake binaries).
 */
interface HeldProbes {
  (probe: DetectorVersionProbe): Promise<string | null>;
}
const control: { held: HeldProbes | null } = { held: null };
vi.mock('@/lib/detection/version-probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/detection/version-probes')>();
  return {
    ...actual,
    runDetectorVersionProbe: (probe: DetectorVersionProbe) =>
      control.held ? control.held(probe) : actual.runDetectorVersionProbe(probe),
  };
});

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

/**
 * Review-4480 (codex P2-1 / opus P3-2): a forced fetch (`force`, `?refresh=1`, an
 * update just finished) that arrives while the antigravity row is being added must
 * re-probe every tool and return that, and the add must not write its older rows
 * back afterwards.
 *
 * Review-4480 r2 (codex P3-1 / opus P3-2): each probe is controlled from the test
 * — no process, no shared counter, no busy wait. claude and codex answer at once
 * with the version the test set ("updated" mid-way); every antigravity probe is a
 * promise of its own, started and released one by one, and every one is released
 * and settled before the case ends.
 */
describe('[#4480] a forced fetch while the antigravity row is being added (I4\')', () => {
  interface AgyProbe {
    release(): void;
    done: Promise<void>;
  }
  let versions: Record<string, string>;
  let agyProbes: AgyProbe[];
  let probeCalls: string[];
  let started: Array<() => void>;

  const toolOf = async (probe: DetectorVersionProbe): Promise<string> => {
    const { DETECTOR_VERSION_PROBES } = await vi.importActual<typeof import('@/lib/detection/version-probes')>(
      '@/lib/detection/version-probes',
    );
    return Object.entries(DETECTOR_VERSION_PROBES).find(([, p]) => p === probe)?.[0] ?? '?';
  };

  /** Resolves once `count` antigravity probes have started (no polling). */
  const agyStarted = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (agyProbes.length >= count) resolve();
        else started.push(check);
      };
      check();
    });

  const installedOf = (rows: { tool: string; installed: string | null }[], tool: string) =>
    rows.find((row) => row.tool === tool)?.installed;

  beforeEach(() => {
    versions = { claude: '2.1.0', codex: '0.100.0' };
    agyProbes = [];
    probeCalls = [];
    started = [];
    control.held = async (probe) => {
      const tool = await toolOf(probe);
      probeCalls.push(tool);
      if (tool !== 'antigravity') return versions[tool] ?? null;
      let release!: () => void;
      let finish!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const done = new Promise<void>((resolve) => { finish = resolve; });
      agyProbes.push({ release, done });
      for (const wake of started.splice(0)) wake();
      await released;
      finish();
      return '1.1.18';
    };
  });

  afterEach(async () => {
    // Release every held probe and wait for it to end before the sandbox goes.
    for (const probe of agyProbes) probe.release();
    await Promise.all(agyProbes.map((probe) => probe.done));
    control.held = null;
  });

  it('4480 (I4\'): force during the add returns every tool re-probed, and the add does not write its old rows back', async () => {
    const first = await getAgentVersions({ now: 1_000 });
    expect(installedOf(first, 'codex')).toBe('0.100.0');

    noteAntigravityUse();
    const adding = getAgentVersions({ now: 1_001 }); // the add: antigravity probe 1, held
    await agyStarted(1);

    versions = { claude: '2.2.0', codex: '0.101.0' };
    const forced = getAgentVersions({ now: 1_002, force: true }); // full: antigravity probe 2, held
    await agyStarted(2);
    agyProbes[1].release();
    const forcedRows = await forced;

    expect(installedOf(forcedRows, 'claude')).toBe('2.2.0');
    expect(installedOf(forcedRows, 'codex')).toBe('0.101.0');
    expect(installedOf(forcedRows, 'antigravity')).toBe('1.1.18');

    // Only now does the add's probe end (after the forced fetch wrote its rows).
    agyProbes[0].release();
    await adding;

    // The next plain fetch inside the TTL answers the forced rows, not the add's.
    const next = await getAgentVersions({ now: 1_003 });
    expect(installedOf(next, 'claude')).toBe('2.2.0');
    expect(installedOf(next, 'codex')).toBe('0.101.0');
    expect(probeCalls.filter((tool) => tool === 'claude')).toHaveLength(2);
  });

  it('4480 (I4\'): clearing the cache during the add keeps the add from writing its old rows back', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();
    const adding = getAgentVersions({ now: 1_001 });
    await agyStarted(1);

    clearAgentVersionsCache();
    versions = { claude: '2.1.0', codex: '0.101.0' };
    agyProbes[0].release();
    await adding;

    const next = getAgentVersions({ now: 1_002 }); // a full fetch: antigravity probe 2
    await agyStarted(2);
    agyProbes[1].release();
    expect(installedOf(await next, 'codex')).toBe('0.101.0');
  });
});
