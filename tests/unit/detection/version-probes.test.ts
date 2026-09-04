/**
 * `DETECTOR_VERSION_PROBES` — the receipts §13.2 S17 asks for (Issue #1929).
 *
 * Four properties are pinned here, and every one of them is a property some
 * plausible implementation gets wrong:
 *
 *  1. **Absolute-path resolution** (DR4-010 (2)). A probe that hands `execFile`
 *     the bare word `opencode` lets whatever is first on the server's `PATH` —
 *     including a worktree's own `node_modules/.bin` — decide what runs with the
 *     server's privileges.
 *  2. **Skip, do not fall back.** When nothing resolves, the probe must spawn
 *     *nothing* and report nothing, rather than trying the bare name.
 *  3. **copilot is delegated.** The design's first draft spelled this row
 *     `gh copilot -- --version`; gh's own help says that command DOWNLOADS the
 *     CLI when `PATH` has none. The mutation test below shows that spelling
 *     really would spawn `gh`, so the guards against it are not vacuous.
 *  4. **The hot path never awaits a child.** `capture --json` polls every 5
 *     seconds with no iteration cap, so `getDetectorStalenessSnapshot()` has to
 *     answer synchronously even when every probe hangs.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ExecCall {
  command: string;
  args: string[];
  opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv };
}

let execCalls: ExecCall[] = [];
/** Absolute path → what its `--version` prints (or an error). */
let execTable: Record<string, { stdout?: string; error?: boolean }> = {};
/** When true the mocked execFile never calls back, standing in for a hung CLI. */
let execHangs = false;

vi.mock('child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    opts: ExecCall['opts'],
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    execCalls.push({ command, args, opts });
    if (execHangs) return; // never calls back
    const entry = execTable[command];
    if (!entry || entry.error) {
      cb(new Error('ENOENT'), '', '');
      return;
    }
    cb(null, entry.stdout ?? '', '');
  },
}));

/** Executable name → absolute path, standing in for the real `PATH` walk. */
let pathTable: Record<string, string> = {};
let copilotVersion: string | null = null;

const findExecutableOnPathMock = vi.fn((name: string): string | null => pathTable[name] ?? null);
const resolveCopilotExecutableMock = vi.fn(async () =>
  copilotVersion
    ? { path: '/opt/homebrew/bin/copilot', version: copilotVersion, source: 'path' as const }
    : null
);

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  findExecutableOnPath: (name: string) => findExecutableOnPathMock(name),
  resolveCopilotExecutable: () => resolveCopilotExecutableMock(),
}));

import {
  DETECTOR_VERSION_PROBES,
  clearDetectorVersionProbeCache,
  compareCliVersions,
  getDetectorFreshness,
  getDetectorStalenessSnapshot,
  parseCliVersion,
  parseVerifiedAgainstVersion,
  runDetectorVersionProbe,
  toDetectorStaleness,
  DETECTOR_VERSION_PROBE_TIMEOUT_MS,
} from '@/lib/detection/version-probes';
import { DETECTOR_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { TOOL_STATUS_DETECTORS } from '@/lib/detection/tools/registry';
import { SENSITIVE_ENV_KEYS } from '@/lib/security/env-sanitizer';

/** Absolute path the fake PATH walk hands back for `name`. */
const abs = (name: string) => `/opt/fake-prefix/bin/${name}`;

/** Put every execFile-kind probe on the fake PATH, answering `stdout`. */
function installEveryProbe(stdout: Record<string, string>): void {
  for (const [tool, probe] of Object.entries(DETECTOR_VERSION_PROBES)) {
    if (probe.kind !== 'execFile') continue;
    pathTable[probe.command] = abs(probe.command);
    if (stdout[tool] !== undefined) execTable[abs(probe.command)] = { stdout: stdout[tool] };
  }
}

beforeEach(() => {
  execCalls = [];
  execTable = {};
  execHangs = false;
  pathTable = {};
  copilotVersion = null;
  findExecutableOnPathMock.mockClear();
  resolveCopilotExecutableMock.mockClear();
  clearDetectorVersionProbeCache();
});

// --- The table itself -------------------------------------------------------

describe('[#1929] DETECTOR_VERSION_PROBES', () => {
  it('covers every tool that has a detector, except vibe-local', () => {
    // Pinned by equality: adding or dropping a probe has to be a visible diff,
    // because a tool silently missing from this table is a tool whose staleness
    // is silently never reported.
    expect(Object.keys(DETECTOR_VERSION_PROBES).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'command-code',
      'copilot',
      'gemini',
      'opencode',
    ]);

    const detectorTools = TOOL_STATUS_DETECTORS.map((d) => d.tool).sort();
    const unprobed = detectorTools.filter((tool) => !(tool in DETECTOR_VERSION_PROBES));
    // vibe-local is not an external CLI, so there is nothing to probe (§4 D2).
    expect(unprobed).toEqual(['vibe-local']);
  });

  it('probes antigravity as `agy` — the tool id is not the executable name', () => {
    const probe = DETECTOR_VERSION_PROBES.antigravity;
    expect(probe.kind).toBe('execFile');
    expect(probe.kind === 'execFile' && probe.command).toBe('agy');
  });

  it('reads its baseline from the same objects the detectors carry', () => {
    // The anti-drift guard for splitting the stamps out of the tool modules:
    // a detector and this table cannot disagree because they are the same
    // object, and this test fails the moment somebody re-inlines one.
    for (const detector of TOOL_STATUS_DETECTORS) {
      expect(detector.verifiedAgainst, detector.tool).toBe(
        DETECTOR_VERIFIED_AGAINST[detector.tool]
      );
    }
  });
});

