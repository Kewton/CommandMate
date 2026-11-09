/**
 * I-F13 (Issue #4226, design `docs/design/mem-prompt-4226.md` §3.6・§7.3): the awaits of
 * the prompts are the design's table, and INV-A holds by construction.
 *
 *  (1) Every `await` of `src/lib/mem-suggest/**` is `await step('<id>', () => …)` with an
 *      id of `MEM_SUGGEST_AWAITS`; no `.then(`/`.catch(`/`.finally(`; no function hands
 *      a promise on without awaiting it, save the arrows given to `step` and the one
 *      named helper `runStep` (the step itself); no `void` of a promise.
 *      The route has its own rule (P2-1): `await params`, then the body (`readMemBody`,
 *      W1), then `memSuggest`, and nothing after it but `return NextResponse.json(…)`.
 *  (2) Every key of the table is used (the table and the source agree).
 *  (3) `settleShown`, `readShown`, the rules (`judgeSuggestions`) and the quiet line
 *      (`formatQuietLine`) are called only from the build handed to `withMemTarget` in
 *      `step('W5', …)`, helpers included (the call chain is followed).
 *  (4) That build is not `async` and returns no promise.
 *  (5) The paths (Codex P2-2, PM P3-1): every path through `memSuggest`, the helpers it
 *      calls inlined (across files), awaits the steps in the order of the table: for each
 *      of the table's `paths`, its ids in the table's order, each once, the `last` one
 *      last. A path may stop early (a return), never reorder, repeat or go past it, and
 *      each whole sequence is walked by some path. A step in a loop, a `try`, a
 *      condition expression or a function value is refused (its count is not fixed).
 *  (6) No floating promise: a call whose type is a promise is awaited, or is what an
 *      arrow given to `step` (or `runStep`) returns. Also in the route.
 *
 * What this guard guarantees, and what it does not (PM decision 2026-11-10, design §3.6
 * "I-F13 の保証の範囲"). A static reading of calls never runs out of edges (aliases, helper
 * depth, higher-order functions, dynamic calls), so the edge is drawn here, not chased:
 *  - Covered: direct calls; import aliases (`import { settleShown as settleLate }`, namespace
 *    imports `ns.peek(…)`); variable aliases (`const f = peek`, `let f = …; f = peek`); and the
 *    reverse lookup of one level of helper (a helper the W5 build calls directly, called from
 *    outside the build as well).
 *  - Not covered: helpers of more than one level (`wrapped → peek → readShown`, called after
 *    W5 through `wrapped`: Codex 5-2b, third re-review `review-4226d.md`, tracked in #4289);
 *    higher-order functions (a function passed as a value and called elsewhere); dynamic calls
 *    (computed property names, `Function.prototype.call`/`apply`, lookups by string).
 * INV-A itself is fixed at run time by the table-driven injection test over W1〜W5
 * (`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`, I-F11, design §3.6). The expectation
 * differs by the point of the change: W1 (before the fix) answers the state after the change
 * (the `off` kinds: no prompt, no record); W2〜W4: a change after the await resolves leaves no
 * prompt and no record; W5: a change during its wait (between the two `deps.observe`) leaves no
 * prompt and no record, while a change after W5 resolved leaves the prompt and the record
 * (INV-A's edge: the build has judged and recorded; the record is quiet's, `full` records
 * none; a delete of the worktree takes the record with it as a child row). The injection covers only the awaits of the table's ids (`deps.step`,
 * and W5's `deps.observe`); a wait outside the table (an `await` not through `step`, a timer)
 * or a read/record outside the build by a synchronous helper is not detected by it
 * automatically. This guard is an aid that notices a new `await`
 * (or a record outside the build) added in the shapes above; it is not the proof of INV-A.
 *
 * The files are `src/lib/mem-suggest/**` as listed on disk (and any file a control
 * adds there), not a fixed list (Codex P2-2).
 *
 * Read with the TypeScript type checker (the return types decide what is a promise).
 * The controls run the same checks on changed copies written under a `mkdtemp`
 * directory (removed after each test) and read back; the repository's files are not
 * touched (the copies are handed to the compiler in memory, at the path they replace,
 * so their imports resolve as the original's do).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

const ROOT = process.cwd();
const SERVICE = path.join(ROOT, 'src/lib/mem-suggest/service.ts');
const ROUTE = path.join(ROOT, 'src/app/api/worktrees/[id]/mem/suggest/route.ts');
const LIB_DIR = path.join(ROOT, 'src/lib/mem-suggest');
/** The route's own steps (its rule is `routeViolations`); the service's paths go without them. */
const ROUTE_IDS = new Set(['W1']);

