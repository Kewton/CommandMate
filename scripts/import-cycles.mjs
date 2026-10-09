#!/usr/bin/env node
/**
 * Lists the module-scope import cycles in `src/` and compares them with a
 * checked-in baseline (Issue #3482).
 *
 * ## Why
 *
 * A refactor that splits a module can put the new module into an existing
 * cycle (#3374: `response-checker-extraction-steps -> response-poller-core ->
 * response-checker`). lint, typecheck and the unit tests all stay green — a
 * cycle only breaks when the load order changes (a new import, a partial
 * `vi.mock`), and then it shows up as an `undefined` binding somewhere else.
 * The guard `tests/unit/guards/import-cycles-baseline-3482.test.ts` turns
 * "a cycle that is not in the baseline appeared" into a red test.
 *
 * ## Why the TypeScript compiler API rather than `madge` / `dependency-cruiser`
 *
 * `typescript` is already a devDependency; both alternatives would add a
 * dependency tree to install and audit (`npm audit` runs in CI). The compiler
 * API gives an exact parse (no regex over comments / strings) and
 * `ts.resolveModuleName` applies the same `paths` (`@/*`) and `bundler`
 * resolution that `tsc` uses, read from `tsconfig.json`.
 *
 * ## What counts as an edge
 *
 * - `import ... from 'x'`, `import 'x'`, `export ... from 'x'`, `export * from 'x'`
 *   — the forms that evaluate `x` before this module's body runs.
 * - NOT `import type` / `export type`, nor `import { type A, type B }` where every
 *   specifier is type-only: the compiler erases them, so they cannot take part
 *   in a load-time cycle.
 * - NOT dynamic `import()`: it runs after this module finished evaluating, so it
 *   never observes a half-initialised module. Deferring the load with
 *   `await import()` is also the documented way to cut a cycle (#1984).
 * - Only targets that resolve to another `.ts` / `.tsx` under `src/`
 *   (`.d.ts` excluded — it has no runtime).
 *
 * The check is syntactic: `import { Foo }` where `Foo` is used only as a type
 * still counts (the compiler would elide it). Write `import type` for such imports.
 *
 * ## Cycle identity
 *
 * Every elementary cycle (Johnson's algorithm) is reported as a ring of
 * repository-relative paths, rotated to start at its smallest path. Two rings
 * over the same files in a different order are different cycles.
 *
 * ## Usage
 *
 *   node scripts/import-cycles.mjs                    # compare with the baseline (exit 1 on new cycles)
 *   node scripts/import-cycles.mjs --list             # print every current cycle
 *   node scripts/import-cycles.mjs --write-baseline   # rewrite the baseline JSON
 *
 * Rewrite the baseline only to record cycles that went away, or a new cycle you
 * decided to accept — and write the reason in the commit message body.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

export const BASELINE_RELATIVE_PATH = 'tests/unit/guards/import-cycles-baseline.json';
export const UPDATE_BASELINE_COMMAND = 'node scripts/import-cycles.mjs --write-baseline';

/** Upper bound on enumerated cycles; hitting it means the graph needs cutting, not a bigger number. */
export const MAX_CYCLES = 20000;

/**
 * Every `.ts` / `.tsx` (not `.d.ts`) under `dir`, absolute paths, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * `compilerOptions` of `<root>/tsconfig.json` (with `paths` resolved against root).
 *
 * @param {string} root
 * @returns {ts.CompilerOptions}
 */