// --- S17 (1): absolute-path resolution --------------------------------------

describe('[#1929][S17] probe execution resolves an absolute path first', () => {
  it('never hands execFile a bare command name', async () => {
    installEveryProbe({ claude: '2.1.240', codex: 'codex-cli 0.148.0' });

    await getDetectorFreshness();

    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      expect(call.command, `${call.command} was not resolved to an absolute path`).toMatch(/^\//);
    }
    // The bare names the table declares must not appear as a command.
    for (const probe of Object.values(DETECTOR_VERSION_PROBES)) {
      if (probe.kind !== 'execFile') continue;
      expect(execCalls.some((call) => call.command === probe.command)).toBe(false);
    }
    expect(findExecutableOnPathMock).toHaveBeenCalledWith('claude');
  });

  it('skips a probe whose command does not resolve, spawning nothing at all', async () => {
    // Nothing on PATH, no copilot anywhere: the machine §4 D2's default is
    // written for.
    const rows = await getDetectorFreshness();

    expect(execCalls, 'a probe spawned a child on a machine with no CLIs').toHaveLength(0);
    expect(rows.every((row) => row.installed === null)).toBe(true);
    expect(rows.every((row) => row.stale === false)).toBe(true);
    expect(toDetectorStaleness(rows)).toEqual({});
  });

  it('does not fall back to the bare name when only some commands resolve', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: '2.1.240' } };

    await getDetectorFreshness();

    expect(execCalls.map((call) => call.command)).toEqual([abs('claude')]);
  });
});

// --- S17 (2): copilot is delegated ------------------------------------------

describe('[#1929][S17] copilot delegates to resolveCopilotExecutable', () => {
  it('declares copilot as a delegated probe, not an execFile row', () => {
    expect(DETECTOR_VERSION_PROBES.copilot.kind).toBe('delegated');
  });

  it('spells no probe as `gh`, and passes `copilot` to no other binary', () => {
    // The exact mutation §13.2 S17 names: `gh copilot -- --version`. gh's own
    // help says it DOWNLOADS the Copilot CLI when PATH has none, so a version
    // hint written this way installs software (DR4-010 (5) / #1979).
    for (const [tool, probe] of Object.entries(DETECTOR_VERSION_PROBES)) {
      if (probe.kind !== 'execFile') continue;
      expect(probe.command, `${tool} probes through gh`).not.toBe('gh');
      expect(
        [...probe.args],
        `${tool} passes \`copilot\` as an argument to another binary`
      ).not.toContain('copilot');
    }
  });

  it('reads copilot through the resolver, never through a child process', async () => {
    copilotVersion = '1.0.80';

    const rows = await getDetectorFreshness();

    expect(resolveCopilotExecutableMock).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.tool === 'copilot')?.installed).toBe('1.0.80');
    expect(execCalls, 'the copilot probe spawned a child from this module').toHaveLength(0);
    expect(findExecutableOnPathMock).not.toHaveBeenCalledWith('gh');
  });

  it('reports copilot as absent — never as an error — when nothing resolves', async () => {
    copilotVersion = null;

    const rows = await getDetectorFreshness();
    const snapshot = getDetectorStalenessSnapshot();

    expect(rows.find((row) => row.tool === 'copilot')).toEqual({
      tool: 'copilot',
      installed: null,
      verifiedAgainst: DETECTOR_VERIFIED_AGAINST.copilot.version,
      stale: false,
    });
    expect(snapshot?.copilot).toBeUndefined();
    expect(execCalls).toHaveLength(0);
  });

  it('survives a resolver that rejects', async () => {
    resolveCopilotExecutableMock.mockRejectedValueOnce(new Error('boom'));

    const rows = await getDetectorFreshness();

    expect(rows.find((row) => row.tool === 'copilot')?.installed).toBeNull();
  });

  // The non-vacuity proof for the two guards above: the forbidden spelling is a
  // real, reachable behaviour of this module's own executor, and it produces
  // exactly the child process they forbid. Without this, both guards would pass
  // just as happily against a table that could not spawn anything at all.
  it('MUTATION: the `gh copilot -- --version` spelling really would spawn gh', async () => {
    pathTable = { gh: abs('gh') };
    execTable = { [abs('gh')]: { stdout: 'GitHub Copilot CLI 1.0.80.' } };

    const version = await runDetectorVersionProbe({
      kind: 'execFile',
      command: 'gh',
      args: ['copilot', '--', '--version'],
    });

    expect(version).toBe('1.0.80');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].command).toBe(abs('gh'));
    expect(execCalls[0].args).toContain('copilot');
  });
});

