/**
 * Every path that makes the hand-off dialog go away asks the one rule (Issue #4227 G-PR2 pr2d,
 * design `mem-ui-4227.md` §4.1.1, the PM's condition 1 in `pm-return-4227-pr2c-codex.md`).
 *
 * The invariant (a decide being sent or unknown is never dropped without the person's choice,
 * and the dialog stays while there is one) holds only if no path goes round the rule. A new
 * path that does fails here:
 *
 * 1. In the dialog (`SessionHandoffDialog.tsx`) `onClose` is called in one place only, `closeBy`,
 *    which asks the rule (`closeHandoffOpening`); `onClose` is handed to nothing else (no
 *    `onClose={onClose}`, no alias).
 * 2. In the page's hook (`useWorktreeDetailController.ts`) the hand-off target is cleared
 *    (`setHandoffTarget(null)`) in one place only, `closeHandoffBy`, which asks the rule;
 *    it is set in `openHandoff` only, and every caller of `openHandoff` asks `closeHandoffBy` first.
 * 5. pr2e (PM Claude pr2d P3-1, codex review-4227-pr2c P2-3): counted by the identifiers that clear
 *    a unit, not by the names of calls — every reference, an alias's included. `onClose`,
 *    `setHandoffTarget` and the store's clears (`dropHandoffUnit` the person's drop,
 *    `settleHandoffDecide` a decide's answer, `endHandoffStop` / `endHandoffCancel` the end of a
 *    stop or a cancel) are referenced only where allowed; the identifiers of the units' old copy
 *    in the component (`setPending`, `pendingRef`, `keepPending`) not at all; and in the store
 *    (`@/lib/handoff/close-rule`) the decide's units (`pending`, `inflight`) are written by
 *    `startHandoffDecide`, `settleHandoffDecide` and `dropHandoffUnit` only. No other source in
 *    `src/` references a clear.
 * 6. pr2f (codex review-4227-pr2d P2-3, the PM's decision: forbid, not resolve): the store's
 *    functions are imported by name only. In `src/` an import of the store with an alias
 *    (`import { dropHandoffUnit as forget }`), a namespace (`import * as rule`, `export * as`), a
 *    re-export of all (`export *`) or with an alias, a dynamic `import()` or a `require()` fails —
 *    whatever its specifier (`@/lib/handoff/close-rule`, a relative path). The store's settle,
 *    drop, close, hide and patch take the sending / the opening they are for (`SentHandoffDecide`,
 *    `HandoffOpeningToken`) as their first parameter; no other exported function writes the store
 *    but its starts and the flags' ends; and no source but the store casts to those types.
 * 3. The paths named at the call sites are exactly `HANDOFF_CLOSE_PATHS` (no path declared and
 *    unused, none used and undeclared).
 * 4. The pages hand the dialog the hook's `closeHandoff` (directly, or as `onHandoffClose`).
 *
 * Positive controls: copies of the real sources under `os.tmpdir()` with one way round the rule
 * added (an effect that clears the target, a button that calls `onClose`, a reopening that clears
 * the unit, an undeclared path, and pr2e's aliases and direct setters) each fail; the copies as
 * they are pass.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HANDOFF_CLOSE_PATHS } from '@/lib/handoff/close-rule';

const ROOT = path.resolve(__dirname, '../../..');
const DIALOG = 'src/components/mem/SessionHandoffDialog.tsx';
const HOOK = 'src/hooks/useWorktreeDetailController.ts';
const PAGES = ['src/components/worktree/WorktreeDetailDesktop.tsx', 'src/components/worktree/WorktreeDetailRefactored.tsx'];
const STORE = 'src/lib/handoff/close-rule.ts';

const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

interface CallSite {
  callee: string;
  args: string[];
  /** The name of the nearest enclosing `const x = …` (or function) the call is in. */
  owner: string | null;
  ownerText: string;
  /** The statements before the call's own statement in its block (what ran first there). */
  before: string;
  /** In JSX: the attribute the call is in and the opening tag of its element. */
  jsx: { attribute: string; tag: string } | null;
}

