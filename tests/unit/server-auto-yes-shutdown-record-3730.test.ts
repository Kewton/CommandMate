/**
 * Where `server.ts` records and restores the Auto-Yes shutdown record
 * (Issue #3730).
 *
 * The server cannot be started under the unit suite, so the two boundaries are
 * pinned on the shipped source, by position:
 *
 * - **Start.** The restore runs synchronously before EITHER listener opens
 *   (`remoteServer.listen` and `server.listen`), so the first request on the
 *   local or the remote door already sees the notices, and no enable / disable
 *   a request makes can be overwritten by a seed landing after it. It also runs
 *   before `initializeWorktrees()` (the ID reconcile there moves the notices
 *   with every other state).
 * - **Stop.** The record is taken inside `gracefulShutdown`, before the
 *   pollers are released and before the listeners close — it is also what
 *   closes the door on an enable still in flight.
 *
 * What the two functions do is tested in
 * `tests/unit/lib/auto-yes-shutdown-record-3730.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

/** Index of the only CODE occurrence of `needle` (comment lines skipped). */
function codeIndex(needle: string): number {
  let offset = 0;
  const hits: number[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    if (!isComment && line.includes(needle)) hits.push(offset + line.indexOf(needle));
    offset += line.length + 1;
  }
  expect(hits, `expected exactly one code occurrence of ${needle}`).toHaveLength(1);
  return hits[0];
}

describe('server.ts and the Auto-Yes shutdown record (Issue #3730)', () => {
  it('imports both halves from the record module', () => {
    expect(source).toMatch(
      /import \{ recordAutoYesShutdown, restoreAutoYesShutdownRecord \} from '\.\/src\/lib\/auto-yes-shutdown-record';/,
    );
  });

  it('restores before either listener opens and before the worktree initialisation', () => {
    const restore = codeIndex('restoreAutoYesShutdownRecord();');
    expect(restore).toBeLessThan(codeIndex('remoteServer.listen('));
    expect(restore).toBeLessThan(codeIndex('server.listen(port, hostname'));
    expect(restore).toBeLessThan(codeIndex('await initializeWorktrees();'));
  });

  it('records inside the graceful shutdown, before the pollers are released and the listeners close', () => {
    const shutdown = codeIndex('function gracefulShutdown(');
    const record = codeIndex('recordAutoYesShutdown();');
    expect(record).toBeGreaterThan(shutdown);
    expect(record).toBeLessThan(codeIndex("releaseAutoYes('server-shutdown', { scope: 'all' });"));
    expect(record).toBeLessThan(codeIndex('listener.close('));
  });
});
