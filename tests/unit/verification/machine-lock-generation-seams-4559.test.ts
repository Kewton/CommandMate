/**
 * Issue #4559 PR-2, T3 (the JS part; docs/design/machine-lock-generation-4559.md §8.1): the guard of the
 * seams. One table (OPS, below) is the source: every operation of the core that changes a name — a raw
 * `fs.mkdirSync` / `linkSync` / `renameSync` / `rmSync` / `rmdirSync` / `unlinkSync`, an observed
 * `obs.mkdir` / `link` / `rename` / `unlink` / `rmdir`, the clean-up deletes `rmQuiet` / `rmdirQuiet` —
 * is a row (function, operation, count), with the seam right before it (or `—`, an older step of the
 * <lock> kept for the older versions, §6) and the model's step. The scan of the core must give exactly
 * the table; a row with a seam must have `seam(` on the line right before each of its operations. The
 * design's §8.3 is the table rendered, byte for byte.
 *
 * Also: nothing outside the core (and its byte copy) writes a generation's `end` or names a generation,
 * and machine-lock.ts has no file operation of its own — given that the copy is the core (the copy test;
 * here its premise is checked again, so a changed copy turns this red rather than silently passing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  CHAIN_CHOICE_POINTS,
  NON_BLOCKING,
  OPS,
  TABLE_SCENARIOS,
  buildTable,
  chainPoints,
  cleanAll,
  coreProcedures,
  heldBack,
  namesPoint,
  nonBlocking,
  parseCore,
  readAgain,
  releasedWithoutEnd,
  renderOps,
  renderTable,
  type OpRow,
  type TableRow,
} from './lock-generation-4559-harness';
import { CHAIN_OBSERVATION_POINTS, OBSERVATION_POINTS } from './lock-observation-points-4288';

const REPO = path.resolve(__dirname, '../../..');
const CORE = 'scripts/orchestrate/machine-lock-sync.mjs';
const COPY = 'src/lib/verification/machine-lock-sync-core.generated.ts';
const TS = 'src/lib/verification/machine-lock.ts';
const DOC = 'docs/design/machine-lock-generation-4559.md';
const read = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');

const OP_RE = /\b(fs\.(?:mkdirSync|linkSync|renameSync|rmSync|rmdirSync|unlinkSync)|obs\.(?:mkdir|link|rename|unlink|rmdir)|rmQuiet|rmdirQuiet)\(/g;

/** Each name-changing operation of a source: the top-level function, the operation, the line and the line before it. */
export function scanOps(source: string): { fn: string; op: string; line: number; before: string }[] {
  const lines = source.split('\n');
  const found: { fn: string; op: string; line: number; before: string }[] = [];
  let fn = '<top>';
  let before = '';
  lines.forEach((text, i) => {
    const def = /^(?:export )?(?:async )?function\*? ([A-Za-z_$][\w$]*)/.exec(text);
    if (def) fn = def[1];
    const code = !/^\s*(\*|\/\/|\/\*)/.test(text) && text.trim() !== '';
    if (code) {
      for (const m of text.matchAll(OP_RE)) {
        if (/function\s+$/.test(text.slice(0, m.index))) continue; // the definition itself
        found.push({ fn, op: m[1], line: i + 1, before });
      }
      before = text;
    }
    if (/^\}/.test(text)) fn = '<top>';
  });
  return found;
}

