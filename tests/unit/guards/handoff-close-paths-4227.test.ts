/**
 * Every path that makes the hand-off dialog go away asks the one rule (Issue #4227 G-PR2 pr2d,
 * design `mem-ui-4227.md` §4.1.1, the PM's condition 1 in `pm-return-4227-pr2c-codex.md`).
 *
 * The invariant (a decide being sent or unknown is never dropped without the person's choice,
 * and the dialog stays while there is one) holds only if no path goes round the rule. A new
 * path that does fails here:
 *
 * 1. In the dialog (`SessionHandoffDialog.tsx`) `onClose` is called in one place only, `closeBy`,
 *    which asks `askHandoffClose`; `onClose` is handed to nothing else (no `onClose={onClose}`).
 *    The unknown unit is cleared (`keepPending(null)`) only where the person chose: a decide's
 *    answer and the drop button.
 * 2. In the page's hook (`useWorktreeDetailController.ts`) the hand-off target is cleared
 *    (`setHandoffTarget(null)`) in one place only, `closeHandoffBy`, which asks `askHandoffClose`;
 *    it is set in `openHandoff` only, and every caller of `openHandoff` asks `closeHandoffBy` first.
 * 3. The paths named at the call sites are exactly `HANDOFF_CLOSE_PATHS` (no path declared and
 *    unused, none used and undeclared).
 * 4. The pages hand the dialog the hook's `closeHandoff` (directly, or as `onHandoffClose`).
 *
 * Positive controls: copies of the real sources under `os.tmpdir()` with one way round the rule
 * added (an effect that clears the target, a button that calls `onClose`, a reopening that clears
 * the unit, an undeclared path) each fail; the copies as they are pass.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HANDOFF_CLOSE_PATHS } from '@/lib/handoff/close-rule';

const ROOT = path.resolve(__dirname, '../../..');
const DIALOG = 'src/components/mem/SessionHandoffDialog.tsx';
const HOOK = 'src/hooks/useWorktreeDetailController.ts';
const PAGES = ['src/components/worktree/WorktreeDetailDesktop.tsx', 'src/components/worktree/WorktreeDetailRefactored.tsx'];

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

/** The problems found in the dialog's source (empty: it follows the rule). */
function checkDialog(source: string): string[] {
  const problems: string[] = [];
  const sites = callSites(source, 'dialog.tsx');
  const closes = sites.filter((site) => site.callee === 'onClose');
  if (closes.length !== 1) problems.push(`onClose is called ${closes.length} times (expected once, in closeBy)`);
  for (const site of closes) {
    if (site.owner !== 'closeBy') problems.push(`onClose called in ${site.owner ?? 'the top level'}, not closeBy`);
    if (!site.ownerText.includes('askHandoffClose(')) problems.push('closeBy does not ask askHandoffClose');
  }
  if (/=\{\s*onClose\s*\}/.test(source)) problems.push('onClose is handed on as a prop (round the rule)');
  const clears = sites.filter((site) => site.callee === 'keepPending' && site.args[0] === 'null');
  for (const site of clears) {
    const isDrop = site.jsx?.attribute === 'onClick' && site.jsx.tag.includes('data-testid="handoff-pending-drop"');
    if (site.owner !== 'decide' && !isDrop) {
      problems.push(`keepPending(null) in ${site.owner ?? 'the top level'}: only a decide's answer and the drop clear the unit`);
    }
  }
  if (clears.length !== 2) problems.push(`keepPending(null) appears ${clears.length} times (expected 2: a decide's answer, the drop)`);
  return problems;
}

/** The problems found in the hook's source. */
function checkHook(source: string): string[] {
  const problems: string[] = [];
  const sites = callSites(source, 'hook.ts');
  const sets = sites.filter((site) => site.callee === 'setHandoffTarget');
  for (const site of sets) {
    if (site.args[0] === 'null') {
      if (site.owner !== 'closeHandoffBy') problems.push(`setHandoffTarget(null) in ${site.owner ?? 'the top level'}, not closeHandoffBy`);
      else if (!site.ownerText.includes('askHandoffClose(')) problems.push('closeHandoffBy does not ask askHandoffClose');
    } else if (site.owner !== 'openHandoff') {
      problems.push(`setHandoffTarget(${site.args[0]}) in ${site.owner ?? 'the top level'}, not openHandoff`);
    }
  }
  if (sets.filter((site) => site.args[0] === 'null').length !== 1) problems.push('setHandoffTarget(null) must appear once, in closeHandoffBy');
  for (const site of sites.filter((call) => call.callee === 'openHandoff')) {
    if (!site.before.includes("closeHandoffBy('page-end')")) problems.push(`openHandoff in ${site.owner} without closeHandoffBy('page-end') first`);
  }
  return problems;
}

/** The path names used at the call sites of the two sources. */
function usedPaths(...sources: string[]): Set<string> {
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\b(?:closeBy|closeHandoffBy|askHandoffClose)\('([a-z-]+)'/g)) used.add(match[1]);
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

  it('the page: the target cleared only in closeHandoffBy (which asks the rule), set only in openHandoff after it', () => {
    expect(checkHook(read(HOOK))).toEqual([]);
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
    const dialog = mutated(DIALOG, "if (!closeBy('plain-stop-done')) setPlainStopped(true);", 'onClose();');
    expect(checkDialog(dialog).join('\n')).toMatch(/onClose called in plainStop/);
  });

  it('an opening that clears the unit (the code before pr2c / pr2d) fails', () => {
    const dialog = mutated(DIALOG, 'setOpenedFor(worktreeId);', 'setOpenedFor(worktreeId);\n    if (pendingRef.current && pendingRef.current.worktreeId !== worktreeId) keepPending(null);');
    const problems = checkDialog(dialog).join('\n');
    expect(problems).toMatch(/keepPending\(null\) in SessionHandoffDialog: only/);
    expect(problems).toMatch(/appears 3 times/);
  });

  it('a path named at a call site but not declared fails', () => {
    const hook = mutated(HOOK, "closeHandoffBy('worktree-switch');", "closeHandoffBy('route-change');");
    expect(checkPaths(read(DIALOG), hook).join('\n')).toMatch(/'route-change' is used but not declared/);
  });
});
