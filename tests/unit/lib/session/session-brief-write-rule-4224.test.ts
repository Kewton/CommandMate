/**
 * The write rule of `session-brief.ts` (Issue #4224, D2 design §20): every write a send makes
 * goes through one gate, by a site of `BRIEF_WRITE_RULES`, and is made only when the worktree
 * is proven `same` (and, for `same-and-instance`, the instance is still the pinned lifetime).
 * `unknown` and `changed` write nothing (fail-closed).
 *
 * Two parts:
 *  - the scan, from the writer's side: every occurrence of a writer in the module's source is
 *    inside a gate call (`this.write('<site>'` / `writeAtEntrance('<site>'`), every import from
 *    the ledger modules is classified, and every site of the table is used. A writer called
 *    around the table fails. Its own controls run the scanner on sources written here.
 *  - the rule itself, table-driven (`briefWriteVerdict`), with the unknown / changed rows.
 *
 * Reads the module's source only; writes nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { BRIEF_WRITE_RULES, briefWriteVerdict, type BriefWriteGuard } from '@/lib/session/session-brief';

const SOURCE = readFileSync(path.join(process.cwd(), 'src/lib/session/session-brief.ts'), 'utf8');

/** What writes (ledger rows, the incarnation, the reset row, the provider's reservation and receipt). */
const WRITERS = [
  'claimBoundary',
  'copyDeliveryToRelaunchBoundaries',
  'fillBoundaryIncarnation',
  'openBoundary',
  'settleBoundaryClaim',
  'settleStaleClaim',
  'skipBoundary',
  'getOrCreateWorktreeIncarnation',
  'openResetBoundaryFromSend',
  // The provider's port: called as a method (`….reserve!(` / `….settle!(`), not read as a flag.
  '.reserve',
  '.settle',
];

/** What the module imports from the ledger's modules and only reads. A new import must be classified. */
const READERS = [
  'getBoundaryById',
  'getCurrentBoundary',
  'getLatestWorktreeBoundaryId',
  'isSameInstanceLifetime',
  'readInstanceLifetime',
  'getWorktreeIncarnation',
  'BOUNDARY_TOOLS',
  'boundaryDatabaseFor',
  'isResetCommandBody',
  'isSlashCommandBody',
];

const LEDGER_MODULES = ['@/lib/db/session-brief-db', '@/lib/mem/incarnation', '@/lib/session/session-boundary'];

/** Strip comments (a writer's name in prose is not a call). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The span of each gate call: from `this.write(` / `writeAtEntrance(` to its matching paren. */
function gateSpans(source: string): Array<{ site: string; start: number; end: number }> {
  const spans: Array<{ site: string; start: number; end: number }> = [];
  const gate = /(?:this\.write|writeAtEntrance)\(\s*('([a-z.-]+)'|site)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = gate.exec(source))) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    spans.push({ site: match[2] ?? 'site', start: match.index, end });
  }
  return spans;
}

interface ScanResult {
  ungated: string[];
  unclassified: string[];
  unknownSites: string[];
  unusedSites: string[];
  indirect: string[];
}

