/**
 * Which worktree routes can reach tmux, read off the import graph (Issue #3290).
 *
 * ## Why the import graph and not a list of function names
 *
 * Issue #2865 decided which routes needed the session-ownership check with a
 * grep for the names of the functions that touch tmux (`sendKeys(`,
 * `capturePane(`, `hasSession(` …). `direct-input/route.ts` reaches tmux through
 * `sendDirectInput(` — a wrapper one module away — so the grep never returned
 * it, and it shipped without the check. A name list is only as complete as the
 * last wrapper somebody remembered to add to it.
 *
 * So nothing here knows the name of a function. A route is enumerated when a
 * module that RUNS the tmux binary is reachable from its file by following
 * imports, however many wrappers sit in between. The answer is an
 * over-approximation by construction (it says "can reach", not "does call"),
 * and `worktree-route-session-ownership-3290.test.ts` is what turns each
 * enumerated handler into either a behavioural check or a written reason.
 *
 * ## What counts as an edge
 *
 * Everything that loads a module at some point: `import … from`, a bare
 * `import '…'`, `export … from`, `await import('…')` and `require('…')`. A
 * deferred load still ends in a call, so dynamic imports are edges here —
 * unlike `no-ws-server-manager-cycle-1984.test.ts`, which asks about load-time
 * cycles and rightly ignores them. Type-only imports are erased by the
 * compiler and are not edges.
 *
 * ## What counts as reaching tmux
 *
 * A module that loads `child_process` and names the `tmux` binary as a command
 * string. That is a property read off each file, not a list of files: a new
 * module that shells out to tmux becomes a sink the day it is written.
 */

import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

export const REPO_ROOT = process.cwd();

/** The directory whose `route.ts` files this guard is about. */
export const WORKTREE_ROUTES_DIR = join(REPO_ROOT, 'src', 'app', 'api', 'worktrees', '[id]');

/** The export names Next.js treats as request handlers. */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

const CHILD_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);

export interface ModuleFacts {
  /** Specifiers of every module this one loads at runtime, as written. */
  specifiers: string[];
  /** It loads `child_process` and names `tmux` as a command: it runs the binary. */
  runsTmux: boolean;
  /** HTTP methods it exports. Meaningful for a route module only. */
  handlers: string[];
}

/** `import type …` and `import { type A, type B } …` bring nothing in at runtime. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // `import './x'` — a side-effect import, always an edge
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // default import
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** `export type { A } from` and `export { type A } from` are erased as well. */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

function isTmuxCommandText(text: string): boolean {
  return text === 'tmux' || text.startsWith('tmux ');
}

/**
 * Read one module's facts off its text. Pure, so the parser itself can be held
 * to fixtures (a parser that silently reads nothing makes every "no route is
 * missing" claim true for the wrong reason).
 */
export function analyseSource(fileName: string, text: string): ModuleFacts {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];
  const handlers = new Set<string>();
  let namesTmux = false;

  const addHandler = (name: string): void => {
    if ((HTTP_METHODS as readonly string[]).includes(name)) handlers.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      return; // a module specifier is not a command string
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyExport(node)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) addHandler(element.name.text);
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      addHandler(node.name.text);
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addHandler(declaration.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text);
      }
    }
    if (ts.isStringLiteralLike(node) && isTmuxCommandText(node.text)) namesTmux = true;
    if (ts.isTemplateExpression(node) && isTmuxCommandText(node.head.text)) namesTmux = true;
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    specifiers,
    runsTmux: namesTmux && specifiers.some((specifier) => CHILD_PROCESS_SPECIFIERS.has(specifier)),
    handlers: [...handlers].sort(),
  };
}