function callSites(source: string, fileName: string): CallSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: CallSite[] = [];
  const ownerOf = (node: ts.Node): { name: string | null; text: string } => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
        return { name: current.name.text, text: current.initializer.getText(sf) };
      }
      if (ts.isFunctionDeclaration(current) && current.name) return { name: current.name.text, text: current.getText(sf) };
      current = current.parent;
    }
    return { name: null, text: '' };
  };
  const beforeOf = (node: ts.Node): string => {
    let statement: ts.Node = node;
    while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
    const block = statement.parent;
    if (!block || !ts.isBlock(block)) return '';
    const index = block.statements.indexOf(statement as ts.Statement);
    return block.statements
      .slice(0, Math.max(index, 0))
      .map((s) => s.getText(sf))
      .join('\n');
  };
  const jsxOf = (node: ts.Node): CallSite['jsx'] => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isJsxAttribute(current)) {
      if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) return null;
      current = current.parent;
    }
    if (!current || !ts.isJsxAttribute(current)) return null;
    const element = current.parent.parent;
    return { attribute: current.name.getText(sf), tag: element.getText(sf) };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const owner = ownerOf(node);
      sites.push({
        callee: node.expression.text,
        args: node.arguments.map((arg) => arg.getText(sf)),
        owner: owner.name,
        ownerText: owner.text,
        before: beforeOf(node),
        jsx: jsxOf(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

interface Reference {
  name: string;
  /** The call it is the callee of (its arguments), or null: an alias, a prop, a value. */
  callArgs: string[] | null;
  owner: string | null;
  ownerText: string;
  jsx: { attribute: string; tag: string } | null;
}

/**
 * Every reference to one of `names` (pr2e, P3-1): not a declaration, an import, a property's name
 * nor a JSX attribute's name — a use, whether called, aliased, handed on or written.
 */
function references(source: string, fileName: string, names: ReadonlySet<string>): Reference[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Reference[] = [];
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return true;
    if (ts.isJsxAttribute(parent) && parent.name === node) return true;
    // A hook's list of dependencies names it without using it.
    if (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent) && /^use(?:Callback|Effect|Memo)$/.test(parent.parent.expression.getText(sf))) return true;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && !isDeclarationName(node)) {
      const site = callSitesOwner(node, sf);
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
      found.push({ name: node.text, callArgs: call ? call.arguments.map((arg) => arg.getText(sf)) : null, ...site });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function callSitesOwner(node: ts.Node, sf: ts.SourceFile): Pick<Reference, 'owner' | 'ownerText' | 'jsx'> {
  let owner: string | null = null;
  let ownerText = '';
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
      owner = current.name.text;
      ownerText = current.initializer.getText(sf);
      break;
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      owner = current.name.text;
      ownerText = current.getText(sf);
      break;
    }
  }
  let jsx: Reference['jsx'] = null;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) break;
    if (ts.isJsxAttribute(current)) {
      jsx = { attribute: current.name.getText(sf), tag: current.parent.parent.getText(sf) };
      break;
    }
  }
  return { owner, ownerText, jsx };
}

/** The store's clears and where each may be referenced in the dialog (pr2e, P3-1). */
const CLEARS = ['dropHandoffUnit', 'settleHandoffDecide', 'endHandoffStop', 'endHandoffCancel', 'resetHandoffStoreForTests'] as const;
/** The old copy of the units in the component: referenced nowhere. */
const OLD_COPY = ['setPending', 'pendingRef', 'keepPending'] as const;
const isDrop = (ref: Reference): boolean => ref.jsx?.attribute === 'onClick' && ref.jsx.tag.includes('data-testid="handoff-pending-drop"');
const DIALOG_CLEARS: Record<(typeof CLEARS)[number], (ref: Reference) => boolean> = {
  dropHandoffUnit: (ref) => ref.callArgs !== null && isDrop(ref),
  settleHandoffDecide: (ref) => ref.callArgs !== null && ref.owner === 'decide',
  endHandoffStop: (ref) => ref.callArgs !== null && (ref.owner === 'stop' || ref.owner === 'plainStop'),
  endHandoffCancel: (ref) => ref.callArgs !== null && ref.owner === 'requestClose',
  resetHandoffStoreForTests: () => false,
};

