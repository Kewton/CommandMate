/**
 * Who builds a brief, read off the TypeScript syntax of `src/` (Issue #4223, codex-2
 * re-reviews P2 and PM re-review P3-2, 2026-11-09). Not a test file.
 *
 * Starting from `buildBrief` of `src/lib/brief/build.ts`, every function whose body calls
 * a member of the chain joins it, until nothing new is found — so a wrapper of a wrapper
 * (the API around `briefForRoute`) is a caller too. A member is a (module, name) pair, and
 * a bare call is resolved to one through the file's own functions, its local aliases
 * (`const make = buildBrief`) and its imports (`import { buildBrief as make } from …`,
 * the module path resolved), so a common name imported from another module is not
 * mistaken for a member. A re-export (`export { buildBrief as make } from …`,
 * `export const make = buildBrief`) makes the new name a member of the re-exporting
 * module. `ns.name(…)` through `import * as ns` is resolved like a bare call; any other
 * `obj.name(…)` counts only for a member that is a method (a class or object method, or a
 * function-valued property) — a top-level function is reached by import, and matching it
 * by name through any object would pull every `x.encode(…)` of `src/` in.
 *
 * A function is any of: a function declaration, an arrow function or function expression
 * bound to a name (`const f = () => …`, an object property), a class or object method; an
 * unnamed callback belongs to the function around it. A call inside a loop
 * (`for` / `while` / `do`), or a function that calls itself, is a rebuild.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

export interface ChainCaller {
  /** Whether it calls a member of the chain inside a loop, or calls itself. */
  retries: boolean;
}

/** A module path without its extension or `/index` (`src/lib/brief/build`). */
const moduleOf = (file: string): string => file.replace(/\.(tsx?|mjs|js)$/, '').replace(/\/index$/, '');

/** Where an import specifier written in `file` points, or null for a package. */
function resolveSpecifier(specifier: string, file: string): string | null {
  if (specifier.startsWith('@/')) return moduleOf(`src/${specifier.slice(2)}`);
  if (specifier.startsWith('.')) return moduleOf(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  return null;
}

interface Ref {
  module: string;
  name: string;
}

interface FunctionFacts {
  key: string;
  name: string;
  /** Reachable as `obj.name(…)`: a method or a function-valued property. */
  method: boolean;
  /** `ref`: a call through a namespace import, already resolved. */
  calls: Array<{ name: string; viaProperty: boolean; inLoop: boolean; ref?: Ref }>;
}

interface FileFacts {
  file: string;
  module: string;
  functions: FunctionFacts[];
  /** A local name → what it is (a local alias followed, then an import resolved). */
  resolve(name: string): Ref;
  /** Re-exports: the new name and what it refers to. */
  reexports: Array<{ name: string; target: Ref }>;
}

const LOOPS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

function nameOf(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name && !ts.isComputedPropertyName(node.name) ? node.name.getText() : null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && !ts.isComputedPropertyName(parent.name)) return parent.name.getText();
    if (ts.isPropertyDeclaration(parent) && !ts.isComputedPropertyName(parent.name)) return parent.name.getText();
    return null;
  }
  return null;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isMethod(node: ts.Node): boolean {
  if (ts.isMethodDeclaration(node)) return true;
  const parent = node.parent;
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent));
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

