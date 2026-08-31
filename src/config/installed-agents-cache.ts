/**
 * Cached "which agent CLIs are installed" probe (Issue #2065, rule from #1913).
 *
 * `CLIToolManager.getAllToolsInfo()` answers by running one `which`-style child
 * process per tool (seven of them, each with its own timeout; `copilot` needs a
 * `gh copilot --help`). That is fine once, on a settings screen the user opened
 * on purpose. It is not fine anywhere a list is rendered, which is why Issue
 * #1913 made "do not `await isInstalled()` on a hot path" a rule, and why the
 * resolution order this Issue ships (`app_settings` -> constant) never consults
 * it: `getWorktrees()` must not grow a filesystem probe.
 *
 * So the probe lives behind a TTL, and only the settings surface asks for it.
 * The TTL rather than a permanent memo because installing a CLI is exactly the
 * thing a user does between two visits to this screen, and a permanent cache
 * would keep telling them it is missing until the server restarts.
 *
 * Server-only: importing this from a client component pulls `child_process` in.
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * How long one probe result is reused.
 *
 * 30s is chosen against the user's loop, not the machine's: install a CLI in a
 * terminal, switch back, reload the settings screen. Long enough that opening
 * the screen twice in a row costs one probe; short enough that a fresh install
 * shows up without a restart.
 */
export const INSTALLED_AGENTS_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  installed: CLIToolType[];
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<CLIToolType[]> | null = null;

/**
 * Ids of the agent CLIs detected on this machine.
 *
 * Single-flight: two concurrent callers share one probe rather than doubling the
 * child processes.
 *
 * @param now - Injectable clock (tests)
 * @returns Installed tool ids, in `CLI_TOOL_IDS` order
 */
export async function getInstalledAgentIds(now: number = Date.now()): Promise<CLIToolType[]> {
  if (cache && cache.expiresAt > now) return cache.installed;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const info = await CLIToolManager.getInstance().getAllToolsInfo();
      const installed = info.filter((t) => t.installed).map((t) => t.id);
      cache = { installed, expiresAt: Date.now() + INSTALLED_AGENTS_CACHE_TTL_MS };
      return installed;
    } catch {
      // A probe that throws must not fail the settings request: the list is an
      // annotation next to each checkbox, not the setting itself.
      cache = { installed: [], expiresAt: Date.now() + INSTALLED_AGENTS_CACHE_TTL_MS };
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cached probe. Tests, and any surface that just installed a tool. */
export function clearInstalledAgentsCache(): void {
  cache = null;
  inFlight = null;
}
