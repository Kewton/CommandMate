/**
 * `ANTIGRAVITY_VERIFIED_AGAINST` names the build #2270 measured (Issue #2292).
 *
 * The stamp is "which build were these rules read off", not "which build is
 * installed". #2270 re-read agy's rules off live 1.1.25 panes at the production
 * geometry, but its contract's `scope.allow` did not include
 * `tools/verified-against.ts`, so the stamp stayed at the 0.4-era
 * `0.4.x` / `2026-07-30` / `inline`. The visible consequence was not a
 * misdetection but a permanent lie in the other direction:
 * {@link getDetectorFreshness} compared `1.1.25` against `0.4.0` and
 * `commandmate status` printed "antigravity: installed 1.1.25, rules read off
 * 0.4.x" on every run of a machine whose rules were in fact current.
 *
 * So this file pins the stamp AND both sides of the comparison it feeds. A test
 * that only asserted "antigravity is not stale" would pass just as well if the
 * whole row had been dropped from the probe table, which is why the newer-install
 * direction is pinned next to it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Absolute path → what its `--version` prints. */
let execTable: Record<string, { stdout?: string }> = {};

vi.mock('child_process', () => ({
  execFile: (
    command: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const entry = execTable[command];
    if (!entry) {
      cb(new Error('ENOENT'), '', '');
      return;
    }
    cb(null, entry.stdout ?? '', '');
  },
}));

/** Executable name → absolute path, standing in for the real `PATH` walk. */
let pathTable: Record<string, string> = {};

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  findExecutableOnPath: (name: string): string | null => pathTable[name] ?? null,
  // Every other tool is absent on this fake machine, so only agy answers.
  resolveCopilotExecutable: async () => null,
}));

import {
  clearDetectorVersionProbeCache,
  getDetectorFreshness,
  parseCliVersion,
  parseVerifiedAgainstVersion,
  toDetectorStaleness,
} from '@/lib/detection/version-probes';
import {
  ANTIGRAVITY_VERIFIED_AGAINST,
  DETECTOR_VERIFIED_AGAINST,
} from '@/lib/detection/tools/verified-against';

const AGY = '/opt/fake-prefix/bin/agy';

/** Put `agy --version` on the fake PATH answering `version`, and nothing else. */
function installAgy(version: string): void {
  pathTable = { agy: AGY };
  execTable = { [AGY]: { stdout: version } };
}

/** The antigravity row of a freshly computed freshness report. */
async function antigravityRow() {
  const rows = await getDetectorFreshness();
  const row = rows.find((r) => r.tool === 'antigravity');
  if (!row) throw new Error('antigravity has no row in the freshness report');
  return row;
}

beforeEach(() => {
  execTable = {};
  pathTable = {};
  clearDetectorVersionProbeCache();
});

describe('[#2292] the antigravity stamp names the build #2270 measured', () => {
  it('is agy 1.1.25, captured 2026-09-04 at the production pane geometry', () => {
    // Pinned field by field rather than as a snapshot: each value answers a
    // different question a later reader will ask of it, and #2270's live panes
    // (`tests/unit/status-detector-selection.test.ts`, banner `Antigravity CLI
    // 1.1.25`, 200x1000, 2026-09-04) are the receipt for all three.
    expect(ANTIGRAVITY_VERIFIED_AGAINST.version).toBe('1.1.25');
    expect(ANTIGRAVITY_VERIFIED_AGAINST.capturedAt).toBe('2026-09-04');
    // `inline` was the 0.4-era capture condition. The 1.1.25 permission dialog
    // draws no composer row and only reproduces at the pane the server captures.
    expect(ANTIGRAVITY_VERIFIED_AGAINST.paneGeometry).toBe('200x1000');
  });

  it('is the same object the staleness table serves', () => {
    // The stamp is re-exported by `tools/antigravity/detect.ts` and read here;
    // one copy, so the rules and the freshness report cannot disagree.
    expect(DETECTOR_VERIFIED_AGAINST.antigravity).toBe(ANTIGRAVITY_VERIFIED_AGAINST);
  });
});

describe('[#2292] getDetectorFreshness reads agy 1.1.25 as current', () => {
  it('does not report antigravity as stale when 1.1.25 is installed', async () => {
    installAgy('1.1.25');

    expect(await antigravityRow()).toEqual({
      tool: 'antigravity',
      installed: '1.1.25',
      verifiedAgainst: '1.1.25',
      stale: false,
    });
  });

  it('keeps antigravity out of the wire staleness at 1.1.25', async () => {
    // What `commandmate status` and `capture --json` actually publish: absent,
    // not present-with-stale-false. This is the line the operator stopped seeing.
    installAgy('1.1.25');

    expect(toDetectorStaleness(await getDetectorFreshness()).antigravity).toBeUndefined();
  });

  it('still reports antigravity as stale once the install moves ahead', async () => {
    // The other direction, so "never stale" cannot pass this file. Under the old
    // `0.4.x` stamp both cases were stale and only this one was right.
    installAgy('1.2.0');

    expect(await antigravityRow()).toEqual({
      tool: 'antigravity',
      installed: '1.2.0',
      verifiedAgainst: '1.1.25',
      stale: true,
    });
    expect(toDetectorStaleness(await getDetectorFreshness()).antigravity).toEqual({
      installed: '1.2.0',
      verifiedAgainst: '1.1.25',
    });
  });

  it('does not report an older install as stale either', async () => {
    // 1.1.18 is what the #1929 measurement table recorded. Rules read off a
    // NEWER build than the one installed is not the skew this warning is about.
    installAgy('1.1.18');

    expect((await antigravityRow()).stale).toBe(false);
  });
});

describe('[#2292] the minor-series wildcard branch outlives its last user', () => {
  it('no stamp in the table is written as a wildcard any more', () => {
    // The grep that settled the keep-or-delete question in
    // `parseVerifiedAgainstVersion`'s docstring, as a test rather than as a
    // claim: antigravity's `0.4.x` was the only one, and #2292 replaced it.
    // Reintroducing the format has to be a visible diff to this line.
    const wildcards = Object.entries(DETECTOR_VERIFIED_AGAINST)
      .filter(([, stamp]) => /^\d+\.\d+\.(?:x|\*)$/i.test(stamp.version))
      .map(([tool]) => tool);

    expect(wildcards).toEqual([]);
  });

  it('still widens a wildcard stamp rather than reading it as "no version"', () => {
    // Exercised on the format directly, so the branch does not go vacuous now
    // that no tool uses it. Deleting it would make a future `2.0.x` stamp parse
    // as null and file that tool with `unmeasured` — silently never stale.
    expect(parseCliVersion('2.0.x')).toBeNull();
    expect(parseVerifiedAgainstVersion('2.0.x')).toBe('2.0.0');
    expect(parseVerifiedAgainstVersion('2.0.*')).toBe('2.0.0');
    expect(parseVerifiedAgainstVersion('unmeasured')).toBeNull();
    expect(parseVerifiedAgainstVersion('1.1.25')).toBe('1.1.25');
  });
});
