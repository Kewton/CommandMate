/**
 * I1 and I2 kept as rules, not as edges (Issue #4225, design §11.1, 5-2d): every await
 * and every state-changing write of the promote service is a row of the design's table,
 * every entrance names where its generation is fixed, and every UPDATE of an operation is
 * conditional. A new await or write that bypasses the table fails here.
 *
 * The controls run the same checks on changed copies of the sources written under a
 * `mkdtemp` directory (removed after each test); the repository's files are not touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  casRowsWithoutResult,
  conditionalWriteViolations,
  discardedCasResults,
  countRows,
  diffCounts,
  documentedCounts,
  generationViolations,
  readService,
  tableOf,
} from './promote-await-write-table-4225.helpers';

const ROOT = process.cwd();
const SERVICE = readFileSync(path.join(ROOT, 'src/lib/promote/service.ts'), 'utf8');
const STORE = readFileSync(path.join(ROOT, 'src/lib/db/mem-promote-db.ts'), 'utf8');
const DESIGN = readFileSync(path.join(ROOT, 'docs/design/mem-promote-4225.md'), 'utf8');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'promote-await-write-4225-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A changed copy, written and read back from the sandbox. */
function copyOf(source: string, from: string, to: string, name = 'copy.ts'): string {
  expect(source.includes(from)).toBe(true);
  const file = path.join(dir, name);
  writeFileSync(file, source.replace(from, to));
  return readFileSync(file, 'utf8');
}

const tableDiff = (source: string) => diffCounts(countRows(readService(source).rows), documentedCounts(DESIGN));
const generation = () => tableOf(DESIGN, 'promote-generation');

describe('the table of the design is the service', () => {
  it('every await and every write of the service is a row with its count (and no row is left over)', () => {
    expect(documentedCounts(DESIGN).size).toBeGreaterThan(0);
    expect(tableDiff(SERVICE)).toEqual([]);
  });

  it('every row says its rule', () => {
    for (const row of tableOf(DESIGN, 'promote-await-write')) expect(row[4]?.length ?? 0, row.join(' | ')).toBeGreaterThan(0);
  });

  it('every value import of a store, A or outside is classified as a write or a read; the service runs no SQL but SELECT', () => {
    const reading = readService(SERVICE);
    expect(reading.unclassified).toEqual([]);
    expect(reading.rawWrites).toEqual([]);
  });

  it('I1: every entrance names where its generation is fixed, and it is fixed before the first await', () => {
    expect(generation().map(([fn]) => fn).sort()).toEqual(readService(SERVICE).entrances);
    expect(generationViolations(readService(SERVICE), generation())).toEqual([]);
  });

  it('I2: every UPDATE of an operation is conditional on its state; the transition on the transition as read, its reason on the claim', () => {
    expect(conditionalWriteViolations(STORE)).toEqual([]);
  });

  it('I2 (5-2e): no caller throws away the result of a CAS (service and store), and every CAS row of the table says the caller sees it', () => {
    expect(discardedCasResults(SERVICE)).toEqual([]);
    expect(discardedCasResults(STORE)).toEqual([]);
    expect(casRowsWithoutResult(DESIGN)).toEqual([]);
  });
});

