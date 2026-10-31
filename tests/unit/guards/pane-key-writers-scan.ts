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
 *
 * ## Beyond the exported writers (Issue #4032)
 *
 * {@link tmuxKeyWriterExports} reads the writers off the tmux module itself, so
 * a new one cannot stay off {@link KEY_WRITERS} unnoticed; {@link scanRawKeyWrites}
 * finds the `send-keys` / `paste-buffer` commands composed outside it.
 */

import ts from 'typescript';
import { join } from 'path';
import { createModuleGraph, repoRelative, resolveRepoSpecifier, REPO_ROOT } from './route-tmux-reach';
import { readdirSync, readFileSync } from 'fs';

/**
 * The tmux exports that type into a pane: `sendKeys` (Issue #3981) and, since
 * Issue #4032, every other one ({@link tmuxKeyWriterExports} checks the list
 * against the module).
 */
export const KEY_WRITERS: readonly string[] = [
  'sendKeys',
  'sendSpecialKeys',
  'sendSpecialKey',
  'clearInputLine',
  'clearComposerLine',
  'clearComposerPasteToken',
  'sendSpecialKeysAndInvalidate',
  'sendDirectInputAndInvalidate',
];

/** The tmux commands that put keys or text into a pane. */
export const RAW_KEY_COMMANDS: readonly string[] = ['send-keys', 'paste-buffer'];

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

/** The name of a method / property / accessor being declared, which is not a reference. */
function isMemberDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  );
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
      // `x.sendKeys` / `{ sendKeys: … }` name a property, not the import; nor
      // does a method of that name (a transport's `sendSpecialKey`, #4032).
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        isMemberDeclarationName(node);
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

/** How {@link scanReferences} tells the defining module's imports from others. */
export interface ReferenceScanOptions {
  /**
   * Whether a specifier written in the scanned file loads the module that
   * defines `names`. Every specifier counts when omitted (a fixture's text).
   */
  fromDefiningModule?: (specifier: string) => boolean;
}

/**
 * Every reference to a function named one of `names` in one file — the callers
 * of a ledger row whose lock its caller holds (`held: 'caller'`, review P2-1).
 *
 * By name, as written: a bare identifier (a call, or the function handed on),
 * or `this.name` (a method). Declarations, import specifiers, and
 * `other.name` / `{ name: … }` (another object's property) are not references.
 * `callee` is the name referenced; `site` and `lexicallyLocked` read as for a
 * key-writer site.
 *
 * Issue #4032: as {@link scanKeyWriters} reads a key writer — through an import
 * of the defining module, renamed (`import { name as other }`, a destructured
 * `await import()`) or as a namespace (`ns.name`) — and a re-export of the name
 * (`export { name } from`, `export *`, or exporting the imported binding) is a
 * site of its own, `<re-export>`: the module that calls it next is not one that
 * imports the definition, so the walk would not read it.
 */