/** The problems found in the dialog's source (empty: it follows the rule). */
function checkDialog(source: string): string[] {
  const problems: string[] = [];
  const closes = references(source, 'dialog.tsx', new Set(['onClose']));
  const calls = closes.filter((ref) => ref.callArgs !== null);
  if (calls.length !== 1) problems.push(`onClose is called ${calls.length} times (expected once, in closeBy)`);
  for (const ref of closes) {
    if (ref.callArgs === null) {
      problems.push(`onClose is referenced in ${ref.owner ?? 'the top level'} without being called (an alias, or handed on as a prop: round the rule)`);
      continue;
    }
    if (ref.owner !== 'closeBy') problems.push(`onClose called in ${ref.owner ?? 'the top level'}, not closeBy`);
    else if (!ref.ownerText.includes('closeHandoffOpening(')) problems.push('closeBy does not ask the rule (closeHandoffOpening)');
  }
  if (/=\{\s*onClose\s*\}/.test(source)) problems.push('onClose is handed on as a prop (round the rule)');
  for (const ref of references(source, 'dialog.tsx', new Set<string>(CLEARS))) {
    const allowed = DIALOG_CLEARS[ref.name as (typeof CLEARS)[number]](ref);
    if (!allowed) problems.push(`${ref.name} in ${ref.owner ?? 'the top level'}: ${ref.callArgs === null ? 'an alias or a value' : 'not where it is allowed'} — only the person's drop, a decide's answer and the end of a stop / cancel clear a unit`);
  }
  for (const ref of references(source, 'dialog.tsx', new Set<string>(OLD_COPY))) {
    problems.push(`${ref.name} in ${ref.owner ?? 'the top level'}: the units are the store's, not the component's`);
  }
  if (/\.(?:pending|inflight|stopping|cancelling)\s*=[^=]/.test(source)) problems.push('a unit is written directly (not through the store)');
  if (references(source, 'dialog.tsx', new Set(['dropHandoffUnit'])).length !== 1) problems.push('dropHandoffUnit must appear once, in the drop button');
  return problems;
}

