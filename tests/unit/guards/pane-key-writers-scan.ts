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

/**
 * tmux's own aliases of {@link RAW_KEY_COMMANDS} (`tmux list-commands`), Issue
 * #4050. Counted only where the word goes to tmux — an argv handed to a tmux
 * invocation, or a shell line after `tmux` — because `send` is also a CLI
 * command name (`new Command('send')`, `commandmate send`).
 */
export const RAW_KEY_COMMAND_ALIASES: Readonly<Record<string, string>> = { send: 'send-keys', pasteb: 'paste-buffer' };

/** A set of tmux commands to look for, by their full names and tmux's aliases. */
export interface TmuxCommandSet {
  commands: readonly string[];
  aliases: Readonly<Record<string, string>>;
  /**
   * Also count an array that merely starts with a full name, wherever it goes
   * (#4032's rule for the key commands: an argv built before it is handed to
   * tmux). Off for a name that is also a label (`'kill-session'` names an API).
   */
  anyArgvHead?: boolean;
}

export const RAW_KEY_COMMAND_SET: TmuxCommandSet = { commands: RAW_KEY_COMMANDS, aliases: RAW_KEY_COMMAND_ALIASES, anyArgvHead: true };

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

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/**
 * The specifier of a dynamic import used without a binding (Issue #4050):
 * `(await import('m')).name` — `expression` is the object the member is read
 * off, parentheses and `await` included.
 */
function unboundDynamicImportSpecifier(expression: ts.Expression): string | null {
  const node = unwrap(expression);
  return ts.isAwaitExpression(node) ? dynamicImportSpecifier(unwrap(node.expression)) : null;
}

/**
 * `import('m').then((m) => …)` / `.then(({ name }) => …)` (Issue #4050): the
 * specifier and the callback's first parameter, which binds the module.
 */
function thenOfDynamicImport(node: ts.Node): { specifier: string; parameter: ts.ParameterDeclaration } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'then') return null;
  const specifier = dynamicImportSpecifier(unwrap(node.expression.expression));
  const callback = node.arguments[0];
  if (specifier === null || callback === undefined) return null;
  const fn = unwrap(callback);
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length === 0) return null;
  return { specifier, parameter: fn.parameters[0] };
}

