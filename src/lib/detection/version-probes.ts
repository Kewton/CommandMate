/**
 * `DETECTOR_VERSION_PROBES` — are the detector's rules still describing the CLI
 * that is installed? (Issue #1929, 方針書 §4 D2 / §7 / §10.11 / §13.2 S17)
 *
 * Every rule in `src/lib/detection/tools/` was read off a capture of one build
 * of one CLI. `tools/verified-against.ts` records which build. This module reads
 * the other half of the comparison — the version that is installed right now —
 * so `capture --json` and `commandmate status` can say "these rules were
 * measured against copilot 1.0.80 and you are running 1.2.0" instead of leaving
 * a reader to guess whether a misdetection is a bug or a version skew.
 *
 * ## The cost rules, and why they are not optional
 *
 * `capture --json` and `GET /current-output` are the **5-second polling path** —
 * the monitor skills run them with no iteration cap. A probe table that spawns
 * six children cannot sit on that path, so (DR3-013):
 *
 *  - probes run **once per process**, concurrent first callers share the same
 *    in-flight promise, and the result is cached;
 *  - {@link getDetectorStalenessSnapshot} **never awaits a child process**. It
 *    answers from the cache or answers `undefined` and starts the probe in the
 *    background. `undefined` means "not known yet", never "nothing is stale":
 *    the hint is additive, so a poll that lands cold simply shows nothing and
 *    the next one shows the banner;
 *  - {@link getDetectorFreshness} is the awaiting form, for the two callers that
 *    genuinely want the answer (`commandmate status`, `check:detector-freshness`)
 *    and are operator-initiated one-offs.
 *
 * ## The execution rules (DR4-010 / §10.11)
 *
 * `PATH` is untrusted input: the server's `PATH` comes from the shell that
 * started it, and a repo-local `node_modules/.bin` on it would let opening a
 * worktree decide which binary a cold probe runs. So every `execFile` probe
 * resolves its command to an **absolute path** through
 * {@link findExecutableOnPath} first and **skips entirely** — spawning nothing —
 * when that resolves to nothing; children run with `sanitizeEnvForChildProcess()`
 * so no probe ever sees CommandMate's auth token or DB path; and both `timeout`
 * and `maxBuffer` are explicit.
 *
 * ## copilot is delegated, and must stay delegated (S17)
 *
 * The design policy's first draft probed `gh copilot -- --version`. It cannot be
 * used: `copilot` is not a gh extension but a preview command built into gh
 * 2.86.0, and gh's own help says that when `PATH` has no copilot it
 * **downloads** the CLI into `~/.local/share/gh/copilot`. A version hint that
 * installs software is not a version hint. #1907 measured this and built
 * {@link resolveCopilotExecutable}; #1913 wired it into the catalog's
 * `VERSION_PROBES` as `kind: 'delegated'`; this table reuses the same shape.
 *
 * Delegating is not an exception to DR4-010 (1) — it satisfies it more strongly
 * than an `execFile` row could, because `CopilotTool.isInstalled()` and
 * `startSession()` decide what to launch from **the same function's same return
 * value**, so probe and launch cannot disagree.
 *
 * ## What "probes must not modify the environment" can actually mean (measured)
 *
 * DR4-010 (5) says a probe must not change the environment ("installation,
 * download, or config-file generation"). Measured on 2026-08-23 (macOS
 * darwin 25.6.0) by running each `--version` under a **disposable** `HOME` /
 * `XDG_DATA_HOME` / `XDG_CONFIG_HOME` and listing what appeared:
 *
 * | probe                | version   | warm ms | wrote into a pristine HOME              |
 * |----------------------|-----------|---------|------------------------------------------|
 * | `claude --version`   | 2.1.240   | 199     | nothing                                   |
 * | `agy --version`      | 1.1.18    | 176     | nothing                                   |
 * | `codex --version`    | 0.148.0   | 172     | `~/.codex/tmp/arg0`                       |
 * | `opencode --version` | 1.18.21   | 404     | `~/.config/opencode`, `~/.cache/opencode`, `~/.local/{state,share}/opencode` |
 * | `copilot --version`  | 1.0.80    | 436     | `~/Library/Caches/copilot`                |
 * | `gemini --version`   | 0.55.1    | 929     | `~/.gemini/projects.json.<uuid>.tmp` ×2 (leaked, not cleaned up) |
 *
 * So the literal reading of (5) is satisfied by **two** of the six probes, and
 * four of the rows the policy already approved fail it. The rule that the D2
 * premise actually rests on is the narrower one #1979 was defending: a probe
 * must not **install or download software, or change which binary would be
 * launched**. Every row above satisfies that; none of them fetches anything.
 * The gemini row is the weakest — it leaks two temp files into a `~/.gemini`
 * that does not exist yet — and it is kept because it is the same class of
 * side effect as codex/opencode/copilot, which are already in the table, and
 * because dropping gemini would leave the one tool with **no** measured
 * detector rules also with no way to notice that.
 *
 * `~/.config/gh` and `~/.local/share/gh` were checksummed before and after the
 * whole measurement and neither changed (`~/.local/share/gh` still does not
 * exist), which is the receipt #1979 asked for.
 *
 * ## Why this module imports nothing through `@/`
 *
 * `commandmate status` is one of the two exposure surfaces §4 D2 names, and
 * `tsconfig.cli.json` compiles the CLI with `"paths": {}`. See the same
 * constraint spelled out in `src/cli/types/api-responses.ts`.
 *
 * @module lib/detection/version-probes
 */