/** The problems found in the hook's source. */
function checkHook(source: string): string[] {
  const problems: string[] = [];
  const sites = callSites(source, 'hook.ts');
  for (const ref of references(source, 'hook.ts', new Set(['setHandoffTarget']))) {
    if (ref.callArgs === null) {
      problems.push(`setHandoffTarget is referenced in ${ref.owner ?? 'the top level'} without being called (an alias: round the rule)`);
    } else if (ref.callArgs[0] === 'null') {
      if (ref.owner !== 'closeHandoffBy') problems.push(`setHandoffTarget(null) in ${ref.owner ?? 'the top level'}, not closeHandoffBy`);
      else if (!ref.ownerText.includes('closeHandoffOpening(')) problems.push('closeHandoffBy does not ask the rule (closeHandoffOpening)');
    } else if (ref.owner !== 'openHandoff') {
      problems.push(`setHandoffTarget(${ref.callArgs[0]}) in ${ref.owner ?? 'the top level'}, not openHandoff`);
    }
  }
  if (sites.filter((site) => site.callee === 'setHandoffTarget' && site.args[0] === 'null').length !== 1) problems.push('setHandoffTarget(null) must appear once, in closeHandoffBy');
  for (const site of sites.filter((call) => call.callee === 'openHandoff')) {
    if (!site.before.includes("closeHandoffBy('page-end')")) problems.push(`openHandoff in ${site.owner} without closeHandoffBy('page-end') first`);
  }
  for (const ref of references(source, 'hook.ts', new Set<string>([...CLEARS, ...OLD_COPY]))) {
    problems.push(`${ref.name} in the hook (${ref.owner ?? 'the top level'}): the page clears no unit`);
  }
  const sf = ts.createSourceFile('hook.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(sf) === 'handoffTargetRef.current') {
      const { owner } = callSitesOwner(node, sf);
      if (owner !== 'closeHandoffBy' && owner !== 'openHandoff') problems.push(`handoffTargetRef.current written in ${owner ?? 'the top level'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

/** The functions of the store that may write the decide's units (`pending`, `inflight`). */
const UNIT_WRITERS = new Set(['startHandoffDecide', 'settleHandoffDecide', 'dropHandoffUnit']);

/** The problems found in the store (`@/lib/handoff/close-rule`). */
function checkStore(source: string): string[] {
  const problems: string[] = [];
  const sf = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const written =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ['pending', 'inflight'].includes(node.name.getText(sf))
        ? node.name.getText(sf)
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.(pending|inflight)$/.test(node.left.getText(sf))
          ? node.left.getText(sf)
          : null;
    if (written) {
      let fn: ts.Node | undefined = node.parent;
      while (fn && !ts.isFunctionDeclaration(fn) && !ts.isVariableDeclaration(fn)) fn = fn.parent;
      const name = fn && (ts.isFunctionDeclaration(fn) || ts.isVariableDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name) ? fn.name.text : null;
      if (name !== 'NO_UNITS' && (name === null || !UNIT_WRITERS.has(name))) problems.push(`the store writes ${written} in ${name ?? 'the top level'}: only ${[...UNIT_WRITERS].join(', ')} may`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const resets = [...source.matchAll(/commit\(EMPTY\)/g)].length;
  if (resets !== 1 || !/export function resetHandoffStoreForTests\(\): void \{\s*commit\(EMPTY\);/.test(source)) problems.push('the store is emptied outside resetHandoffStoreForTests');
  return problems;
}

/** Every `.ts` / `.tsx` file under `src/`. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((entry) => {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) return sourcesUnder(rel);
    return /\.tsx?$/.test(entry) ? [rel] : [];
  });
}

/** No source but the dialog and the store references a clear (pr2e). */
function checkOthers(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    if (file === DIALOG || file === STORE) continue;
    if (!/\b(?:dropHandoffUnit|settleHandoffDecide|endHandoffStop|endHandoffCancel|resetHandoffStoreForTests)\b/.test(source)) continue;
    for (const ref of references(source, file, new Set<string>(CLEARS))) problems.push(`${ref.name} in ${file} (${ref.owner ?? 'the top level'}): only the dialog clears a unit`);
  }
  return problems;
}

/** `specifier` (in `file`) names the store: `@/lib/handoff/close-rule` or a relative path to it. */
function namesStore(file: string, specifier: string): boolean {
  const target = STORE.replace(/\.ts$/, '');
  let resolved: string | null = null;
  if (specifier.startsWith('@/')) resolved = path.posix.join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.split(path.sep).join('/')), specifier));
  if (resolved === null) return false;
  resolved = resolved.replace(/\.(?:ts|tsx|js)$/, '').replace(/\/index$/, '');
  return resolved === target;
}

/** pr2f: the ways of reaching the store's functions under another name, in `src/` (empty: none). */
function checkImportForms(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    if (!/close-rule/.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && namesStore(file, node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (node.importClause?.name) problems.push(`${file}: a default import of the store (${node.importClause.name.text})`);
        if (bindings && ts.isNamespaceImport(bindings)) problems.push(`${file}: a namespace import of the store (* as ${bindings.name.text})`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (element.propertyName) problems.push(`${file}: ${element.propertyName.text} imported as ${element.name.text}`);
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && namesStore(file, node.moduleSpecifier.text)) {
        const clause = node.exportClause;
        if (!clause) problems.push(`${file}: export * from the store`);
        else if (ts.isNamespaceExport(clause)) problems.push(`${file}: export * as ${clause.name.text} from the store`);
        else for (const element of clause.elements) if (element.propertyName) problems.push(`${file}: ${element.propertyName.text} re-exported as ${element.name.text}`);
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]) && namesStore(file, node.arguments[0].text)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push(`${file}: a dynamic import() of the store`);
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require') problems.push(`${file}: a require() of the store`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return problems;
}

/**
 * pr2f: the store's exported functions that write it, and the type of the first parameter each
 * must take (`null`: none, it starts something; `string`: a flag's worktree id).
 */
const STORE_WRITERS: Record<string, string | null> = {
  startHandoffDecide: 'HandoffDecideUnit',
  settleHandoffDecide: 'SentHandoffDecide',
  dropHandoffUnit: 'SentHandoffDecide',
  startHandoffStop: 'string',
  endHandoffStop: 'string',
  startHandoffCancel: 'string',
  endHandoffCancel: 'string',
  beginHandoffOpening: 'string',
  patchHandoffOpening: 'HandoffOpeningToken',
  noteHandoffHidden: 'HandoffOpeningToken',
  closeHandoffOpening: 'HandoffOpeningToken',
  resetHandoffStoreForTests: null,
};

function checkStoreSignatures(source: string): string[] {
  const problems: string[] = [];
  const sf = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name.text;
    const writes = /\b(?:commit|markClosed|writeFlags)\(/.test(statement.body.getText(sf));
    if (!(name in STORE_WRITERS)) {
      if (writes) problems.push(`${name} writes the store but is not one of its writers (a settle, close or patch without its sending / opening)`);
      continue;
    }
    const expected = STORE_WRITERS[name];
    const first = statement.parameters[0]?.type?.getText(sf) ?? null;
    if (first !== expected) problems.push(`${name} takes ${first ?? 'nothing'} first, not ${expected ?? 'nothing'}`);
  }
  return problems;
}

/** pr2f: no source but the store makes a sending or an opening's identity (a cast to the brand). */
function checkBrandCasts(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  return files
    .filter(({ file, source }) => file !== STORE && /\bas\s+(?:SentHandoffDecide|HandoffOpeningToken)\b|<(?:SentHandoffDecide|HandoffOpeningToken)>/.test(source))
    .map(({ file }) => `${file} casts to SentHandoffDecide / HandoffOpeningToken (only the store makes them)`);
}

/** The path names used at the call sites of the two sources. */
function usedPaths(...sources: string[]): Set<string> {
  const used = new Set<string>();
  for (const source of sources) {
    // pr2f: `closeBy(of, 'person')` — the opening named first.
    for (const match of source.matchAll(/\b(?:closeBy|closeHandoffBy|askHandoffClose|closeHandoffOpening)\((?:[\w.]+,\s*)?'([a-z-]+)'/g)) used.add(match[1]);
  }
  return used;
}

function checkPaths(dialog: string, hook: string): string[] {
  const used = usedPaths(dialog, hook);
  const declared = new Set<string>(HANDOFF_CLOSE_PATHS);
  return [
    ...[...declared].filter((name) => !used.has(name)).map((name) => `path '${name}' is declared but no call site names it`),
    ...[...used].filter((name) => !declared.has(name)).map((name) => `path '${name}' is used but not declared in HANDOFF_CLOSE_PATHS`),
  ];
}

describe('[#4227 pr2d] every path that closes the hand-off asks the one rule', () => {
  it('the dialog: onClose only from closeBy (which asks the rule); the unit cleared only by the person’s choice', () => {
    expect(checkDialog(read(DIALOG))).toEqual([]);
  });

  it('pr2e: the store writes the decide’s units in its three functions only; no other source clears a unit', () => {
    expect(checkStore(read(STORE))).toEqual([]);
    expect(checkOthers(sourcesUnder('src').map((file) => ({ file, source: read(file) })))).toEqual([]);
  });

  it('the page: the target cleared only in closeHandoffBy (which asks the rule), set only in openHandoff after it', () => {
    expect(checkHook(read(HOOK))).toEqual([]);
  });

  it('pr2f: the store is imported by name only; its settle, drop, close, hide and patch take their sending / opening', () => {
    const sources = sourcesUnder('src').map((file) => ({ file, source: read(file) }));
    expect(checkImportForms(sources)).toEqual([]);
    expect(checkStoreSignatures(read(STORE))).toEqual([]);
    expect(checkBrandCasts(sources)).toEqual([]);
  });

  it('the paths named at the call sites are exactly HANDOFF_CLOSE_PATHS', () => {
    expect(checkPaths(read(DIALOG), read(HOOK))).toEqual([]);
  });

  it('the pages hand the dialog the hook’s closeHandoff', () => {
    const desktop = read(PAGES[0]);
    const refactored = read(PAGES[1]);
    expect(desktop).toMatch(/<SessionHandoffDialog[\s\S]*?onClose=\{onHandoffClose\}/);
    expect(refactored).toMatch(/onHandoffClose=\{closeHandoff\}/);
    expect(refactored).toMatch(/<SessionHandoffDialog[\s\S]*?onClose=\{closeHandoff\}/);
    expect(read(HOOK)).toMatch(/const closeHandoff = useCallback\(\(\): void => \{\s*closeHandoffBy\('dialog'\);/);
  });
});

describe('[#4227 pr2d] (positive controls) a way round the rule fails the guard', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  /** Writes a mutated copy under `os.tmpdir()` and reads it back (the repository is not touched). */
  const mutated = (file: string, from: string | RegExp, to: string): string => {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), 'handoff-close-paths-'));
    const source = read(file);
    const next = source.replace(from, to);
    expect(next).not.toBe(source);
    const copy = path.join(dir, path.basename(file));
    writeFileSync(copy, next);
    return readFileSync(copy, 'utf8');
  };

  it('(negative control) unmutated copies pass', () => {
    const dialog = mutated(DIALOG, 'data-testid="handoff-dialog"', 'data-testid="handoff-dialog" ');
    const hook = mutated(HOOK, 'const closeHandoffBy =', 'const closeHandoffBy  =');
    expect(checkDialog(dialog)).toEqual([]);
    expect(checkHook(hook)).toEqual([]);
    expect(checkPaths(dialog, hook)).toEqual([]);
    expect(checkStore(mutated(STORE, 'function markClosed(token: HandoffOpeningToken): void {', 'function markClosed(token: HandoffOpeningToken): void  {'))).toEqual([]);
  });

  it('a worktree switch that clears the target directly (the code before pr2d) fails', () => {
    const hook = mutated(HOOK, "closeHandoffBy('worktree-switch');", 'setHandoffTarget(null);');
    expect(checkHook(hook).join('\n')).toMatch(/setHandoffTarget\(null\) in/);
    expect(checkPaths(read(DIALOG), hook).join('\n')).toMatch(/'worktree-switch' is declared but no call site/);
  });

  it('opening the hand-off without asking first (the attended side before pr2d) fails', () => {
    const hook = mutated(HOOK, /if \(!closeHandoffBy\('page-end'\)\) return;\n(\s*)setKillTarget\(null\);/, 'setKillTarget(null);');
    expect(checkHook(hook).join('\n')).toMatch(/openHandoff in openEnd without closeHandoffBy/);
  });

  it('a button that calls onClose directly, or onClose handed on as a prop, fails', () => {
    const direct = mutated(DIALOG, "onClick={() => void requestClose('close')} data-testid=\"handoff-close\"", 'onClick={() => onClose()} data-testid="handoff-close"');
    expect(checkDialog(direct).join('\n')).toMatch(/onClose is called 2 times/);
    const prop = mutated(DIALOG, "onClose={() => void requestClose(foreign ? 'close' : 'cancel')}", 'onClose={onClose}');
    expect(checkDialog(prop).join('\n')).toMatch(/handed on as a prop/);
  });

  it('a plain stop that closes without the rule (the code before pr2d) fails', () => {
    const dialog = mutated(DIALOG, "if (closeBy(of, 'plain-stop-done') === 'refused') patchHandoffOpening(of, { plainStopped: true });", 'onClose();');
    expect(checkDialog(dialog).join('\n')).toMatch(/onClose called in plainStop/);
  });

  it('an opening that clears the unit (the code before pr2c / pr2d) fails', () => {
    // pr2e: the units are the store's; the opening's own clear of them is what the guard sees.
    const dialog = mutated(DIALOG, 'current = beginHandoffOpening(worktreeId, target);', 'current = beginHandoffOpening(worktreeId, target);\n      dropHandoffUnit(worktreeId);');
    const problems = checkDialog(dialog).join('\n');
    expect(problems).toMatch(/dropHandoffUnit in SessionHandoffDialog: not where it is allowed/);
    expect(problems).toMatch(/dropHandoffUnit must appear once/);
  });

  it('a path named at a call site but not declared fails', () => {
    const hook = mutated(HOOK, "closeHandoffBy('worktree-switch');", "closeHandoffBy('route-change');");
    expect(checkPaths(read(DIALOG), hook).join('\n')).toMatch(/'route-change' is used but not declared/);
  });

  // pr2e (PM Claude pr2d P3-1, codex review-4227-pr2c P2-3): aliases and direct setters.
  it('pr2e G1: an alias of onClose that closes after the plain stop without the rule fails', () => {
    const dialog = mutated(
      DIALOG,
      "if (closeBy(of, 'plain-stop-done') === 'refused') patchHandoffOpening(of, { plainStopped: true });",
      "const closeNow = onClose;\n    if (closeBy(of, 'plain-stop-done') === 'refused') closeNow();"
    );
    expect(checkDialog(dialog).join('\n')).toMatch(/onClose is referenced in closeNow without being called/);
  });

  it('pr2e G2: a reopening that clears the unit with the old setter, or by a direct write, fails', () => {
    const setter = mutated(DIALOG, 'current = beginHandoffOpening(worktreeId, target);', 'current = beginHandoffOpening(worktreeId, target);\n      pendingRef.current = null;\n      setPending(null);');
    const problems = checkDialog(setter).join('\n');
    expect(problems).toMatch(/pendingRef in SessionHandoffDialog: the units are the store's/);
    expect(problems).toMatch(/setPending in SessionHandoffDialog/);
    const direct = mutated(DIALOG, 'current = beginHandoffOpening(worktreeId, target);', 'current = beginHandoffOpening(worktreeId, target);\n      (units as { pending: unknown }).pending = null;');
    expect(checkDialog(direct).join('\n')).toMatch(/a unit is written directly/);
  });

  it('pr2e: an alias of the drop used elsewhere, or a clear from the hook, fails', () => {
    const alias = mutated(DIALOG, 'current = beginHandoffOpening(worktreeId, target);', 'current = beginHandoffOpening(worktreeId, target);\n      const forget = dropHandoffUnit;\n      forget(worktreeId);');
    expect(checkDialog(alias).join('\n')).toMatch(/dropHandoffUnit in forget: an alias or a value/);
    const settle = mutated(DIALOG, 'endHandoffStop(forWorktree);\n    }\n    // pr2f', "endHandoffStop(forWorktree);\n      settleHandoffDecide(forWorktree, 'answered');\n    }\n    // pr2f");
    expect(checkDialog(settle).join('\n')).toMatch(/settleHandoffDecide in plainStop: not where it is allowed/);
    const hook = mutated(HOOK, "closeHandoffBy('worktree-switch');", "closeHandoffBy('worktree-switch');\n    dropHandoffUnit(worktreeId);");
    expect(checkHook(hook).join('\n')).toMatch(/dropHandoffUnit in the hook/);
  });

  it('pr2e G3: an alias of setHandoffTarget on the switch of worktree fails (its path named in a comment)', () => {
    const hook = mutated(HOOK, "closeHandoffBy('worktree-switch');", "// closeHandoffBy('worktree-switch')\n    const clearTarget = setHandoffTarget;\n    clearTarget(null);");
    expect(checkHook(hook).join('\n')).toMatch(/setHandoffTarget is referenced in clearTarget without being called/);
  });

  it('pr2e: the store writing the pending unit outside its three functions, or emptied elsewhere, fails', () => {
    const write = mutated(
      STORE,
      '/** Starts the stop: refused while one runs or a cancel waits. */',
      'export function forgetHandoffUnits(worktreeId: string): void {\n  commit({ ...state, units: { ...state.units, [worktreeId]: { ...handoffUnitsOf(worktreeId), pending: null } } });\n}\n\n/** Starts the stop: refused while one runs or a cancel waits. */'
    );
    expect(checkStore(write).join('\n')).toMatch(/the store writes pending in forgetHandoffUnits/);
    const empty = mutated(STORE, 'function markClosed(token: HandoffOpeningToken): void {', 'export function forgetAll(): void {\n  commit(EMPTY);\n}\n\nfunction markClosed(token: HandoffOpeningToken): void {');
    expect(checkStore(empty).join('\n')).toMatch(/emptied outside resetHandoffStoreForTests/);
  });

  it('pr2e: another source of src/ that clears a unit fails', () => {
    const panel = mutated('src/components/mem/MemItemsPanel.tsx', /^/, "import { dropHandoffUnit } from '@/lib/handoff/close-rule';\nexport const forget = (id: string) => dropHandoffUnit(id);\n");
    expect(checkOthers([{ file: 'src/components/mem/MemItemsPanel.tsx', source: panel }]).join('\n')).toMatch(/dropHandoffUnit in src\/components\/mem\/MemItemsPanel.tsx/);
  });

  // pr2f (codex review-4227-pr2d P2-3): another file clearing a unit under an alias or a namespace.
  it('pr2f: another file of src/ that reaches a clear through an import alias or a namespace fails', () => {
    const file = 'src/components/mem/MemItemsPanel.tsx';
    const alias = mutated(file, /^/, "import { dropHandoffUnit as forget } from '@/lib/handoff/close-rule';\nexport const drop = (u: Parameters<typeof forget>[0]) => forget(u);\n");
    expect(checkImportForms([{ file, source: alias }]).join('\n')).toMatch(/dropHandoffUnit imported as forget/);
    // The guard of pr2e did not see it: the alias is not the clear's name.
    expect(checkOthers([{ file, source: alias }])).toEqual([]);
    const namespace = mutated(file, /^/, "import * as rule from '../../lib/handoff/close-rule';\nexport const drop = (u: never) => rule.dropHandoffUnit(u);\n");
    expect(checkImportForms([{ file, source: namespace }]).join('\n')).toMatch(/namespace import of the store \(\* as rule\)/);
    expect(checkOthers([{ file, source: namespace }])).toEqual([]);
    const reexport = mutated(file, /^/, "export { settleHandoffDecide as settle } from '@/lib/handoff/close-rule';\nexport * as everything from '@/lib/handoff/close-rule';\n");
    const problems = checkImportForms([{ file, source: reexport }]).join('\n');
    expect(problems).toMatch(/settleHandoffDecide re-exported as settle/);
    expect(problems).toMatch(/export \* as everything/);
    const dynamic = mutated(file, /^/, "export const later = () => import('@/lib/handoff/close-rule').then((m) => m.dropHandoffUnit);\n");
    expect(checkImportForms([{ file, source: dynamic }]).join('\n')).toMatch(/dynamic import\(\) of the store/);
    const local = mutated('src/lib/handoff/screen-client.ts', /^/, "import * as rule from './close-rule';\n");
    expect(checkImportForms([{ file: 'src/lib/handoff/screen-client.ts', source: local }]).join('\n')).toMatch(/namespace import/);
  });

  it('pr2f (negative control) a named import, a type import and a plain re-export of the store pass', () => {
    const file = 'src/components/mem/MemItemsPanel.tsx';
    const named = mutated(
      file,
      /^/,
      "import { handoffUnitsLock, type HandoffHold } from '@/lib/handoff/close-rule';\nexport { handoffCloseBlock } from '@/lib/handoff/close-rule';\nimport * as other from '@/lib/handoff/types';\n"
    );
    expect(checkImportForms([{ file, source: named }])).toEqual([]);
  });

  it('pr2f: a store function that closes, settles or patches without its opening / sending fails', () => {
    const tokenless = mutated(
      STORE,
      '/** Tests only: the store as at load. */',
      "export function closeCurrentHandoff(path: HandoffClosePath): void {\n  if (askHandoffClose(path) === null && state.opening) markClosed(state.opening.token);\n}\n\n/** Tests only: the store as at load. */"
    );
    expect(checkStoreSignatures(tokenless).join('\n')).toMatch(/closeCurrentHandoff writes the store but is not one of its writers/);
    const byWorktree = mutated(STORE, 'export function settleHandoffDecide(sending: SentHandoffDecide,', 'export function settleHandoffDecide(sending: string,');
    expect(checkStoreSignatures(byWorktree).join('\n')).toMatch(/settleHandoffDecide takes string first, not SentHandoffDecide/);
    const cast = mutated(DIALOG, 'const of = token;', 'const of = {} as HandoffOpeningToken;');
    expect(checkBrandCasts([{ file: DIALOG, source: cast }]).join('\n')).toMatch(/casts to/);
    expect(checkStoreSignatures(mutated(STORE, 'function markClosed(', 'function  markClosed('))).toEqual([]);
  });
});