export function scanReferences(
  file: string,
  text: string,
  names: readonly string[],
  options: ReferenceScanOptions = {}
): KeySite[] {
  // `export *` re-exports the names without spelling them.
  if (!names.some((n) => text.includes(n)) && !/\bexport\s*\*/.test(text)) return [];
  const fromDefining = options.fromDefiningModule ?? (() => true);
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sites: KeySite[] = [];
  const aliases = new Map<string, string>(); // local name -> name, when renamed
  const namespaces = new Set<string>();
  const imported = new Set<string>(); // local names an import of `names` bound
  const add = (node: ts.Node, callee: string, site?: string): void => {
    sites.push({
      file,
      site: site ?? siteName(node),
      callee,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      lexicallyLocked: isLexicallyLocked(node, source),
    });
  };
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    return (
      ((ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isBindingElement(parent)) &&
        parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      // `{ name: local }` destructured: `name` is the property read, not the function.
      (ts.isBindingElement(parent) && parent.propertyName === node)
    );
  };
  const bind = (local: string, name: string): void => {
    imported.add(local);
    if (local !== name) aliases.set(local, name);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && fromDefining(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (names.includes(name)) bind(element.name.text, name);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const specifier = dynamicImportSpecifier(node.initializer);
      if (specifier !== null && fromDefining(specifier)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const name = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name) ? element.name.text : null;
            if (name !== null && names.includes(name) && ts.isIdentifier(element.name)) bind(element.name.text, name);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      const clause = node.exportClause;
      if (specifier !== null && fromDefining(specifier) && (!clause || ts.isNamespaceExport(clause))) {
        for (const name of names) add(node, name, '<re-export>');
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (specifier !== null) {
            if (fromDefining(specifier) && names.includes(exported)) add(element, exported, '<re-export>');
          } else if (imported.has(exported)) {
            add(element, aliases.get(exported) ?? exported, '<re-export>');
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const parent = node.parent;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (names.includes(node.text)) {
        if (
          !isMember ||
          parent.expression.kind === ts.SyntaxKind.ThisKeyword ||
          (ts.isIdentifier(parent.expression) && namespaces.has(parent.expression.text))
        ) {
          add(node, node.text);
        }
      } else if (aliases.has(node.text) && !isMember && !isMemberDeclarationName(node)) {
        add(node, aliases.get(node.text) as string);
      }
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

/**
 * The files that can call `name` as defined in `definingFile`: that file, and
 * every `src` file whose imports reach it directly (the same graph as
 * {@link candidateFiles}), repo-relative and sorted.
 */
let callerGraph: ReturnType<typeof createModuleGraph> | null = null;
export function callerFiles(definingFile: string): string[] {
  callerGraph ??= createModuleGraph();
  const graph = callerGraph;
  const target = join(REPO_ROOT, definingFile);
  return sourceFiles(join(REPO_ROOT, 'src'))
    .filter((f) => f === target || graph.imports(f).includes(target))
    .map(repoRelative)
    .sort();
}

const callerScans = new Map<string, KeySite[]>();
/** Every reference to `name` (defined in `definingFile`) in the files that can call it (read once per run). */
export function scanCallers(definingFile: string, name: string): KeySite[] {
  const key = `${definingFile} :: ${name}`;
  let found = callerScans.get(key);
  if (found === undefined) {
    const target = join(REPO_ROOT, definingFile);
    found = callerFiles(definingFile).flatMap((f) =>
      scanReferences(f, readFileSync(join(REPO_ROOT, f), 'utf-8'), [name], {
        fromDefiningModule: (specifier) => resolveRepoSpecifier(specifier, join(REPO_ROOT, f)) === target,
      })
    );
    callerScans.set(key, found);
  }
  return [...found];
}

/** A `send-keys` / `paste-buffer` command composed outside the tmux module (Issue #4032). */
export interface RawKeyWrite {
  file: string;
  /** Innermost named function holding it (as for {@link KeySite.site}). */
  site: string;
  /** Which of {@link RAW_KEY_COMMANDS}. */
  command: string;
  line: number;
}

/** The command a literal starts a tmux invocation with, or null. */
function rawCommandOf(node: ts.Node): string | null {
  // `['send-keys', …]` — an argv for `execFile('tmux', …)`.
  if (ts.isStringLiteralLike(node) && RAW_KEY_COMMANDS.includes(node.text)) {
    const parent = node.parent;
    return ts.isArrayLiteralExpression(parent) && parent.elements[0] === node ? node.text : null;
  }
  // `` `send-keys -t ${target} …` `` — a line for a control-mode client's stdin.
  const head = ts.isTemplateExpression(node) ? node.head.text : ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
  if (head === null) return null;
  return RAW_KEY_COMMANDS.find((command) => head.startsWith(`${command} `)) ?? null;
}

/**
 * Every `send-keys` / `paste-buffer` command composed in one file: the first
 * element of an argv array, or a command line in a template. A label that
 * merely names one (`'paste-buffer'` handed to a log) is not a command.
 */
export function scanRawKeyWrites(file: string, text: string): RawKeyWrite[] {
  if (!RAW_KEY_COMMANDS.some((c) => text.includes(c))) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: RawKeyWrite[] = [];
  const visit = (node: ts.Node): void => {
    const command = rawCommandOf(node);
    if (command !== null) {
      found.push({
        file,
        site: siteName(node),
        command,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let repositoryRawWrites: RawKeyWrite[] | null = null;
/** Every raw key write in `src` outside the tmux module (read once per run). */
export function scanRepositoryRawWrites(): RawKeyWrite[] {
  repositoryRawWrites ??= srcFiles()
    .filter((f) => f !== TMUX_MODULE)
    .flatMap((f) => scanRawKeyWrites(f, readFileSync(join(REPO_ROOT, f), 'utf-8')));
  return [...repositoryRawWrites];
}

/**
 * The functions the tmux module exports that type into a pane, read off its
 * text (Issue #4032): one that composes a raw key command, or calls a function
 * of the module that does — followed to a fixpoint, so a wrapper of a wrapper
 * counts. Sorted.
 */
export function tmuxKeyWriterExports(text: string, file: string = TMUX_MODULE): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies = new Map<string, { exported: boolean; node: ts.Node }>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const exported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      bodies.set(statement.name.text, { exported, node: statement.body });
    }
  }
  const calls = (node: ts.Node, names: ReadonlySet<string>): boolean => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (rawCommandOf(n) !== null) hit = true;
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) hit = true;
      else ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };
  const writers = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, { node }] of bodies) {
      if (!writers.has(name) && calls(node, writers)) {
        writers.add(name);
        grew = true;
      }
    }
  }
  return [...writers].filter((name) => bodies.get(name)?.exported === true).sort();
}

export { repoRelative };