import { execFile } from 'child_process';
import { findExecutableOnPath, resolveCopilotExecutable } from '../cli-tools/copilot-executable';
import { sanitizeEnvForChildProcess } from '../security/env-sanitizer';
import { DETECTOR_VERIFIED_AGAINST } from './tools/verified-against';

/** Budget for one `<cli> --version`. Matches the catalog probe and copilot-executable. */
export const DETECTOR_VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * Cap on `--version` output kept in memory (DR4-010 (4)).
 *
 * `execFile` defaults to 1MB. A `--version` that answers with a megabyte is
 * already misbehaving, so the buffer is sized to a version banner and the child
 * is killed past it; the over-long answer is discarded rather than parsed.
 */
const DETECTOR_VERSION_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

/** Extracts a `major.minor.patch` triple from arbitrary `--version` output. */
const VERSION_REGEX = /(\d+)\.(\d+)\.(\d+)/;

/** Extract a normalized `major.minor.patch` version from `--version` output. */
export function parseCliVersion(output: string): string | null {
  const match = VERSION_REGEX.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * A `verifiedAgainst` stamp written as a minor-series wildcard: `0.4.x`.
 *
 * Only ever applied to the stamp, never to a probe's own output — one side of
 * this comparison is a string a human typed into a tool module, the other is
 * what a binary printed about itself, and only the first is allowed to be vague.
 */
const VERIFIED_AGAINST_WILDCARD_REGEX = /^(\d+)\.(\d+)\.(?:x|\*)$/i;

/**
 * The comparable form of a `verifiedAgainst` stamp, or null when there is none.
 *
 * `'unmeasured'` is null — a tool nobody has captured frames for cannot be
 * fresh or stale. `'0.4.x'` becomes `0.4.0`: antigravity's stamp is a minor
 * series rather than a build (Issue #995 measured a range), and reading it as
 * "no version" would silently exempt the one tool whose rules are furthest
 * behind. Widening to `.0` is the safe direction — it can only ever call a
 * newer install stale, never call a stale one current.
 */
export function parseVerifiedAgainstVersion(stamp: string): string | null {
  const wildcard = VERIFIED_AGAINST_WILDCARD_REGEX.exec(stamp);
  if (wildcard) return `${wildcard[1]}.${wildcard[2]}.0`;
  return parseCliVersion(stamp);
}

/**
 * Compare two `major.minor.patch` versions numerically.
 * @returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * One staleness probe.
 *
 * `execFile` is the default: resolve `command` on `PATH`, run it with `args`,
 * read a version out of the output. `delegated` exists for a tool that owns its
 * own resolution, because *finding* the executable is part of the question for
 * it — see the copilot note in the module doc.
 */
export type DetectorVersionProbe =
  | { readonly kind: 'execFile'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'delegated'; readonly probe: () => Promise<string | null> };

/**
 * Detector staleness probes: tool id → how to read its installed version.
 *
 * Deliberately the same shape as `VERSION_PROBES` in `slash-command-catalog.ts`
 * (§4 D2: 「`VERSION_PROBES` と同型」), and deliberately a separate table: the
 * catalog's question is "is the bundled slash-command list behind?" and this
 * one's is "were these detection rules read off the build that is installed?".
 * They happen to agree today; nothing requires them to.
 *
 * The binary for antigravity is `agy` — tool id and executable name differ
 * (DR2-023). `gemini`'s row is `gemini --version`, measured for this Issue (the
 * policy left it unconfirmed); its `verifiedAgainst` is `unmeasured`, so it is
 * reported as "installed, rules never measured" rather than compared.
 * `vibe-local` has no row: it is not an external CLI.
 */
export const DETECTOR_VERSION_PROBES: Readonly<Record<string, DetectorVersionProbe>> = {
  claude: { kind: 'execFile', command: 'claude', args: ['--version'] },
  codex: { kind: 'execFile', command: 'codex', args: ['--version'] },
  antigravity: { kind: 'execFile', command: 'agy', args: ['--version'] },
  opencode: { kind: 'execFile', command: 'opencode', args: ['--version'] },
  gemini: { kind: 'execFile', command: 'gemini', args: ['--version'] },
  copilot: {
    kind: 'delegated',
    probe: async () => (await resolveCopilotExecutable())?.version ?? null,
  },
};

/** One row of the full freshness report. */
export interface DetectorFreshnessRow {
  /** Catalog / `CLIToolType` id. */
  readonly tool: string;
  /** Version the probe read, or null when the tool is absent / unreadable. */
  readonly installed: string | null;
  /** Build the tool module's rules were read off (may be `'unmeasured'`). */
  readonly verifiedAgainst: string;
  /**
   * True only when both sides are comparable versions AND installed is newer.
   *
   * A tool that is not installed, whose `--version` could not be parsed, or
   * whose rules were never measured is **not** stale — those are three kinds of
   * "no answer", and reporting them as staleness would nag about something the
   * operator cannot act on.
   */
  readonly stale: boolean;
}

/** What the wire carries: only the tools whose installed build is newer. */
export interface DetectorStalenessEntry {
  readonly installed: string;
  readonly verifiedAgainst: string;
}

/**
 * `detector.staleness` as `capture --json` publishes it: tool id → the skew.
 *
 * A tool is **absent** from this map unless it was probed successfully AND is
 * newer than the rules — so `staleness.copilot === undefined` is the answer on a
 * machine with no copilot, which is the S17 receipt (probe skipped, nothing
 * spawned, nothing reported).
 */
export type DetectorStaleness = Readonly<Record<string, DetectorStalenessEntry>>;

let freshnessCache: readonly DetectorFreshnessRow[] | null = null;
let freshnessInFlight: Promise<readonly DetectorFreshnessRow[]> | null = null;

/**
 * Run one probe. Resolves null on any failure, and **without spawning anything**
 * when the command does not resolve to an absolute path (DR4-010 (2)).
 */
export function runDetectorVersionProbe(probe: DetectorVersionProbe): Promise<string | null> {
  if (probe.kind === 'delegated') {
    return probe.probe().catch(() => null);
  }

  const executable = findExecutableOnPath(probe.command);
  // Skip, do not fall back to the bare name: handing an unresolved command to
  // execFile is exactly the PATH-decides-the-binary case DR4-010 removes.
  if (!executable) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(
      executable,
      [...probe.args],
      {
        timeout: DETECTOR_VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: DETECTOR_VERSION_PROBE_MAX_BUFFER_BYTES,
        env: sanitizeEnvForChildProcess(),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseCliVersion(`${stdout ?? ''}\n${stderr ?? ''}`));
      }
    );
  });
}

