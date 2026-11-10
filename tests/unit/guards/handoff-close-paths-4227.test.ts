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
 * 7. pr2g (codex review-4227-pr2e P2, PM Claude pr2f P3-3, the PM's decision (a) in
 *    `pm-return-4227-pr2f-codex.md`): the store's writers (`STORE_WRITERS`) are handed on nowhere in
 *    `src/` — no re-export (same name or aliased, of the store's or a bridge's, `export { x }` of an
 *    import), no `export default`, no import of one under an alias from any module (a bridge's
 *    user), no reference but a call — and `import()` / `require()` take a plain string (a template
 *    with a substitution or a computed specifier fails, but for a fixed head the store is not under).
 * 8. pr2h (the PM's decision in `pm-return-4227-pr2g.md`: pass the allowed form only, not list the
 *    forbidden ones — the gaps of pr2f, pr2g and their reviews were of one kind). The invariant: in
 *    every `.ts` / `.tsx` file of `src/`, a value of the store's writers (`STORE_WRITERS`) is reached
 *    only by a static import with a string literal, from a file of `STORE_IMPORTERS`, of the writer
 *    under its own name, which is then only called. Every file is parsed (no filter of its raw
 *    text); a specifier is judged by where the compiler resolves it (`@/`, relative, escapes); no
 *    other file takes a value from the store at all; a loader (`import()`, `require()`, a
 *    `createRequire` result) takes a string only — the one exception is `src/i18n.ts`'s
 *    `../locales/${identifier}/<name>.json` — and `require` is never taken as a value. Type-only
 *    imports / exports and `typeof` pass.
 * 9. pr2i (the PM's decision in `pm-return-4227-pr2h.md`: the guard's last form — names and places
 *    fixed by tables, the meaning not followed). The store's export surface is `STORE_EXPORTS` (each
 *    value and whether it writes; declarations only, no `export { … }` / default; in the store a
 *    writer is called by a writer of the table only, never held as a value); the store's values are
 *    re-exported per `STORE_REEXPORTS` only (the dialog's `handoffCloseBlock`); a value of `module` /
 *    `node:module` is taken in `NODE_MODULE_IMPORTERS` only (qr-terminal.ts's
 *    `import { createRequire } from 'node:module'`); a writer is referenced as a call's callee only
 *    (a list of dependencies, an argument, a JSX attribute fail — no exception by a callee's name);
 *    a reader is a file that takes a value (type-only imports are no readers).
 * 10. pr2j (the PM's return `pm-return-4227-pr2i.md`): in the store a writer's name is its
 *    declaration only (no call of one in another writer: a function in a writer's body that calls
 *    one can be handed out); every table is read by its own names (`Object.hasOwn`, or a `Set`), not
 *    `in` (an export named `toString`); `node:module` is judged per specifier's `type`, by the same
 *    function as the store (`import { type Module }` / `export { type Module } from` pass).
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

/** pr2h: each source is parsed once (every file of `src/` is read by several checks). */
const parsed = new Map<string, ts.SourceFile>();
function parse(file: string, source: string): ts.SourceFile {
  const key = `${file}\0${source}`;
  let sf = parsed.get(key);
  if (!sf) {
    sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(key, sf);
  }
  return sf;
}

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
  const sf = parse(fileName, source);
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
function references(source: string, fileName: string, names: ReadonlySet<string>, dependencyLists: 'exempt' | 'count' = 'exempt'): Reference[] {
  const sf = parse(fileName, source);
  const found: Reference[] = [];
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return true;
    if (ts.isJsxAttribute(parent) && parent.name === node) return true;
    // pr2h (PM Claude pr2g P3-4): a type's position (`typeof x`) hands nothing on at run time.
    if (inTypePosition(node)) return true;
    // A hook's list of dependencies names it without using it (`onClose`, `setHandoffTarget`).
    // pr2i (codex review-4227-pr2g P2-2): not for the store's writers — the exception goes by a
    // callee's name (`useMemo`), and a list is a value handed to a function like any argument.
    if (dependencyLists === 'exempt' && ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent) && /^use(?:Callback|Effect|Memo)$/.test(parent.parent.expression.getText(sf))) return true;
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

/** pr2h: `node` is inside a type (`typeof x`, a type's annotation): nothing of it runs. */
function inTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) return false;
    if (ts.isTypeQueryNode(current) || ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
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
    // pr2h: no filter of the raw text first (an escape in an identifier, codex pr2f P2 (2)).
    for (const ref of references(source, file, new Set<string>(CLEARS))) problems.push(`${ref.name} in ${file} (${ref.owner ?? 'the top level'}): only the dialog clears a unit`);
  }
  return problems;
}

const posix = (file: string): string => file.split(path.sep).join('/');

/**
 * pr2h: the compiler's own options (`paths` of `@/*`), so a specifier is judged by where the
 * compiler takes it — `@/`, a relative path, an escape (`'@/lib/handoff/close-rule'`), an
 * extension (`.js`) or a `..` that comes back — not by how it is spelt.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const { config } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(config.compilerOptions, ROOT);
  return { ...options, baseUrl: options.baseUrl ?? ROOT };
})();

/**
 * `specifier` (in `file`) names the store. pr2h (PM Claude pr2g P3-1, codex pr2f P2 (2)): the
 * parsed value of the specifier (escapes undone), resolved by the compiler's module resolution;
 * for a copy whose directory is not there, the same path normalised by hand.
 */
const resolvedSpecifiers = new Map<string, boolean>();
function namesStore(file: string, specifier: string): boolean {
  const key = `${path.posix.dirname(posix(file))}\0${specifier}`;
  const known = resolvedSpecifiers.get(key);
  if (known !== undefined) return known;
  const answer = resolvesToStore(file, specifier);
  resolvedSpecifiers.set(key, answer);
  return answer;
}

function resolvesToStore(file: string, specifier: string): boolean {
  const store = path.join(ROOT, STORE);
  const resolved = ts.resolveModuleName(specifier, path.join(ROOT, file), COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved && path.resolve(resolved) === store) return true;
  const target = STORE.replace(/\.ts$/, '');
  let normal: string | null = null;
  if (specifier.startsWith('@/')) normal = path.posix.normalize(path.posix.join('src', specifier.slice(2)));
  else if (specifier.startsWith('.')) normal = path.posix.normalize(path.posix.join(path.posix.dirname(posix(file)), specifier));
  if (normal === null) return false;
  normal = normal.replace(/\/+$/, '').replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '').replace(/\/index$/, '');
  return normal === target;
}

/** pr2h: the one file whose loader may take a template (the locales of next-intl). */
const I18N = 'src/i18n.ts';

/**
 * pr2h (codex pr2f P2 (1), PM Claude pr2g P3-2): the one form of a template a loader may take —
 * the real one of `src/i18n.ts`, `../locales/${identifier}/<a fixed name>.json`: in that file only,
 * one substitution that is an identifier, and after it a fixed part without `..` or another `/`.
 * The substitution's value is not known here, so the exception is this form, not "a directory
 * the store is not under".
 */
function isLocalesTemplate(file: string, arg: ts.Expression): boolean {
  if (posix(file) !== I18N || !ts.isTemplateExpression(arg)) return false;
  if (arg.head.text !== '../locales/' || arg.templateSpans.length !== 1) return false;
  const [span] = arg.templateSpans;
  return ts.isIdentifier(span.expression) && /^\/[A-Za-z0-9_-]+\.json$/.test(span.literal.text);
}

/**
 * pr2g, pr2h: a loader's (`import()` / `require()`) specifier is a string — a literal, or a
 * template without a substitution (read as a string) — or the locales' one form. Anything else
 * (a template with a substitution, a concatenation, a variable) may name the store unseen.
 */
function computedSpecifierProblem(file: string, arg: ts.Expression, sf: ts.SourceFile): string | null {
  if (ts.isStringLiteral(arg)) return null;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return namesStore(file, arg.text) ? 'names the store' : null;
  if (isLocalesTemplate(file, arg)) return null;
  if (ts.isTemplateExpression(arg)) return `a template specifier (${arg.getText(sf)})`;
  return `a computed specifier (${arg.getText(sf)})`;
}


