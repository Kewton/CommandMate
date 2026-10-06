/**
 * Turn one product-path run's state file and ledger into its execution result
 * and publish it (Issue #3312). Called by supervisor.sh (`--by supervisor`) and
 * by deadline-guard.sh when the supervisor did not finish (`--by deadline-guard`).
 *
 *   npx tsx scripts/agent-health/product/finalize.ts --base <run base> --run-id <id> --by <who>
 *
 * Reads <base>/runs/<id>/run.state, <base>/ledger/<id>.json and, when the
 * stage wrote one, <base>/runs/<id>/usage.json. Publishes to
 * CM_PRODUCT_PUBLISH_DIR (src/lib/agent-health/product-result.ts).
 *
 * Exit: 0 published, 1 not published, 2 bad arguments.
 */

import fs from 'fs';
import path from 'path';
import {
  buildProductRunResult,
  parseStateFile,
  publishProductRunResult,
  resolveProductPublishDir,
  type ProductLedger,
  type ProductReclaimer,
} from '@/lib/agent-health/product-result';

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toLedger(value: unknown): ProductLedger | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || !Array.isArray(raw.resources)) return null;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  return {
    runId: raw.runId,
    status: typeof raw.status === 'string' ? raw.status : '',
    resources: raw.resources
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ id: String(item.id), kind: String(item.kind), state: String(item.state) })),
    reclaimedRuns: strings(raw.reclaimedRuns),
    unknownElsewhere: strings(raw.unknownElsewhere),
  };
}

export function main(argv: readonly string[]): number {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1] ?? '');
  const base = args.get('--base');
  const runId = args.get('--run-id');
  const by = args.get('--by');
  if (!base || !runId || !/^[A-Za-z0-9._-]+$/.test(runId) || (by !== 'supervisor' && by !== 'deadline-guard')) {
    process.stderr.write('usage: finalize.ts --base <dir> --run-id <id> --by supervisor|deadline-guard\n');
    return 2;
  }
  const runDir = path.join(base, 'runs', runId);
  let stateText: string;
  try {
    stateText = fs.readFileSync(path.join(runDir, 'run.state'), 'utf8');
  } catch {
    process.stderr.write(`finalize: no ${path.join(runDir, 'run.state')}\n`);
    return 1;
  }
  const result = buildProductRunResult(
    parseStateFile(stateText),
    toLedger(readJson(path.join(base, 'ledger', `${runId}.json`))),
    { by: by as ProductReclaimer, finishedAt: new Date(), usage: readJson(path.join(runDir, 'usage.json')) ?? [] }
  );
  if (result === null) {
    process.stderr.write(`finalize: ${runId}: the state file does not make a result\n`);
    return 1;
  }
  try {
    const published = publishProductRunResult(result, resolveProductPublishDir());
    process.stdout.write(`PRODUCT_RESULT run=${runId} by=${by} out=${published}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`finalize: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
