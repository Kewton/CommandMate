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

/*
 * What one file's text answers for one name is kept for the process (Issue #4534,
 * the 5-second timeout): every control is today's tree plus a few files, so the
 * walk asked the same file the same question once per test and parsed it again
 * each time (about 3 s a test alone, 7–14 s under the load of a whole run). The
 * answer is a function of the file's path and text, the name, and — for a free
 * function — where the specifiers resolve. The disk does not change during a
 * run (the controls are in memory); an answer that read the tree's own added
 * files (a specifier the disk does not resolve) is NOT kept, so it is computed
 * again for each tree. The rules, the files read and the answers are unchanged.
 */
const memo = new Map<string, { exportStar: boolean; answers: Map<string, unknown> }>();
const memoOf = (text: string): { exportStar: boolean; answers: Map<string, unknown> } => {
  let entry = memo.get(text);
  if (entry === undefined) {
    entry = { exportStar: /\bexport\s*\*/.test(text), answers: new Map() };
    memo.set(text, entry);
  }
  return entry;
};
const onDisk = new Map<string, string | null>();

/**
 * As `resolveRepoSpecifier`, and for a file that exists only in `files` (a control's added file).
 * `readTree` is told when the answer could depend on `files` (the disk did not resolve a repo specifier).
 */
function resolveIn(files: ReadonlyMap<string, string>, specifier: string, fromFile: string, readTree: () => void = () => {}): string | null {
  const diskKey = `${fromFile}\u0000${specifier}`;
  let disk = onDisk.get(diskKey);
  if (disk === undefined) {
    disk = resolveRepoSpecifier(specifier, join(REPO_ROOT, fromFile));
    onDisk.set(diskKey, disk);
  }
  if (disk !== null) return disk;
  const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : specifier.startsWith('.') ? normalize(join(dirname(fromFile), specifier)) : null;
  if (base === null) return null;
  readTree();
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (files.has(candidate)) return join(REPO_ROOT, candidate);
  return null;
}

function importsFrom(files: ReadonlyMap<string, string>, text: string, file: string, target: string, readTree: () => void): boolean {
  const specifiers = [...text.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return specifiers.some((specifier) => resolveIn(files, specifier, file, readTree) === target);
}

/** Every reference to the free function `name` defined in `definingFile`, as `file#site`. */
export function freeReferences(files: ReadonlyMap<string, string>, definingFile: string, name: string): string[] {
  const target = join(REPO_ROOT, definingFile);
  const found: string[] = [];
  for (const [file, text] of files) {
    // (f): `export *` re-exports the name without spelling it.
    if (!text.includes(name) && !memoOf(text).exportStar) continue;
    const answers = memoOf(text).answers;
    const question = `free\u0000${file}\u0000${definingFile}\u0000${name}`;
    const kept = answers.get(question) as string[] | undefined;
    if (kept !== undefined) {
      found.push(...kept);
      continue;
    }
    let treeRead = false;
    const readTree = (): void => {
      treeRead = true;
    };
    const sites = scanReferences(file, text, [name], {
      fromDefiningModule: (specifier) => resolveIn(files, specifier, file, readTree) === target,
    });
    const here: string[] = [];
    for (const site of sites) {
      if (file === definingFile || importsFrom(files, text, file, target, readTree)) here.push(key(file, site.site));
    }
    if (!treeRead) answers.set(question, here);
    found.push(...here);
  }
  return found;
}

/** Every `x.name(…)` in one file, as its site and receiver (a function of the path and the text only). */
function memberCallsOf(file: string, text: string, name: string): Array<{ site: string; receiver: string }> {
  const answers = memoOf(text).answers;
  const question = `member\u0000${file}\u0000${name}`;
  let calls = answers.get(question) as Array<{ site: string; receiver: string }> | undefined;
  if (calls === undefined) {
    calls = scanMemberCalls(file, text, name).map((call) => ({ site: call.site, receiver: call.receiver }));
    answers.set(question, calls);
  }
  return calls;
}

function memberReferences(files: ReadonlyMap<string, string>, name: string): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    if (!text.includes(name)) continue;
    for (const call of memberCallsOf(file, text, name)) {
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

/** The gates (Issue #4534 r5): a function that calls one is where the walk below starts. */
export const GATE_CALLS = ['fenceGate', 'fenceBatchOpen', 'fenceBatchStep', 'fenceConfirm', 'fenceConfirmDispatch'] as const;

/**
 * The functions that reach a gate, as `file#site` — G-閉包's walk (free functions
 * by reference through their imports, methods by NAME) started at the gates
 * instead of at the layer mark, and not stopped at the entries. Wider than the
 * truth (a method is reached by every same-named call). A helper of the static
 * INV-catch check; the run-time table is the main one.
 */
export function computeGateReach(files: ReadonlyMap<string, string>): Set<string> {
  const seeds = [...new Set(GATE_CALLS.flatMap((g) => freeReferences(files, FENCE_MODULE, g)))].filter((n) => !n.startsWith(`${FENCE_MODULE}#`));
  const members = new Set<string>();
  const work = [...seeds];
  while (work.length > 0) {
    const node = work.pop() as string;
    if (members.has(node)) continue;
    members.add(node);
    const [file, site] = split(node);
    if (site === '<module>' || site === '<re-export>') continue;
    const method = site.includes('.') ? site.slice(site.indexOf('.') + 1) : null;
    const callers = method !== null ? memberReferences(files, method) : freeReferences(files, file, site);
    for (const caller of callers) if (!members.has(caller)) work.push(caller);
  }
  return members;
}