/**
 * pr2f, pr2h: the ways of reaching the store's functions under another name, in `src/` (empty:
 * none). Every file is parsed (pr2h: no filter of the raw text first); a type-only import or
 * export hands nothing on and passes (PM Claude pr2g P3-4).
 */
function checkImportForms(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    const sf = parse(file, source);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && namesStore(file, node.moduleSpecifier.text) && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (node.importClause?.name) problems.push(`${file}: a default import of the store (${node.importClause.name.text})`);
        if (bindings && ts.isNamespaceImport(bindings)) problems.push(`${file}: a namespace import of the store (* as ${bindings.name.text})`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (element.propertyName && !element.isTypeOnly) problems.push(`${file}: ${element.propertyName.text} imported as ${element.name.text}`);
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && namesStore(file, node.moduleSpecifier.text) && !node.isTypeOnly) {
        const clause = node.exportClause;
        if (!clause) problems.push(`${file}: export * from the store`);
        else if (ts.isNamespaceExport(clause)) problems.push(`${file}: export * as ${clause.name.text} from the store`);
        else for (const element of clause.elements) if (element.propertyName && !element.isTypeOnly) problems.push(`${file}: ${element.propertyName.text} re-exported as ${element.name.text}`);
      }
      // pr2h: `import x = require('…')` (tsc refuses it under `module: esnext`; the guard does not lean on that).
      if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const spec = node.moduleReference.expression;
        if (!ts.isStringLiteral(spec)) problems.push(`${file}: import = require() with a computed specifier`);
        else if (namesStore(file, spec.text)) problems.push(`${file}: import = require() of the store`);
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]) && namesStore(file, node.arguments[0].text)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push(`${file}: a dynamic import() of the store`);
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require') problems.push(`${file}: a require() of the store`);
      }
      // pr2g: import() / require() with a template or a computed specifier.
      const loader = ts.isCallExpression(node)
        ? node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? 'import()'
          : ts.isIdentifier(node.expression) && node.expression.text === 'require'
            ? 'require()'
            : null
        : null;
      if (loader && ts.isCallExpression(node)) {
        const problem = node.arguments.length === 0 ? 'no specifier' : computedSpecifierProblem(file, node.arguments[0], sf);
        // The locales' template is `import()`'s only (pr2h).
        if (problem) problems.push(`${file}: ${loader} with ${problem}`);
        else if (loader === 'require()' && !ts.isStringLiteral(node.arguments[0]) && !ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) problems.push(`${file}: require() with a template specifier`);
      }
      // pr2h (PM Claude pr2g P3-2): `require` is called, never taken as a value (`const r = require; r(…)`).
      if (ts.isIdentifier(node) && node.text === 'require' && !isPropertyName(node) && !inTypePosition(node)) {
        const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!called) problems.push(`${file}: require referenced without being called (a loader under another name)`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return problems;
}

/** `node` is a property's name (`x.require`, `{ require: … }`), not a reference. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  return (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
}

/**
 * pr2h (the PM's decision in `pm-return-4227-pr2g.md`, PM Claude pr2g P3-3): the files that may
 * take a value from the store — the dialog and the page's hook. Fixed here: a new reader (a wrapper
 * of a writer, a bridge, an alias) fails until it is named. pr2i (PM Claude pr2h P3-1, codex
 * review-4227-pr2g P2-3): a reader is a file that takes a value; the PC page
 * (`WorktreeDetailDesktop.tsx`) takes a type only (`import type { SessionStopResult }`), so it is
 * not one, and a value import there fails.
 */
const STORE_IMPORTERS: ReadonlySet<string> = new Set([DIALOG, HOOK]);

/**
 * pr2h: the invariant's first half. In `src/` but the store and {@link STORE_IMPORTERS}, nothing
 * of the store is taken as a value — no import (named, default, namespace, side effect), no
 * re-export — whatever the specifier's spelling (it is resolved). Type-only imports and exports
 * (`import type`, `{ type X }`, `export type`) pass: they hand nothing on at run time.
 */
function checkStoreImporters(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    const rel = posix(file);
    if (rel === STORE || STORE_IMPORTERS.has(rel)) continue;
    const sf = parse(file, source);
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && namesStore(file, statement.moduleSpecifier.text)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        const values = !clause
          ? ['(its evaluation)']
          : [
              ...(clause.name ? [clause.name.text] : []),
              ...(bindings && ts.isNamespaceImport(bindings) ? [`* as ${bindings.name.text}`] : []),
              ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : []),
            ];
        for (const value of values) problems.push(`${rel}: imports ${value} from the store (only ${[...STORE_IMPORTERS].join(', ')} may)`);
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && namesStore(file, statement.moduleSpecifier.text) && !statement.isTypeOnly) {
        const clause = statement.exportClause;
        const values = !clause ? ['*'] : ts.isNamespaceExport(clause) ? [`* as ${clause.name.text}`] : clause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
        for (const value of values) problems.push(`${rel}: re-exports ${value} from the store (only ${[...STORE_IMPORTERS].join(', ')} may take its values)`);
      }
    }
  }
  return problems;
}

/**
 * pr2h: `createRequire` makes a loader under another name. It is referenced only as
 * `const x = createRequire(…)`, and `x` only called with a string that is not the store.
 */
function checkCreatedRequires(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    const sf = parse(file, source);
    const loaders = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'createRequire' && !isPropertyName(node) && !ts.isImportSpecifier(node.parent)) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
        const declaration = call && ts.isVariableDeclaration(call.parent) && call.parent.initializer === call && ts.isIdentifier(call.parent.name) ? call.parent : null;
        if (declaration) loaders.add((declaration.name as ts.Identifier).text);
        else problems.push(`${file}: createRequire used but as \`const x = createRequire(…)\``);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (loaders.size === 0) continue;
    const uses = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && loaders.has(node.text) && !isPropertyName(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
        const arg = call?.arguments[0];
        if (!call || !arg) problems.push(`${file}: the loader ${node.text} referenced without being called`);
        else if (!ts.isStringLiteral(arg)) problems.push(`${file}: the loader ${node.text} with a computed specifier (${arg.getText(sf)})`);
        else if (namesStore(file, arg.text)) problems.push(`${file}: the loader ${node.text} loads the store`);
      }
      ts.forEachChild(node, uses);
    };
    uses(sf);
  }
  return problems;
}

/**
 * pr2j (codex review-4227-pr2h P2-1): a table's own entry — never one inherited from
 * `Object.prototype` (`toString`, `constructor`): `name in TABLE` / `TABLE[name]` would count it.
 * Every table of this guard is read through this (or is a `Set`).
 */
function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * pr2i, pr2j (codex review-4227-pr2h P2-2): the statement takes a value from a module that
 * `matches` names — an import (no clause, a default, a namespace, a named specifier that is not
 * `type`) or a re-export (`*`, `* as`, a named specifier that is not `type`). Type-only ones (the
 * declaration's `type` or each specifier's) do not. One rule for the store and for `node:module`.
 */
function takesValueOf(statement: ts.Node, matches: (specifier: string) => boolean): boolean {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && matches(statement.moduleSpecifier.text)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    const bindings = clause.namedBindings;
    return !!clause.name || (bindings !== undefined && (ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly)));
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && matches(statement.moduleSpecifier.text) && !statement.isTypeOnly) {
    const clause = statement.exportClause;
    return !clause || ts.isNamespaceExport(clause) || clause.elements.some((e) => !e.isTypeOnly);
  }
  return false;
}

/** pr2i: `module` / `node:module` (where `createRequire` comes from), by the parsed specifier. */
const NODE_MODULE = new Set(['module', 'node:module']);
const isNodeModule = (specifier: string): boolean => NODE_MODULE.has(specifier);

/**
 * pr2i (the PM's decision in `pm-return-4227-pr2h.md` 3, PM Claude pr2h P2-2, codex
 * review-4227-pr2g P2-1): the one file that may take a value from `module` / `node:module` — the
 * real one today (`src/cli/utils/qr-terminal.ts`), with the one form it uses
 * (`import { createRequire } from 'node:module'`, no alias). The guard does not follow what the
 * loader is made from (its base, its arguments): a loader is made in this file only.
 */