export function analyseFile(file: string, text: string): FileFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const module = moduleOf(file);
  const aliases = new Map<string, string>(); // local name → local name it stands for
  const imports = new Map<string, Ref>(); // local name → (module, original name)
  const namespaces = new Map<string, string>(); // `import * as ns` → module
  const pendingReexports: Array<{ name: string; local?: string; target?: Ref }> = [];
  const functions: FunctionFacts[] = [];
  const stack: Array<{ facts: FunctionFacts | null; loopDepth: number }> = [{ facts: null, loopDepth: 0 }];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = resolveSpecifier(node.moduleSpecifier.text, file);
      const bindings = node.importClause?.namedBindings;
      if (from && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.set(element.name.text, { module: from, name: (element.propertyName ?? element.name).text });
      }
      if (from && bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, from);
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? resolveSpecifier(node.moduleSpecifier.text, file) : null;
      for (const element of node.exportClause.elements) {
        const original = (element.propertyName ?? element.name).text;
        if (original === element.name.text && !node.moduleSpecifier) continue; // `export { f }`: f is already itself
        if (from) pendingReexports.push({ name: element.name.text, target: { module: from, name: original } });
        else if (!node.moduleSpecifier) pendingReexports.push({ name: element.name.text, local: original });
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      aliases.set(node.name.text, node.initializer.text);
      if (isExported(node.parent.parent)) pendingReexports.push({ name: node.name.text, local: node.initializer.text });
    }
    if (isFunctionLike(node)) {
      const own = nameOf(node);
      const className = ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name ? `${node.parent.name.text}.` : '';
      if (own) {
        const facts: FunctionFacts = { key: `${file}:${className}${own}`, name: own, method: isMethod(node), calls: [] };
        functions.push(facts);
        stack.push({ facts, loopDepth: 0 });
        ts.forEachChild(node, visit);
        stack.pop();
        return;
      }
    }
    const top = stack[stack.length - 1];
    if (LOOPS.has(node.kind)) {
      top.loopDepth += 1;
      ts.forEachChild(node, visit);
      top.loopDepth -= 1;
      return;
    }
    if (ts.isCallExpression(node) && top.facts) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) top.facts.calls.push({ name: callee.text, viaProperty: false, inLoop: top.loopDepth > 0 });
      else if (ts.isPropertyAccessExpression(callee)) {
        const ns = ts.isIdentifier(callee.expression) ? namespaces.get(callee.expression.text) : undefined;
        top.facts.calls.push({
          name: callee.name.text,
          viaProperty: ns === undefined,
          inLoop: top.loopDepth > 0,
          ...(ns !== undefined ? { ref: { module: ns, name: callee.name.text } } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const resolve = (name: string): Ref => {
    let current = name;
    for (let hops = 0; aliases.has(current) && hops < 8; hops += 1) current = aliases.get(current)!;
    return imports.get(current) ?? { module, name: current };
  };
  return {
    file,
    module,
    functions,
    resolve,
    reexports: pendingReexports.map((entry) => ({ name: entry.name, target: entry.target ?? resolve(entry.local!) })),
  };
}

const analysed = new Map<string, FileFacts>();

/** {@link analyseFile}, parsed once per (file, text). */
function analyseCached(file: string, text: string): FileFacts {
  const key = `${file}\0${text}`;
  let facts = analysed.get(key);
  if (!facts) {
    facts = analyseFile(file, text);
    analysed.set(key, facts);
  }
  return facts;
}

export const BRIEF_CHAIN_ROOT: Ref = { module: 'src/lib/brief/build', name: 'buildBrief' };

/** Every caller in the chain of `root` in `sources`, keyed `file:function`. */
export function briefCallChain(sources: Record<string, string>, root: Ref = BRIEF_CHAIN_ROOT): Record<string, ChainCaller> {
  return walkChain(sources, root).callers;
}

/**
 * The chain and every name it can be called by — the callers' own names and the names
 * they are re-exported as (codex re-review P2: `export { buildBrief as make }` makes
 * `make` an entrance; the file selection has to look for it too).
 */
export function walkChain(sources: Record<string, string>, root: Ref = BRIEF_CHAIN_ROOT): { callers: Record<string, ChainCaller>; names: Set<string> } {
  const files = Object.entries(sources).map(([file, text]) => analyseCached(file, text));
  const members = new Map<string, { ref: Ref; method: boolean }>([[`${root.module}#${root.name}`, { ref: root, method: false }]]);
  const has = (ref: Ref): boolean => members.has(`${ref.module}#${ref.name}`);
  const add = (ref: Ref, method: boolean): boolean => {
    const key = `${ref.module}#${ref.name}`;
    if (members.has(key)) return false;
    members.set(key, { ref, method });
    return true;
  };
  const found = new Map<string, ChainCaller>();
  for (let grew = true; grew; ) {
    grew = false;
    const byProperty = new Set([...members.values()].filter((member) => member.method).map((member) => member.ref.name));
    for (const where of files) {
      for (const reexport of where.reexports) {
        if (has(reexport.target) && add({ module: where.module, name: reexport.name }, false)) grew = true;
      }
      for (const facts of where.functions) {
        const hits = facts.calls.filter(
          (call) => (call.ref ? has(call.ref) : call.viaProperty ? byProperty.has(call.name) : has(where.resolve(call.name))) && call.name !== facts.name
        );
        if (hits.length === 0) continue;
        const retries = hits.some((call) => call.inLoop) || facts.calls.some((call) => call.name === facts.name && !call.viaProperty);
        const previous = found.get(facts.key);
        if (!previous || previous.retries !== retries) {
          found.set(facts.key, { retries });
          grew = true;
        }
        if (add({ module: where.module, name: facts.name }, facts.method)) grew = true;
      }
    }
  }
  return {
    callers: Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : 1))),
    names: new Set([...members.values()].map((member) => member.ref.name)),
  };
}

function sourcesUnder(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) sourcesUnder(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The files of `src/` that could be in the chain: grown by the names found (the callers'
 * names and their re-exported names), so only those that name a member are parsed.
 * `extra` is added to `src/` before the selection (a self-test's new files go through the
 * same selection as the real ones).
 */
export function chainSources(root = path.join(process.cwd(), 'src'), extra: Record<string, string> = {}): Record<string, string> {
  const texts = new Map(sourcesUnder(root).map((file) => [path.relative(process.cwd(), file).split(path.sep).join('/'), readFileSync(file, 'utf8')]));
  for (const [file, text] of Object.entries(extra)) texts.set(file, text);
  const picked: Record<string, string> = {};
  let names = new Set([BRIEF_CHAIN_ROOT.name]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, text] of texts) {
      if (picked[file] || ![...names].some((name) => new RegExp(`\\b${name}\\b`).test(text))) continue;
      picked[file] = text;
      grew = true;
    }
    const next = walkChain(picked).names;
    if ([...next].some((name) => !names.has(name))) grew = true;
    names = new Set([...names, ...next]);
  }
  return picked;
}