// --- S17 (3)(4): sanitized env, explicit bounds -----------------------------

describe('[#1929][S17] probe children are bounded and sanitized', () => {
  it('runs every probe with a sanitized env, a timeout and a byte cap', async () => {
    process.env.CM_AUTH_TOKEN_HASH = 'must-not-reach-the-child';
    try {
      installEveryProbe({ claude: '2.1.240' });

      await getDetectorFreshness();

      expect(execCalls.length).toBeGreaterThan(0);
      for (const call of execCalls) {
        expect(call.opts.timeout).toBe(DETECTOR_VERSION_PROBE_TIMEOUT_MS);
        expect(call.opts.maxBuffer).toBe(64 * 1024);
        expect(call.opts.env, `${call.command} inherited process.env verbatim`).toBeDefined();
        for (const key of SENSITIVE_ENV_KEYS) {
          expect(call.opts.env?.[key], `${key} leaked into the probe env`).toBeUndefined();
        }
      }
    } finally {
      delete process.env.CM_AUTH_TOKEN_HASH;
    }
  });
});

// --- The hot path -----------------------------------------------------------

describe('[#1929] getDetectorStalenessSnapshot never awaits a child', () => {
  it('returns undefined immediately on a cold cache and starts the probe', () => {
    execHangs = true;
    pathTable = { claude: abs('claude') };

    // Nothing is awaited between these two statements, so if the snapshot did
    // await its probes this line could not be reached at all.
    expect(getDetectorStalenessSnapshot()).toBeUndefined();
    expect(
      execCalls.filter((call) => call.command === abs('claude')),
      'the snapshot itself has to start the background probe'
    ).toHaveLength(1);
  });

  it('keeps answering while every probe hangs', async () => {
    execHangs = true;
    pathTable = { claude: abs('claude') };

    expect(getDetectorStalenessSnapshot()).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(getDetectorStalenessSnapshot()).toBeUndefined();
  });

  it('distinguishes "not known yet" from "nothing is stale"', async () => {
    installEveryProbe({ claude: DETECTOR_VERIFIED_AGAINST.claude.version });

    expect(getDetectorStalenessSnapshot(), 'cold cache must be undefined').toBeUndefined();

    await getDetectorFreshness();

    // Warm and clean is `{}` — a different value from `undefined`, which is the
    // whole point: a caller must be able to tell the two apart.
    expect(getDetectorStalenessSnapshot()).toEqual({});
  });

  it('joins the in-flight probe instead of starting a second round', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: '2.1.240' } };

    getDetectorStalenessSnapshot();
    const [first, second] = await Promise.all([getDetectorFreshness(), getDetectorFreshness()]);

    expect(execCalls.filter((call) => call.command === abs('claude'))).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('caches the answer for the life of the process', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: '9.9.9' } };
    const first = await getDetectorFreshness();

    // Change what the CLI would answer; a cached call must not re-probe.
    execTable = { [abs('claude')]: { stdout: '0.0.1' } };
    const second = await getDetectorFreshness();

    expect(second).toBe(first);
    expect(execCalls.filter((call) => call.command === abs('claude'))).toHaveLength(1);
  });
});