const NODE_MODULE_IMPORTERS: Readonly<Record<string, string>> = { 'src/cli/utils/qr-terminal.ts': "import { createRequire } from 'node:module'" };

/**
 * pr2i: in `src/`, a value of `module` / `node:module` is taken in {@link NODE_MODULE_IMPORTERS}
 * only, in its one form. Elsewhere any value import (named, aliased, default, namespace, side
 * effect), a re-export, `import x = require(…)`, `require(…)` or `import(…)` of it fails, whatever
 * it names. Type-only imports pass.
 */
function checkNodeModuleImports(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    const rel = posix(file);
    const allowed = own(NODE_MODULE_IMPORTERS, rel);
    const sf = parse(file, source);
    const visit = (node: ts.Node): void => {
      // pr2j: a value is taken per specifier (`import { type Module }` takes none), as for the store.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && takesValueOf(node, isNodeModule)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const values = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((e) => !e.isTypeOnly) : [];
        const theOneForm =
          clause !== undefined &&
          !clause.name &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          values.length === 1 &&
          values[0].name.text === 'createRequire' &&
          !values[0].propertyName &&
          node.moduleSpecifier.text === 'node:module';
        if (!(allowed && theOneForm)) {
          problems.push(`${rel}: a value import of ${node.moduleSpecifier.text} (${node.getText(sf)}) — only ${Object.entries(NODE_MODULE_IMPORTERS).map(([f, form]) => `${f} (${form})`).join(', ')} may`);
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && takesValueOf(node, isNodeModule)) {
        problems.push(`${rel}: re-exports from ${node.moduleSpecifier.text}`);
      }
      if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression) && NODE_MODULE.has(node.moduleReference.expression.text)) {
        problems.push(`${rel}: import = require() of ${node.moduleReference.expression.text}`);
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0 && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) && NODE_MODULE.has(node.arguments[0].text)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) problems.push(`${rel}: loads ${node.arguments[0].text} (${node.getText(sf)})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return problems;
}

/** pr2i: the files that take a value from `module` / `node:module` (for the table's equality). */
function nodeModuleImporters(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  return files
    .filter(({ file, source }) =>
      parse(file, source).statements.some((s) => takesValueOf(s, isNodeModule))
    )
    .map(({ file }) => posix(file));
}

/** pr2i: a value import / re-export of the store (not type-only): its file is a reader. */
function takesStoreValue(file: string, statement: ts.Statement): boolean {
  return takesValueOf(statement, (specifier) => namesStore(file, specifier));
}

/** pr2i (PM Claude pr2h P3-1, codex review-4227-pr2g P2-3): the files that take a value from the store. */
function storeReaders(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  return files.filter(({ file, source }) => posix(file) !== STORE && parse(file, source).statements.some((s) => takesStoreValue(file, s))).map(({ file }) => posix(file));
}

/**
 * pr2i (the PM's decision 2, PM Claude pr2h P2-1): the names a file may re-export from the store —
 * today the dialog's `handoffCloseBlock` (`export { handoffCloseBlock, type HandoffCloseBlock }`),
 * a reader of the rule, not a writer. Fixed here, like {@link STORE_IMPORTERS}.
 */
const STORE_REEXPORTS: Readonly<Record<string, readonly string[]>> = { [DIALOG]: ['handoffCloseBlock'] };

/**
 * pr2i: the values a file hands on from the store, as `name` or `name as alias` — `export { … }
 * from` the store, `export *`, and `export { x }` / `export default x` / `export = x` of a value
 * imported from it. Type-only ones are not counted.
 */
function storeReexportsOf(file: string, source: string): string[] {
  const sf = parse(file, source);
  const imported = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !namesStore(file, s.moduleSpecifier.text) || s.importClause?.isTypeOnly) continue;
    const clause = s.importClause;
    if (clause?.name) imported.set(clause.name.text, 'default');
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, '*');
    if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) if (!e.isTypeOnly) imported.set(e.name.text, (e.propertyName ?? e.name).text);
  }
  const out: string[] = [];
  const named = (original: string, exportedAs: string): string => (original === exportedAs ? original : `${original} as ${exportedAs}`);
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      const fromStore = !!s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && namesStore(file, s.moduleSpecifier.text);
      const clause = s.exportClause;
      if (fromStore && !clause) out.push('*');
      else if (fromStore && clause && ts.isNamespaceExport(clause)) out.push(`* as ${clause.name.text}`);
      else if (clause && ts.isNamedExports(clause)) {
        for (const e of clause.elements) {
          if (e.isTypeOnly) continue;
          const local = (e.propertyName ?? e.name).text;
          if (fromStore) out.push(named(local, e.name.text));
          else if (!s.moduleSpecifier && imported.has(local)) out.push(named(imported.get(local)!, e.name.text));
        }
      }
    }
    if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression) && imported.has(s.expression.text)) out.push(named(imported.get(s.expression.text)!, 'default'));
  }
  return out;
}

/** pr2i: in `src/`, the store's values are re-exported by {@link STORE_REEXPORTS} only, under their own names. */
function checkStoreReexports(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const problems: string[] = [];
  for (const { file, source } of files) {
    const rel = posix(file);
    if (rel === STORE) continue;
    const allowed = own(STORE_REEXPORTS, rel) ?? [];
    for (const name of storeReexportsOf(file, source)) {
      if (!allowed.includes(name)) problems.push(`${rel}: re-exports ${name} from the store (only ${Object.entries(STORE_REEXPORTS).map(([f, names]) => `${f}: ${names.join(', ')}`).join('; ')} may)`);
    }
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

/**
 * pr2i (the PM's decision 1 in `pm-return-4227-pr2h.md`, PM Claude pr2h P2-1): the store's export
 * surface — every value it exports, and whether it is a writer ({@link STORE_WRITERS}). The real
 * list today; a value that is not here, or a name here that is not exported, fails.
 */
const STORE_EXPORTS: Readonly<Record<string, 'writer' | 'reader'>> = {
  handoffCloseBlock: 'reader',
  HANDOFF_CLOSE_PATHS: 'reader',
  subscribeHandoffStore: 'reader',
  handoffStoreSnapshot: 'reader',
  handoffUnitsOf: 'reader',
  startHandoffDecide: 'writer',
  settleHandoffDecide: 'writer',
  dropHandoffUnit: 'writer',
  startHandoffStop: 'writer',
  endHandoffStop: 'writer',
  startHandoffCancel: 'writer',
  endHandoffCancel: 'writer',
  beginHandoffOpening: 'writer',
  liveHandoffOpeningFor: 'reader',
  patchHandoffOpening: 'writer',
  isLiveHandoffOpening: 'reader',
  handoffTextSendable: 'reader',
  noteHandoffHidden: 'writer',
  currentHandoffHold: 'reader',
  handoffUnitsLock: 'reader',
  listenHandoffRefusal: 'reader',
  askHandoffClose: 'reader',
  closeHandoffOpening: 'writer',
  resetHandoffStoreForTests: 'writer',
};

/**
 * pr2i: the store exports its values by their declarations only (`export function` / `export
 * const`), each named in {@link STORE_EXPORTS} — no `export { … }` (an alias or not), no `export
 * default` / `export =`, no export that is not in the table. pr2j: in the store a writer is
 * referenced by its declaration only — a value that holds one (an object, an array), a wrapper of
 * one (a function that is not a writer) and a call of one in a writer (a handle's `close`, the
 * state's) fail. The table is read by its own names only ({@link own}).
 */
function checkStoreSurface(source: string): string[] {
  const problems: string[] = [];
  const sf = parse(STORE, source);
  const exported = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) problems.push(`the store re-exports ${statement.getText(sf)}`);
      else for (const e of clause.elements) if (!e.isTypeOnly) problems.push(`the store exports ${e.getText(sf)} by \`export { … }\` (its values are exported by their declarations only)`);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      problems.push(`the store has \`${statement.getText(sf)}\``);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      problems.push('the store has an `export default` declaration');
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) exported.add(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exported.add(d.name.text);
        else problems.push(`the store exports a destructured ${d.name.getText(sf)}`);
      }
    } else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) exported.add(statement.name.text);
    else problems.push(`the store exports ${statement.getText(sf).slice(0, 60)} (not a function, a const or a type)`);
  }
  for (const name of exported) if (own(STORE_EXPORTS, name) === undefined) problems.push(`the store exports ${name}, not in STORE_EXPORTS`);
  for (const name of Object.keys(STORE_EXPORTS)) if (!exported.has(name)) problems.push(`${name} is in STORE_EXPORTS but the store does not export it`);
  // pr2j (PM Claude pr2i P2-1): in the store a writer's name is its declaration only — not even a
  // callee in another writer (an arrow function in a writer's body is owned by that writer and can be
  // handed out as a value: a handle's `close`, the state's). The real store calls no writer.
  for (const ref of references(source, STORE, new Set(Object.keys(STORE_WRITERS)), 'count')) {
    const where = ref.owner ?? 'the top level';
    if (ref.callArgs === null) problems.push(`the store references ${ref.name} in ${where} without calling it (a writer held as a value)`);
    else if (ref.owner === null || own(STORE_EXPORTS, ref.owner) !== 'writer') problems.push(`the store calls ${ref.name} in ${where}, not a writer of STORE_EXPORTS (a wrapper of a writer)`);
    else problems.push(`the store calls ${ref.name} in ${where} (in the store a writer's name is its declaration only: a function in a writer that calls one can be handed out)`);
  }
  return problems;
}