/** The scanner: the module's source against the table. */
function scan(source: string, sites: readonly string[]): ScanResult {
  const body = code(source);
  const result: ScanResult = { ungated: [], unclassified: [], unknownSites: [], unusedSites: [], indirect: [] };
  // Imports from the ledger modules: named only, every name classified.
  for (const mod of LEDGER_MODULES) {
    const escaped = mod.replace(/[/.@-]/g, (c) => `\\${c}`);
    if (new RegExp(`import\\s*\\*\\s*as\\s+\\w+\\s+from\\s*'${escaped}'`).test(body)) result.indirect.push(`namespace import of ${mod}`);
    if (new RegExp(`(?:import|require)\\(\\s*'${escaped}'`).test(body)) result.indirect.push(`dynamic import of ${mod}`);
    const named = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g');
    let m: RegExpExecArray | null;
    while ((m = named.exec(body))) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        if (!name || /^[A-Z]/.test(name) && name !== 'BOUNDARY_TOOLS') continue; // types
        if (!WRITERS.includes(name) && !READERS.includes(name)) result.unclassified.push(name);
        if (/\sas\s/.test(raw)) result.indirect.push(`aliased import ${raw.trim()}`);
      }
    }
  }
  const imports = body.replace(/import[\s\S]*?from\s*'[^']*';/g, (m) => ' '.repeat(m.length));
  const spans = gateSpans(imports);
  for (const writer of WRITERS) {
    const pattern = writer.startsWith('.')
      ? new RegExp(`\\.${writer.slice(1)}!?\\(`, 'g')
      : new RegExp(`(?<![\\w.])${writer}(?!\\w)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(imports))) {
      const at = m.index;
      if (!spans.some((span) => at > span.start && at < span.end)) {
        result.ungated.push(`${writer} at line ${imports.slice(0, at).split('\n').length}`);
      }
    }
  }
  const used = new Set(spans.map((span) => span.site));
  for (const span of spans) if (span.site !== 'site' && !sites.includes(span.site)) result.unknownSites.push(span.site);
  // A site forwarded as a parameter (`skip(…, site)`) is used by its callers' literals.
  const literals = new Set([...imports.matchAll(/'([a-z]+\.[a-z-]+)'/g)].map((m) => m[1]));
  for (const site of sites) if (!used.has(site) && !literals.has(site)) result.unusedSites.push(site);
  return result;
}

const SITES = Object.keys(BRIEF_WRITE_RULES);
const CLEAN: ScanResult = { ungated: [], unclassified: [], unknownSites: [], unusedSites: [], indirect: [] };

describe('every write of session-brief.ts goes through the table (D2 design §20.2)', () => {
  it('the module: no writer outside the gate, every import classified, every site used', () => {
    expect(scan(SOURCE, SITES)).toEqual(CLEAN);
  });

  it('every skip() names a site of the table (the consuming writes)', () => {
    const calls = [...code(SOURCE).matchAll(/this\.skip\([^;]*?,\s*'([a-z.-]+)'\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(10);
    for (const site of calls) expect(SITES).toContain(site);
    // Nothing calls skip without a site (the old boolean `consume` is gone).
    expect(code(SOURCE)).not.toMatch(/this\.skip\([^;]*,\s*(?:true|false)\)/);
  });

  it('the table: the dead row and the stale claim need the instance as pinned too; nothing after the entrance is unguarded', () => {
    expect(BRIEF_WRITE_RULES['plan.dead-row']).toBe('same-and-instance');
    expect(BRIEF_WRITE_RULES['plan.stale-claim']).toBe('same-and-instance');
    const unguarded = Object.entries(BRIEF_WRITE_RULES).filter(([, guard]) => guard === 'entrance').map(([site]) => site);
    expect(unguarded).toEqual(['entrance.incarnation']);
  });
});

describe('the scanner’s own controls (sources written here)', () => {
  const header = "import { skipBoundary, getBoundaryById } from '@/lib/db/session-brief-db';\n";

  it('positive: a writer called around the gate is found', () => {
    const source = `${header}class A { m(db) { skipBoundary(db, 'x', 'empty', 1); } }`;
    expect(scan(source, ['plan.consume']).ungated).toEqual(['skipBoundary at line 2']);
  });

  it('positive: the provider’s receipt called around the gate is found; its flag check is not a call', () => {
    const source = `${header}async function f(plan) { if (!plan.provider.settle) return; await plan.provider.settle({}); }`;
    expect(scan(source, []).ungated).toEqual(['.settle at line 2']);
  });

  it('positive: a writer taken as a value (an alias) is found', () => {
    const source = `${header}const consume = skipBoundary;\n`;
    expect(scan(source, []).ungated).toHaveLength(1);
  });

  it('positive: a namespace, a dynamic import, an aliased import and an unclassified name are found', () => {
    const source = [
      "import * as ledger from '@/lib/db/session-brief-db';",
      "const later = () => import('@/lib/db/session-brief-db');",
      "import { skipBoundary as s, deleteBoundary } from '@/lib/db/session-brief-db';",
    ].join('\n');
    const result = scan(source, []);
    expect(result.indirect).toHaveLength(3);
    expect(result.unclassified).toEqual(['deleteBoundary']);
  });

  it('positive: a site not in the table, and a table site never used, are found', () => {
    const source = `${header}class A { m(db) { this.write('plan.other', db, () => skipBoundary(db, 'x', 'empty', 1)); } }`;
    const result = scan(source, ['plan.consume']);
    expect(result.unknownSites).toEqual(['plan.other']);
    expect(result.unusedSites).toEqual(['plan.consume']);
  });

  it('negative: the same writer inside the gate, a reader anywhere, and a name in a comment pass', () => {
    const source = `${header}// skipBoundary(db) in prose\nclass A { m(db) { getBoundaryById(db, 'x'); this.write('plan.consume', db, () => skipBoundary(db, 'x', 'empty', 1)); } }`;
    expect(scan(source, ['plan.consume'])).toEqual(CLEAN);
  });
});

describe('the rule (briefWriteVerdict), table-driven', () => {
  const asPinned = () => true;
  const remade = () => false;
  const rows: Array<[BriefWriteGuard, boolean, 'same' | 'changed' | 'unknown', () => boolean, string]> = [
    ['same', true, 'same', remade, 'write'],
    ['same', true, 'unknown', asPinned, 'lifetime_unpinned'],
    ['same', true, 'changed', asPinned, 'worktree_changed'],
    ['same-and-instance', true, 'same', asPinned, 'write'],
    ['same-and-instance', true, 'same', remade, 'incarnation_changed'],
    ['same-and-instance', true, 'unknown', asPinned, 'lifetime_unpinned'], // Codex re-review 2 P2
    ['same-and-instance', true, 'changed', asPinned, 'worktree_changed'],
    ['reset', true, 'same', asPinned, 'write'],
    ['reset', true, 'unknown', asPinned, 'lifetime_unpinned'], // Codex 5-2b P2
    ['reset', true, 'changed', asPinned, 'worktree_changed'],
    ['reset', false, 'unknown', asPinned, 'write'], // Timer / relay: D1's instance check
    ['entrance', false, 'unknown', asPinned, 'write'],
    ['settled', true, 'changed', asPinned, 'write'],
  ];
  it.each(rows)('%s (pinned %s, %s) → %s', (guard, pinned, continuity, instance, expected) => {
    expect(briefWriteVerdict(guard, pinned, continuity, instance)).toBe(expected);
  });

  it('no guard but entrance / settled lets `unknown` or `changed` write when pinned', () => {
    for (const guard of ['same', 'same-and-instance', 'reset'] as const) {
      for (const continuity of ['unknown', 'changed'] as const) {
        expect(briefWriteVerdict(guard, true, continuity, asPinned)).not.toBe('write');
      }
    }
  });
});
