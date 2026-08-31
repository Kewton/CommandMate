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
}

let cache: CacheEntry | null = null;
let inFlight: Promise<AgentVersionRow[]> | null = null;

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

async function computeRows(): Promise<AgentVersionRow[]> {
  const tools = Object.keys(DETECTOR_VERSION_PROBES).sort();
  return Promise.all(tools.map(buildRow));
}

/**
 * Every tool's version row, cached for {@link AGENT_VERSIONS_CACHE_TTL_MS}.
 *
 * Single-flight: two concurrent callers share one fan-out rather than doubling
 * the child processes.
 *
 * @param options.force - Skip the cache and re-probe. What the UI passes right
 *   after an update, so the new version is visible without a 30s wait.
 * @param options.now - Injectable clock (tests).
 */
export async function getAgentVersions(
  options: { force?: boolean; now?: number } = {}
): Promise<AgentVersionRow[]> {
  const now = options.now ?? Date.now();

  if (options.force) {
    cache = null;
  } else if (cache && cache.expiresAt > now) {
    return cache.rows;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rows = await computeRows();
      cache = { rows, expiresAt: Date.now() + AGENT_VERSIONS_CACHE_TTL_MS };
      return rows;
    } catch {
      // A probe fan-out that throws must not fail the surface that asked: the
      // versions are an annotation, and an empty list renders as "unknown".
      cache = { rows: [], expiresAt: Date.now() + AGENT_VERSIONS_CACHE_TTL_MS };
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cached probe. Tests, and every surface that just ran an update. */
export function clearAgentVersionsCache(): void {
  cache = null;
  inFlight = null;
}
