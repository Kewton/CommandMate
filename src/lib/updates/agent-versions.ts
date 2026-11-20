/**
 * "Which agent CLIs are installed, and is codex behind?" (Issue #2069)
 *
 * One row per tool for the two update surfaces — the More screen's card and the
 * agent pane's — and the split in what a row carries is deliberate:
 *
 *  - **every tool reports `installed` only.** That is this Issue's 実装内容 2:
 *    the probe table already exists, it answers without a network, and
 *    "installed 1.0.80" is the whole truth CommandMate has about a copilot.
 *  - **codex additionally reports `latestVersion` / `updateAvailable`**, because
 *    codex is the one tool that writes its own release check to disk. See
 *    `./codex-version`.
 *
 * Nothing here queries a registry. A row that says `updateAvailable: false` is
 * saying "nothing on this machine claims otherwise", never "I checked online".
 *
 * ## Why not `getDetectorFreshness()`
 *
 * It answers a different question (are the *detector's rules* stale?) and — the
 * reason that matters here — it caches for the life of the process. This module
 * is read immediately after an update completes, so a permanent memo would show
 * the old version forever and make the acceptance criterion 「完了後に
 * `codex --version` が上がる」 unobservable from the UI. So the probes are run
 * through the same `runDetectorVersionProbe` (same absolute-path resolution,
 * same sanitized env, same timeout) behind a **TTL** instead, on the reasoning
 * `config/installed-agents-cache` already wrote down: the user's loop is
 * "install something, come back, look again".
 *
 * @module lib/updates/agent-versions
 */

import { DETECTOR_VERSION_PROBES, runDetectorVersionProbe } from '../detection/version-probes';
import { evaluateCodexUpdate, readCodexVersionFile } from './codex-version';
import { isUpdatableAgentTool } from './agent-updater';
import { mayProbeToolVersion } from '../tool-policy/version-probe-gate';

/**
 * How long one fan-out of `--version` probes is reused.
 *
 * Same 30s as `config/installed-agents-cache`, and for the same reason: opening
 * a screen twice in a row costs one fan-out, while a version that changed under
 * the server shows up without a restart. An update finishing calls
 * {@link clearAgentVersionsCache} rather than waiting this out.
 */
export const AGENT_VERSIONS_CACHE_TTL_MS = 30_000;

/** One tool's version row, as the API publishes it. */
export interface AgentVersionRow {
  /** Catalog / `CLIToolType` id. */
  tool: string;
  /** What `--version` reported, or null when the tool is not on PATH. */
  installed: string | null;
  /** codex only: its own `latest_version`. Null for every other tool. */
  latestVersion: string | null;
  /** codex only: its own `dismissed_version`. Null for every other tool. */
  dismissedVersion: string | null;
  /** True only when a newer version is known AND the tool is installed. */
  updateAvailable: boolean;
  /** True when the available update is one the user dismissed inside codex. */
  dismissedInCodex: boolean;
  /** Whether CommandMate has an update flow for this tool at all. */
  updatable: boolean;
  /** Where `latestVersion` came from, or null when nothing said. */
  source: 'version.json' | null;
}

interface CacheEntry {
  rows: AgentVersionRow[];
  expiresAt: number;
  /**
   * Issue #4452: whether antigravity could be probed when these rows were made. A
   * use of antigravity (or a declaration) since changes the answer, and the row
   * shows right after the use rather than after the TTL. Issue #4480: only the
   * antigravity row is added (or dropped) then; the other rows are kept, so
   * claude / codex are not probed again inside the TTL.
   */
  antigravityProbeable: boolean;
}

/** One probe run in flight, and what it was started under. */
interface Flight {
  promise: Promise<AgentVersionRow[]>;
  /** {@link generation} when it started; it writes the cache only if unchanged. */
  generation: number;
  /** `mayProbeToolVersion('antigravity')` when it started. */
  antigravityProbeable: boolean;
  /** Started by `force` (a forced fetch may share only a forced full fetch). */
  forced: boolean;
}

let cache: CacheEntry | null = null;
/**
 * Issue #4480 (review-4480): bumped by a forced fetch and by
 * {@link clearAgentVersionsCache}. A run started under an older generation still
 * answers its own callers but never writes the cache, so rows probed before an
 * update cannot be written back over the rows probed after it.
 */
let generation = 0;
/** The full fan-out in flight (every tool the gate allows). */
let fullInFlight: Flight | null = null;
/** The antigravity-row add in flight (only antigravity is probed). */
let addInFlight: Flight | null = null;

/** Probe one tool and build its row. codex gets the extra half. */
async function buildRow(tool: string): Promise<AgentVersionRow> {
  const installed = await runDetectorVersionProbe(DETECTOR_VERSION_PROBES[tool]);
  const updatable = isUpdatableAgentTool(tool);

  if (tool !== 'codex') {
    return {
      tool,
      installed,
      latestVersion: null,
      dismissedVersion: null,
      updateAvailable: false,
      dismissedInCodex: false,
      updatable,
      source: null,
    };
  }

  const status = evaluateCodexUpdate(installed, readCodexVersionFile());
  return {
    tool,
    installed: status.installed,
    latestVersion: status.latestVersion,
    dismissedVersion: status.dismissedVersion,
    updateAvailable: status.updateAvailable,
    dismissedInCodex: status.dismissedInCodex,
    updatable,
    source: status.source,
  };
}

/**
 * Issue #4452: antigravity has no row unless its version may be read
 * ({@link mayProbeToolVersion}: the usage declaration, or a use in this process).
 * Listing versions is not using antigravity, so `agy` is not started for it. The row
 * is left out rather than reported as `installed: null`, which would read as
 * "not installed".
 */