function checkStoreSignatures(source: string): string[] {
  const problems: string[] = [];
  const sf = parse('store.ts', source);
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name.text;
    const writes = /\b(?:commit|markClosed|writeFlags)\(/.test(statement.body.getText(sf));
    if (own(STORE_WRITERS, name) === undefined) {
      if (writes) problems.push(`${name} writes the store but is not one of its writers (a settle, close or patch without its sending / opening)`);
      continue;
    }
    const expected = own(STORE_WRITERS, name) ?? null;
    const first = statement.parameters[0]?.type?.getText(sf) ?? null;
    if (first !== expected) problems.push(`${name} takes ${first ?? 'nothing'} first, not ${expected ?? 'nothing'}`);
  }
  return problems;
}

/**
 * pr2g (codex review-4227-pr2e P2, PM Claude pr2f P3-3, the PM's decision (a)): the store's writers
 * ({@link STORE_WRITERS}: its starts, settle, drop, close, hide, patch and the flags' ends) are
 * called where they are imported, and handed on nowhere. In `src/` but the store: no re-export of
 * one (`export { dropHandoffUnit } from …`, with or without an alias, from the store or not, nor
 * `export { x }` of an import), no `export default` / `export =` of one, no import of one under an
 * alias from any module (the second step of a bridge), and no reference that is not a call (a
 * value, an object's property, an argument). A chain of re-exports is cut at its first link.
 */
