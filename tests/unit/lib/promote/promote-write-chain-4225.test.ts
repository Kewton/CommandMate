/**
 * The chain of writes around the promote path (Issue #4225, design T23・⑦). A's test
 * (`write-entrances-recreate-4221.test.ts`) is left as it is; this one sees what it
 * cannot: a store write named under an alias, through a namespace import or a
 * re-export, and a file that writes `mem_items` without going through the store.
 *
 * (1) The store's writes (`mem-db.ts`'s exports that INSERT / UPDATE / DELETE, found from
 *     its source, not listed by name) are called outside `mem-db.ts` and `mem/service.ts`
 *     only by the callers named below, each with its reason. A new caller fails here.
 * (2) A's entrance for E (`memSettleDecisionTransition`) is called by `promote/service.ts` only,
 *     and `transitionDecision` by `mem/service.ts` only.
 * (3) Nothing under `src/` but `mem-db.ts` writes `mem_items` in SQL.
 * (4) Every entrance of the promote service that reaches a write asks for the screen's
 *     mark first (`isScreenRequest`), in the service and not only in the route.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  exportedWriters,
  firstStatementOf,
  MEM_DB,
  MEM_SERVICE,
  PROMOTE_SERVICE,
  ROOT,
  sourcesUnder,
  specifiersOf,
  SRC,
  usesOf,
  writeEntrancesOfPromote,
} from './promote-write-chain-4225.helpers';

/** Callers of the store's writes outside `mem-db.ts` and `mem/service.ts`, as they are today, with their reasons. */
const KNOWN_STORE_CALLERS: Record<string, { calls: string[]; reason: string }> = {
  'src/lib/db/agent-instances-db.ts': { calls: ['archiveNowSlots', 'nextSlotVersion'], reason: '#4221: a `now` moves out before its roster slot goes' },
  'src/lib/db/worktree-db.ts': { calls: ['archiveNowSlots'], reason: '#4221: a `now` moves out before its worktree goes' },
  'src/lib/db/mem-close-db.ts': { calls: ['closeMemItemByCondition'], reason: '#4222: the condition close, in the notice transaction' },
  'src/lib/mem/settings-service.ts': {
    calls: ['deleteMemBranchOverride', 'saveMemBranchOverride', 'saveMemSettings'],
    reason: '#4221: the screen-only settings (not items)',
  },
};

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const sources = () => sourcesUnder(SRC);

function storeCallers(files: Array<{ file: string; source: string }>): Record<string, string[]> {
  const writers = exportedWriters(readFileSync(MEM_DB, 'utf8'));
  const out: Record<string, string[]> = {};
  for (const { file, source } of files) {
    if (file === MEM_DB || file === MEM_SERVICE) continue;
    const used = usesOf(source, specifiersOf(file, MEM_DB), writers);
    if (used.length > 0) out[rel(file)] = used;
  }
  return out;
}

const SYNTHETIC = path.join(SRC, 'lib/promote/synthetic.ts');

describe('(1) the store is written through mem/service.ts only, but for the named callers', () => {
  it('finds the store writes from its source (transitionDecision among them)', () => {
    const writers = exportedWriters(readFileSync(MEM_DB, 'utf8'));
    for (const known of ['transitionDecision', 'createMemItem', 'updateMemItem', 'closeMemItem', 'purgeMem']) expect(writers.has(known)).toBe(true);
    expect(writers.has('getMemRecord')).toBe(false);
  });

  it('the callers outside are exactly the known ones', () => {
    const found = storeCallers(sources().map((file) => ({ file, source: readFileSync(file, 'utf8') })));
    expect(found).toEqual(Object.fromEntries(Object.entries(KNOWN_STORE_CALLERS).map(([file, entry]) => [file, entry.calls])));
  });

  it.each([
    ['a direct call', "import { transitionDecision } from '@/lib/db/mem-db';\nexport function x(db) { transitionDecision(db, () => true, 'i', { version: 1 }, 'record'); }"],
    ['an alias', "import { transitionDecision as move } from '@/lib/db/mem-db';\nexport function x(db) { move(db, () => true, 'i', { version: 1 }, 'record'); }"],
    ['a namespace import', "import * as store from '@/lib/db/mem-db';\nexport function x(db) { store.transitionDecision(db, () => true, 'i', { version: 1 }, 'record'); }"],
    ['a relative path', "import { updateMemItem } from '../db/mem-db';\nexport function x(db) { updateMemItem(db, a, 'i', 1, {}); }"],
    ['a re-export', "export { transitionDecision } from '@/lib/db/mem-db';"],
  ])('(positive control) %s from a new file is caught', (_name, source) => {
    expect(storeCallers([{ file: SYNTHETIC, source }])).toEqual({ 'src/lib/promote/synthetic.ts': [expect.any(String)] });
  });

  it('(control) a read of the store from a new file is not', () => {
    expect(storeCallers([{ file: SYNTHETIC, source: "import { getMemRecord } from '@/lib/db/mem-db';\nexport const x = (db) => getMemRecord(db, 'i');" }])).toEqual({});
  });
});