async function computeDetectorFreshness(): Promise<readonly DetectorFreshnessRow[]> {
  const tools = Object.keys(DETECTOR_VERSION_PROBES).sort();
  return Promise.all(
    tools.map(async (tool): Promise<DetectorFreshnessRow> => {
      const verifiedAgainst = DETECTOR_VERIFIED_AGAINST[tool]?.version ?? 'unmeasured';
      const installed = await runDetectorVersionProbe(DETECTOR_VERSION_PROBES[tool]);
      const baseline = parseVerifiedAgainstVersion(verifiedAgainst);
      return {
        tool,
        installed,
        verifiedAgainst,
        stale:
          installed !== null && baseline !== null && compareCliVersions(installed, baseline) > 0,
      };
    })
  );
}

/**
 * The full freshness report, computed once per process and cached. Concurrent
 * first callers share one probe.
 *
 * **This awaits child processes — never call it from a request path.** Use
 * {@link getDetectorStalenessSnapshot} there. Kept for `commandmate status`,
 * `npm run check:detector-freshness` and tests, and as the single implementation
 * both entry points share.
 */
export async function getDetectorFreshness(): Promise<readonly DetectorFreshnessRow[]> {
  if (freshnessCache !== null) return freshnessCache;
  if (freshnessInFlight) return freshnessInFlight;

  freshnessInFlight = computeDetectorFreshness();
  try {
    freshnessCache = await freshnessInFlight;
    return freshnessCache;
  } finally {
    freshnessInFlight = null;
  }
}

/** Reduce a report to the wire shape: stale tools only. */
export function toDetectorStaleness(rows: readonly DetectorFreshnessRow[]): DetectorStaleness {
  const staleness: Record<string, DetectorStalenessEntry> = {};
  for (const row of rows) {
    if (!row.stale || row.installed === null) continue;
    staleness[row.tool] = { installed: row.installed, verifiedAgainst: row.verifiedAgainst };
  }
  return staleness;
}

/**
 * The staleness this process already knows, or `undefined` plus a background
 * probe when it knows nothing yet. **Never awaits a child process** (§4 D2,
 * DR3-013 (a)(b)(c)).
 *
 * `undefined` is "not known yet", not "nothing is stale" — see the module doc.
 * The returned object is `{}` once the cache is warm and nothing is stale, which
 * is how a caller tells the two apart.
 */
export function getDetectorStalenessSnapshot(): DetectorStaleness | undefined {
  if (freshnessCache !== null) return toDetectorStaleness(freshnessCache);
  // Fire and forget. No in-flight check here on purpose: getDetectorFreshness
  // owns that slot and hands a concurrent caller the promise that is already
  // running, so a second guard would be a copy of an invariant that lives one
  // function down — and a copy is what goes stale. It swallows its own failures,
  // so nothing here needs the result.
  void getDetectorFreshness().catch(() => []);
  return undefined;
}

/** Clear the process-level probe cache (tests, and any future cache-control wiring). */
export function clearDetectorVersionProbeCache(): void {
  freshnessCache = null;
  freshnessInFlight = null;
}
