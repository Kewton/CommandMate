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
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { OPS, renderOps, type OpRow } from './lock-generation-4559-harness';

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
  fault: (p, _t, c) => (p === 'gen-owner-link' && c === 1 ? 'EIO' : undefined),
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
  const calls = fs.readFileSync(events, 'utf8').split('\n').filter((l) => l === stop).length;
  return { root, genDir, reached, calls };
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
    const stop = core.indexOf('      return { unknown: published.unknown };', start);
    expect([start > 0, stop > start]).toEqual([true, true]);
    const broken = `${core.slice(0, start)}${core.slice(stop)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-own-tomb-copy-'));
    try {
      const file = path.join(dir, 'machine-lock-sync-no-own-tomb.mjs');
      fs.writeFileSync(file, broken);
      const w = await killedWriter(file, 'tomb-linked');
      try {
        expect({ reached: w.reached, calls: w.calls }).toEqual({ reached: false, calls: 0 });
        expect(g1(w.genDir)).toEqual({ owner: null, end: null });
      } finally {
        fs.rmSync(w.root, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