export function readCompilerOptions(root) {
  const configPath = path.join(root, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    throw new Error(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  }
  // parseJsonConfigFileContent (not convertCompilerOptionsFromJson) because it
  // records where `paths` are relative to when there is no `baseUrl`; without it
  // every `@/` import silently fails to resolve. The file list is not needed, so
  // `include` / `files` are dropped and "no inputs found" (TS18003) is ignored.
  const { include: _include, files: _files, ...rest } = config;
  const { options, errors: all } = ts.parseJsonConfigFileContent(rest, ts.sys, root, undefined, configPath);
  const errors = all.filter((d) => d.code !== 18003);
  if (errors.length > 0) {
    throw new Error(`invalid compilerOptions in ${configPath}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
  }
  return options;
}

/**
 * True when the statement is erased by the compiler (brings no value at runtime).
 *
 * @param {ts.ImportDeclaration | ts.ExportDeclaration} node
 * @returns {boolean}
 */
export function isTypeOnlyDeclaration(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // `import 'x'` — side effect
    if (clause.isTypeOnly) return true;
    if (clause.name) return false; // default import
    const bindings = clause.namedBindings;
    if (!bindings) return false;
    if (ts.isNamespaceImport(bindings)) return false;
    return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false; // `export *` / `export * as ns`
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

/**
 * Module specifiers of the value-level static imports / re-exports in `text`.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {string[]}
 */
export function valueImportSpecifiers(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  /** @type {string[]} */
  const specs = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) continue; // `export { a }` without `from`
    if (isTypeOnlyDeclaration(stmt)) continue;
    specs.push(spec.text);
  }
  return specs;
}

/**
 * Value-level import graph of `<root>/<srcDir>`, keyed by root-relative posix paths.
 *
 * @param {{ root: string, srcDir?: string }} options
 * @returns {Map<string, Set<string>>}
 */
export function buildImportGraph({ root: givenRoot, srcDir = 'src' }) {
  // The resolver returns real paths (macOS: /var -> /private/var under os.tmpdir()),
  // so the file set has to be keyed by real paths too, or every edge is dropped.
  const root = fs.realpathSync(givenRoot);
  const options = readCompilerOptions(root);
  const files = listSourceFiles(path.join(root, srcDir));
  const known = new Set(files);
  const cache = ts.createModuleResolutionCache(root, (s) => s, options);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  for (const file of files) {
    /** @type {Set<string>} */
    const deps = new Set();
    for (const spec of valueImportSpecifiers(file, fs.readFileSync(file, 'utf-8'))) {
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys, cache).resolvedModule;
      if (!resolved) continue;
      const target = path.resolve(resolved.resolvedFileName);
      if (known.has(target) && target !== file) deps.add(rel(target));
    }
    graph.set(rel(file), deps);
  }
  return graph;
}

/**
 * Rotates a ring so it starts at its smallest node.
 *
 * @param {string[]} ring
 * @returns {string[]}
 */
export function normalizeCycle(ring) {
  let min = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i] < ring[min]) min = i;
  return [...ring.slice(min), ...ring.slice(0, min)];
}

/** @param {string[]} ring */
export const cycleKey = (ring) => normalizeCycle(ring).join(' -> ');

/**
 * Every elementary cycle of `graph` (Johnson's algorithm), normalized and sorted.
 *
 * @param {Map<string, Set<string>>} graph
 * @param {{ maxCycles?: number }} [opts]
 * @returns {string[][]}
 */
export function findCycles(graph, { maxCycles = MAX_CYCLES } = {}) {
  const nodes = [...graph.keys()].sort();
  const index = new Map(nodes.map((n, i) => [n, i]));
  const adj = nodes.map((n) => [...(graph.get(n) ?? [])].filter((m) => index.has(m)).map((m) => index.get(m)).sort((a, b) => a - b));

  /** @type {number[][]} */
  const cycles = [];

  // Tarjan's SCC restricted to nodes >= start.
  const sccFrom = (start) => {
    const idx = new Array(nodes.length).fill(-1);
    const low = new Array(nodes.length).fill(0);
    const onStack = new Array(nodes.length).fill(false);
    const stack = [];
    let counter = 0;
    /** @type {number[][]} */
    const comps = [];
    const strong = (v) => {
      // Iterative to survive deep graphs.
      const work = [[v, 0]];
      idx[v] = low[v] = counter++;
      stack.push(v);
      onStack[v] = true;
      while (work.length > 0) {
        const frame = work[work.length - 1];
        const [u, i] = frame;
        const succ = adj[u];
        if (i < succ.length) {
          frame[1]++;
          const w = succ[i];
          if (w < start) continue;
          if (idx[w] === -1) {
            idx[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = true;
            work.push([w, 0]);
          } else if (onStack[w]) {
            low[u] = Math.min(low[u], idx[w]);
          }
        } else {
          work.pop();
          if (work.length > 0) {
            const parent = work[work.length - 1][0];
            low[parent] = Math.min(low[parent], low[u]);
          }
          if (low[u] === idx[u]) {
            const comp = [];
            let w;
            do {
              w = stack.pop();
              onStack[w] = false;
              comp.push(w);
            } while (w !== u);
            comps.push(comp);
          }
        }
      }
    };
    for (let v = start; v < nodes.length; v++) if (idx[v] === -1) strong(v);
    return comps;
  };

  let s = 0;
  while (s < nodes.length) {
    // The SCC containing the least vertex >= s that lies in a non-trivial SCC.
    const comps = sccFrom(s).filter((c) => c.length > 1 || adj[c[0]].includes(c[0]));
    if (comps.length === 0) break;
    let best = null;
    for (const c of comps) {
      const m = Math.min(...c);
      if (best === null || m < best.min) best = { min: m, set: new Set(c) };
    }
    s = best.min;
    const inComp = best.set;
    const blocked = new Array(nodes.length).fill(false);
    /** @type {Set<number>[]} */
    const blockMap = nodes.map(() => new Set());
    const pathStack = [];
    const unblock = (u) => {
      const todo = [u];
      while (todo.length > 0) {
        const x = todo.pop();
        if (!blocked[x]) continue;
        blocked[x] = false;
        for (const w of blockMap[x]) todo.push(w);
        blockMap[x].clear();
      }
    };
    const circuit = (v) => {
      let found = false;
      pathStack.push(v);
      blocked[v] = true;
      for (const w of adj[v]) {
        if (!inComp.has(w)) continue;
        if (w === s) {
          cycles.push([...pathStack]);
          if (cycles.length > maxCycles) {
            throw new Error(`more than ${maxCycles} import cycles — cut the graph instead of raising the cap`);
          }
          found = true;
        } else if (!blocked[w] && circuit(w)) {
          found = true;
        }
      }
      if (found) unblock(v);
      else for (const w of adj[v]) if (inComp.has(w)) blockMap[w].add(v);
      pathStack.pop();
      return found;
    };
    circuit(s);
    s++;
  }

  return cycles
    .map((c) => normalizeCycle(c.map((i) => nodes[i])))
    .sort((a, b) => cycleKey(a).localeCompare(cycleKey(b)));
}

/**
 * @param {string} file
 * @returns {string[][]}
 */
export function readBaseline(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(data.cycles)) throw new Error(`${file}: "cycles" must be an array`);
  return data.cycles;
}

/**
 * Cycles in `current` that the baseline does not have (`added`), and baseline
 * cycles that are gone (`removed` — good news, never a failure).
 *
 * @param {string[][]} current
 * @param {string[][]} baseline
 * @returns {{ added: string[][], removed: string[][] }}
 */
export function compareWithBaseline(current, baseline) {
  const base = new Set(baseline.map(cycleKey));
  const now = new Set(current.map(cycleKey));
  return {
    added: current.filter((c) => !base.has(cycleKey(c))),
    removed: baseline.filter((c) => !now.has(cycleKey(c))),
  };
}

/**
 * Failure message naming each new ring and the files in it.
 *
 * @param {string[][]} added
 * @param {{ limit?: number }} [opts]
 * @returns {string}
 */
export function formatNewCycles(added, { limit = 30 } = {}) {
  const files = [...new Set(added.flat())].sort();
  const lines = [
    `${added.length} new import cycle(s) not in ${BASELINE_RELATIVE_PATH}:`,
    ...added.slice(0, limit).map((c) => `  ${[...c, c[0]].join(' -> ')}`),
    ...(added.length > limit ? [`  ... and ${added.length - limit} more`] : []),
    `files in the new cycles: ${files.join(', ')}`,
    'Break the cycle (move the shared value to a leaf module, or use `import type` for types).',
    `Only if the cycle is intended, run \`${UPDATE_BASELINE_COMMAND}\` and write the reason in the commit message body.`,
  ];
  return lines.join('\n');
}

/**
 * @param {string[][]} cycles
 * @returns {string}
 */
export function serializeBaseline(cycles) {
  return `${JSON.stringify(
    {
      $comment: [
        'Module-scope import cycles in src/ accepted as of the last update (Issue #3482).',
        'Each entry is a ring rotated to start at its smallest path; the last file imports the first.',
        `Update with \`${UPDATE_BASELINE_COMMAND}\` and write the reason in the commit message body.`,
      ],
      cycles,
    },
    null,
    2
  )}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, log?: (s: string) => void, error?: (s: string) => void }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { root = process.cwd(), log = console.log, error = console.error } = deps;
  const mode = argv[0] ?? '--check';
  if (!['--check', '--list', '--write-baseline'].includes(mode) || argv.length > 1) {
    error('Usage: node scripts/import-cycles.mjs [--check | --list | --write-baseline]');
    return 2;
  }
  const cycles = findCycles(buildImportGraph({ root }));
  const baselineFile = path.join(root, BASELINE_RELATIVE_PATH);

  if (mode === '--list') {
    for (const c of cycles) log([...c, c[0]].join(' -> '));
    log(`${cycles.length} cycle(s)`);
    return 0;
  }
  if (mode === '--write-baseline') {
    fs.writeFileSync(baselineFile, serializeBaseline(cycles));
    log(`wrote ${cycles.length} cycle(s) to ${BASELINE_RELATIVE_PATH}`);
    return 0;
  }
  const { added, removed } = compareWithBaseline(cycles, readBaseline(baselineFile));
  if (removed.length > 0) {
    log(`${removed.length} baseline cycle(s) are gone; run \`${UPDATE_BASELINE_COMMAND}\` to record it.`);
  }
  if (added.length > 0) {
    error(formatNewCycles(added));
    return 1;
  }
  log(`import cycles: ${cycles.length} (no new cycle against ${BASELINE_RELATIVE_PATH})`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