/** The name a member access reads, for `x.name` and `x['name']`; null for a computed key. */
function memberName(node: ts.Node): { object: ts.Expression; name: string } | null {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { object: node.expression, name: node.argumentExpression.text };
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
    // `const m = await import(…)` / `const { w } = await import(…)`, and (Issue
    // #4050) the parameter of `import(…).then((m) => …)` / `.then(({ w }) => …)`.
    const bound = ts.isVariableDeclaration(node)
      ? { specifier: dynamicImportSpecifier(node.initializer), name: node.name }
      : (() => {
          const then = thenOfDynamicImport(node);
          return then === null ? null : { specifier: then.specifier, name: then.parameter.name };
        })();
    if (bound !== null && bound.specifier !== null && isTmuxSpecifier(bound.specifier)) {
      if (ts.isIdentifier(bound.name)) namespaces.add(bound.name.text);
      else if (ts.isObjectBindingPattern(bound.name)) {
        for (const element of bound.name.elements) {
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
    // `ns.w` / `ns['w']` (Issue #4050) on a namespace, and `(await import(…)).w`
    // with no binding at all (Issue #4050).
    const member = memberName(node);
    if (member !== null && writers.includes(member.name)) {
      const object = unwrap(member.object);
      const specifier = unboundDynamicImportSpecifier(member.object);
      if ((ts.isIdentifier(object) && namespaces.has(object.text)) || (specifier !== null && isTmuxSpecifier(specifier))) {
        add(node, member.name);
      }
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
    // As in scanKeyWriters: a declaration, or (Issue #4050) `import(…).then((m) => …)`.
    const bound = ts.isVariableDeclaration(node)
      ? { specifier: dynamicImportSpecifier(node.initializer), name: node.name }
      : (() => {
          const then = thenOfDynamicImport(node);
          return then === null ? null : { specifier: then.specifier, name: then.parameter.name };
        })();
    if (bound !== null && bound.specifier !== null && fromDefining(bound.specifier)) {
      if (ts.isIdentifier(bound.name)) namespaces.add(bound.name.text);
      else if (ts.isObjectBindingPattern(bound.name)) {
        for (const element of bound.name.elements) {
          const name = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : ts.isIdentifier(element.name) ? element.name.text : null;
          if (name !== null && names.includes(name) && ts.isIdentifier(element.name)) bind(element.name.text, name);
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
    // Issue #4050: `ns['name']`, and `(await import(…)).name` / `['name']` with no binding.
    const member = memberName(node);
    if (member !== null && names.includes(member.name)) {
      const object = unwrap(member.object);
      const specifier = unboundDynamicImportSpecifier(member.object);
      const viaNamespace = ts.isElementAccessExpression(node) && ts.isIdentifier(object) && namespaces.has(object.text);
      if (viaNamespace || (specifier !== null && fromDefining(specifier))) add(node, member.name);
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

/** Global flags of tmux that take an argument: `tmux -L <socket> send-keys …` (Issue #4050). */
const TMUX_FLAGS_WITH_ARGUMENT: ReadonlySet<string> = new Set(['-L', '-S', '-f', '-c', '-T']);

const isTmuxProgram = (text: string): boolean => text === 'tmux' || text.endsWith('/tmux');

/** The full name of `word` in `set` — itself, or what its alias stands for — or null. */
function commandNamed(word: string, set: TmuxCommandSet, withAliases: boolean): string | null {
  if (set.commands.includes(word)) return word;
  return withAliases ? (set.aliases[word] ?? null) : null;
}

/**
 * Is `call` a tmux invocation an argv is handed to (Issue #4050)? Its first
 * argument names the program (`execFile('tmux', …)`, `spawn('/usr/bin/tmux', …)`),
 * or the callee says tmux (`runTmux(…)`, `tmuxExec(…)`).
 */
function isTmuxInvocation(call: ts.CallExpression): boolean {
  const first = call.arguments[0];
  if (first !== undefined && ts.isStringLiteralLike(first) && isTmuxProgram(first.text)) return true;
  const name = calleeName(call.expression);
  return name !== null && /tmux/i.test(name);
}

/**
 * The commands of a tmux argv (Issue #4050): the word at each command position
 * — the first one after the global flags (and their arguments), and the first
 * one after each `;` that chains another command. A spread may hold flags, so
 * it leaves the position open; any other expression there is a command nobody
 * can read, and closes it.
 */
function argvCommands(array: ts.ArrayLiteralExpression, set: TmuxCommandSet): Array<{ node: ts.Node; command: string }> {
  const found: Array<{ node: ts.Node; command: string }> = [];
  let elements = [...array.elements];
  const head = elements[0];
  if (head !== undefined && ts.isStringLiteralLike(head) && isTmuxProgram(head.text)) elements = elements.slice(1);
  let expectCommand = true;
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const literal = ts.isStringLiteralLike(element) ? element.text : null;
    if (!expectCommand) {
      if (literal === ';' || literal === '\\;') expectCommand = true;
      continue;
    }
    if (ts.isSpreadElement(element)) continue;
    if (literal === null) {
      expectCommand = false;
      continue;
    }
    if (TMUX_FLAGS_WITH_ARGUMENT.has(literal)) {
      i += 1;
      continue;
    }
    if (literal.startsWith('-')) continue;
    const command = commandNamed(literal, set, true);
    if (command !== null) found.push({ node: element, command });
    expectCommand = false;
  }
  return found;
}

/** The text of a string or template, its substitutions written as one word each. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
  return null;
}

/**
 * Where a shell line runs one of the commands through tmux (Issue #4050):
 * `tmux [flags] <command>` with the command a word of its own, e.g.
 * `` exec(`tmux -L ${sock} send-keys -t ${s} Enter`) ``. A permission pattern
 * (`Bash(tmux kill-session:*)`) is not a word followed by a space, so it is not one.
 */
function shellCommands(text: string, set: TmuxCommandSet): string[] {
  const words = [...set.commands, ...Object.keys(set.aliases)].map((w) => w.replace(/[-]/g, '\\-')).join('|');
  const line = new RegExp(`(?:^|[\\s;&|(\`'"])tmux(?:\\s+-[A-Za-z0-9]+(?:\\s+(?!-)[^\\s;]+)?)*\\s+(${words})(?=[\\s;'"\`]|$)`, 'g');
  return [...text.matchAll(line)].map((m) => commandNamed(m[1], set, true) as string);
}

/**
 * The commands `node` composes for tmux: an argv array (Issue #4032: one that
 * starts with a full command name; Issue #4050: any argv handed to a tmux
 * invocation, or starting with the program, read past its global flags and
 * aliases), a control-mode line starting with a full command name, or a shell
 * line that runs tmux (Issue #4050).
 */
function rawCommandsAt(node: ts.Node, set: TmuxCommandSet = RAW_KEY_COMMAND_SET): Array<{ node: ts.Node; command: string }> {
  if (ts.isArrayLiteralExpression(node)) {
    const parent = node.parent;
    const head = node.elements[0];
    const toTmux =
      (ts.isCallExpression(parent) && parent.arguments.includes(node) && isTmuxInvocation(parent)) ||
      (head !== undefined && ts.isStringLiteralLike(head) && isTmuxProgram(head.text));
    if (toTmux) return argvCommands(node, set);
    // `['send-keys', …]` — an argv for `execFile('tmux', …)` built elsewhere.
    if (set.anyArgvHead === true && head !== undefined && ts.isStringLiteralLike(head)) {
      const command = commandNamed(head.text, set, false);
      if (command !== null) return [{ node: head, command }];
    }
    return [];
  }
  const text = literalText(node);
  if (text === null) return [];
  const found = shellCommands(text, set).map((command) => ({ node, command }));
  // `` `send-keys -t ${target} …` `` — a line for a control-mode client's stdin.
  if (found.length === 0 && (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    const command = set.commands.find((c) => text.startsWith(`${c} `));
    if (command !== undefined) found.push({ node, command });
  }
  return found;
}

/**
 * Every tmux command of `set` composed in one file — argv arrays, control-mode
 * lines and shell lines (see {@link rawCommandsAt}). A label that merely names
 * one (`'paste-buffer'` handed to a log), a CLI command name (`'send'` outside a
 * tmux argv) and a comment are not commands.
 */
export function scanRawTmuxCommands(file: string, text: string, set: TmuxCommandSet): RawKeyWrite[] {
  const mayHaveAlias = /tmux/i.test(text) && Object.keys(set.aliases).some((a) => text.includes(a));
  if (!set.commands.some((c) => text.includes(c)) && !mayHaveAlias) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: RawKeyWrite[] = [];
  const visit = (node: ts.Node): void => {
    for (const { node: at, command } of rawCommandsAt(node, set)) {
      found.push({
        file,
        site: siteName(at),
        command,
        line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every `send-keys` / `paste-buffer` command composed in one file ({@link scanRawTmuxCommands}). */
export function scanRawKeyWrites(file: string, text: string): RawKeyWrite[] {
  return scanRawTmuxCommands(file, text, RAW_KEY_COMMAND_SET);
}

/** A call of a method by its name, on whatever object (Issue #4050). */
export interface MemberCall {
  file: string;
  /** Innermost named function holding it (as for {@link KeySite.site}). */
  site: string;
  /** The object the method is read off, as written (`cliTool`, `manager.getTool(id)`, `this`). */
  receiver: string;
  line: number;
}

/**
 * Every call of a method named `name` in one file — `x.name(…)` or
 * `x['name'](…)` — whatever the object is called (Issue #4050). Not the
 * declarations of such a method, and not a call of a bare function `name(…)`.
 */
export function scanMemberCalls(file: string, text: string, name: string): MemberCall[] {
  if (!text.includes(name)) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: MemberCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = memberName(unwrap(node.expression));
      if (member !== null && member.name === name) {
        found.push({
          file,
          site: siteName(node),
          receiver: member.object.getText(source),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
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
      if (rawCommandsAt(n).length > 0) hit = true;
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
