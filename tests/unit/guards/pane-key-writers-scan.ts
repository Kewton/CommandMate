/**
 * Every place in `src` that types into a pane through tmux's key writer, read
 * off the source (Issue #3981).
 *
 * ## What counts as a site
 *
 * Any reference — a call, or the function handed on as a value — to a key
 * writer of `src/lib/tmux/tmux.ts` ({@link KEY_WRITERS}), however it was
 * brought in: a named import (renamed or not), a namespace import, a
 * destructured `await import()`, or a re-export. A wrapper with a name nobody
 * has heard of is still a site, because the reference inside it is; what this
 * scanner never does is look for function names a human remembered to list.
 *
 * A site is named by the innermost named function it sits in (`Class.method`,
 * a function, or the variable an arrow is assigned to); `<module>` otherwise.
 *
 * ## Which files are read
 *
 * The candidates are the files whose import graph edges reach the tmux module
 * directly (`route-tmux-reach.ts`'s graph, dynamic imports included). The graph
 * picks candidates only: whether a site holds the input lock is decided per
 * site, below, and by the ledger's evidence tests — never by reachability.
 *
 * ## Lexically under the lock
 *
 * A site is `lexicallyLocked` when it sits in a function passed to one of
 * {@link LOCK_WRAPPERS}, or in a function that takes an `InstanceInputTicket`.
 * That is what lets the ledger catch a wrapper being taken off a `lock` row.
 */

import ts from 'typescript';
import { join } from 'path';
import { createModuleGraph, repoRelative, REPO_ROOT } from './route-tmux-reach';
import { readdirSync, readFileSync } from 'fs';

/** The tmux exports that type into a pane, as this guard covers them today. */
export const KEY_WRITERS: readonly string[] = ['sendKeys'];

/** The functions that run their callback as a holder of the instance input lock. */
export const LOCK_WRAPPERS: readonly string[] = ['withInstanceInputLock', 'answerUnderInstanceInputLock'];

export const TMUX_MODULE = 'src/lib/tmux/tmux.ts';

export interface KeySite {
  file: string;
  /** Innermost named function holding the reference. */
  site: string;
  /** The key writer referenced. */
  callee: string;
  line: number;
  lexicallyLocked: boolean;
}

function isTmuxSpecifier(specifier: string): boolean {
  return /(^|\/)tmux\/tmux$/.test(specifier) || specifier === './tmux';
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function siteName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      const owner = current.parent;
      const className = ts.isClassDeclaration(owner) && owner.name ? `${owner.name.text}.` : '';
      return `${className}${current.name.text}`;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return '<module>';
}

function takesTicket(fn: ts.FunctionLikeDeclaration, source: ts.SourceFile): boolean {
  return fn.parameters.some((p) => p.type !== undefined && /\bInstanceInputTicket\b/.test(p.type.getText(source)));
}

function isLexicallyLocked(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    if (takesTicket(current, source)) return true;
    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      const name = calleeName(parent.expression);
      if (name !== null && LOCK_WRAPPERS.includes(name)) return true;
    }
  }
  return false;
}

function dynamicImportSpecifier(expression: ts.Expression | undefined): string | null {
  let node = expression;
  if (node && ts.isAwaitExpression(node)) node = node.expression;
  if (
    node &&
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

/**
 * Read one file's key-writer sites off its text. Pure, so the scanner itself is
 * held to fixtures (a scanner that reads nothing makes every check pass).
 */
export function scanKeyWriters(file: string, text: string, writers: readonly string[] = KEY_WRITERS): KeySite[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const aliases = new Map<string, string>(); // local name -> writer
  const namespaces = new Set<string>();
  const declarations = new Set<ts.Node>(); // identifiers that only declare a binding
  const sites: KeySite[] = [];

  const add = (node: ts.Node, callee: string, site?: string): void => {
    sites.push({
      file,
      site: site ?? siteName(node),
      callee,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      lexicallyLocked: isLexicallyLocked(node, source),
    });
  };

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isTmuxSpecifier(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (writers.includes(imported)) {
            aliases.set(element.name.text, imported);
            declarations.add(element.name);
            if (element.propertyName) declarations.add(element.propertyName);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isTmuxSpecifier(node.moduleSpecifier.text)) {
      const clause = node.exportClause;
      if (!clause) {
        for (const writer of writers) add(node, writer, '<re-export>');
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (writers.includes(exported)) add(element, exported, '<re-export>');
          declarations.add(element.name);
          if (element.propertyName) declarations.add(element.propertyName);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const specifier = dynamicImportSpecifier(node.initializer);
      if (specifier !== null && isTmuxSpecifier(specifier)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name) ? element.name.text : null;
            if (imported !== null && writers.includes(imported) && ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, imported);
              declarations.add(element.name);
              if (element.propertyName) declarations.add(element.propertyName);
            }
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && !declarations.has(node) && aliases.has(node.text)) {
      const parent = node.parent;
      // `x.sendKeys` / `{ sendKeys: … }` name a property, not the import.
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) add(node, aliases.get(node.text) as string);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      writers.includes(node.name.text)
    ) {
      add(node, node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Every `.ts` / `.tsx` file under `dir`, absolute. On disk, not `git ls-files`: a new file counts before it is added. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Every source file under `src`, repo-relative and sorted. */
export function srcFiles(): string[] {
  return sourceFiles(join(REPO_ROOT, 'src')).map(repoRelative).sort();
}

/** `src` files whose imports reach the tmux module directly, repo-relative and sorted. */
let candidates: string[] | null = null;
export function candidateFiles(): string[] {
  if (candidates !== null) return candidates;
  const tmux = join(REPO_ROOT, TMUX_MODULE);
  const graph = createModuleGraph();
  candidates = sourceFiles(join(REPO_ROOT, 'src'))
    .filter((f) => f !== tmux && graph.imports(f).includes(tmux))
    .map(repoRelative)
    .sort();
  return candidates;
}

let repositorySites: KeySite[] | null = null;
/** Every key-writer site in `src` today (read once per run). */
export function scanRepository(): KeySite[] {
  repositorySites ??= candidateFiles().flatMap((f) => scanKeyWriters(f, readFileSync(join(REPO_ROOT, f), 'utf-8')));
  return [...repositorySites];
}

export { repoRelative };