describe('(self-test) the checks fail on what they forbid', () => {
  it('a new await in an entrance → a row is missing', () => {
    const changed = copyOf(SERVICE, "if (body.ifState !== 'unknown')", "await Promise.resolve();\n  if (body.ifState !== 'unknown')");
    expect(tableDiff(changed)).toEqual(['promoteAbandon|await|Promise.resolve: source 1, table 0']);
  });

  it('a new write in an entrance → a row is missing', () => {
    const changed = copyOf(SERVICE, "if (!getRepositoryById(db, repositoryId)) return promoteError('not_found');\n  const now", "abandonPromoteOperation(db, repositoryId, 0);\n  if (!getRepositoryById(db, repositoryId)) return promoteError('not_found');\n  const now");
    expect(tableDiff(changed)).toEqual(['promoteList|write|abandonPromoteOperation: source 1, table 0']);
  });

  it('a second call of a listed write → the count differs', () => {
    const changed = copyOf(SERVICE, "logger.info('mem-promote-abandoned'", "abandonPromoteOperation(db, operationId, 0);\n  logger.info('mem-promote-abandoned'");
    expect(tableDiff(changed)).toEqual(['promoteAbandon|write|abandonPromoteOperation: source 2, table 1']);
  });

  it('an unclassified import, an alias, and SQL the service writes itself → reported', () => {
    let changed = copyOf(SERVICE, '  abandonPromoteOperation,\n', '  abandonPromoteOperation,\n  rewritePromoteOperation,\n  settlePromoteOperation as settleAgain,\n');
    changed = copyOf(changed, "logger.info('mem-promote-abandoned'", "db.prepare('UPDATE mem_promote_operations SET state = 1').run();\n  logger.info('mem-promote-abandoned'", 'copy2.ts');
    const reading = readService(changed);
    expect(reading.unclassified).toEqual(['rewritePromoteOperation', 'settlePromoteOperation as settleAgain']);
    expect(reading.rawWrites).toHaveLength(1);
  });

  it('I1: the generation taken after the membership’s await again (the 5-2d P1 shape) → reported', () => {
    const fixLine = SERVICE.split('\n').find((line) => line.includes('const incarnation = itemClosedAcknowledged ? null : getOrCreateWorktreeIncarnation('))!;
    const awaitLine = SERVICE.split('\n').find((line, i, all) => line.includes('const readIds = await repositoryReadIds') && all[i - 1] === fixLine)!;
    const changed = copyOf(SERVICE, `${fixLine}\n${awaitLine}`, `${awaitLine}\n${fixLine}`);
    expect(generationViolations(readService(changed), generation())).toEqual([
      'promoteSettleTransition: getOrCreateWorktreeIncarnation after the first await',
      'promoteSettleTransition: the lifetime is taken after an await',
    ]);
  });

  it('I1: an entrance without a row in the generation table → reported', () => {
    const changed = copyOf(SERVICE, '/** For tests and the routes', 'export async function promoteExtra(): Promise<void> {}\n\n/** For tests and the routes');
    expect(generationViolations(readService(changed), generation())).toEqual(['promoteExtra: no row in the generation table']);
  });

  it('I2: the claim dropped from the failure’s condition, or the state dropped from an UPDATE → reported', () => {
    const noClaim = copyOf(STORE, "WHERE id = ? AND state = 'succeeded' AND transition_pending = 1 AND transition_claim = ?`", "WHERE id = ? AND state = 'succeeded' AND transition_pending = 1`");
    expect(conditionalWriteViolations(noClaim)).toEqual([expect.stringContaining("a reason written without the request's claim")]);
    const noState = copyOf(STORE, "WHERE id = ? AND state = 'unknown'`", 'WHERE id = ?`', 'copy2.ts');
    expect(conditionalWriteViolations(noState)).toEqual(['no state condition: id = ?']);
  });

  it('I2 (5-2e): the settle’s result thrown away (the 5-2e P2 shape), a CAS under void or awaited alone → reported', () => {
    const settleLine = SERVICE.split('\n').find((line) => line.includes('const own = settleOrUnknown(db, claimed.operationId, settle, now'))!;
    const dropped = copyOf(SERVICE, settleLine, settleLine.replace('const own = ', '') + '\n    const own = true;');
    expect(discardedCasResults(dropped)).toEqual(['promoteApprove|settleOrUnknown']);
    const voided = copyOf(
      SERVICE,
      "if (!abandonPromoteOperation(db, operationId, deps.now?.() ?? Date.now())) return promoteError('state_forbids');",
      'void abandonPromoteOperation(db, operationId, 0);\n  await (finishPromoteTransition(db, operationId, \'c\', { moved: true }, 0));',
      'copy2.ts'
    );
    expect(discardedCasResults(voided)).toEqual(['promoteAbandon|abandonPromoteOperation', 'promoteAbandon|finishPromoteTransition']);
    const store = copyOf(
      STORE,
      "if (settlePromoteOperation(db, row.operation_id, { state: 'unknown', reason: 'stale_attempt' }, now)) settled += 1;",
      "settlePromoteOperation(db, row.operation_id, { state: 'unknown', reason: 'stale_attempt' }, now);",
      'copy3.ts'
    );
    expect(discardedCasResults(store)).toEqual(['settleStalePromoteAttempts|settlePromoteOperation']);
  });

  it('I2 (5-2e): a CAS row of the table whose rule does not say the result is seen → reported', () => {
    const row = DESIGN.split('\n').find((line) => line.startsWith('| `promoteAbandon` | write | `abandonPromoteOperation` |'))!;
    const file = path.join(dir, 'design.md');
    writeFileSync(file, DESIGN.replace(row, '| `promoteAbandon` | write | `abandonPromoteOperation` | 1 | I2：`unknown` のときだけ |'));
    expect(casRowsWithoutResult(readFileSync(file, 'utf8'))).toEqual(['promoteAbandon|abandonPromoteOperation']);
  });

  it('(control) the sources as they are, copied unchanged → nothing reported', () => {
    const service = copyOf(SERVICE, 'export', 'export');
    expect(tableDiff(service)).toEqual([]);
    expect(generationViolations(readService(service), generation())).toEqual([]);
    expect(conditionalWriteViolations(copyOf(STORE, 'export', 'export', 'copy2.ts'))).toEqual([]);
    expect(discardedCasResults(service)).toEqual([]);
    expect(discardedCasResults(copyOf(STORE, 'export', 'export', 'copy3.ts'))).toEqual([]);
  });
});
