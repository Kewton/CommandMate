/**
 * The hand-off never kills a session (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.6・§4.6.1・
 * §7.3 `handoff-no-kill-4227`, the PM's decision `pm-decision-4227-kill.md`): a session is
 * stopped only by the existing stop a person presses.
 *
 * 1. Nothing `src/lib/handoff/**` loads (its import closure, dynamic imports included) is tmux,
 *    a CLI tool, `session-cleanup` or the kill-session route, and no module of that closure
 *    calls a `killSession` / `stopClaudeSession`.
 * 2. The hand-off's routes call no `killSession` and import neither tmux, `session-cleanup` nor
 *    the kill-session route — named imports, `as` aliases, `import * as` namespaces and
 *    re-exports are followed (TypeScript's AST, not a grep). Only the observation route
 *    loads the CLI tools, and it asks them one thing: `isRunning`.
 * 3. The dialog (G-4) reaches the stop (`onStop`) from its stop buttons' handlers only — never
 *    from an effect (H15(f) also runs it).
 *
 * Positive controls are fixture sources under `os.tmpdir()`: a direct `killSession(name)`, an
 * aliased `k(name)`, a namespace `tmux.killSession(name)` and an import of the kill-session
 * route each fail; a source that only reads `isRunning` passes.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createModuleGraph, REPO_ROOT, repoRelative } from './route-tmux-reach';

const KILL_NAMES = new Set(['killSession', 'stopClaudeSession', 'killWorktreeSession']);
const FORBIDDEN_SPECIFIER = /(^|\/)lib\/tmux(\/|$)|session-cleanup|kill-session/;
const OBSERVE_ROUTE = 'src/app/api/worktrees/[id]/mem/handoff/requests/[rid]/end/observe/route.ts';
const TOOL_SPECIFIERS = new Set(['@/lib/cli-tools/manager', '@/lib/cli-tools/types']);

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** What a source does toward a kill, read off its AST. `toolsAllowed`: the observation route. */
export function killFindings(fileName: string, text: string, toolsAllowed = false): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const namespaces = new Set<string>();
  const aliases = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (FORBIDDEN_SPECIFIER.test(specifier)) out.push(`imports ${specifier}`);
      if (/cli-tools/.test(specifier) && !(toolsAllowed && TOOL_SPECIFIERS.has(specifier))) out.push(`imports ${specifier}`);
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
      const elements =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : [];
      for (const element of elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (KILL_NAMES.has(imported)) {
          out.push(`binds ${imported}${element.propertyName ? ` as ${element.name.text}` : ''}`);
          aliases.add(element.name.text);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (KILL_NAMES.has(callee.text) || aliases.has(callee.text))) out.push(`calls ${callee.text}(`);
      if (ts.isPropertyAccessExpression(callee) && KILL_NAMES.has(callee.name.text)) out.push(`calls .${callee.name.text}(`);
      if (ts.isPropertyAccessExpression(callee) && toolsAllowed && !['isRunning', 'getInstance', 'getTool', 'json', 'resolve'].includes(callee.name.text)) {
        // The observation route asks a tool one thing: whether it runs.
        if (ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'getTool') {
          out.push(`asks the tool .${callee.name.text}(`);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && KILL_NAMES.has(node.name.text)) {
      out.push(`names ${node.expression.text}.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(out)];
}

const HANDOFF_LIB = path.join(REPO_ROOT, 'src', 'lib', 'handoff');
const HANDOFF_ROUTES = path.join(REPO_ROOT, 'src', 'app', 'api', 'worktrees', '[id]', 'mem', 'handoff');
const DIALOG = path.join(REPO_ROOT, 'src', 'components', 'mem', 'SessionHandoffDialog.tsx');

/** Modules of the lib's closure that are a kill's way, or call one. */
function closureKillers(entry: string): string[] {
  const graph = createModuleGraph();
  return [...graph.closure(entry)]
    .map((file) => [repoRelative(file), file] as const)
    .filter(([module, file]) => {
      // `cli-tools/types.ts` is the tools' ids and types (mem's roster reads it); it is still held to the call check below.
      const toolModule = /^src\/lib\/cli-tools\//.test(module) && module !== 'src/lib/cli-tools/types.ts';
      if (/^src\/lib\/tmux\//.test(module) || toolModule || /session-cleanup\.ts$/.test(module) || /kill-session\/route\.ts$/.test(module)) return true;
      return killFindings(file, readFileSync(file, 'utf8')).some((finding) => finding.startsWith('calls'));
    })
    .map(([module]) => module);
}

/** The bodies of the dialog's effects (`useEffect(() => { … })`), where `onStop` must never be. */
export function effectsCallingStop(text: string): number {
  const source = ts.createSourceFile('d.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = 0;
  const callsStop = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'onStop') || (ts.forEachChild(node, callsStop) ?? false);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect' && node.arguments[0] && callsStop(node.arguments[0])) found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});
function fixture(name: string, text: string): string {
  scratch = scratch ?? mkdtempSync(path.join(tmpdir(), 'handoff-no-kill-4227-'));
  const file = path.join(scratch, name);
  writeFileSync(file, text);
  return file;
}

describe('the hand-off never kills (Issue #4227, the PM’s decision)', () => {
  it('(1) nothing src/lib/handoff/** loads is a kill’s way', () => {
    const entries = files(HANDOFF_LIB);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const entry of entries) expect([repoRelative(entry), closureKillers(entry)]).toEqual([repoRelative(entry), []]);
    for (const entry of entries) expect([repoRelative(entry), killFindings(entry, readFileSync(entry, 'utf8'))]).toEqual([repoRelative(entry), []]);
  });

  it('(2) the routes call no kill; only the observation route loads the tools, and asks isRunning', () => {
    const routes = files(HANDOFF_ROUTES);
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const route of routes) {
      const module = repoRelative(route);
      expect([module, killFindings(route, readFileSync(route, 'utf8'), module === OBSERVE_ROUTE)]).toEqual([module, []]);
    }
    const observe = readFileSync(path.join(REPO_ROOT, OBSERVE_ROUTE), 'utf8');
    expect(observe).toMatch(/\.isRunning\(worktreeId, resolution\.target\.instanceId\)/);
  });

  it('(3) the dialog reaches the stop from its buttons’ handlers only, never from an effect', () => {
    const text = readFileSync(DIALOG, 'utf8');
    expect(effectsCallingStop(text)).toBe(0);
    expect(text).toMatch(/await onStop\(\)/);
    expect(effectsCallingStop('useEffect(() => { void onStop(); }, [done]);')).toBe(1);
  });

  it.each([
    ['a direct killSession(name)', "import { killSession } from '@/lib/tmux/tmux';\nexport async function end(name: string) { await killSession(name); }\n"],
    ['an aliased k(name)', "import { killSession as k } from '@/lib/tmux/tmux';\nexport async function end(name: string) { await k(name); }\n"],
    ['a namespace tmux.killSession(name)', "import * as tmux from '@/lib/tmux/tmux';\nexport async function end(name: string) { await tmux.killSession(name); }\n"],
    ['the kill-session route', "import { POST } from '@/app/api/worktrees/[id]/kill-session/route';\nexport const x = POST;\n"],
  ])('positive control: %s fails', (_name, text) => {
    const file = fixture('careless.ts', text);
    expect(killFindings(file, text).length).toBeGreaterThan(0);
    expect(killFindings(file, text, true).length).toBeGreaterThan(0);
  });

  it('negative control: a source that only reads isRunning passes (as the observation route)', () => {
    const text =
      "import { CLIToolManager } from '@/lib/cli-tools/manager';\nexport async function seen(w: string, i: string) {\n  return CLIToolManager.getInstance().getTool('claude').isRunning(w, i);\n}\n";
    expect(killFindings(fixture('observe.ts', text), text, true)).toEqual([]);
    const tool = "import { CLIToolManager } from '@/lib/cli-tools/manager';\nexport async function stop(w: string, i: string) {\n  return CLIToolManager.getInstance().getTool('claude').killSession(w, i);\n}\n";
    expect(killFindings(fixture('stop.ts', tool), tool, true)).toContain('calls .killSession(');
  });
});
