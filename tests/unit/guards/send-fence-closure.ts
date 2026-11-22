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
 * - R-root: a function of the set that nothing references and that is no entry
 * - R-module: a reference from module scope, or a re-export
 * - R-run: an entry that references the set outside the function it runs under
 *   its ticket
 *
 * Free functions are followed by reference, methods by NAME (`x.sendMessage(`
 * reaches every `sendMessage` of the set): wider than the truth. A same-named
 * call that is something else is on {@link NOT_A_SEND}, with its reason.
 */

import ts from 'typescript';
import { dirname, join, normalize } from 'node:path';
import { REPO_ROOT, resolveRepoSpecifier } from './route-tmux-reach';
import { scanMemberCalls, scanReferences } from './pane-key-writers-scan';

export const FENCE_MODULE = 'src/lib/session/terminal-fence.ts';
export const MARK = 'enterSendLayer';
export const TICKET_OPENERS = ['openSendTicket', 'runWithSendTicket'] as const;

/** Same-named member calls that are not the tool method (`file#site` → reason). */
export const NOT_A_SEND: Readonly<Record<string, string>> = {
  'src/components/sessions/SessionTile.tsx#SessionTileCard': 'worktreeApi.sendMessage: the browser API client (an HTTP POST to the send route)',
  'src/lib/handoff/page-owner.ts#sendMessageForHandoffPage': 'worktreeApi.sendMessage: the browser API client (an HTTP POST to the send route)',
};

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
    if (!text.includes(name)) continue;
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
    for (const call of scanMemberCalls(file, text, name)) found.push(key(file, call.site));
  }
  return found;
}

/** R-run: in an entry, a call of a member of the set must sit in a function handed to `.run(` / `runWithSendTicket(`. */
function outsideRun(file: string, text: string, entrySite: string, names: ReadonlySet<string>): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bad: string[] = [];
  const nameOf = (e: ts.Expression): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);
  const enclosing = (node: ts.Node): string => {
    for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
      if (ts.isFunctionDeclaration(c) && c.name) return c.name.text;
      if (ts.isMethodDeclaration(c) && ts.isIdentifier(c.name)) return c.name.text;
      if ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isVariableDeclaration(c.parent) && ts.isIdentifier(c.parent.name)) return c.parent.name.text;
    }
    return '<module>';
  };
  const underTicket = (node: ts.Node): boolean => {
    for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
      if ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isCallExpression(c.parent)) {
        const callee = nameOf(c.parent.expression);
        if (callee === 'run' || callee === 'runWithSendTicket') return true;
      }
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = nameOf(node.expression);
      if (callee !== null && names.has(callee) && enclosing(node) === entrySite && !underTicket(node)) {
        bad.push(`${key(file, entrySite)} calls ${callee} outside its ticket (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
      (caller) => caller !== node && !(caller in NOT_A_SEND),
    );
    members.set(node, callers);
    for (const caller of callers) if (!entries.has(caller)) work.push(caller);
  }
  for (const [node, callers] of members) {
    const [, site] = split(node);
    if (site === '<module>' || site === '<re-export>') continue;
    if (callers.length === 0) violations.push(`R-root: ${node} is reached by nothing and opens no ticket`);
  }
  const names = new Set(
    [...members.keys()].map((node) => {
      const site = split(node)[1];
      return site.includes('.') ? site.slice(site.indexOf('.') + 1) : site;
    }),
  );
  for (const entry of entries) {
    const [file, site] = split(entry);
    violations.push(...outsideRun(file, files.get(file) ?? '', site, names).map((v) => `R-run: ${v}`));
  }
  return { seeds, entries: [...entries].sort(), members, violations: violations.sort() };
}
