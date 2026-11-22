/**
 * G-閉包 for the send fence (Issue #4534, INV-閉包, design §5). A HELPER of the
 * static checks — the run-time guards (G-境 and the detector) are the main
 * ones, and this reads only the forms listed in the design's table.
 *
 * The set of production functions a send reaches the send-only layers through
 * is CLOSED: computed here, never listed by hand. It starts at the functions
 * that carry the layer mark (`enterSendLayer(`) and grows by every function
 * that references one already in it — until it meets an ENTRY, a function that
 * opens a ticket (`openSendTicket(` / `runWithSendTicket(`). What else the walk
 * ends at is a way in with no ticket:
 *
 * - R-root: a function of the set that is no entry and does not reach one
 *   through its callers — nothing references it, or only a loop of functions
 *   that reach no entry either ((i))
 * - R-module: a reference from module scope, or a re-export — named, aliased,
 *   `export default`, or an `export *` of a module that defines a member ((f))
 * - R-run: in an entry, a VALUE reference to the set (a call, or the function
 *   taken as a value, (g)) outside the function the entry runs under its own
 *   ticket — the second argument of `runWithSendTicket(`, or a function handed
 *   to `.run(` of a variable that received `openSendTicket(` ((h)); and an entry
 *   that runs nothing of the set under its ticket at all ((k): an entry written
 *   as a method is read like a free function)
 *
 * Free functions are followed by reference, methods by NAME (`x.sendMessage(`
 * reaches every `sendMessage` of the set): wider than the truth. A same-named
 * call that is something else is on {@link NOT_A_SEND}: that call — that site,
 * that method, that receiver — and nothing else at the site ((j)).
 */

import ts from 'typescript';
import { dirname, join, normalize } from 'node:path';
import { REPO_ROOT, resolveRepoSpecifier } from './route-tmux-reach';
import { scanMemberCalls, scanReferences } from './pane-key-writers-scan';

export const FENCE_MODULE = 'src/lib/session/terminal-fence.ts';
export const MARK = 'enterSendLayer';
export const TICKET_OPENERS = ['openSendTicket', 'runWithSendTicket'] as const;

/** A same-named member call that is not the tool method. */
export interface NotASend {
  /** `file#site` of the call. */
  site: string;
  member: string;
  /** The object the method is read off, as written. */
  receiver: string;
  reason: string;
}

/** Same-named member calls that are not the tool method: these calls only. */
export const NOT_A_SEND: readonly NotASend[] = [
  {
    site: 'src/components/sessions/SessionTile.tsx#SessionTileCard',
    member: 'sendMessage',
    receiver: 'worktreeApi',
    reason: 'the browser API client (an HTTP POST to the send route)',
  },
  {
    site: 'src/lib/handoff/page-owner.ts#sendMessageForHandoffPage',
    member: 'sendMessage',
    receiver: 'worktreeApi',
    reason: 'the browser API client (an HTTP POST to the send route)',
  },
];

export interface Closure {
  seeds: string[];
  entries: string[];
  /** Every function of the set, with what references it. */
  members: Map<string, string[]>;
  violations: string[];
}

const key = (file: string, site: string): string => `${file}#${site}`;
const split = (node: string): [string, string] => {
  const i = node.indexOf('#');
  return [node.slice(0, i), node.slice(i + 1)];
};

/** As `resolveRepoSpecifier`, and for a file that exists only in `files` (a control's added file). */
function resolveIn(files: ReadonlyMap<string, string>, specifier: string, fromFile: string): string | null {
  const onDisk = resolveRepoSpecifier(specifier, join(REPO_ROOT, fromFile));
  if (onDisk !== null) return onDisk;
  const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : specifier.startsWith('.') ? normalize(join(dirname(fromFile), specifier)) : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (files.has(candidate)) return join(REPO_ROOT, candidate);
  return null;
}

function importsFrom(files: ReadonlyMap<string, string>, text: string, file: string, target: string): boolean {
  const specifiers = [...text.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return specifiers.some((specifier) => resolveIn(files, specifier, file) === target);
}

/** Every reference to the free function `name` defined in `definingFile`, as `file#site`. */
export function freeReferences(files: ReadonlyMap<string, string>, definingFile: string, name: string): string[] {
  const target = join(REPO_ROOT, definingFile);
  const found: string[] = [];
  for (const [file, text] of files) {
    // (f): `export *` re-exports the name without spelling it.
    if (!text.includes(name) && !/\bexport\s*\*/.test(text)) continue;
    const sites = scanReferences(file, text, [name], {
      fromDefiningModule: (specifier) => resolveIn(files, specifier, file) === target,
    });
    for (const site of sites) {
      if (file === definingFile || importsFrom(files, text, file, target)) found.push(key(file, site.site));
    }
  }
  return found;
}

function memberReferences(files: ReadonlyMap<string, string>, name: string): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    if (!text.includes(name)) continue;
    for (const call of scanMemberCalls(file, text, name)) {
      const site = key(file, call.site);
      const excused = NOT_A_SEND.some((row) => row.site === site && row.member === name && row.receiver === call.receiver);
      if (!excused) found.push(site);
    }
  }
  return found;
}

/** The enclosing function's site name, as `scanReferences` names it (`Class.method` for a method). */
function siteOf(node: ts.Node): string {
  for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
    if (ts.isFunctionDeclaration(c) && c.name) return c.name.text;
    if (ts.isMethodDeclaration(c) && ts.isIdentifier(c.name)) {
      const owner = c.parent;
      return ts.isClassDeclaration(owner) && owner.name ? `${owner.name.text}.${c.name.text}` : c.name.text;
    }
    if ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isVariableDeclaration(c.parent) && ts.isIdentifier(c.parent.name)) {
      return c.parent.name.text;
    }
  }
  return '<module>';
}

