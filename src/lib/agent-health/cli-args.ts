/**
 * Command-line parsing for `scripts/agent-health/run.ts` (Issue #2878).
 *
 * ```
 * run.ts [--tools claude,codex,…] [--only <checkId>[,<checkId>]] [--out <file>]
 *        [--timeout-per-tool <sec>] [--state <file>] [--server-log <file>]
 *        [--synced-from <sha>]
 * ```
 */

import {
  AGENT_HEALTH_CHECK_IDS,
  AGENT_HEALTH_TOOLS,
  isAgentHealthCheckId,
  isAgentHealthTool,
  type AgentHealthCheckId,
  type AgentHealthSync,
  type AgentHealthTool,
} from './types';

export const DEFAULT_TIMEOUT_PER_TOOL_SEC = 150;

/** The whole run stays under this (a scheduled run is cut at 15 minutes). */
export const RUN_BUDGET_SEC = 12 * 60;

export interface AgentHealthOptions {
  tools: AgentHealthTool[];
  /** The checks to run. `version` is always run (it gates the rest). */
  checks: AgentHealthCheckId[];
  /** null → `~/.commandmate/agent-health/reports/<JST date>.json`. */
  out: string | null;
  timeoutPerToolSec: number;
  /** null → `~/.commandmate/agent-health/state.json`. */
  statePath: string | null;
  /** null → located automatically (see `production-log.ts`). */
  serverLog: string | null;
  /** The commit before `daily.sh` synced (Issue #2924). null → no `sync` in the report. */
  syncedFrom: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

export type ParseResult =
  | { ok: true; options: AgentHealthOptions }
  | { ok: false; error: string; help?: boolean };

export const USAGE = [
  'Usage: npx tsx scripts/agent-health/run.ts [options]',
  '',
  `  --tools <list>            ${AGENT_HEALTH_TOOLS.join(',')} (default: all)`,
  `  --only <list>             ${AGENT_HEALTH_CHECK_IDS.join(',')} (default: all; version always runs)`,
  '  --out <file>              report path (default: ~/.commandmate/agent-health/reports/<JST date>.json)',
  `  --timeout-per-tool <sec>  per-tool budget (default: ${DEFAULT_TIMEOUT_PER_TOOL_SEC})`,
  '  --state <file>            previous-version state (default: ~/.commandmate/agent-health/state.json)',
  '  --server-log <file>       production server log to watch (default: <main worktree>/logs/server.log)',
  '  --synced-from <sha>       commit before the sync (set by daily.sh); records `sync` in the report',
  '  -h, --help                show this help',
  '',
  'Exit: 0 all pass/skip, 1 at least one fail, 2 the script itself failed.',
].join('\n');

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseAgentHealthArgs(argv: readonly string[]): ParseResult {
  const options: AgentHealthOptions = {
    tools: [...AGENT_HEALTH_TOOLS],
    checks: [...AGENT_HEALTH_CHECK_IDS],
    out: null,
    timeoutPerToolSec: DEFAULT_TIMEOUT_PER_TOOL_SEC,
    statePath: null,
    serverLog: null,
    syncedFrom: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') return { ok: false, error: USAGE, help: true };

    const [name, inline] = flag.startsWith('--') && flag.includes('=')
      ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)]
      : [flag, undefined];
    const takeValue = (): string | null => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };

    switch (name) {
      case '--tools': {
        const value = takeValue();
        if (value === null) return { ok: false, error: '--tools requires a value' };
        const tools = splitList(value);
        const unknown = tools.filter((tool) => !isAgentHealthTool(tool));
        if (tools.length === 0 || unknown.length > 0) {
          return {
            ok: false,
            error: `--tools: unknown tool(s) ${unknown.join(',') || '(empty)'}; expected ${AGENT_HEALTH_TOOLS.join(',')}`,
          };
        }
        // Report order is fixed; duplicates collapse.
        options.tools = AGENT_HEALTH_TOOLS.filter((tool) => tools.includes(tool));
        break;
      }
      case '--only': {
        const value = takeValue();
        if (value === null) return { ok: false, error: '--only requires a value' };
        const checks = splitList(value);
        const unknown = checks.filter((check) => !isAgentHealthCheckId(check));
        if (checks.length === 0 || unknown.length > 0) {
          return {
            ok: false,
            error: `--only: unknown check(s) ${unknown.join(',') || '(empty)'}; expected ${AGENT_HEALTH_CHECK_IDS.join(',')}`,
          };
        }
        options.checks = AGENT_HEALTH_CHECK_IDS.filter(
          (check) => check === 'version' || checks.includes(check)
        );
        break;
      }
      case '--out':
      case '--state':
      case '--server-log': {
        const value = takeValue();
        if (value === null || value === '') return { ok: false, error: `${name} requires a path` };
        if (name === '--out') options.out = value;
        else if (name === '--state') options.statePath = value;
        else options.serverLog = value;
        break;
      }
      case '--timeout-per-tool': {
        const value = takeValue();
        const seconds = value === null ? NaN : Number(value);
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > RUN_BUDGET_SEC) {
          return {
            ok: false,
            error: `--timeout-per-tool must be an integer between 10 and ${RUN_BUDGET_SEC} (got ${value ?? 'nothing'})`,
          };
        }
        options.timeoutPerToolSec = seconds;
        break;
      }
      case '--synced-from': {
        const value = takeValue();
        if (value === null || !FULL_SHA.test(value)) {
          return {
            ok: false,
            error: `--synced-from must be a 40-digit hex commit (got ${value ?? 'nothing'})`,
          };
        }
        options.syncedFrom = value;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${flag}` };
    }
  }

  return { ok: true, options };
}

/**
 * The report's `sync` field for a run started by `daily.sh` (Issue #2924).
 * `head` is the commit being checked. A hand-run `run.ts` (no `--synced-from`)
 * gets no `sync`.
 */
export function syncRecordFor(syncedFrom: string | null, head: string): AgentHealthSync | undefined {
  if (syncedFrom === null) return undefined;
  return { status: 'ok', before: syncedFrom, after: head };
}