/** Every `.ts` of `src/lib/mem-suggest/**` on disk, and any a control adds there. */
function libFilesOf(overrides: Record<string, string>): string[] {
  const onDisk = (readdirSync(LIB_DIR, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => path.join(LIB_DIR, name));
  const added = Object.keys(overrides).filter((file) => file.startsWith(LIB_DIR + path.sep) && file.endsWith('.ts'));
  return [...new Set([...onDisk, ...added])].sort();
}
const RESTRICTED = new Set(['settleShown', 'readShown', 'judgeSuggestions', 'formatQuietLine']);
const STEP_HELPER = 'runStep';
const ENTRANCES = new Set(['memSuggest']);

const parsedConfig = (() => {
  const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
})();

let lastProgram: ts.Program | undefined;

/** A program over the real files, with some of them replaced in memory. */
function programWith(rootFiles: string[], overrides: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { ...parsedConfig.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => overrides[path.resolve(file)] ?? readFile(file);
  host.fileExists = (file) => overrides[path.resolve(file)] !== undefined || fileExists(file);
  host.getSourceFile = (file, language, onError, create) => {
    const replaced = overrides[path.resolve(file)];
    if (replaced !== undefined) return ts.createSourceFile(file, replaced, language, true);
    return getSourceFile(file, language, onError, create);
  };
  lastProgram = ts.createProgram([...rootFiles, ROUTE], options, host, lastProgram);
  return lastProgram;
}

const isFunctionNode = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

function nameOf(node: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

function isPromise(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((part) => isPromise(checker, part));
  return type.getSymbol()?.getName() === 'Promise';
}

function returnsPromise(checker: ts.TypeChecker, node: ts.FunctionLikeDeclaration): boolean {
  const signature = checker.getSignatureFromDeclaration(node);
  return signature ? isPromise(checker, checker.getReturnTypeOfSignature(signature)) : false;
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

/** `step('Wn', arrow)`: the id, or null. */
function stepId(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'step' || !ts.isIdentifier(node.expression)) return null;
  const [id] = node.arguments;
  return id && ts.isStringLiteral(id) ? id.text : null;
}

/** The keys of `MEM_SUGGEST_AWAITS` as the source writes them. */
function tableKeys(source: ts.SourceFile): string[] {
  let keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'MEM_SUGGEST_AWAITS' && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) keys = init.properties.map((p) => (p.name ? p.name.getText().replace(/['"]/g, '') : ''));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

interface TableEntry {
  key: string;
  paths: string[];
  position: string;
}

/** The entries of `MEM_SUGGEST_AWAITS` in the source's order: their `paths` and `position`. */
function tableEntries(source: ts.SourceFile): TableEntry[] {
  let entries: TableEntry[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'MEM_SUGGEST_AWAITS' && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (!ts.isObjectLiteralExpression(init)) return;
      entries = init.properties.filter(ts.isPropertyAssignment).map((property) => {
        const entry: TableEntry = { key: property.name.getText().replace(/['"]/g, ''), paths: [], position: '' };
        if (!ts.isObjectLiteralExpression(property.initializer)) return entry;
        for (const field of property.initializer.properties) {
          if (!ts.isPropertyAssignment(field)) continue;
          const name = field.name.getText();
          if (name === 'paths' && ts.isArrayLiteralExpression(field.initializer)) {
            entry.paths = field.initializer.elements.filter(ts.isStringLiteral).map((element) => element.text);
          }
          if (name === 'position' && ts.isStringLiteral(field.initializer)) entry.position = field.initializer.text;
        }
        return entry;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return entries;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current && !isFunctionNode(current)) current = current.parent;
  return current ?? null;
}

const where = (node: ts.Node) => {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(ROOT, source.fileName)}:${line + 1}`;
};

/** The route's rule (P2-1). */
function routeViolations(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const awaits: string[] = [];
  walk(source, (node) => {
    if (ts.isAwaitExpression(node)) {
      const operand = node.expression;
      awaits.push(ts.isCallExpression(operand) ? `${calleeName(operand)}()` : operand.getText());
    }
    if (ts.isForOfStatement(node) && node.awaitModifier) out.push(`for await in the route at ${where(node)}`);
    if (ts.isCallExpression(node) && ['then', 'catch', 'finally'].includes(calleeName(node) ?? '') && ts.isPropertyAccessExpression(node.expression)) {
      out.push(`.${calleeName(node)}( in the route at ${where(node)}`);
    }
  });
  if (awaits.join(' → ') !== 'params → readMemBody() → memSuggest()') out.push(`route awaits: ${awaits.join(' → ')}`);
  walk(source, (node) => {
    if (!ts.isVariableStatement(node) || !node.getText().includes('await memSuggest(')) return;
    const block = node.parent;
    if (!ts.isBlock(block)) return;
    const after = block.statements.slice(block.statements.indexOf(node) + 1);
    const allowed = after.length === 1 && ts.isReturnStatement(after[0]) && /^return NextResponse\.json\(/.test(after[0].getText());
    if (!allowed) out.push(`after memSuggest: ${after.map((s) => s.getText().split('\n')[0]).join(' | ')}`);
  });
  return out;
}

export interface TableFindings {
  violations: string[];
  unusedKeys: string[];
}

/** Every check of (1)〜(4) on the sources as given (overrides by absolute path). */
function analyze(overrides: Record<string, string> = {}): TableFindings {
  const LIB_FILES = libFilesOf(overrides);
  const program = programWith(LIB_FILES, overrides);
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const serviceFile = program.getSourceFile(SERVICE) as ts.SourceFile;
  const keys = tableKeys(serviceFile);
  const used = new Set<string>();
  const libSources = new Set(LIB_FILES.map((file) => program.getSourceFile(file)).filter((source): source is ts.SourceFile => source !== undefined));

  for (const file of LIB_FILES) {
    const source = program.getSourceFile(file) as ts.SourceFile;
    walk(source, (node) => {
      if (ts.isAwaitExpression(node)) {
        const id = stepId(node.expression);
        if (id === null) violations.push(`await not through step at ${where(node)}`);
        else if (!keys.includes(id)) violations.push(`step('${id}') is not in MEM_SUGGEST_AWAITS at ${where(node)}`);
      }
      if (ts.isForOfStatement(node) && node.awaitModifier) violations.push(`for await at ${where(node)}`);
      const id = stepId(node);
      if (id !== null) used.add(id);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['then', 'catch', 'finally'].includes(node.expression.name.text)) {
        violations.push(`.${node.expression.name.text}( at ${where(node)}`);
      }
      if (ts.isVoidExpression(node) && isPromise(checker, checker.getTypeAtLocation(node.expression))) violations.push(`void of a promise at ${where(node)}`);
      if (isFunctionNode(node) && returnsPromise(checker, node)) {
        const name = nameOf(node);
        const isStepArrow = ts.isCallExpression(node.parent) && stepId(node.parent) !== null && node.parent.arguments[1] === node;
        if (!isStepArrow && !(name !== null && (ENTRANCES.has(name) || name === STEP_HELPER))) {
          violations.push(`a promise handed on by ${name ?? 'an anonymous function'} at ${where(node)}`);
        }
      }
    });
  }

  // (3)(4): the build of W5 and what it reaches.
  const builds: ts.Node[] = [];
  walk(serviceFile, (node) => {
    if (stepId(node) !== 'W5') return;
    walk(node, (inner) => {
      if (ts.isCallExpression(inner) && calleeName(inner) === 'withMemTarget' && inner.arguments[3]) builds.push(inner.arguments[3]);
    });
  });
  if (builds.length === 0) violations.push('no build is handed to withMemTarget in step(W5)');
  const reachable = new Set<ts.Node>();
  const queue: ts.Node[] = [];
  /**
   * The values assigned to a binding after its declaration (`let f = a; f = peek;`), so a
   * reassignment is followed as the initializer is (Codex 5-2c-2 P2).
   */
  const assigned = new Map<ts.Symbol, ts.Expression[]>();
  for (const source of libSources) {
    walk(source, (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(node.left)) return;
      const symbol = checker.getSymbolAtLocation(node.left);
      if (!symbol) return;
      const list = assigned.get(symbol) ?? [];
      list.push(node.right);
      assigned.set(symbol, list);
    });
  }
  /** The name a callee is spelt with at a call: an identifier, or the name of `a.b`. */
  const calleeAt = (call: ts.CallExpression): ts.Identifier | null =>
    ts.isIdentifier(call.expression) ? call.expression : ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.name) ? call.expression.name : null;
  /**
   * The one rule that resolves a name (Codex 5-2c P2-2 and 5-2c-2 P2): an import alias
   * (`peek as look`), a local binding (`const again = peek`, `const f = ns.peek`) and a
   * reassignment (`f = peek`) are all followed to the symbols they end at. The helpers
   * (reachability, the callers of a helper, the paths) and the restricted calls are
   * classified by the same symbols, never by the spelling at the call.
   */
  const symbolsOf = (at: ts.Identifier): ts.Symbol[] => {
    const ends: ts.Symbol[] = [];
    const seen = new Set<ts.Symbol>();
    const pending: ts.Symbol[] = [];
    const first = checker.getSymbolAtLocation(at);
    if (first) pending.push(first);
    const follow = (expression: ts.Expression): boolean => {
      let inner = expression;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
      const name = ts.isIdentifier(inner) ? inner : ts.isPropertyAccessExpression(inner) ? inner.name : null;
      const next = name ? checker.getSymbolAtLocation(name) : undefined;
      if (!next) return false;
      pending.push(next);
      return true;
    };
    while (pending.length > 0 && seen.size < 64) {
      const symbol = pending.pop() as ts.Symbol;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      if (symbol.flags & ts.SymbolFlags.Alias) {
        pending.push(checker.getAliasedSymbol(symbol));
        continue;
      }
      // A binding ends here when it holds a function itself, or when nothing it holds is a name.
      let followed = false;
      let holdsFunction = false;
      const declaration = symbol.valueDeclaration;
      const values = [...(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer ? [declaration.initializer] : []), ...(assigned.get(symbol) ?? [])];
      for (const value of values) {
        if (isFunctionNode(value)) holdsFunction = true;
        else followed = follow(value) || followed;
      }
      if (!followed || holdsFunction) ends.push(symbol);
    }
    return ends;
  };
  /** Every function of the files a name may stand for, by {@link symbolsOf}. */
  const functionsOf = (at: ts.Identifier): ts.Node[] => {
    const out: ts.Node[] = [];
    for (const symbol of symbolsOf(at)) {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration || !libSources.has(declaration.getSourceFile())) continue;
      if (isFunctionNode(declaration)) out.push(declaration);
      else if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionNode(declaration.initializer)) out.push(declaration.initializer);
      for (const value of assigned.get(symbol) ?? []) if (isFunctionNode(value) && libSources.has(value.getSourceFile())) out.push(value);
    }
    return out;
  };
  const declarationOf = (identifier: ts.Identifier): ts.Node | null => functionsOf(identifier)[0] ?? null;
  for (const build of builds) {
    const nodes = ts.isIdentifier(build) ? functionsOf(build) : [build];
    for (const node of nodes) {
      if (isFunctionNode(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) violations.push(`the W5 build is async at ${where(node)}`);
      if (isFunctionNode(node) && returnsPromise(checker, node)) violations.push(`the W5 build returns a promise at ${where(node)}`);
      reachable.add(node);
      queue.push(node);
    }
  }
  while (queue.length > 0) {
    walk(queue.pop() as ts.Node, (inner) => {
      if (!ts.isCallExpression(inner)) return;
      const at = calleeAt(inner);
      if (!at) return;
      for (const target of functionsOf(at)) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    });
  }
  const insideReachable = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (reachable.has(current)) return true;
    return false;
  };
  /** The restricted names a call's callee was declared with, by {@link symbolsOf}. */
  const restrictedOf = (call: ts.CallExpression): string[] => {
    const at = calleeAt(call);
    const names = at ? symbolsOf(at).map((symbol) => symbol.getName()) : [];
    if (names.length === 0) {
      const spelt = calleeName(call);
      if (spelt !== null) names.push(spelt);
    }
    return [...new Set(names.filter((name) => RESTRICTED.has(name)))];
  };
  for (const file of LIB_FILES) {
    const source = program.getSourceFile(file) as ts.SourceFile;
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      for (const restricted of restrictedOf(node)) {
        if (!insideReachable(node)) violations.push(`${restricted} outside the W5 build at ${where(node)}`);
        // A helper the build reaches may not be called from outside it as well (by any name).
        const owner = enclosingFunction(node);
        const ownerName = owner ? nameOf(owner) : null;
        if (ownerName === null || !owner) continue;
        for (const other of libSources) {
          walk(other, (ref) => {
            if (!ts.isCallExpression(ref) || insideReachable(ref)) return;
            const at = calleeAt(ref);
            if (at && functionsOf(at).includes(owner)) violations.push(`${ownerName} (calls ${restricted}) is called outside the W5 build at ${where(ref)}`);
          });
        }
      }
    });
  }

  // (5): the paths of memSuggest against the table.
  violations.push(...pathViolations(serviceFile, libSources, declarationOf));

  // (6): no floating promise, in the files and in the route.
  for (const source of [...libSources, program.getSourceFile(ROUTE) as ts.SourceFile]) {
    walk(source, (node) => {
      if (ts.isCallExpression(node) && isPromise(checker, checker.getTypeAtLocation(node)) && !promiseIsHeld(node)) {
        violations.push(`a promise not awaited (${calleeName(node) ?? 'a call'}) at ${where(node)}`);
      }
    });
  }

  const route = program.getSourceFile(ROUTE) as ts.SourceFile;
  const routeFindings = routeViolations(route);
  violations.push(...routeFindings);
  if (routeFindings.length === 0) used.add('W1');
  return { violations, unusedKeys: keys.filter((key) => !used.has(key)) };
}

/** The arrow given to `step` as what it runs. */
const isStepArrow = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && stepId(node.parent) !== null && node.parent.arguments[1] === node;

const isRunStep = (node: ts.Node): boolean =>
  isFunctionNode(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && node.parent.name.text === STEP_HELPER;

/** (6): a promise is awaited, or is what an arrow given to `step` (or `runStep`) returns. */
function promiseIsHeld(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    (ts.isConditionalExpression(node.parent) && node.parent.condition !== node)
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (ts.isAwaitExpression(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === node) return isStepArrow(parent) || isRunStep(parent);
  if (ts.isReturnStatement(parent)) {
    const owner = enclosingFunction(parent);
    return owner !== null && (isStepArrow(owner) || isRunStep(owner));
  }
  return false;
}

interface Trace {
  ids: string[];
  ended: boolean;
}

/** (5): every path through `memSuggest`, helpers inlined across the files, against the table. */
function pathViolations(
  serviceFile: ts.SourceFile,
  libSources: Set<ts.SourceFile>,
  declarationOf: (identifier: ts.Identifier) => ts.Node | null
): string[] {
  const out: string[] = [];
  const seenSteps = new Set<ts.Node>();
  const stack: ts.Node[] = [];
  const MAX_TRACES = 2000;

  const calleeOf = (call: ts.CallExpression): ts.FunctionLikeDeclaration | null => {
    // The same callee rule as the reachability (Codex 5-2c-2 P2): `a.b(...)` is resolved by `b`.
    const at = ts.isIdentifier(call.expression) ? call.expression : ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.name) ? call.expression.name : null;
    if (at === null || stepId(call) !== null) return null;
    const target = declarationOf(at);
    return target && isFunctionNode(target) ? target : null;
  };
  const stepsMemo = new Map<ts.Node, boolean>();
  const hasSteps = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (stepsMemo.has(node)) return stepsMemo.get(node) as boolean;
    let found = false;
    walk(node, (inner) => {
      if (found || !ts.isCallExpression(inner)) return;
      if (stepId(inner) !== null) found = true;
      const callee = calleeOf(inner);
      if (callee && !seen.has(callee)) {
        seen.add(callee);
        if (hasSteps(callee, seen)) found = true;
      }
    });
    stepsMemo.set(node, found);
    return found;
  };
  const dedupe = (traces: Trace[]): Trace[] => {
    const byKey = new Map<string, Trace>();
    for (const trace of traces) byKey.set(`${trace.ended}:${trace.ids.join(',')}`, trace);
    const unique = [...byKey.values()];
    if (unique.length > MAX_TRACES) {
      out.push(`more than ${MAX_TRACES} paths through memSuggest`);
      return unique.slice(0, MAX_TRACES);
    }
    return unique;
  };
  const extend = (traces: Trace[], sequences: string[][]): Trace[] =>
    dedupe(traces.flatMap((trace) => sequences.map((ids) => ({ ids: [...trace.ids, ...ids], ended: false }))));

  /** The steps an expression runs, as alternative sequences (an inlined helper may have several). */
  const expressionSteps = (root: ts.Node): string[][] => {
    let sequences: string[][] = [[]];
    const visit = (node: ts.Node): void => {
      if (node !== root && isFunctionNode(node)) {
        if (hasSteps(node)) out.push(`a step inside a function value at ${where(node)}`);
        return;
      }
      const id = stepId(node);
      if (id !== null) {
        seenSteps.add(node);
        const run = (node as ts.CallExpression).arguments[1];
        if (run && hasSteps(run)) out.push(`a step inside step('${id}') at ${where(node)}`);
        sequences = sequences.map((ids) => [...ids, id]);
        return;
      }
      if (ts.isConditionalExpression(node) && (hasSteps(node.whenTrue) || hasSteps(node.whenFalse))) {
        out.push(`a step under a condition expression at ${where(node)}`);
      }
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
        hasSteps(node.right)
      ) {
        out.push(`a step under a condition expression at ${where(node)}`);
      }
      ts.forEachChild(node, visit);
      if (ts.isCallExpression(node)) {
        const callee = calleeOf(node);
        if (callee && hasSteps(callee)) {
          const inner = tracesOf(callee).map((trace) => trace.ids);
          sequences = sequences.flatMap((ids) => inner.map((more) => [...ids, ...more]));
        }
      }
    };
    visit(root);
    return sequences;
  };

  const statementTraces = (statement: ts.Statement, traces: Trace[]): Trace[] => {
    const done = traces.filter((trace) => trace.ended);
    const active = traces.filter((trace) => !trace.ended);
    if (active.length === 0) return traces;
    if (ts.isBlock(statement)) return dedupe([...done, ...statementsTraces(statement.statements, active)]);
    if (ts.isIfStatement(statement)) {
      const after = extend(active, expressionSteps(statement.expression));
      const then = statementTraces(statement.thenStatement, after);
      const otherwise = statement.elseStatement ? statementTraces(statement.elseStatement, after) : after;
      return dedupe([...done, ...then, ...otherwise]);
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const ended = extend(active, statement.expression ? expressionSteps(statement.expression) : [[]]).map((trace) => ({ ...trace, ended: true }));
      return dedupe([...done, ...ended]);
    }
    if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement)) return dedupe([...done, ...extend(active, expressionSteps(statement))]);
    if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) return traces;
    if (hasSteps(statement)) out.push(`a step in a ${ts.SyntaxKind[statement.kind]} at ${where(statement)}`);
    return traces;
  };
  const statementsTraces = (statements: readonly ts.Statement[], traces: Trace[]): Trace[] =>
    statements.reduce((current, statement) => statementTraces(statement, current), traces);

  function tracesOf(fn: ts.FunctionLikeDeclaration): Trace[] {
    if (stack.includes(fn)) {
      out.push(`a recursive call through steps at ${where(fn)}`);
      return [{ ids: [], ended: false }];
    }
    stack.push(fn);
    const start: Trace[] = [{ ids: [], ended: false }];
    const body = fn.body;
    const traces = !body ? start : ts.isBlock(body) ? statementsTraces(body.statements, start) : extend(start, expressionSteps(body));
    stack.pop();
    return traces;
  }

  let entrance: ts.FunctionLikeDeclaration | null = null;
  walk(serviceFile, (node) => {
    if (isFunctionNode(node) && ENTRANCES.has(nameOf(node) ?? '')) entrance = node;
  });
  if (!entrance) return [...out, 'no entrance (memSuggest) in the service'];
  const traces = tracesOf(entrance);

  // The table's sequences: per path, its ids in the table's order; `last` must be last.
  const entries = tableEntries(serviceFile).filter((entry) => !ROUTE_IDS.has(entry.key));
  const pathNames = [...new Set(entries.flatMap((entry) => entry.paths))];
  const expected = pathNames.map((name) => ({ name, ids: entries.filter((entry) => entry.paths.includes(name)).map((entry) => entry.key) }));
  for (const entry of entries.filter((e) => e.position === 'last')) {
    for (const sequence of expected) {
      if (sequence.ids.includes(entry.key) && sequence.ids.at(-1) !== entry.key) out.push(`the table: ${entry.key} is "last" but not last on ${sequence.name}`);
    }
  }
  const isPrefix = (ids: string[], of: string[]) => ids.length <= of.length && ids.every((id, index) => of[index] === id);
  for (const trace of traces) {
    if (!expected.some((sequence) => isPrefix(trace.ids, sequence.ids))) {
      out.push(`a path of memSuggest awaits ${trace.ids.join(' → ') || '(nothing)'}, not in the table's order (${expected.map((e) => `${e.name}: ${e.ids.join(' → ')}`).join('; ')})`);
    }
  }
  for (const sequence of expected) {
    if (!traces.some((trace) => trace.ids.join(',') === sequence.ids.join(','))) {
      out.push(`no path of memSuggest walks the table's ${sequence.name}: ${sequence.ids.join(' → ')}`);
    }
  }
  for (const source of libSources) {
    walk(source, (node) => {
      if (stepId(node) !== null && !seenSteps.has(node)) out.push(`a step outside the paths of memSuggest at ${where(node)}`);
    });
  }
  return out;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mem-suggest-await-table-4226-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EXTRA = path.join(LIB_DIR, 'extra-4226-control.ts');

/** A new file of `src/lib/mem-suggest/`, written under the sandbox and read back (never on disk there). */
function added(file: string, content: string): Record<string, string> {
  const copy = path.join(dir, path.basename(file));
  writeFileSync(copy, content);
  return { [file]: readFileSync(copy, 'utf8') };
}

const QUIET_W5 = "closeRequest({ db, fixed, branches }, outcome)));\n    return answer;";
const IMPORTS_END = "import { formatQuietLine, judgeSuggestions, MEM_SUGGEST_MESSAGES, type SuggestHit } from './rules';";

/** A changed copy of a source, written under the sandbox and read back. */
function changed(file: string, from: string, to: string): Record<string, string> {
  const source = readFileSync(file, 'utf8');
  expect(source.includes(from), from).toBe(true);
  const copy = path.join(dir, path.basename(file));
  writeFileSync(copy, source.replace(from, to));
  return { [file]: readFileSync(copy, 'utf8') };
}

describe('I-F13: the awaits of the prompts are the table, and INV-A holds', () => {
  it('the sources pass: every await is a step of the table, every key is used, the record is in the W5 build only', () => {
    const findings = analyze();
    expect(findings.violations).toEqual([]);
    expect(findings.unusedKeys).toEqual([]);
  }, 60_000);

  it('(negative control) a synchronous read-only helper outside the build (the fingerprint) is no violation', () => {
    const findings = analyze(
      changed(SERVICE, '  const step = deps.step ?? runStep;', "  const step = deps.step ?? runStep;\n  suggestionFingerprint('x', []);")
    );
    expect(findings.violations).toEqual([]);
  }, 60_000);
});

describe('(self-test) the checks fail on what they forbid', () => {
  it('a bare await (the branch listing awaited outside step)', () => {
    const findings = analyze(
      changed(SERVICE, '    const branches = branchesOf(listing);', '    await deps.listBranches?.(fixed.worktreePath);\n    const branches = branchesOf(listing);')
    );
    expect(findings.violations.some((v) => v.startsWith('await not through step'))).toBe(true);
  }, 60_000);

  it("a step that is not in the table (step('W9'))", () => {
    const findings = analyze(changed(SERVICE, "const listing = await step('W2',", "const listing = await step('W9',"));
    expect(findings.violations.some((v) => v.includes("step('W9')"))).toBe(true);
    expect(findings.unusedKeys).toEqual(['W2']);
  }, 60_000);

  it('a key of the table no await uses', () => {
    const findings = analyze(
      changed(SERVICE, "  W5: { await: 'withMemTarget (the closing", "  W6: { await: 'unused', paths: ['quiet'], position: 'nowhere' },\n  W5: { await: 'withMemTarget (the closing")
    );
    expect(findings.unusedKeys).toEqual(['W6']);
  }, 60_000);

  it('settleShown after W5 returned (outside the build)', () => {
    const findings = analyze(
      changed(
        SERVICE,
        '    const answer = await step(\'W5\', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));\n    return answer;',
        "    const answer = await step('W5', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));\n    settleShown(db, { worktreeId, instanceId: '', scopeHash: '', write: [], clear: [], rosterInstanceIds: [], knownCodes: [], liveScopeHashes: new Set() });\n    return answer;"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('settleShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('readShown in the build of W3 (outside the W5 build)', () => {
    const findings = analyze(
      changed(SERVICE, '  return { target: outcome, registration: registrationOf(db) };', "  readShown(db, fixed.worktreeId, 'claude', '');\n  return { target: outcome, registration: registrationOf(db) };")
    );
    expect(findings.violations.some((v) => v.startsWith('readShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('an async build', () => {
    const findings = analyze(
      changed(SERVICE, "(outcome) => closeRequest({ db, fixed, branches }, outcome)", 'async (outcome) => closeRequest({ db, fixed, branches }, outcome)')
    );
    expect(findings.violations.some((v) => v.startsWith('the W5 build is async'))).toBe(true);
  }, 60_000);

  it('a helper that hands a promise on without awaiting it, and a .then(', () => {
    const findings = analyze(
      changed(
        SERVICE,
        'function registrationOf(db: Database.Database): string {',
        "function later(): Promise<number> {\n  return Promise.resolve(1).then((n) => n);\n}\n\nfunction registrationOf(db: Database.Database): string {"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('a promise handed on by later'))).toBe(true);
    expect(findings.violations.some((v) => v.startsWith('.then('))).toBe(true);
  }, 60_000);

  it('the route: an await after memSuggest, or something other than the JSON answer after it', () => {
    const findings = analyze(
      changed(
        ROUTE,
        '    return NextResponse.json(outcome.body, { status: outcome.status });\n  } catch',
        '    await Promise.resolve();\n    return NextResponse.json(outcome.body, { status: outcome.status });\n  } catch'
      )
    );
    expect(findings.violations.some((v) => v.startsWith('route awaits:'))).toBe(true);
    expect(findings.violations.some((v) => v.startsWith('after memSuggest:'))).toBe(true);
    expect(findings.unusedKeys).toEqual(['W1']);
  }, 60_000);
});

describe('(self-test, Codex P2-2 / PM P3-1) the order, the count, floating promises and the other files', () => {
  it('G1: an id of the table reused after W5 (quiet: W2 → W5 → W2)', () => {
    const findings = analyze(
      changed(SERVICE, QUIET_W5, "closeRequest({ db, fixed, branches }, outcome)));\n    await step('W2', () => Promise.resolve(listing));\n    return answer;")
    );
    expect(findings.violations.some((v) => v.includes('awaits W2 → W5 → W2'))).toBe(true);
  }, 60_000);

  it('G3: the order turned round (a W5 before W2)', () => {
    const findings = analyze(changed(SERVICE, "    const listing = await step('W2',", "    await step('W5', () => Promise.resolve(null));\n    const listing = await step('W2',"));
    expect(findings.violations.some((v) => v.includes('awaits W5 → W2 → W5'))).toBe(true);
  }, 60_000);

  it('a whole sequence no path walks (W5 left out of quiet)', () => {
    const findings = analyze(
      changed(
        SERVICE,
        "    const answer = await step('W5', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));",
        "    const answer = closeRequest({ db, fixed, branches }, { ok: false, code: 'not_found' } as never);"
      )
    );
    expect(findings.violations.some((v) => v.startsWith("no path of memSuggest walks the table's quiet"))).toBe(true);
  }, 60_000);

  it('a step in a loop (its count is not fixed)', () => {
    const findings = analyze(
      changed(SERVICE, "    const listing = await step('W2',", "    for (const _ of [1]) await step('W2', () => Promise.resolve(null));\n    const listing = await step('W2',")
    );
    expect(findings.violations.some((v) => v.startsWith('a step in a ForOfStatement'))).toBe(true);
  }, 60_000);

  it('G2: a floating promise in the build (a promise-returning call not awaited)', () => {
    const findings = analyze(
      changed(SERVICE, '  // The materials, read now (the copy after, §3.2).', '  execGitCommandCapture(BRANCH_ARGS, fixed.worktreePath);\n  // The materials, read now (the copy after, §3.2).')
    );
    expect(findings.violations.some((v) => v.startsWith('a promise not awaited (execGitCommandCapture)'))).toBe(true);
  }, 60_000);

  it('a floating promise in memSuggest itself (returned, not awaited)', () => {
    const findings = analyze(changed(SERVICE, '    const branches = branchesOf(listing);', '    if (listing.ok === false) return memList(db, fixed.spec, {}, deps);\n    const branches = branchesOf(listing);'));
    expect(findings.violations.some((v) => v.startsWith('a promise not awaited (memList)'))).toBe(true);
  }, 60_000);

  it('a bare await in a helper of another file of mem-suggest (the files are listed, not fixed)', () => {
    const findings = analyze(added(EXTRA, 'export async function extra(): Promise<number> {\n  return await Promise.resolve(1);\n}\n'));
    expect(findings.violations.some((v) => v.startsWith('await not through step at src/lib/mem-suggest/extra-4226-control.ts'))).toBe(true);
  }, 60_000);

  it('a step of the table in a helper of another file, called after W5 (the call is followed across files)', () => {
    const both = analyze({
      ...added(
        EXTRA,
        "import type { MemSuggestStep } from './service';\n\nexport async function listAgain(step: MemSuggestStep): Promise<void> {\n  await step('W2', () => Promise.resolve(null));\n}\n"
      ),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { listAgain } from './extra-4226-control';\n`)
        .replace(QUIET_W5, 'closeRequest({ db, fixed, branches }, outcome)));\n    await listAgain(step);\n    return answer;'),
    });
    expect(both.violations.some((v) => v.includes('awaits W2 → W5 → W2'))).toBe(true);
  }, 60_000);

  it('a helper of another file that reads the record, called outside the W5 build', () => {
    const findings = analyze({
      ...added(
        EXTRA,
        "import type Database from 'better-sqlite3';\nimport { readShown } from '@/lib/db/suggestion-shown-db';\n\nexport function peek(db: Database.Database): number {\n  return readShown(db, 'w', 'claude', '').size;\n}\n"
      ),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { peek } from './extra-4226-control';\n`)
        .replace('    const branches = branchesOf(listing);', '    peek(db);\n    const branches = branchesOf(listing);'),
    });
    expect(findings.violations.some((v) => v.startsWith('readShown outside the W5 build at src/lib/mem-suggest/extra-4226-control.ts'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c P2-2) settleShown imported under another name and called after W5 (the name is resolved, not read)', () => {
    const findings = analyze({
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { settleShown as settleLate } from '@/lib/db/suggestion-shown-db';\n`)
        .replace(
          QUIET_W5,
          "closeRequest({ db, fixed, branches }, outcome)));\n    settleLate(db, { worktreeId, instanceId: '', scopeHash: '', write: [], clear: [], rosterInstanceIds: [], knownCodes: [], liveScopeHashes: new Set() });\n    return answer;"
        ),
    });
    expect(findings.violations.some((v) => v.startsWith('settleShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c P2-2) settleShown bound to a local name and called after W5', () => {
    const findings = analyze(
      changed(
        SERVICE,
        QUIET_W5,
        "closeRequest({ db, fixed, branches }, outcome)));\n    const settleLate = settleShown;\n    settleLate(db, { worktreeId, instanceId: '', scopeHash: '', write: [], clear: [], rosterInstanceIds: [], knownCodes: [], liveScopeHashes: new Set() });\n    return answer;"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('settleShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c P2-2) readShown imported under another name in another file, called outside the W5 build', () => {
    const findings = analyze({
      ...added(
        EXTRA,
        "import type Database from 'better-sqlite3';\nimport { readShown as peekRecord } from '@/lib/db/suggestion-shown-db';\n\nexport function peek(db: Database.Database): number {\n  return peekRecord(db, 'w', 'claude', '').size;\n}\n"
      ),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { peek } from './extra-4226-control';\n`)
        .replace('    const branches = branchesOf(listing);', '    peek(db);\n    const branches = branchesOf(listing);'),
    });
    expect(findings.violations.some((v) => v.startsWith('readShown outside the W5 build at src/lib/mem-suggest/extra-4226-control.ts'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c P2-2) a helper the build reaches, called outside it as well under an import alias', () => {
    const findings = analyze({
      ...added(
        EXTRA,
        "import type Database from 'better-sqlite3';\nimport { readShown } from '@/lib/db/suggestion-shown-db';\n\nexport function peek(db: Database.Database): number {\n  return readShown(db, 'w', 'claude', '').size;\n}\n"
      ),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { peek, peek as look } from './extra-4226-control';\n`)
        .replace('  // The materials, read now (the copy after, §3.2).', '  peek(db);\n  // The materials, read now (the copy after, §3.2).')
        .replace('    const branches = branchesOf(listing);', '    look(db);\n    const branches = branchesOf(listing);'),
    });
    expect(findings.violations.some((v) => v.startsWith('peek (calls readShown) is called outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(negative control, Codex 5-2c P2-2) settleShown under another name inside the W5 build is no violation', () => {
    const findings = analyze({
      [SERVICE]: readFileSync(SERVICE, 'utf8').replace(
        "import { readShown, settleShown, type ShownRow } from '@/lib/db/suggestion-shown-db';",
        "import { readShown, settleShown as settleRecord, type ShownRow } from '@/lib/db/suggestion-shown-db';"
      ).replace('  settleShown(db, {', '  settleRecord(db, {'),
    });
    expect(findings.violations).toEqual([]);
  }, 60_000);

  /** A helper of another file that reads the record, called from the W5 build (`peek(db)`). */
  const PEEK = "import type Database from 'better-sqlite3';\nimport { readShown } from '@/lib/db/suggestion-shown-db';\n\nexport function peek(db: Database.Database): number {\n  return readShown(db, 'w', 'claude', '').size;\n}\n";
  const withPeek = (imports: string, inBuild: string, outside: string): Record<string, string> => ({
    ...added(EXTRA, PEEK),
    [SERVICE]: readFileSync(SERVICE, 'utf8')
      .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\n${imports}\n`)
      .replace('  // The materials, read now (the copy after, §3.2).', `${inBuild}  // The materials, read now (the copy after, §3.2).`)
      .replace('    const branches = branchesOf(listing);', `${outside}    const branches = branchesOf(listing);`),
  });

  it('(Codex 5-2c-2 P2) a helper the build reaches, called outside it as well through a local binding (const again = peek)', () => {
    const findings = analyze(withPeek("import { peek } from './extra-4226-control';", '  peek(db);\n', '    const again = peek;\n    again(db);\n'));
    expect(findings.violations.some((v) => v.startsWith('peek (calls readShown) is called outside the W5 build at src/lib/mem-suggest/service.ts'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c-2 P2) a helper the build reaches, called outside it through a local binding of an import alias', () => {
    const findings = analyze(withPeek("import { peek, peek as look } from './extra-4226-control';", '  peek(db);\n', '    const again = look;\n    again(db);\n'));
    expect(findings.violations.some((v) => v.startsWith('peek (calls readShown) is called outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c-2 P2) a helper the build reaches, called outside it through a reassigned binding', () => {
    const findings = analyze(
      withPeek("import { peek } from './extra-4226-control';", '  peek(db);\n', '    let again: (d: typeof db) => number = () => 0;\n    again = peek;\n    again(db);\n')
    );
    expect(findings.violations.some((v) => v.startsWith('peek (calls readShown) is called outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c-2 P2) a helper the build reaches, called outside it through a namespace import', () => {
    const findings = analyze(withPeek("import { peek } from './extra-4226-control';\nimport * as extra from './extra-4226-control';", '  peek(db);\n', '    extra.peek(db);\n'));
    expect(findings.violations.some((v) => v.startsWith('peek (calls readShown) is called outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c-2 P2) settleShown reassigned to a local binding and called after W5', () => {
    const findings = analyze(
      changed(
        SERVICE,
        QUIET_W5,
        "closeRequest({ db, fixed, branches }, outcome)));\n    let settleLate: typeof settleShown = () => undefined as never;\n    settleLate = settleShown;\n    settleLate(db, { worktreeId, instanceId: '', scopeHash: '', write: [], clear: [], rosterInstanceIds: [], knownCodes: [], liveScopeHashes: new Set() });\n    return answer;"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('settleShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('(Codex 5-2c-2 P2) a step of the table in a helper of another file, called after W5 through a namespace import', () => {
    const both = analyze({
      ...added(
        EXTRA,
        "import type { MemSuggestStep } from './service';\n\nexport async function listAgain(step: MemSuggestStep): Promise<void> {\n  await step('W2', () => Promise.resolve(null));\n}\n"
      ),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport * as extra from './extra-4226-control';\n`)
        .replace(QUIET_W5, 'closeRequest({ db, fixed, branches }, outcome)));\n    await extra.listAgain(step);\n    return answer;'),
    });
    expect(both.violations.some((v) => v.includes('awaits W2 → W5 → W2'))).toBe(true);
  }, 60_000);

  it('(negative control, Codex 5-2c-2 P2) the helper called inside the W5 build, directly and through a binding, alias and reassignment, is no violation', () => {
    const findings = analyze(
      withPeek(
        "import { peek, peek as look } from './extra-4226-control';",
        '  peek(db);\n  const again = look;\n  again(db);\n  let later: (d: typeof db) => number = () => 0;\n  later = peek;\n  later(db);\n',
        ''
      )
    );
    expect(findings.violations).toEqual([]);
  }, 60_000);

  it('(negative control) a synchronous helper of another file called from the build is no violation', () => {
    const findings = analyze({
      ...added(EXTRA, 'export function countOf(names: readonly string[]): number {\n  return names.length;\n}\n'),
      [SERVICE]: readFileSync(SERVICE, 'utf8')
        .replace(`${IMPORTS_END}\n`, `${IMPORTS_END}\nimport { countOf } from './extra-4226-control';\n`)
        .replace('  // The materials, read now (the copy after, §3.2).', '  countOf(closing.branches ?? []);\n  // The materials, read now (the copy after, §3.2).'),
    });
    expect(findings.violations).toEqual([]);
  }, 60_000);
});
