/**
 * Command-line parsing for `scripts/agent-health/metrics.ts` (Issue #3044).
 *
 * ```
 * metrics.ts [--out <file>] [--state <file>] [--only <metricId>[,…]] [--coverage | --no-coverage]
 * ```
 */

import { METRIC_IDS, isMetricId, type MetricId } from './metrics-types';

export interface MetricsOptions {
  /** null → `~/.commandmate/agent-health/metrics/<JST date>.json`. */
  out: string | null;
  /** null → `~/.commandmate/agent-health/metrics-state.json`. */
  statePath: string | null;
  metrics: MetricId[];
  /** 'auto' → Monday (JST) only. */
  coverage: 'auto' | 'on' | 'off';
}

export type MetricsParseResult =
  | { ok: true; options: MetricsOptions }
  | { ok: false; error: string; help?: boolean };

export const METRICS_USAGE = [
  'Usage: npx tsx scripts/agent-health/metrics.ts [options]',
  '',
  '  --out <file>      report path (default: ~/.commandmate/agent-health/metrics/<JST date>.json)',
  '  --state <file>    previous values (default: ~/.commandmate/agent-health/metrics-state.json)',
  `  --only <list>     ${METRIC_IDS.join(',')} (default: all)`,
  '  --coverage        run coverage today even if it is not Monday (JST)',
  '  --no-coverage     skip coverage even on Monday',
  '  -h, --help        show this help',
  '',
  'Exit: 0 nothing failed, 1 at least one metric failed, 2 the script itself failed.',
].join('\n');

export function parseMetricsArgs(argv: readonly string[]): MetricsParseResult {
  const options: MetricsOptions = { out: null, statePath: null, metrics: [...METRIC_IDS], coverage: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string | null => {
      if (inline !== undefined) return inline === '' ? null : inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    switch (flag) {
      case '-h':
      case '--help':
        return { ok: false, error: METRICS_USAGE, help: true };
      case '--out':
      case '--state': {
        const v = value();
        if (v === null) return { ok: false, error: `${flag} requires a path` };
        if (flag === '--out') options.out = v;
        else options.statePath = v;
        break;
      }
      case '--only': {
        const v = value();
        if (v === null) return { ok: false, error: '--only requires a list' };
        const ids = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
        const unknown = ids.filter((id) => !isMetricId(id));
        if (unknown.length > 0 || ids.length === 0) {
          return { ok: false, error: `unknown metric: ${unknown.join(',') || '(empty)'} (want ${METRIC_IDS.join(', ')})` };
        }
        options.metrics = METRIC_IDS.filter((id) => ids.includes(id));
        break;
      }
      case '--coverage':
        options.coverage = 'on';
        break;
      case '--no-coverage':
        options.coverage = 'off';
        break;
      default:
        return { ok: false, error: `unknown argument: ${arg}\n\n${METRICS_USAGE}` };
    }
  }
  return { ok: true, options };
}