async function computeRows(): Promise<AgentVersionRow[]> {
  const tools = Object.keys(DETECTOR_VERSION_PROBES).filter((tool) => mayProbeToolVersion(tool)).sort();
  return Promise.all(tools.map(buildRow));
}

/** Rows in the list's order (by tool id, as {@link computeRows} sorts the ids). */
function sortRows(rows: AgentVersionRow[]): AgentVersionRow[] {
  return [...rows].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Issue #4480: the cached rows with the antigravity row added (gate open) or
 * dropped (gate closed). Only antigravity is probed — the same "add only what
 * became probeable" the detector and the catalog do.
 */
async function withAntigravityRow(rows: AgentVersionRow[], probeable: boolean): Promise<AgentVersionRow[]> {
  const others = rows.filter((row) => row.tool !== 'antigravity');
  if (!probeable || !('antigravity' in DETECTOR_VERSION_PROBES)) return others;
  return sortRows([...others, await buildRow('antigravity')]);
}

/**
 * When a fan-out started at `startedAt` should stop being reused.
 *
 * Takes the caller's clock rather than reading `Date.now()` again, and that is
 * the whole point of the helper: an injected `now` that is honoured on the READ
 * side but ignored on the WRITE side makes every TTL assertion vacuous — the
 * cache is stamped with a real epoch, a test's `now: 2_000` is smaller than it
 * whatever the TTL is, and `AGENT_VERSIONS_CACHE_TTL_MS = 0` still passes.
 */
function expiryFrom(startedAt: number): number {
  return startedAt + AGENT_VERSIONS_CACHE_TTL_MS;
}

/**
 * Every tool's version row, cached for {@link AGENT_VERSIONS_CACHE_TTL_MS}.
 *
 * Single-flight: two concurrent callers share one fan-out rather than doubling
 * the child processes. Issue #4480: except that a forced fetch shares only a
 * forced fan-out of its own generation — never the antigravity-row add, nor a
 * fan-out started before it — and nothing started before a force or a clear
 * writes the cache afterwards.
 *
 * @param options.force - Skip the cache and re-probe. What the UI passes right
 *   after an update, so the new version is visible without a 30s wait.
 * @param options.now - Injectable clock, used for BOTH the expiry comparison
 *   and the expiry that is written. Honouring it on only one side would leave
 *   the TTL untestable — see {@link expiryFrom}.
 */
export async function getAgentVersions(
  options: { force?: boolean; now?: number } = {}
): Promise<AgentVersionRow[]> {
  const now = options.now ?? Date.now();
  const probeable = mayProbeToolVersion('antigravity');

  if (options.force) {
    // Issue #4480 (review-4480): a forced fetch is a full fan-out started now. It
    // never shares an add (which probes antigravity only) or a full fan-out that
    // was started before it; it shares only a forced one of the same generation.
    if (fullInFlight?.forced && fullInFlight.generation === generation) return fullInFlight.promise;
    generation += 1;
    cache = null;
    return startFull(now, probeable, true);
  }

  if (cache && cache.expiresAt > now) {
    if (cache.antigravityProbeable === probeable) return cache.rows;
    const sharable = [fullInFlight, addInFlight].find(
      (flight) => flight && flight.generation === generation && flight.antigravityProbeable === probeable
    );
    if (sharable) return sharable.promise;
    return startAdd(cache, probeable);
  }

  if (fullInFlight && fullInFlight.generation === generation) return fullInFlight.promise;
  return startFull(now, probeable, false);
}

/** Start a full fan-out; it writes the cache only if no force or clear came since. */
function startFull(now: number, antigravityProbeable: boolean, forced: boolean): Promise<AgentVersionRow[]> {
  const startedIn = generation;
  // `promise` is set below: the run compares itself with the slot when it ends.
  const flight = { generation: startedIn, antigravityProbeable, forced } as Flight;
  const promise = (async () => {
    let rows: AgentVersionRow[];
    try {
      rows = await computeRows();
    } catch {
      // A probe fan-out that throws must not fail the surface that asked: the
      // versions are an annotation, and an empty list renders as "unknown".
      rows = [];
    }
    if (generation === startedIn) {
      cache = { rows, expiresAt: expiryFrom(now), antigravityProbeable };
    }
    if (fullInFlight === flight) fullInFlight = null;
    return rows;
  })();
  flight.promise = promise;
  fullInFlight = flight;
  return promise;
}

/**
 * Issue #4480: inside the TTL only the gate's answer changed (a use or a
 * declaration since). Add or drop the antigravity row and keep the rest — a full
 * fan-out here would run claude / codex `--version` once more than the TTL allows
 * (review-4452-3 P3-2). The entry keeps its expiry. It writes the cache only if
 * the entry it started from is still the cache and no force or clear came since.
 */
function startAdd(base: CacheEntry, antigravityProbeable: boolean): Promise<AgentVersionRow[]> {
  const startedIn = generation;
  // `promise` is set below: the run compares itself with the slot when it ends.
  const flight = { generation: startedIn, antigravityProbeable, forced: false } as Flight;
  const promise = (async () => {
    let rows: AgentVersionRow[];
    try {
      rows = await withAntigravityRow(base.rows, antigravityProbeable);
    } catch {
      // Same rule as the full fan-out: the versions are an annotation.
      rows = base.rows;
    }
    if (generation === startedIn && cache === base) {
      cache = { rows, expiresAt: base.expiresAt, antigravityProbeable };
    }
    if (addInFlight === flight) addInFlight = null;
    return rows;
  })();
  flight.promise = promise;
  addInFlight = flight;
  return promise;
}

/** Drop the cached probe. Tests, and every surface that just ran an update. */
export function clearAgentVersionsCache(): void {
  generation += 1;
  cache = null;
  fullInFlight = null;
  addInFlight = null;
}