function checkWriterHandOn(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const writers = new Set(Object.keys(STORE_WRITERS));
  const problems: string[] = [];
  for (const { file, source } of files) {
    // pr2h: every file is parsed (no filter of the raw text first).
    if (posix(file) === STORE) continue;
    const sf = parse(file, source);
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          if (writers.has(original) && !element.isTypeOnly) problems.push(`${file}: ${original} re-exported (the store's writers are handed on nowhere)`);
        }
      }
      if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && writers.has(node.expression.text)) {
        problems.push(`${file}: ${node.expression.text} exported as default`);
      }
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if (element.propertyName && !element.isTypeOnly && writers.has(element.propertyName.text)) problems.push(`${file}: ${element.propertyName.text} imported as ${element.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // pr2i: a writer is referenced only as a call's callee — no exception (a list of dependencies included).
    for (const ref of references(source, file, writers, 'count')) {
      if (ref.callArgs === null) problems.push(`${file}: ${ref.name} referenced in ${ref.owner ?? 'the top level'} without being called (handed on)`);
    }
  }
  return problems;
}

/**
 * pr2f: no source but the store makes a sending or an opening's identity (a cast to the brand).
 * pr2h: read from the parsed casts (`as X`, `<X>`), not the raw text.
 */
function checkBrandCasts(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const brands = new Set(['SentHandoffDecide', 'HandoffOpeningToken']);
  const problems: string[] = [];
  for (const { file, source } of files) {
    if (posix(file) === STORE) continue;
    const sf = parse(file, source);
    let casts = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && ts.isTypeReferenceNode(node.type)) {
        const name = node.type.typeName;
        if (brands.has(ts.isIdentifier(name) ? name.text : name.right.text)) casts = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (casts) problems.push(`${file} casts to SentHandoffDecide / HandoffOpeningToken (only the store makes them)`);
  }
  return problems;
}

/**
 * pr2h — the invariant (the PM's decision in `pm-return-4227-pr2g.md`, design §4.1.1 / §7.3): in
 * every `.ts` / `.tsx` file of `src/`, the only way a value of the store's writers
 * ({@link STORE_WRITERS}) is reached is a static import with a string literal, from a file of
 * {@link STORE_IMPORTERS}, of the writer under its own name, which is then only called. What is
 * not that form fails, whatever it is: a wrapper or a bridge (not an allowed file), an alias, a
 * namespace, `export *`, a re-export, a value, a loader with a computed specifier or under
 * another name. Type-only references pass.
 */
function checkStoreReach(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const store = files.filter(({ file }) => posix(file) === STORE);
  return [
    ...checkStoreImporters(files),
    ...checkImportForms(files),
    ...checkWriterHandOn(files),
    ...checkCreatedRequires(files),
    // pr2i: the names and the places fixed by tables (the PM's decision in `pm-return-4227-pr2h.md`).
    ...store.flatMap(({ source }) => checkStoreSurface(source)),
    ...checkStoreReexports(files),
    ...checkNodeModuleImports(files),
  ];
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

  it('pr2e: the store writes the decide’s units in its three functions only; no other source clears a unit', { timeout: 60_000 }, () => {
    expect(checkStore(read(STORE))).toEqual([]);
    expect(checkOthers(sourcesUnder('src').map((file) => ({ file, source: read(file) })))).toEqual([]);
  });

  it('the page: the target cleared only in closeHandoffBy (which asks the rule), set only in openHandoff after it', () => {
    expect(checkHook(read(HOOK))).toEqual([]);
  });

  // pr2h: every file of src/ is parsed (no filter of its text): given the time of a loaded machine.
  it('pr2f: the store is imported by name only; its settle, drop, close, hide and patch take their sending / opening', { timeout: 60_000 }, () => {
    const sources = sourcesUnder('src').map((file) => ({ file, source: read(file) }));
    expect(checkImportForms(sources)).toEqual([]);
    expect(checkWriterHandOn(sources)).toEqual([]);
    expect(checkStoreSignatures(read(STORE))).toEqual([]);
    expect(checkBrandCasts(sources)).toEqual([]);
  });

  it('pr2h: the invariant — the store’s writers are reached only by a static import from an allowed file, then called', { timeout: 60_000 }, () => {
    const sources = sourcesUnder('src').map((file) => ({ file, source: read(file) }));
    // The whole of src/ is read (no file left out by a filter of its text).
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some(({ file }) => posix(file) === I18N)).toBe(true);
    expect(checkStoreReach(sources)).toEqual([]);
    // The allowed files are the real readers of the store today (a name left over fails too).
    // pr2i: a reader takes a value (type-only imports are not counted).
    expect(storeReaders(sources).sort()).toEqual([...STORE_IMPORTERS].sort());
  });

  it('pr2i: the tables are the real sources today — the store’s exports, its re-exports, the importers of node:module', { timeout: 60_000 }, () => {
    const sources = sourcesUnder('src').map((file) => ({ file, source: read(file) }));
    expect(checkStoreSurface(read(STORE))).toEqual([]);
    // The table's writers are STORE_WRITERS (one list of what writes the store).
    expect(Object.keys(STORE_EXPORTS).filter((name) => own(STORE_EXPORTS, name) === 'writer').sort()).toEqual(Object.keys(STORE_WRITERS).sort());
    const reexports = sources.flatMap(({ file, source }) => (posix(file) === STORE ? [] : storeReexportsOf(file, source).map((name) => `${posix(file)}: ${name}`)));
    expect(reexports.sort()).toEqual(Object.entries(STORE_REEXPORTS).flatMap(([file, names]) => names.map((name) => `${file}: ${name}`)).sort());
    expect(checkStoreReexports(sources)).toEqual([]);
    expect(nodeModuleImporters(sources).sort()).toEqual(Object.keys(NODE_MODULE_IMPORTERS).sort());
    expect(checkNodeModuleImports(sources)).toEqual([]);
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
    // pr2h: the invariant too (not an allowed file).
    expect(checkStoreReach([{ file: 'src/components/mem/MemItemsPanel.tsx', source: panel }]).join('\n')).toMatch(/MemItemsPanel.tsx: imports dropHandoffUnit from the store/);
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
    // pr2h: each form is red under the invariant too.
    for (const source of [alias, namespace, reexport, dynamic]) expect(checkStoreReach([{ file, source }])).not.toEqual([]);
    expect(checkStoreReach([{ file: 'src/lib/handoff/screen-client.ts', source: local }]).join('\n')).toMatch(/screen-client.ts: imports \* as rule from the store/);
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

  // pr2g (codex review-4227-pr2e P2): a bridge re-exports a writer under its own name and another
  // file imports it from the bridge under an alias — two files, neither aliasing the store itself.
  it('pr2g: a writer re-exported by a bridge and imported from it under an alias fails (both files)', () => {
    const bridgeFile = 'src/lib/handoff/bridge.ts';
    const userFile = 'src/components/mem/MemItemsPanel.tsx';
    const bridge = mutated('src/lib/handoff/template.ts', /^/, "export { dropHandoffUnit } from './close-rule';\n");
    const user = mutated(userFile, /^/, "import { dropHandoffUnit as forget } from '@/lib/handoff/bridge';\nexport const drop = (u: Parameters<typeof forget>[0]) => forget(u);\n");
    const files = [
      { file: bridgeFile, source: bridge },
      { file: userFile, source: user },
    ];
    // What pr2f's guard saw: nothing (a same-name re-export, an alias of another module).
    expect(checkImportForms(files)).toEqual([]);
    expect(checkOthers(files)).toEqual([]);
    const problems = checkWriterHandOn(files).join('\n');
    expect(problems).toMatch(/src\/lib\/handoff\/bridge.ts: dropHandoffUnit re-exported/);
    expect(problems).toMatch(/MemItemsPanel.tsx: dropHandoffUnit imported as forget/);
    // Each file alone fails too (the chain is cut at either link).
    expect(checkWriterHandOn([files[0]])).not.toEqual([]);
    expect(checkWriterHandOn([files[1]])).not.toEqual([]);
    // pr2h: the bridge is not an allowed file; the user hands an alias on.
    expect(checkStoreReach([files[0]]).join('\n')).toMatch(/bridge.ts: re-exports dropHandoffUnit from the store/);
    expect(checkStoreReach([files[1]])).not.toEqual([]);
  });

  it('pr2g: two steps of re-exports, a local re-export, a default export and a writer handed on as a value fail', () => {
    const file = 'src/lib/handoff/template.ts';
    const twoSteps = mutated(file, /^/, "export { closeHandoffOpening as close } from './bridge';\nexport { patchHandoffOpening } from './bridge';\n");
    const two = checkWriterHandOn([{ file, source: twoSteps }]).join('\n');
    expect(two).toMatch(/closeHandoffOpening re-exported/);
    expect(two).toMatch(/patchHandoffOpening re-exported/);
    const local = mutated(file, /^/, "import { noteHandoffHidden, settleHandoffDecide } from './close-rule';\nexport { noteHandoffHidden };\nexport default settleHandoffDecide;\n");
    const loc = checkWriterHandOn([{ file, source: local }]).join('\n');
    expect(loc).toMatch(/noteHandoffHidden re-exported/);
    expect(loc).toMatch(/settleHandoffDecide exported as default/);
    const value = mutated(file, /^/, "import { dropHandoffUnit, endHandoffStop } from './close-rule';\nexport const api = { dropHandoffUnit, stop: endHandoffStop };\n");
    const val = checkWriterHandOn([{ file, source: value }]).join('\n');
    expect(val).toMatch(/dropHandoffUnit referenced in api without being called/);
    expect(val).toMatch(/endHandoffStop referenced in api without being called/);
    // pr2h: each is red under the invariant too.
    for (const source of [twoSteps, local, value]) expect(checkStoreReach([{ file, source }])).not.toEqual([]);
  });

  it('pr2g: import() / require() with a template or a computed specifier fails; the locales’ template passes', () => {
    const file = 'src/components/mem/MemItemsPanel.tsx';
    const plain = mutated(file, /^/, 'export const later = () => import(`@/lib/handoff/close-rule`);\n');
    expect(checkImportForms([{ file, source: plain }]).join('\n')).toMatch(/import\(\) with names the store/);
    const template = mutated(file, /^/, "const leaf = 'close-rule';\nexport const later = () => import(`@/lib/handoff/${leaf}`);\n");
    expect(checkImportForms([{ file, source: template }]).join('\n')).toMatch(/import\(\) with a template specifier/);
    const computed = mutated(file, /^/, "const where = '@/lib/handoff/' + 'close-rule';\nexport const later = () => import(where);\nexport const now = () => require(where);\n");
    const comp = checkImportForms([{ file, source: computed }]).join('\n');
    expect(comp).toMatch(/import\(\) with a computed specifier \(where\)/);
    expect(comp).toMatch(/require\(\) with a computed specifier \(where\)/);
    const above = mutated(file, /^/, 'export const later = (leaf: string) => import(`../../lib/${leaf}`);\n');
    expect(checkImportForms([{ file, source: above }]).join('\n')).toMatch(/template specifier/);
    // pr2h: each is red under the invariant too.
    for (const source of [plain, template, computed, above]) expect(checkStoreReach([{ file, source }])).not.toEqual([]);
    // Negative control: the locales' template of src/i18n.ts (a directory the store is not under).
    expect(checkImportForms([{ file: 'src/i18n.ts', source: read('src/i18n.ts') }])).toEqual([]);
  });

  it('pr2g (negative control) a named import of the writers, called where imported, passes', () => {
    expect(checkWriterHandOn([{ file: DIALOG, source: read(DIALOG) }, { file: HOOK, source: read(HOOK) }])).toEqual([]);
    const file = 'src/components/mem/MemItemsPanel.tsx';
    const named = mutated(file, /^/, "import { handoffUnitsLock } from '@/lib/handoff/close-rule';\nexport { handoffCloseBlock } from '@/lib/handoff/close-rule';\n");
    expect(checkWriterHandOn([{ file, source: named }])).toEqual([]);
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

// pr2h (the PM's decision in `pm-return-4227-pr2g.md`): the guard passes the allowed form only. Each
// form the reviews of pr2g found (PM Claude P3-1〜P3-3, codex review-4227-pr2f P2 (1) (2)) is one
// case, on a copy under `os.tmpdir()`; the real sources, `src/i18n.ts` and type-only references pass.
describe('[#4227 pr2h] the invariant: a writer is reached only by a static import from an allowed file, then called', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  /** `file`'s real source with `head` put first, written under `os.tmpdir()` and read back. */
  const withHead = (file: string, head: string): { file: string; source: string } => {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), 'handoff-close-paths-pr2h-'));
    const copy = path.join(dir, path.basename(file));
    writeFileSync(copy, `${head}\n${read(file)}`);
    return { file, source: readFileSync(copy, 'utf8') };
  };
  /** A new file of `src/` (it is not in the repository), written under `os.tmpdir()`. */
  const newFile = (file: string, source: string): { file: string; source: string } => {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), 'handoff-close-paths-pr2h-'));
    const copy = path.join(dir, path.basename(file));
    writeFileSync(copy, source);
    return { file, source: readFileSync(copy, 'utf8') };
  };
  /** The filter of the raw text pr2f / pr2g put before the parse (what these forms slipped by). */
  const oldFilter = /close-rule|\bimport\s*\(|\brequire\s*\(/;
  const PANEL = 'src/components/mem/MemItemsPanel.tsx';

  it('PM Claude P3-1 (a): a namespace import of the store with an escaped specifier fails', () => {
    const one = newFile('src/zz/new.ts', "import * as S from '@/lib/handoff/\\u0063lose-rule';\nexport const g = S.dropHandoffUnit;\n");
    expect(oldFilter.test(one.source)).toBe(false);
    const problems = checkStoreReach([one]).join('\n');
    expect(problems).toMatch(/src\/zz\/new.ts: imports \* as S from the store/);
    expect(problems).toMatch(/namespace import of the store \(\* as S\)/);
  });

  it('PM Claude P3-1 (b): `export *` of the store with an escaped specifier fails', () => {
    const one = newFile('src/lib/handoff/bridge.ts', "export * from './close-rul\\u0065';\n");
    expect(oldFilter.test(one.source)).toBe(false);
    const problems = checkStoreReach([one]).join('\n');
    expect(problems).toMatch(/bridge.ts: re-exports \* from the store/);
    expect(problems).toMatch(/bridge.ts: export \* from the store/);
  });

  it('PM Claude P3-2 (a): the locales’ template with a string substituted (`../` out of locales) fails', () => {
    const one = withHead(I18N, "export const f = () => import(`../locales/${'../lib/handoff/close-rule'}`);");
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/i18n.ts: import\(\) with a template specifier/);
  });

  it('PM Claude P3-2 (b): `require` taken as a value (`const r = require; r(…)`) fails', () => {
    const one = newFile('src/zz/new.ts', "const r = require;\nexport const g = () => r('@/lib/handoff/close-' + 'rule');\n");
    expect(checkStoreReach([one]).join('\n')).toMatch(/require referenced without being called/);
  });

  it('PM Claude P3-3: a wrapper of a writer exported from a file that is not allowed fails', () => {
    const one = withHead(PANEL, "import { closeHandoffOpening } from '@/lib/handoff/close-rule';\nexport function closeIt(t: Parameters<typeof closeHandoffOpening>[0]) {\n  return closeHandoffOpening(t, 'dialog');\n}");
    // What pr2g's guard saw: nothing (a named import, called where imported).
    expect(checkImportForms([one])).toEqual([]);
    expect(checkWriterHandOn([one])).toEqual([]);
    expect(checkStoreReach([one]).join('\n')).toMatch(/MemItemsPanel.tsx: imports closeHandoffOpening from the store/);
  });

  it('codex pr2f P2 (1): `require` of the locales’ template that `..` takes back to the store fails', () => {
    const one = withHead(I18N, "export const f = () => require(`../locales/${'../src/lib/handoff/close-rule'}`);");
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/i18n.ts: require\(\) with a template specifier/);
  });

  it('codex pr2f P2 (2): `import/*c*/(p)` with a concatenated specifier fails', () => {
    const one = newFile('src/x.ts', "const p = '@/lib/handoff/close' + '-rule';\nexport const later = () => import/*c*/(p);\n");
    expect(oldFilter.test(one.source)).toBe(false);
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/x.ts: import\(\) with a computed specifier \(p\)/);
  });

  it('the locales’ form in another file than src/i18n.ts fails', () => {
    const one = withHead(PANEL, 'export const load = (locale: string) => import(`../locales/${locale}/common.json`);');
    expect(checkStoreReach([one]).join('\n')).toMatch(/MemItemsPanel.tsx: import\(\) with a template specifier/);
  });

  it('the locales’ form with `..` after the substitution fails', () => {
    const one = withHead(I18N, 'export const f = (locale: string) => import(`../locales/${locale}/../lib/handoff/close-rule`);');
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/i18n.ts: import\(\) with a template specifier/);
  });

  it('a loader made by createRequire that loads the store, or is handed on, fails', () => {
    const loads = newFile('src/zz/new.ts', "import { createRequire } from 'node:module';\nconst load = createRequire(__filename);\nexport const g = () => load('../lib/handoff/close-rule');\n");
    expect(checkStoreReach([loads]).join('\n')).toMatch(/the loader load loads the store/);
    const handed = newFile('src/zz/new.ts', "import { createRequire } from 'node:module';\nconst load = createRequire(__filename);\nexport const h = load;\n");
    expect(checkStoreReach([handed]).join('\n')).toMatch(/the loader load referenced without being called/);
  });

  it('(negative control) src/i18n.ts as it is, and the real loader of createRequire, pass', () => {
    expect(checkStoreReach([{ file: I18N, source: read(I18N) }])).toEqual([]);
    const qr = 'src/cli/utils/qr-terminal.ts';
    expect(checkStoreReach([{ file: qr, source: read(qr) }])).toEqual([]);
  });

  it('(negative control) type-only references — import type, export type, typeof — pass anywhere', () => {
    const one = withHead(
      PANEL,
      [
        "import type { closeHandoffOpening as Closer, HandoffOpeningToken } from '@/lib/handoff/close-rule';",
        "import { type dropHandoffUnit as Drop } from '@/lib/handoff/close-rule';",
        "export type { patchHandoffOpening } from '@/lib/handoff/close-rule';",
        'export type ClosePathOf = Parameters<typeof Closer>[1];',
        'export type DropOf = typeof Drop;',
        'export type Token = HandoffOpeningToken;',
      ].join('\n')
    );
    expect(checkStoreReach([one])).toEqual([]);
    // In an allowed file, `typeof` of a writer is not a hand-on (PM Claude pr2g P3-4).
    const dialog = withHead(DIALOG, 'type CloseOf = typeof closeHandoffOpening;\nexport type { CloseOf };');
    expect(checkStoreReach([dialog])).toEqual([]);
  });
});

// pr2i (the PM's decision in `pm-return-4227-pr2h.md`: the guard's last form — names and places fixed
// by tables, the meaning (bases, arguments, data flow) not followed). One case per form, on a copy
// under `os.tmpdir()`; the real sources, a new type-only file, qr-terminal.ts and src/i18n.ts pass.
describe('[#4227 pr2i] names and places fixed by tables: the store’s exports, its re-exports, node:module, callees only', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const write = (file: string, source: string): { file: string; source: string } => {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), 'handoff-close-paths-pr2i-'));
    const copy = path.join(dir, path.basename(file));
    writeFileSync(copy, source);
    return { file, source: readFileSync(copy, 'utf8') };
  };
  /** `file`'s real source with `from` replaced (it must be there) and `tail` put last. */
  const changed = (file: string, from: string, to: string, tail = ''): { file: string; source: string } => {
    const source = read(file);
    expect(source.includes(from)).toBe(true);
    return write(file, `${source.replace(from, to)}${tail ? `\n${tail}\n` : ''}`);
  };
  const withTail = (file: string, tail: string): { file: string; source: string } => write(file, `${read(file)}\n${tail}\n`);
  const withHead = (file: string, head: string): { file: string; source: string } => write(file, `${head}\n${read(file)}`);
  const PANEL = 'src/components/mem/MemItemsPanel.tsx';
  const DESKTOP = 'src/components/worktree/WorktreeDetailDesktop.tsx';
  const QR = 'src/cli/utils/qr-terminal.ts';

  // 1. The store's export surface (PM Claude pr2h P2-1).
  it.each([
    ['an aliased export of a writer', "export { closeHandoffOpening as closeIt };", /exports closeHandoffOpening as closeIt by `export \{ … \}`/],
    ['a same-name `export { … }` of a writer', 'export { dropHandoffUnit };', /exports dropHandoffUnit by `export \{ … \}`/],
    ['an object holding a writer', 'export const handoffApi = { close: closeHandoffOpening };', /references closeHandoffOpening in handoffApi without calling it/],
    ['an array holding a writer (not exported)', 'const writers = [dropHandoffUnit];\nexport const writersCount = writers.length;', /references dropHandoffUnit in writers without calling it/],
    ['a wrapper function of a writer', "export function closeWrap(t: HandoffOpeningToken): HandoffCloseAnswer {\n  return closeHandoffOpening(t, 'dialog');\n}", /calls closeHandoffOpening in closeWrap, not a writer of STORE_EXPORTS/],
    ['`export default` of a writer', 'export default closeHandoffOpening;', /the store has `export default closeHandoffOpening;`/],
    ['a value not in the table', 'export const extra = 1;', /the store exports extra, not in STORE_EXPORTS/],
  ])('the store: %s fails', (_label, tail, expected) => {
    const store = withTail(STORE, tail);
    expect(checkStoreSurface(store.source).join('\n')).toMatch(expected);
    expect(checkStoreReach([store]).join('\n')).toMatch(expected);
  });

  it('the store: a reader of the table that wraps a writer fails (the name is in the table, the call is not a writer’s)', () => {
    const store = changed(STORE, 'export function handoffStoreSnapshot(): HandoffStoreState {\n', "export function handoffStoreSnapshot(): HandoffStoreState {\n  if (state.opening) closeHandoffOpening(state.opening.token, 'dialog');\n");
    // checkStoreSignatures saw nothing: the body calls no commit / markClosed / writeFlags itself.
    expect(checkStoreSignatures(store.source)).toEqual([]);
    expect(checkStoreSurface(store.source).join('\n')).toMatch(/calls closeHandoffOpening in handoffStoreSnapshot, not a writer/);
  });

  it('the store: a name of the table that is no longer exported fails (the table is the whole surface)', () => {
    const store = changed(STORE, 'export function handoffUnitsLock(', 'function handoffUnitsLock(');
    expect(checkStoreSurface(store.source).join('\n')).toMatch(/handoffUnitsLock is in STORE_EXPORTS but the store does not export it/);
  });

  it('PM Claude pr2h P2-1: the chain store → dialog → a file outside fails at the store and at the dialog', () => {
    const store = withTail(STORE, "export { closeHandoffOpening as closeIt };\nexport const handoffApi2 = { close: closeHandoffOpening };");
    const dialog = changed(DIALOG, 'export { handoffCloseBlock, type HandoffCloseBlock }', 'export { handoffCloseBlock, closeIt, handoffApi2, type HandoffCloseBlock }');
    const panel = withHead(PANEL, "import { closeIt } from '@/components/mem/SessionHandoffDialog';\nexport const f = closeIt;");
    const problems = checkStoreReach([store, dialog, panel]).join('\n');
    expect(problems).toMatch(/the store exports closeHandoffOpening as closeIt/);
    expect(problems).toMatch(/SessionHandoffDialog.tsx: re-exports closeIt from the store/);
    expect(problems).toMatch(/SessionHandoffDialog.tsx: re-exports handoffApi2 from the store/);
  });

  // 2. The re-exports of the store (fixed names).
  it.each([
    ['the dialog re-exports a name not in the table', () => changed(DIALOG, 'export { handoffCloseBlock, type HandoffCloseBlock }', 'export { handoffCloseBlock, handoffUnitsOf, type HandoffCloseBlock }'), /SessionHandoffDialog.tsx: re-exports handoffUnitsOf from the store/],
    ['the dialog re-exports the allowed name under an alias', () => changed(DIALOG, 'export { handoffCloseBlock, type HandoffCloseBlock }', 'export { handoffCloseBlock as closeBlock, type HandoffCloseBlock }'), /re-exports handoffCloseBlock as closeBlock from the store/],
    ['the dialog re-exports an imported value locally (`export { x }`)', () => withTail(DIALOG, 'export { handoffUnitsLock };'), /SessionHandoffDialog.tsx: re-exports handoffUnitsLock from the store/],
    ['the hook re-exports the allowed name (another file than the table’s)', () => withHead(HOOK, "export { handoffCloseBlock } from '@/lib/handoff/close-rule';"), /useWorktreeDetailController.ts: re-exports handoffCloseBlock from the store/],
  ])('re-exports: %s fails', (_label, make, expected) => {
    expect(checkStoreReach([make()]).join('\n')).toMatch(expected);
  });

  // 3. `module` / `node:module` by file (PM Claude pr2h P2-2, codex review-4227-pr2g P2-1).
  it('PM Claude pr2h P2-2 (C1): createRequire imported under an alias, its loader reading the store, fails', () => {
    const one = write('src/zz/new.ts', "import { createRequire as cr } from 'node:module';\nconst load = cr(__filename);\nexport const g = load('../lib/handoff/close-rule').closeHandoffOpening;\n");
    // What pr2h's guard saw: nothing (the loader is found by the name `createRequire`).
    expect([...checkStoreImporters([one]), ...checkImportForms([one]), ...checkWriterHandOn([one]), ...checkCreatedRequires([one])]).toEqual([]);
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/zz\/new.ts: a value import of node:module/);
  });

  it.each([
    ['a namespace import (C2)', "import * as nm from 'node:module';\nexport const r = nm.createRequire(__filename);", /a value import of node:module/],
    ['a default import (C3)', "import Module from 'module';\nexport const r = Module.createRequire(__filename);", /a value import of module/],
    ['createRequire under its own name in another file (codex: the base by `new URL`)', "import { createRequire } from 'node:module';\nconst r = createRequire(new URL('./lib/handoff/close-rule.ts', import.meta.url));\nexport const g = () => r('./close-rule.ts');", /src\/zz\/new.ts: a value import of node:module/],
    ['another name of module', "import { builtinModules } from 'module';\nexport const all = builtinModules;", /a value import of module/],
    ['a side-effect import', "import 'node:module';", /a value import of node:module/],
    ['require() of module', "const m = require('node:module');\nexport const r = m.createRequire(__filename);", /loads node:module/],
    ['import() of module', "export const later = () => import('module');", /loads module/],
    ['a re-export from module', "export { createRequire } from 'node:module';", /re-exports from node:module/],
  ])('node:module: %s fails', (_label, source, expected) => {
    expect(checkStoreReach([write('src/zz/new.ts', `${source}\n`)]).join('\n')).toMatch(expected);
  });

  it('node:module: the allowed file with another form (an alias) fails', () => {
    const qr = changed(QR, "import { createRequire } from 'node:module';", "import { createRequire as make } from 'node:module';");
    expect(checkStoreReach([qr]).join('\n')).toMatch(/src\/cli\/utils\/qr-terminal.ts: a value import of node:module/);
  });

  // 4. A writer is referenced only as a call's callee (codex review-4227-pr2g P2-2).
  it.each([
    ['codex: a list of dependencies handed to a function named useMemo', HOOK, 'export const useLeak = (useMemo: (f: () => null, d: unknown[]) => unknown) => useMemo(() => null, [closeHandoffOpening]);', /closeHandoffOpening referenced in useLeak without being called/],
    ['a list of dependencies of React’s useCallback', HOOK, 'export const useKeep = () => useCallback(() => null, [dropHandoffUnit]);', /dropHandoffUnit referenced in useKeep without being called/],
    ['an argument', DIALOG, 'export const register = (f: unknown): unknown => f;\nexport const leaked = register(patchHandoffOpening);', /patchHandoffOpening referenced in leaked without being called/],
    ['a JSX attribute', DIALOG, 'export const Leak = () => <button type="button" onClick={endHandoffStop as never} />;', /endHandoffStop referenced in Leak without being called/],
  ])('callees only: %s fails', (_label, file, tail, expected) => {
    const one = withTail(file, tail);
    expect(checkStoreReach([one]).join('\n')).toMatch(expected);
  });

  it('callees only: pr2h’s exception by the callee’s name saw the lists of dependencies', () => {
    const one = withTail(HOOK, 'export const useLeak = (useMemo: (f: () => null, d: unknown[]) => unknown) => useMemo(() => null, [closeHandoffOpening]);');
    const writers = new Set(Object.keys(STORE_WRITERS));
    expect(references(one.source, HOOK, writers, 'exempt').filter((ref) => ref.callArgs === null)).toEqual([]);
    expect(references(one.source, HOOK, writers, 'count').filter((ref) => ref.callArgs === null)).not.toEqual([]);
  });

  // 5. Readers are the files that take a value (PM Claude pr2h P3-1, codex review-4227-pr2g P2-3).
  it('readers: a value import in the PC page (a type-only reader today, not in the table) fails', () => {
    const desktop = withHead(DESKTOP, "import { handoffUnitsLock } from '@/lib/handoff/close-rule';");
    expect(checkStoreReach([desktop]).join('\n')).toMatch(/WorktreeDetailDesktop.tsx: imports handoffUnitsLock from the store/);
    expect(storeReaders([desktop])).toEqual([DESKTOP]);
  });

  it('(negative control) a new file that imports types only is no reader and passes; the PC page as it is too', () => {
    const one = write(
      'src/zz/types-only.ts',
      "import type { SessionStopResult } from '@/lib/handoff/close-rule';\nimport { type HandoffHold } from '@/lib/handoff/close-rule';\nexport type { HandoffOpeningToken } from '@/lib/handoff/close-rule';\nexport type R = SessionStopResult | HandoffHold;\n"
    );
    expect(storeReaders([one])).toEqual([]);
    expect(checkStoreReach([one])).toEqual([]);
    const desktop = { file: DESKTOP, source: read(DESKTOP) };
    expect(storeReaders([desktop])).toEqual([]);
    expect(checkStoreReach([desktop])).toEqual([]);
  });

  // 6. The locales' substitution is one identifier (PM Claude pr2h P3-3).
  it('the locales’ template with a substitution that is not an identifier (a call) fails', () => {
    // The tail is the allowed one: only the identifier's condition makes it red.
    expect(/^\/[A-Za-z0-9_-]+\.json$/.test('/common.json')).toBe(true);
    const one = withTail(I18N, 'export const f = (l: string) => import(`../locales/${String(l)}/common.json`);');
    expect(checkStoreReach([one]).join('\n')).toMatch(/src\/i18n.ts: import\(\) with a template specifier/);
  });

  // 7. Negative controls of the tables.
  it('(negative control) the store, the dialog, the hook, qr-terminal.ts and src/i18n.ts as they are pass', () => {
    const files = [STORE, DIALOG, HOOK, QR, I18N].map((file) => ({ file, source: read(file) }));
    expect(checkStoreReach(files)).toEqual([]);
    // An unchanged copy of the store passes the surface (the table is the real list).
    expect(checkStoreSurface(withTail(STORE, '// unchanged').source)).toEqual([]);
  });
});

// pr2j (the PM's return `pm-return-4227-pr2i.md`): PM Claude pr2i P2-1, codex review-4227-pr2h P2-1 /
// P2-2. One case per form, on a copy under `os.tmpdir()`; the real sources pass.
describe('[#4227 pr2j] a writer’s name in the store is its declaration only; tables by own names; node:module per specifier', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const write = (file: string, source: string): { file: string; source: string } => {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), 'handoff-close-paths-pr2j-'));
    const copy = path.join(dir, path.basename(file));
    writeFileSync(copy, source);
    return { file, source: readFileSync(copy, 'utf8') };
  };
  const changed = (file: string, from: string, to: string): { file: string; source: string } => {
    const source = read(file);
    expect(source.includes(from)).toBe(true);
    return write(file, source.replace(from, to));
  };
  const BEGIN = '  const opening = freshOpening(worktreeId, target);\n  commit({ ...state, opening });\n  return opening;\n';

  // 1. PM Claude pr2i P2-1: a function in a writer's body that calls a writer, handed out.
  it.each([
    [
      'a handle with a `close` that calls the writer, returned',
      '  const opening = freshOpening(worktreeId, target);\n  commit({ ...state, opening });\n  return { ...opening, close: (p: HandoffClosePath) => closeHandoffOpening(opening.token, p) } as HandoffOpening;\n',
    ],
    [
      'a `close` that calls the writer, put in the state',
      '  const opening = freshOpening(worktreeId, target);\n  (opening as HandoffOpening & { close?: unknown }).close = (p: HandoffClosePath) => closeHandoffOpening(opening.token, p);\n  commit({ ...state, opening });\n  return opening;\n',
    ],
  ])('the store: %s fails', (_label, to) => {
    const store = changed(STORE, BEGIN, to);
    // What pr2i's guard saw: the owner of the arrow function is beginHandoffOpening, a writer.
    const old = references(store.source, STORE, new Set(Object.keys(STORE_WRITERS)), 'count').filter(
      (ref) => ref.callArgs === null || ref.owner === null || own(STORE_EXPORTS, ref.owner) !== 'writer'
    );
    expect(old).toEqual([]);
    const expected = /the store calls closeHandoffOpening in beginHandoffOpening \(in the store a writer's name is its declaration only/;
    expect(checkStoreSurface(store.source).join('\n')).toMatch(expected);
    expect(checkStoreReach([store]).join('\n')).toMatch(expected);
  });

  it('(negative control) the real store refers to no writer but by its declaration', () => {
    expect(references(read(STORE), STORE, new Set(Object.keys(STORE_WRITERS)), 'count')).toEqual([]);
    expect(checkStoreSurface(read(STORE))).toEqual([]);
  });

  // 2. codex review-4227-pr2h P2-1: a name inherited from Object.prototype is not in a table.
  it.each([
    ['toString', 'export const toString = (): string => JSON.stringify(handoffStoreSnapshot());'],
    ['constructor', 'export const constructor = 1;'],
    ['hasOwnProperty', 'export function hasOwnProperty(): boolean {\n  return false;\n}'],
  ])('the store: an export named %s fails (not in STORE_EXPORTS)', (name, tail) => {
    const store = write(STORE, `${read(STORE)}\n${tail}\n`);
    expect(checkStoreSurface(store.source).join('\n')).toMatch(new RegExp(`the store exports ${name}, not in STORE_EXPORTS`));
    expect(checkStoreReach([store]).join('\n')).toMatch(new RegExp(`the store exports ${name}, not in STORE_EXPORTS`));
  });

  it('the store: an exported `toString` that writes it is not one of its writers', () => {
    const store = write(STORE, `${read(STORE)}\nexport function toString(): string {\n  commit(EMPTY);\n  return '';\n}\n`);
    expect(checkStoreSignatures(store.source).join('\n')).toMatch(/toString writes the store but is not one of its writers/);
  });

  it('the tables by file: a file named like an inherited name takes nothing from them', () => {
    // `STORE_REEXPORTS['constructor']` / `NODE_MODULE_IMPORTERS['constructor']` would be a function.
    expect(own(STORE_REEXPORTS, 'constructor')).toBeUndefined();
    expect(own(NODE_MODULE_IMPORTERS, 'toString')).toBeUndefined();
    expect(own(STORE_EXPORTS, 'toString')).toBeUndefined();
    expect(own(STORE_WRITERS, 'valueOf')).toBeUndefined();
    expect(own(STORE_WRITERS, 'resetHandoffStoreForTests')).toBeNull();
  });

  // 3. codex review-4227-pr2h P2-2: node:module is judged per specifier, like the store.
  it('(negative control) `import { type Module }` and `export { type Module } from` node:module pass, and take no value', () => {
    const one = write(
      'src/zz/types-only.ts',
      "import { type Module } from 'node:module';\nexport { type Module as NodeModule } from 'node:module';\nimport type { Module as M2 } from 'module';\nexport type { Module as M3 } from 'module';\nexport type M = Module | M2;\n"
    );
    expect(checkNodeModuleImports([one])).toEqual([]);
    expect(nodeModuleImporters([one])).toEqual([]);
    expect(checkStoreReach([one])).toEqual([]);
  });

  it.each([
    ['a type specifier with a value one', "import { type Module, builtinModules } from 'node:module';\nexport const all = builtinModules;", /a value import of node:module/],
    ['a re-export with a type specifier and a value one', "export { type Module, createRequire } from 'node:module';", /re-exports from node:module/],
  ])('node:module: %s still fails', (_label, source, expected) => {
    const one = write('src/zz/new.ts', `${source}\n`);
    expect(checkStoreReach([one]).join('\n')).toMatch(expected);
  });

  it('node:module: a file that re-exports a value of it is an importer (the table’s equality sees it)', () => {
    const one = write('src/zz/new.ts', "export { createRequire } from 'node:module';\n");
    expect(nodeModuleImporters([one])).toEqual(['src/zz/new.ts']);
  });
});