const counted = (ops: { fn: string; op: string }[]): string[] => {
  const m = new Map<string, number>();
  for (const o of ops) m.set(`${o.fn}|${o.op}`, (m.get(`${o.fn}|${o.op}`) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).sort();
};

/** The seam names a row's column allows before its operations (`a・b` per occurrence in order; `<use>-…` any GEN_WRITES seam). */
function seamOk(row: OpRow, index: number, before: string): boolean {
  const parts = row.seam.split('・');
  const want = parts.length === row.count ? parts[index] : parts[0];
  if (want === '—') return true;
  if (want.startsWith('<use>')) return /\bg\.seam\(w\.seam(?:Tmp|Linked)\)/.test(before);
  return before.includes(`seam('${want}')`);
}

export function checkSeams(source: string): string[] {
  const bad: string[] = [];
  const ops = scanOps(source);
  for (const row of OPS) {
    ops
      .filter((o) => o.fn === row.fn && o.op === row.op)
      .forEach((o, i) => {
        if (!seamOk(row, i, o.before)) bad.push(`${row.fn} ${row.op} at line ${o.line}: no seam ${row.seam} right before (${o.before.trim()})`);
      });
  }
  return bad;
}

/** The table of the design's §8.3 (from its heading to the first blank line after the table starts). */
export function docOpsTable(doc: string): string | null {
  const at = doc.indexOf('\n### 8.3 ');
  if (at < 0) return null;
  const rest = doc.slice(at + 1);
  const start = rest.indexOf('\n| 関数 |');
  if (start < 0) return null;
  const body = rest.slice(start + 1);
  const end = body.indexOf('\n\n');
  return end < 0 ? body.trimEnd() : body.slice(0, end);
}

describe('#4559 T3: the name-changing operations of the core are the table, each with its seam', () => {
  it('the scan of the core is the table, row for row and count for count', () => {
    const ops = scanOps(read(CORE));
    expect(ops.length).toBeGreaterThanOrEqual(50);
    expect(counted(ops)).toEqual(OPS.map((r) => `${r.fn}|${r.op} ${r.count}`).sort());
  });

  it('every operation of a row with a seam has the seam on the line right before it', () => {
    expect(checkSeams(read(CORE))).toEqual([]);
  });

  it('the design\'s §8.3 is the table rendered, byte for byte', () => {
    expect(docOpsTable(read(DOC))).toBe(renderOps());
  });

  it('self-test: a raw rmSync added without a seam, a linkSync in a new function, a seam removed — each is red', () => {
    const core = read(CORE);
    const added = core.replace("    g.seam('gc-rm');\n", "    g.seam('gc-rm');\n    fs.rmSync(genPath(g, n), { recursive: true });\n");
    expect(added).not.toBe(core);
    expect(counted(scanOps(added))).not.toEqual(OPS.map((r) => `${r.fn}|${r.op} ${r.count}`).sort());
    const fresh = `${core}\nfunction sneak(a, b) {\n  fs.linkSync(a, b);\n}\n`;
    expect(counted(scanOps(fresh))).toContain('sneak|fs.linkSync 1');
    const unseamed = core.replace("    g.seam('gen-mkdir');\n", '');
    expect(unseamed).not.toBe(core);
    expect(checkSeams(unseamed).length).toBe(1);
    expect(docOpsTable('# x\n\n### 8.3 a\n\n| 関数 | x |\n|---|---|\n\nmore')).toBe('| 関数 | x |\n|---|---|');
  });
});

/** Writes of a generation's `end` or names of a generation outside the core: `writeEnd(`, `genName(`, `GEN_PATTERN.test(`, `genDirOf(`, a `g<12 digits>` name. */
const OUTSIDE = /\bwriteEnd\(|\bgenName\(|\bGEN_PATTERN\.test\(|\bgenDirOf\(|\.gen\/g\d|\bg\d{12}\b/;

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(rel);
  }
}

describe('#4559 T3: nothing but the core writes `end` or names a generation; TS has no file operation of its own', () => {
  it('src/ and scripts/ (the core and its byte copy aside) never write `end` or name a generation', () => {
    const files: string[] = [];
    walk('src', files);
    walk('scripts', files);
    expect(files.length).toBeGreaterThan(100);
    // The premise of leaving the copy out: it is the core, byte for byte (the copy test's first row).
    expect(read(COPY).endsWith(read(CORE))).toBe(true);
    const hits = files.filter((f) => f !== CORE && f !== COPY).filter((f) => OUTSIDE.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('self-test: a file that writes `end` itself is found; a copy that is not the core breaks the premise', () => {
    expect(OUTSIDE.test("fs.linkSync(tmp, path.join(genDirOf(lock), 'g000000000001', 'end'));")).toBe(true);
    expect(OUTSIDE.test('const n = genName(3);')).toBe(true);
    expect(`${read(COPY)}\n// x`.endsWith(read(CORE))).toBe(false);
  });

  const FS_OPS = /\bfrom ['"](?:node:)?fs['"]|\brequire\(['"](?:node:)?fs['"]\)|\b(?:readdirSync|mkdirSync|renameSync|readFileSync|lstatSync|existsSync|statSync|rmdirSync|rmSync|linkSync|unlinkSync|writeFileSync|openSync)\(|\bchild_process\b/g;

  it('machine-lock.ts has no file operation and no process probe of its own (0 counted)', () => {
    const ts = read(TS);
    expect(ts.length).toBeGreaterThan(2000);
    expect([...ts.matchAll(FS_OPS)].map((m) => m[0])).toEqual([]);
  });

  it('self-test: an fs import or a raw call added to machine-lock.ts is counted', () => {
    const ts = `import { rmSync } from 'fs';\n${read(TS)}\nrmSync('x');\n`;
    expect([...ts.matchAll(FS_OPS)].length).toBe(2);
  });
});

// ------------------------------------------------------------------ §4.4: the writer's own tomb (PR-2, PM's disposal)

/**
 * The writer whose own owner publish failed (EIO once at gen-owner-link) is killed (i) before its own tomb
 * (`gen-owner-failed`) or (ii) after it, before its `end` (`tomb-linked`); the successor B decides by what is
 * left — (i) an owner-less generation: not inside the grace, taken past it; (ii) a tomb: taken at once, its
 * generation ended dead. Each row counts the seam's calls (reached once, not passed by silence). A copy of the
 * core without the own tomb never reaches (ii)'s seam.
 */

const CHILD = `
import fs from 'node:fs';
const [core, root, genDir, events] = process.argv.slice(1);
const m = await import(core);
const hooks = {
  genDir,
  fault: (p, _t, c) => {
    if (p !== 'gen-owner-link' || c !== 1) return undefined;
    fs.appendFileSync(events, 'fault ' + p + '\\n');
    return 'EIO';
  },
  onGenStage: (s) => fs.appendFileSync(events, s + '\\n'),
};
const r = m.acquireMachineLockSync('x', { root, timeoutMs: 600, pollMs: 10, hooks });
fs.appendFileSync(events, 'result ' + r.acquired + '\\n');
if (r.acquired) r.release();
`;

async function killedWriter(corePath: string, stop: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-own-tomb-'));
  const genDir = path.join(root, 'x.gen');
  const dir = fs.mkdtempSync(path.join(root, 'pause-'));
  const events = path.join(dir, 'events');
  fs.writeFileSync(events, '');
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, pathToFileURL(corePath).href, root, genDir, events], {
    env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, CM_VERIFY_TEST_HANDOFF: `pause:${stop}#1`, CM_VERIFY_TEST_HANDOFF_DIR: dir },
    stdio: 'ignore',
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const reachedFile = path.join(dir, `${stop}#1.reached`);
  const end = Date.now() + 8000;
  let done = false;
  void exited.then(() => (done = true));
  while (!fs.existsSync(reachedFile) && !done && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  const reached = fs.existsSync(reachedFile);
  child.kill('SIGKILL');
  await exited;
  const lines = fs.readFileSync(events, 'utf8').split('\n');
  const calls = lines.filter((l) => l === stop).length;
  // b P3-1: what the writer reached before the stop — its own mkdir of g1 and the injected publish failure —
  // so a copy that cannot even be loaded is not read as "never reached the seam".
  const before = { genMkdir: lines.filter((l) => l === 'gen-mkdir').length, faults: lines.filter((l) => l === 'fault gen-owner-link').length, g1: fs.existsSync(path.join(genDir, lockSync.genName(1))) };
  return { root, genDir, reached, calls, before };
}

const g1 = (genDir: string) => {
  const dir = path.join(genDir, lockSync.genName(1));
  const owner = fs.existsSync(path.join(dir, 'owner')) ? JSON.parse(fs.readFileSync(path.join(dir, 'owner'), 'utf8')) : null;
  const end = fs.existsSync(path.join(dir, 'end')) ? fs.readFileSync(path.join(dir, 'end'), 'utf8').split(' ')[0] : null;
  return { owner, end };
};
const successor = (root: string, genDir: string, aheadMs: number, timeoutMs: number) =>
  lockSync.acquireMachineLockSync('x', { root, timeoutMs, pollMs: 10, hooks: { genDir, now: () => Date.now() + aheadMs, startOf: () => 0 } });

describe('#4559 §4.4: the writer\'s own tomb after its owner publish failed, killed before and after it', () => {
  it('(i) killed before its own tomb (gen-owner-failed, reached once): an owner-less generation — not taken inside the grace, taken past it', async () => {
    const w = await killedWriter(path.join(REPO, CORE), 'gen-owner-failed');
    try {
      expect({ reached: w.reached, calls: w.calls }).toEqual({ reached: true, calls: 1 });
      expect(g1(w.genDir)).toEqual({ owner: null, end: null });
      // the ticket's wait aside (70 s ahead: the dead writer's ticket is gone anyway), inside the grace (10 min)
      expect(successor(w.root, w.genDir, 70_000, 200).acquired).toBe(false);
      const past = successor(w.root, w.genDir, 11 * 60_000, 1000);
      expect(past.acquired).toBe(true);
      expect(g1(w.genDir)).toMatchObject({ owner: { tomb: 1 }, end: 'dead' });
      expect(past.release()).toBe('released');
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  }, 20000);

  it('(ii) killed after its own tomb, before its end (tomb-linked, reached once): the successor ends it dead and takes inside the grace', async () => {
    const w = await killedWriter(path.join(REPO, CORE), 'tomb-linked');
    try {
      expect({ reached: w.reached, calls: w.calls }).toEqual({ reached: true, calls: 1 });
      expect(g1(w.genDir)).toMatchObject({ owner: { tomb: 1 }, end: null });
      const inside = successor(w.root, w.genDir, 70_000, 1000);
      expect(inside.acquired).toBe(true);
      expect(g1(w.genDir).end).toBe('dead');
      expect(inside.release()).toBe('released');
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  }, 20000);

  it('self-test: a copy of the core without the own tomb never reaches (ii)\'s seam (0 calls) and leaves the generation owner-less', async () => {
    const core = read(CORE);
    const start = core.indexOf("      g.seam('gen-owner-failed');");
    // the own tomb and its end are cut; `g.own = null` (r6: the writer lets g<n> go, §4.1) stays with the return
    const stop = core.indexOf('      g.own = null;\n      return { unknown: published.unknown };', start);
    expect([start > 0, stop > start]).toEqual([true, true]);
    const broken = `${core.slice(0, start)}${core.slice(stop)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-own-tomb-copy-'));
    try {
      const file = path.join(dir, 'machine-lock-sync-no-own-tomb.mjs');
      fs.writeFileSync(file, broken);
      const w = await killedWriter(file, 'tomb-linked');
      try {
        expect(w.before, 'the copy ran up to the publish failure (g1 made, the fault fired once)').toEqual({ genMkdir: 1, faults: 1, g1: true });
        expect({ reached: w.reached, calls: w.calls }).toEqual({ reached: false, calls: 0 });
        expect(g1(w.genDir)).toEqual({ owner: null, end: null });
      } finally {
        fs.rmSync(w.root, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
  it('self-test (b P3-1): a copy that cannot be loaded reaches nothing before the stop either — the row above would be red on it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-own-tomb-unloadable-'));
    try {
      const file = path.join(dir, 'machine-lock-sync-unloadable.mjs');
      fs.writeFileSync(file, "throw new Error('not a core');\n");
      const w = await killedWriter(file, 'tomb-linked');
      try {
        expect(w.before).toEqual({ genMkdir: 0, faults: 0, g1: false });
        expect(w.before).not.toEqual({ genMkdir: 1, faults: 1, g1: true });
      } finally {
        fs.rmSync(w.root, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});


// ------------------------------------------------------------------ #4559 r7 §1 / r8 (2): the gate (PM's disposition 1)

/**
 * The gate of the public functions (r7 §1, made machine-decided in r8 (2)): the table of the core's public functions ×
 * the observation points each reaches × the reach of the point × resolved / absent / unknown is made by machine
 * (lock-generation-4559-harness.ts `buildTable`: the functions and the points each can reach from a parse of the
 * core's source, the rows from the runs), and every row is checked here — an unknown at any reach (and an absent of
 * the chain's choice) holds back the decision that depends on it (C7-I3): no `end`, no <lock> moved, no generation
 * made, not `released` / taken / removed, past what was on disk at that reach; the reach reached; the answer naming
 * the point (r8 (4)). A failed reach read again (the point once more, then the resolved run's answer) is the next
 * row's to fail. An answer `released` comes with its `end` (r8 (1), §4.2), in every column. A function, an export
 * form, a point or a reach added to the core without its row is red; so is the design's §8.4 when it is not the
 * table, byte for byte.
 */
/** The <lock>'s points (#4288: the rows of the observation table that bash makes too). */
const OLDER_POINTS = new Set(OBSERVATION_POINTS.filter((p) => p.impls.includes('bash')).map((p) => p.point));
/**
 * r8 (4): the points whose answer must name them — the generation chain's rows of the observation table (#4559). The
 * <lock>'s points (#4288's rows, and its test seam handoff-tmp) answer as #4288 does (`kept`, `not acquired`,
 * `not ok (<stage>)`, a `deferred` named by the pid or the group), checked by lock-observation-points-4288 at every
 * point × implementation and not changed by this PR (no output outside its range); the gate holds them back as every
 * row.
 */
const NAMED_POINTS = new Set(CHAIN_OBSERVATION_POINTS);

/** The table of the design's §8.4 (from its heading to the first blank line after the table starts). */
export function docGateTable(doc: string): string | null {
  const at = doc.indexOf('\n### 8.4 ');
  if (at < 0) return null;
  const rest = doc.slice(at + 1);
  const start = rest.indexOf('\n| 関数 | 場面 |');
  if (start < 0) return null;
  const body = rest.slice(start + 1);
  const end = body.indexOf('\n\n');
  return end < 0 ? body.trimEnd() : body.slice(0, end);
}

/** What the gate finds wrong in a table: each row's breaks, named `<function> <scenario> <point>#<reach> <value>: …`. */
export function gateBreaks(rows: TableRow[]): string[] {
  const bad = new Set<string>();
  for (const r of rows) {
    const at = `${r.fn} ${r.scenario} ${r.point}#${r.k}`;
    if (r.reached < 1 || r.k < 1 || r.k > r.reached) bad.add(`${at}: not a reach of its resolved run (${r.reached})`);
    for (const [value, run] of [['resolved', r.resolved], ['absent', r.absent], ['unknown', r.unknown]] as const) {
      if (value !== 'resolved' && !run.fired) bad.add(`${at} ${value}: reach ${r.k} not reached`);
      // the absent of beacon-gen-end is the generation gone (L1: over — removed below the largest): released, no end of its own
      if (releasedWithoutEnd(run) && !(value === 'absent' && r.point === 'beacon-gen-end')) bad.add(`${value === 'resolved' ? `${r.fn} ${r.scenario}` : at} ${value}: released without an end (${run.changes.join(', ')})`);
    }
    if (nonBlocking(r.fn, r.point)) {
      // the same answer (the unknown may be named in it) and the same changes on disk
      const bare = (o: string): string => o.replace(new RegExp(` \\(${r.point} [A-Z]+\\)$`), '');
      const same = { outcome: bare(r.unknown.outcome), changes: r.unknown.changes };
      if (JSON.stringify(same) !== JSON.stringify({ outcome: r.resolved.outcome, changes: r.resolved.changes })) bad.add(`${at} unknown: named a clean-up, but answers ${r.unknown.outcome} (${r.unknown.changes.join(', ')}) for ${r.resolved.outcome}`);
    } else if (!readAgain(r, r.unknown)) {
      for (const b of heldBack(r, r.unknown)) bad.add(`${at} unknown: ${b}`);
      if (NAMED_POINTS.has(r.point) && !namesPoint(r.unknown, r.point, 'EIO')) bad.add(`${at} unknown: the answer ${r.unknown.outcome} names nothing`);
    }
    if (CHAIN_CHOICE_POINTS.includes(r.point)) for (const b of heldBack(r, r.absent)) bad.add(`${at} absent: ${b}`);
  }
  return [...bad];
}

async function loadCopy(dir: string, source: string): Promise<typeof lockSync> {
  const file = path.join(dir, `machine-lock-sync-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, source);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof lockSync;
}
const only = (fns: string[]) => Object.fromEntries(fns.map((f) => [f, TABLE_SCENARIOS[f]]));
/** A copy of the core with `from` (there once) replaced by `to`, loaded from a temporary directory. */
async function brokenCopy(dir: string, edits: [string, string][]): Promise<typeof lockSync> {
  let core = read(CORE);
  for (const [from, to] of edits) {
    expect(core.split(from).length - 1, `the line to break is in the core once: ${from.trim().slice(0, 80)}`).toBe(1);
    core = core.replace(from, to);
  }
  return loadCopy(dir, core);
}

describe('#4559 r7 §1 / r8 (2): the gate — the public functions × their points × each reach × resolved / absent / unknown', () => {
  let rows: TableRow[] = [];
  beforeAll(() => {
    rows = buildTable(lockSync);
  }, 120000);
  afterAll(() => cleanAll());

  it('r8 (2): the exports are read in every form, and they are the module\'s — every name, each a function or not as it is', () => {
    const parsed = parseCore(read(CORE));
    const mod = lockSync as unknown as Record<string, unknown>;
    expect(parsed.exports.map((e) => e.name).sort()).toEqual(Object.keys(mod).sort());
    for (const e of parsed.exports) expect(e.fn, e.name).toBe(typeof mod[e.name] === 'function');
    expect(parsed.exports.length).toBeGreaterThanOrEqual(40);
    // the observations whose point is not a literal or a parameter: GEN_WRITES' (each use's row) only
    expect(parsed.unresolved).toEqual(['linkIntoGen: w.put', 'linkIntoGen: w.link']);
  });

  it('the public functions are read from the core, and each has its scenarios (none without)', () => {
    const procs = coreProcedures(read(CORE));
    expect(procs.length).toBeGreaterThanOrEqual(10);
    expect(procs).toEqual(Object.keys(TABLE_SCENARIOS).sort());
    expect(new Set(rows.map((r) => r.fn))).toEqual(new Set(procs));
  });

  it('r8 (2): each function has a row at every point its calls can reach (by the parse); the #4288 functions\' points are the observation table\'s', () => {
    const parsed = parseCore(read(CORE));
    const missing: Record<string, string[]> = {};
    let counted = 0;
    for (const fn of parsed.procedures) {
      const can = [...(parsed.points.get(fn) ?? [])];
      counted += can.length;
      const gap = can.filter((p) => !rows.some((r) => r.fn === fn && r.point === p)).sort();
      if (gap.length > 0) missing[fn] = gap;
    }
    expect(missing).toEqual({});
    expect(counted).toBeGreaterThanOrEqual(120);
    const table = new Set(OBSERVATION_POINTS.filter((p) => p.impls.includes('sync')).map((p) => p.point));
    expect(parsed.olderPoints.size).toBeGreaterThanOrEqual(20);
    expect([...parsed.olderPoints].filter((p) => !table.has(p)).sort()).toEqual([]);
  });

  it('every observation point of the chain is a row of some function (none without); each point\'s rows are its reaches 1 … reached', () => {
    const points = chainPoints(read(CORE), OLDER_POINTS);
    expect(points.length).toBeGreaterThanOrEqual(25);
    const covered = new Set(rows.map((r) => r.point));
    expect([...points, ...CHAIN_CHOICE_POINTS].filter((p) => !covered.has(p))).toEqual([]);
    const reaches = new Map<string, number[]>();
    for (const r of rows) reaches.set(`${r.fn} ${r.scenario} ${r.point} ${r.reached}`, [...(reaches.get(`${r.fn} ${r.scenario} ${r.point} ${r.reached}`) ?? []), r.k]);
    for (const [key, ks] of reaches) expect(ks, key).toEqual(Array.from({ length: Number(key.split(' ').pop()) }, (_, i) => i + 1));
    expect(rows.filter((r) => r.k >= 2).length, 'rows of a second reach or later').toBeGreaterThanOrEqual(100);
    expect(rows.length).toBeGreaterThanOrEqual(400);
    for (const s of Object.values(TABLE_SCENARIOS)) expect(Object.keys(s).length).toBeGreaterThanOrEqual(1);
  });

  it('every row holds: an unknown at any reach (and an absent of the chain\'s choice) does not advance the decision and names its point; released has its end; a named clean-up answers as resolved', () => {
    expect(gateBreaks(rows)).toEqual([]);
  });

  it('NON_BLOCKING names rows of the table only, each with its reason', () => {
    expect(Object.keys(NON_BLOCKING)).toHaveLength(7);
    for (const [key, why] of Object.entries(NON_BLOCKING)) {
      const [fn, point] = key.split(' ');
      expect(rows.some((r) => (fn === '*' || r.fn === fn) && r.point === point), key).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it('the design\'s §8.4 is the table rendered, byte for byte', () => {
    expect(docGateTable(read(DOC))).toBe(renderTable(rows));
  });

  it('self-test (i): a copy whose releaseAsHead takes the <lock> off while the chain is unknown (5c6ade92d\'s form) is red at that row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-i-'));
    try {
      // 5c6ade92d: no hold-back, and the holding of an unknown chain read as none (the <lock>'s record alone decides)
      const m = await brokenCopy(dir, [
        ["    if (ctx.genUnknown) return deferredUnknown(ctx, ctx.genUnknown);\n", ''],
        ["  if (!ctx.genDir) return { state: 'unknown', unknown: ctx.genUnknown };\n", "  if (!ctx.genDir) return { state: 'none' };\n"],
      ]);
      const breaks = gateBreaks(buildTable(m, only(['releaseAsHead'])));
      for (const value of ['unknown', 'absent']) {
        expect(breaks.filter((b) => b.startsWith(`releaseAsHead live-handoff gen-realpath#1 ${value}: past the point: lock HC gone`)), value).toHaveLength(1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('self-test (ii): a copy with a public function added outside the table is red — in every form of export; a form the parse cannot read throws', () => {
    const forms: [string, string][] = [
      ['peekHolder', 'export function peekHolder(lockPath) {\n  return readHolder(lockPath);\n}\n'],
      // b3 P2-1: the arrow and the async forms the r7 reader did not read
      ['peekArrow', 'export const peekArrow = (lockPath) => readHolder(lockPath);\n'],
      ['peekFn', 'export const peekFn = function (lockPath) {\n  return readHolder(lockPath);\n};\n'],
      ['peekAsync', 'export async function peekAsync(lockPath) {\n  return readHolder(lockPath);\n}\n'],
      ['peekLocal', 'function peekLocal(lockPath) {\n  return readHolder(lockPath);\n}\nexport { peekLocal };\n'],
      ['peekAs', 'export { recoverIfDead as peekAs };\n'],
      ['default', 'export default function (lockPath) {\n  return releaseAsHead(lockPath, []);\n}\n'],
    ];
    for (const [name, text] of forms) {
      const procs = coreProcedures(`${read(CORE)}\n${text}`);
      expect(procs, name).toContain(name);
      expect(procs, name).not.toEqual(Object.keys(TABLE_SCENARIOS).sort());
    }
    // a value export is not a function: never a public function
    expect(coreProcedures(`${read(CORE)}\nexport const PEEK_MS = 5;\n`)).toEqual(Object.keys(TABLE_SCENARIOS).sort());
    for (const text of ["export * from './other.mjs';\n", 'export class Peek {}\n', 'export const { peekA } = { peekA: readHolder };\n']) {
      expect(() => coreProcedures(`${read(CORE)}\n${text}`), text).toThrow(/cannot read/);
    }
    expect(() => coreProcedures('export function x() {}\n')).toThrow(/marker/);
  });

  it('self-test (iii): a copy that reads a holder it cannot observe as not alive (unknown as resolved) is red at that row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-iii-'));
    try {
      const m = await brokenCopy(dir, [["      if (holder.state === 'unknown') return { state: 'unknown', unknown: { point: holder.point, path: genPath(g, listing.max), code: holder.code } };\n", '']]);
      const breaks = gateBreaks(buildTable(m, only(['releaseAsHead'])));
      expect(breaks.filter((b) => b.startsWith('releaseAsHead first-alive holder-pid#1 unknown: past the point: lock HB gone'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('self-test (iv) r8 (2): a copy that reads the second reach\'s unknown as resolved is red at the second reach\'s rows — the first reach\'s row of the same point stays green', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-iv-'));
    try {
      // the observer asks the fault seam (the reach is counted) but drops its answer at the second reach of a point
      const m = await brokenCopy(dir, [['    const code = hooks.fault?.(point, String(target), count);\n', '    const asked = hooks.fault?.(point, String(target), count);\n    const code = count === 2 ? undefined : asked;\n']]);
      const breaks = gateBreaks(buildTable(m, only(['releaseAsHead'])));
      expect(breaks.filter((b) => b.startsWith('releaseAsHead dead-holding holder-read#2 unknown: advanced: released'))).toHaveLength(1);
      expect(breaks.filter((b) => b.startsWith('releaseAsHead dead-holding holder-read#1 unknown'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

/** r8 (1): the edits that take each of the three ways of 711f50192 back into a copy of the core. */
const NO_FINAL_CHECK: [string, string] = ['    if (n !== null) {\n      const g = headGen(ctx, ctx.codec, ctx.hooks, ctx.now);\n', '    if (n !== null && n < 0) {\n      const g = headGen(ctx, ctx.codec, ctx.hooks, ctx.now);\n'];
const REREAD_DROPPED: [string, string] = ["    if (read.state === 'unknown') return { unknown: read.unknown };\n    if (read.state === 'corrupt') return { unknown: { point: 'holder-read', path: read.file, code: 'EINVAL' } };\n", ''];
const LINK_ENOENT_ENDED: [string, string] = ["  return end.state === 'absent' ? genEnded(g, n) : { ended: true };\n", '  return { ended: true };\n'];

describe('#4559 r8 (2): the gate counts — 711f50192\'s three ways to `released` without an end are red at their rows', () => {
  afterAll(() => cleanAll());
  const ways: { name: string; edits: [string, string][]; red: string }[] = [
    // (a) the re-read of the holding's records failing at its 3rd reach, dropped as {}
    { name: '(a) the re-read\'s unknown dropped', edits: [NO_FINAL_CHECK, REREAD_DROPPED], red: 'releaseAsHead dead-holding holder-read#3 unknown: advanced: released' },
    // (b) the judgement before the end answering young (the owner read as missing at its 5th reach)
    { name: '(b) young / busy / again read as ended', edits: [NO_FINAL_CHECK], red: 'releaseAsHead dead-holding holder-read#5 absent: released without an end (lock T gone)' },
    // (c) the end's link answering ENOENT, read as ended without genEnded
    { name: '(c) the end-link\'s ENOENT read as ended', edits: [NO_FINAL_CHECK, LINK_ENOENT_ENDED], red: 'releaseAsHead dead-holding end-link#1 absent: released without an end (lock T gone)' },
  ];
  for (const way of ways) {
    it(`self-test (v) ${way.name}: red at ${way.red.split(':')[0]}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-v-'));
      try {
        const m = await brokenCopy(dir, way.edits);
        const breaks = gateBreaks(buildTable(m, only(['releaseAsHead'])));
        expect(breaks.filter((b) => b === way.red)).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60000);
  }
  it('self-test (v) the copy without the final check alone is red at the end-cleaned scenario\'s resolved run too (the end\'s tmp cleaned once)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-v-'));
    try {
      const m = await brokenCopy(dir, [NO_FINAL_CHECK, LINK_ENOENT_ENDED]);
      expect(gateBreaks(buildTable(m, only(['releaseAsHead'])))).toContain('releaseAsHead dead-holding end-cleaned resolved: released without an end (lock T gone)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('#4559 r8 (4): the named answers and the readHolder rows can be red (b3 P3-1: never green whatever is done)', () => {
  afterAll(() => cleanAll());
  it('self-test (vi): readHolder answering the generation\'s holder over fields it could not read is red; so is one that names nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-vi-'));
    try {
      const advancing = gateBreaks(buildTable(await brokenCopy(dir, [['  if (fields.unknown) return { unknown: fields.unknown };\n', '']]), only(['readHolder'])));
      for (const s of ['gen-and-lock', 'gen-and-lock genOnly']) expect(advancing, s).toContain(`readHolder ${s} gen-fields-read#1 unknown: advanced: holder D g=1`);
      const silent = gateBreaks(buildTable(await brokenCopy(dir, [['  const named = (u) => warn(`machine-lock-unknown point=', '  const named = (u) => void u && warn(`machine-lock-unknown point=']]), only(['readHolder'])));
      for (const point of ['gen-realpath#1', 'gen-list#1', 'gen-end-read#1', 'holder-read#1', 'holder-read#2']) {
        expect(silent.filter((b) => b.startsWith(`readHolder gen-and-lock genOnly ${point} unknown: the answer holder null names nothing`)), point).toHaveLength(1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('self-test (vii) (b3 P2-1 (a)): a release that reads a hand-off\'s group it cannot observe as empty is red at the hand-off scenario\'s row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-vii-'));
    try {
      const m = await brokenCopy(dir, [["        if (group.state !== 'gone') return { result: 'deferred', line:", "        if (group.state === 'alive') return { result: 'deferred', line:"]]);
      const breaks = gateBreaks(buildTable(m, only(['handle.release'])));
      expect(breaks.filter((b) => b.startsWith('handle.release handed-back group#1 unknown: advanced: released'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