/** Apply TypeScript's extension / index resolution to a specifier-derived path. */
function resolveModulePath(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** True for a specifier that names a file of this repository (not a package). */
function isRepoSpecifier(specifier: string): boolean {
  return specifier.startsWith('@/') || specifier.startsWith('@tests/') || specifier.startsWith('.');
}

function specifierBase(specifier: string, fromFile: string): string {
  if (specifier.startsWith('@/')) return join(REPO_ROOT, 'src', specifier.slice(2));
  if (specifier.startsWith('@tests/')) return join(REPO_ROOT, 'tests', specifier.slice('@tests/'.length));
  return resolve(dirname(fromFile), specifier);
}

export interface ModuleGraph {
  /** Facts for a module, read once. */
  facts(file: string): ModuleFacts;
  /** Repo modules `file` loads at runtime (absolute paths). */
  imports(file: string): string[];
  /** `file` plus everything reachable from it. */
  closure(file: string): Set<string>;
  /** Modules reachable from `file` that run the tmux binary, repo-relative and sorted. */
  tmuxSinks(file: string): string[];
  /**
   * Repo specifiers that named a TypeScript module and resolved to nothing —
   * each one is an edge the walk silently dropped.
   */
  unresolved(): string[];
}

/** Repo-relative path with forward slashes. */
export function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

export function createModuleGraph(): ModuleGraph {
  const factsByFile = new Map<string, ModuleFacts>();
  const importsByFile = new Map<string, string[]>();
  const unresolved = new Set<string>();

  const facts = (file: string): ModuleFacts => {
    let known = factsByFile.get(file);
    if (!known) {
      known = analyseSource(file, readFileSync(file, 'utf-8'));
      factsByFile.set(file, known);
    }
    return known;
  };

  const imports = (file: string): string[] => {
    let known = importsByFile.get(file);
    if (!known) {
      const found = new Set<string>();
      for (const specifier of facts(file).specifiers) {
        if (!isRepoSpecifier(specifier)) continue;
        const base = specifierBase(specifier, file);
        const target = resolveModulePath(base);
        if (target) found.add(target);
        // A JSON / CSS / asset import exists on disk under its own name and is
        // not a module that can call anything; only a miss is a dropped edge.
        else if (!existsSync(base)) unresolved.add(`${repoRelative(file)} -> ${specifier}`);
      }
      known = [...found];
      importsByFile.set(file, known);
    }
    return known;
  };

  const closure = (file: string): Set<string> => {
    const seen = new Set<string>([file]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const next of imports(current)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const tmuxSinks = (file: string): string[] =>
    [...closure(file)]
      .filter((module) => facts(module).runsTmux)
      .map(repoRelative)
      .sort();

  return { facts, imports, closure, tmuxSinks, unresolved: () => [...unresolved].sort() };
}

/** Every `route.ts` under `dir`, absolute paths, sorted. */
export function routeFiles(dir: string = WORKTREE_ROUTES_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(path, out);
    else if (entry.name === 'route.ts') out.push(path);
  }
  return out.sort();
}

export interface ReachingHandler {
  /** `<path under src/app/api/worktrees/[id]/>#<METHOD>`, e.g. `send/route.ts#POST`. */
  key: string;
  /** Path of the route file under `src/app/api/worktrees/[id]/`. */
  route: string;
  method: string;
  /** The tmux-running modules its file can reach, repo-relative and sorted. */
  sinks: string[];
}

/** The key a handler is listed under in the table and in the exemption list. */
export function handlerKey(route: string, method: string): string {
  return `${route}#${method}`;
}

/**
 * Every handler of every worktree route whose file can reach a module that runs
 * tmux. This is stage 1: the list the behavioural table has to cover.
 */
export function enumerateTmuxReachingHandlers(graph: ModuleGraph = createModuleGraph()): ReachingHandler[] {
  const reaching: ReachingHandler[] = [];
  for (const file of routeFiles()) {
    const sinks = graph.tmuxSinks(file);
    if (sinks.length === 0) continue;
    const route = relative(WORKTREE_ROUTES_DIR, file).split(sep).join('/');
    for (const method of graph.facts(file).handlers) {
      reaching.push({ key: handlerKey(route, method), route, method, sinks });
    }
  }
  return reaching;
}