// --- What counts as stale ---------------------------------------------------

describe('[#1929] staleness readings', () => {
  it('reports a tool whose installed build is newer than its stamp', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: '99.0.0 (Claude Code)' } };

    const staleness = toDetectorStaleness(await getDetectorFreshness());

    expect(staleness.claude).toEqual({
      installed: '99.0.0',
      verifiedAgainst: DETECTOR_VERIFIED_AGAINST.claude.version,
    });
  });

  it('reports nothing for an equal or older build', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: DETECTOR_VERIFIED_AGAINST.claude.version } };

    const rows = await getDetectorFreshness();

    expect(rows.find((row) => row.tool === 'claude')?.stale).toBe(false);
    expect(toDetectorStaleness(rows)).toEqual({});
  });

  it('treats output with no version in it as no answer', async () => {
    pathTable = { claude: abs('claude') };
    execTable = { [abs('claude')]: { stdout: 'unknown build' } };

    const rows = await getDetectorFreshness();

    expect(rows.find((row) => row.tool === 'claude')?.installed).toBeNull();
    expect(toDetectorStaleness(rows)).toEqual({});
  });

  it('never calls an unmeasured tool stale, however new the install is', async () => {
    // gemini has a probe but no captured frames, so there is no build to be
    // behind. "Nobody measured this" and "this is current" must not print the
    // same, and only the freshness report distinguishes them.
    expect(DETECTOR_VERIFIED_AGAINST.gemini.version).toBe('unmeasured');
    pathTable = { gemini: abs('gemini') };
    execTable = { [abs('gemini')]: { stdout: '99.0.0' } };

    const rows = await getDetectorFreshness();

    expect(rows.find((row) => row.tool === 'gemini')).toEqual({
      tool: 'gemini',
      installed: '99.0.0',
      verifiedAgainst: 'unmeasured',
      stale: false,
    });
    expect(toDetectorStaleness(rows).gemini).toBeUndefined();
  });

  it('reads a minor-series stamp as its `.0`, though no tool carries one now', async () => {
    // Was antigravity's `0.4.x`. Issue #2292 re-stamped it to the 1.1.25 build
    // #2270 actually read the rules off, so the table holds no wildcard today
    // and the branch is exercised on the format instead of through a tool. It
    // stays because the format is still legal in a hand-written stamp, and
    // without it such a stamp would parse as null and be filed with
    // `unmeasured` — silently never stale. See the function's own docstring.
    expect(DETECTOR_VERIFIED_AGAINST.antigravity.version).toBe('1.1.25');
    expect(parseCliVersion('0.4.x')).toBeNull();
    expect(parseVerifiedAgainstVersion('0.4.x')).toBe('0.4.0');
    expect(parseVerifiedAgainstVersion('unmeasured')).toBeNull();

    pathTable = { agy: abs('agy') };
    execTable = { [abs('agy')]: { stdout: '1.1.18' } };

    const staleness = toDetectorStaleness(await getDetectorFreshness());

    // 1.1.18 is BEHIND the build the rules were read off, which is not the skew
    // this warning is about — the newer-install direction is pinned in
    // `tests/unit/lib/detection/detector-freshness-2292.test.ts`.
    expect(staleness.antigravity).toBeUndefined();
  });
});

// --- Version helpers --------------------------------------------------------

describe('[#1929] version helpers', () => {
  it('extracts a triple from each CLI’s real banner', () => {
    // Measured 2026-08-23; the exact strings these binaries print.
    expect(parseCliVersion('2.1.240 (Claude Code)')).toBe('2.1.240');
    expect(parseCliVersion('codex-cli 0.148.0')).toBe('0.148.0');
    expect(parseCliVersion('1.1.18')).toBe('1.1.18');
    expect(parseCliVersion('GitHub Copilot CLI 1.0.80.')).toBe('1.0.80');
    expect(parseCliVersion('0.55.1')).toBe('0.55.1');
    expect(parseCliVersion('no version here')).toBeNull();
  });

  it('orders versions numerically, not lexically', () => {
    expect(compareCliVersions('2.2.0', '2.1.218')).toBe(1);
    expect(compareCliVersions('2.1.218', '2.1.218')).toBe(0);
    expect(compareCliVersions('0.9.0', '0.10.0')).toBe(-1);
  });
});