describe('(2) the decision transition has one way in', () => {
  const callersOf = (name: string, module: string) =>
    sources()
      .filter((file) => file !== module)
      .filter((file) => usesOf(readFileSync(file, 'utf8'), specifiersOf(file, module), new Set([name])).length > 0)
      .map(rel);

  it('memSettleDecisionTransition is called by promote/service.ts only', () => {
    expect(callersOf('memSettleDecisionTransition', MEM_SERVICE)).toEqual(['src/lib/promote/service.ts']);
  });

  it('transitionDecision is called by mem/service.ts only', () => {
    expect(callersOf('transitionDecision', MEM_DB)).toEqual(['src/lib/mem/service.ts']);
  });
});

describe('(3) no file but the store writes mem_items in SQL', () => {
  const MEM_ITEMS_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mem_items\b/i;
  it('finds none outside mem-db.ts (the store and its migrations aside)', () => {
    const writers = sources()
      .filter((file) => file !== MEM_DB && !file.includes(`${path.sep}migrations${path.sep}`))
      .filter((file) => MEM_ITEMS_WRITE.test(readFileSync(file, 'utf8')))
      .map(rel);
    expect(writers).toEqual([]);
  });

  it('(positive control) the rejected option of S1 (E writing mem_items itself) is caught', () => {
    expect(MEM_ITEMS_WRITE.test("db.prepare(`UPDATE mem_items SET state = 'recorded' WHERE id = ?`)")).toBe(true);
    expect(MEM_ITEMS_WRITE.test('SELECT * FROM mem_items')).toBe(false);
  });
});

describe('(4) every write entrance of the promote service asks for the screen first', () => {
  const service = readFileSync(PROMOTE_SERVICE, 'utf8');

  it('the entrances are found and each starts with isScreenRequest', () => {
    const entrances = writeEntrancesOfPromote(service);
    expect(entrances.length).toBeGreaterThanOrEqual(6);
    expect(entrances).not.toContain('promoteList');
    for (const name of entrances) expect(firstStatementOf(service, name)).toMatch(/^if \(!isScreenRequest\(request\)\)/);
  });

  it('(positive control) a new entrance through a helper is found, and one without the check is caught', () => {
    const extra = `${service}
function sweepHelper(db: Database.Database): void {
  settleStalePromoteAttempts(db, 'b', 0);
}
export async function promoteSweep(db: Database.Database): Promise<MemOutcome> {
  sweepHelper(db);
  return promoteError('not_found');
}
`;
    expect(writeEntrancesOfPromote(extra)).toContain('promoteSweep');
    expect(firstStatementOf(extra, 'promoteSweep')).not.toMatch(/isScreenRequest/);
  });

  it('(control) a new read-only export is not an entrance', () => {
    const reader = `${service}\nexport async function promotePeek(db: Database.Database): Promise<MemOutcome> {\n  return promoteError('not_found');\n}\n`;
    expect(writeEntrancesOfPromote(reader)).toEqual(writeEntrancesOfPromote(service));
  });
});