/** Whether `node` is in a type position (an annotation, `typeof x`, a type argument). */
function inTypePosition(node: ts.Node): boolean {
  for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
    if (ts.isTypeNode(c)) return true;
    if (ts.isExpression(c) || ts.isStatement(c)) return false;
  }
  return false;
}

/** A value reference to `name`: not a declaration, an import / export specifier, an object key or a type. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
    ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isBindingElement(parent) ||
    ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return !inTypePosition(node);
}

/**
 * R-run for one entry: every value reference to a name of the set inside the
 * entry's own function must sit under its ticket ((g)); "under its ticket" is
 * only `runWithSendTicket(`'s second argument or `.run(` of a variable that
 * received `openSendTicket(` ((h)); and at least one reference does ((k)).
 */
function entryViolations(file: string, text: string, entrySite: string, names: ReadonlySet<string>): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tickets = new Set<string>();
  const isOpenerCall = (e: ts.Expression | undefined): boolean =>
    e !== undefined && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'openSendTicket';
  const collectTickets = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isOpenerCall(node.initializer)) tickets.add(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isOpenerCall(node.right)) {
      tickets.add(node.left.text);
    }
    ts.forEachChild(node, collectTickets);
  };
  collectTickets(source);
  const underTicket = (node: ts.Node): boolean => {
    for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
      if (!(ts.isArrowFunction(c) || ts.isFunctionExpression(c)) || !ts.isCallExpression(c.parent)) continue;
      const call: ts.CallExpression = c.parent;
      const callee = call.expression;
      if (ts.isIdentifier(callee) && callee.text === 'runWithSendTicket' && call.arguments[1] === c) return true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'run' && ts.isIdentifier(callee.expression) && tickets.has(callee.expression.text)) {
        return true;
      }
    }
    return false;
  };
  const bad: string[] = [];
  let underCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text) && isValueReference(node) && siteOf(node) === entrySite) {
      if (underTicket(node)) underCount += 1;
      else {
        const parent = node.parent;
        const called =
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        bad.push(`${key(file, entrySite)} ${called ? 'calls' : 'references'} ${node.text} outside its ticket (line ${line})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (underCount === 0) bad.push(`${key(file, entrySite)} runs nothing of the set under its ticket`);
  return bad;
}

/** Compute the set and its violations over `files` (repo-relative path → text). */
export function computeSendClosure(files: ReadonlyMap<string, string>): Closure {
  const seeds = [...new Set(freeReferences(files, FENCE_MODULE, MARK))].filter((n) => !n.startsWith(`${FENCE_MODULE}#`)).sort();
  const entries = new Set(TICKET_OPENERS.flatMap((name) => freeReferences(files, FENCE_MODULE, name)).filter((n) => !n.startsWith(`${FENCE_MODULE}#`)));
  const members = new Map<string, string[]>();
  const violations: string[] = [];
  const work = [...seeds];
  while (work.length > 0) {
    const node = work.pop() as string;
    if (members.has(node)) continue;
    const [file, site] = split(node);
    if (site === '<module>' || site === '<re-export>') {
      members.set(node, []);
      violations.push(`R-module: ${node} reaches the send layers from ${site === '<module>' ? 'module scope' : 're-export'}`);
      continue;
    }
    const method = site.includes('.') ? site.slice(site.indexOf('.') + 1) : null;
    const callers = [...new Set(method !== null ? memberReferences(files, method) : freeReferences(files, file, site))].filter(
      (caller) => caller !== node,
    );
    members.set(node, callers);
    for (const caller of callers) if (!entries.has(caller)) work.push(caller);
  }
  // (i): every member reaches an entry through its callers (a fixed point).
  const reaches = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [node, callers] of members) {
      if (reaches.has(node)) continue;
      if (callers.some((caller) => entries.has(caller) || reaches.has(caller))) {
        reaches.add(node);
        grew = true;
      }
    }
  }
  // A member that reaches no entry is reported where the walk ends: at a
  // function nothing references (or a module-scope / re-export site, R-module
  // above); a member above such an end is explained by it. What is left is a
  // loop of callers with no end at all, and each of its members is reported.
  const isEnd = (node: string): boolean => {
    const site = split(node)[1];
    return site === '<module>' || site === '<re-export>' || (members.get(node)?.length ?? 0) === 0;
  };
  const explained = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (seen.has(node)) continue;
      seen.add(node);
      if (isEnd(node)) return true;
      for (const caller of members.get(node) ?? []) if (!entries.has(caller)) stack.push(caller);
    }
    return false;
  };
  for (const [node, callers] of members) {
    const [, site] = split(node);
    if (site === '<module>' || site === '<re-export>' || reaches.has(node)) continue;
    if (callers.length === 0) violations.push(`R-root: ${node} is reached by nothing and opens no ticket`);
    else if (!explained(node)) violations.push(`R-root: ${node} reaches no entry through its callers`);
  }
  const names = new Set(
    [...members.keys()].map((node) => {
      const site = split(node)[1];
      return site.includes('.') ? site.slice(site.indexOf('.') + 1) : site;
    }),
  );
  for (const entry of entries) {
    const [file, site] = split(entry);
    violations.push(...entryViolations(file, files.get(file) ?? '', site, names).map((v) => `R-run: ${v}`));
  }
  return { seeds, entries: [...entries].sort(), members, violations: violations.sort() };
}
