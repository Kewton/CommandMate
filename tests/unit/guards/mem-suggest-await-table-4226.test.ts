/**
 * I-F13 (Issue #4226, design `docs/design/mem-prompt-4226.md` §3.6・§7.3): the awaits of
 * the prompts are the design's table, and INV-A holds by construction.
 *
 *  (1) Every `await` of `src/lib/mem-suggest/**` is `await step('<id>', () => …)` with an
 *      id of `MEM_SUGGEST_AWAITS`; no `.then(`/`.catch(`/`.finally(`; no function hands
 *      a promise on without awaiting it, save the arrows given to `step` and the one
 *      named helper `runStep` (the step itself); no `void` of a promise.
 *      The route has its own rule (P2-1): `await params`, then the body (`readMemBody`,
 *      W1), then `memSuggest`, and nothing after it but `return NextResponse.json(…)`.
 *  (2) Every key of the table is used (the table and the source agree).
 *  (3) `settleShown`, `readShown`, the rules (`judgeSuggestions`) and the quiet line
 *      (`formatQuietLine`) are called only from the build handed to `withMemTarget` in
 *      `step('W5', …)`, helpers included (the call chain is followed).
 *  (4) That build is not `async` and returns no promise.
 *
 * Read with the TypeScript type checker (the return types decide what is a promise).
 * The controls run the same checks on changed copies written under a `mkdtemp`
 * directory (removed after each test) and read back; the repository's files are not
 * touched (the copies are handed to the compiler in memory, at the path they replace,
 * so their imports resolve as the original's do).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

const ROOT = process.cwd();
const SERVICE = path.join(ROOT, 'src/lib/mem-suggest/service.ts');
const ROUTE = path.join(ROOT, 'src/app/api/worktrees/[id]/mem/suggest/route.ts');
const LIB_FILES = ['service.ts', 'rules.ts', 'fingerprint.ts'].map((name) => path.join(ROOT, 'src/lib/mem-suggest', name));
const RESTRICTED = new Set(['settleShown', 'readShown', 'judgeSuggestions', 'formatQuietLine']);
const STEP_HELPER = 'runStep';
const ENTRANCES = new Set(['memSuggest']);

const parsedConfig = (() => {
  const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
})();

let lastProgram: ts.Program | undefined;

/** A program over the real files, with some of them replaced in memory. */
function programWith(overrides: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { ...parsedConfig.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => overrides[path.resolve(file)] ?? readFile(file);
  host.getSourceFile = (file, language, onError, create) => {
    const replaced = overrides[path.resolve(file)];
    if (replaced !== undefined) return ts.createSourceFile(file, replaced, language, true);
    return getSourceFile(file, language, onError, create);
  };
  lastProgram = ts.createProgram([...LIB_FILES, ROUTE], options, host, lastProgram);
  return lastProgram;
}

const isFunctionNode = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

function nameOf(node: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

function isPromise(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((part) => isPromise(checker, part));
  return type.getSymbol()?.getName() === 'Promise';
}

function returnsPromise(checker: ts.TypeChecker, node: ts.FunctionLikeDeclaration): boolean {
  const signature = checker.getSignatureFromDeclaration(node);
  return signature ? isPromise(checker, checker.getReturnTypeOfSignature(signature)) : false;
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

/** `step('Wn', arrow)`: the id, or null. */
function stepId(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'step' || !ts.isIdentifier(node.expression)) return null;
  const [id] = node.arguments;
  return id && ts.isStringLiteral(id) ? id.text : null;
}

/** The keys of `MEM_SUGGEST_AWAITS` as the source writes them. */
function tableKeys(source: ts.SourceFile): string[] {
  let keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'MEM_SUGGEST_AWAITS' && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) keys = init.properties.map((p) => (p.name ? p.name.getText().replace(/['"]/g, '') : ''));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current && !isFunctionNode(current)) current = current.parent;
  return current ?? null;
}

const where = (node: ts.Node) => {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(ROOT, source.fileName)}:${line + 1}`;
};

/** The route's rule (P2-1). */
function routeViolations(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const awaits: string[] = [];
  walk(source, (node) => {
    if (ts.isAwaitExpression(node)) {
      const operand = node.expression;
      awaits.push(ts.isCallExpression(operand) ? `${calleeName(operand)}()` : operand.getText());
    }
    if (ts.isForOfStatement(node) && node.awaitModifier) out.push(`for await in the route at ${where(node)}`);
    if (ts.isCallExpression(node) && ['then', 'catch', 'finally'].includes(calleeName(node) ?? '') && ts.isPropertyAccessExpression(node.expression)) {
      out.push(`.${calleeName(node)}( in the route at ${where(node)}`);
    }
  });
  if (awaits.join(' → ') !== 'params → readMemBody() → memSuggest()') out.push(`route awaits: ${awaits.join(' → ')}`);
  walk(source, (node) => {
    if (!ts.isVariableStatement(node) || !node.getText().includes('await memSuggest(')) return;
    const block = node.parent;
    if (!ts.isBlock(block)) return;
    const after = block.statements.slice(block.statements.indexOf(node) + 1);
    const allowed = after.length === 1 && ts.isReturnStatement(after[0]) && /^return NextResponse\.json\(/.test(after[0].getText());
    if (!allowed) out.push(`after memSuggest: ${after.map((s) => s.getText().split('\n')[0]).join(' | ')}`);
  });
  return out;
}

export interface TableFindings {
  violations: string[];
  unusedKeys: string[];
}

/** Every check of (1)〜(4) on the sources as given (overrides by absolute path). */
function analyze(overrides: Record<string, string> = {}): TableFindings {
  const program = programWith(overrides);
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const serviceFile = program.getSourceFile(SERVICE) as ts.SourceFile;
  const keys = tableKeys(serviceFile);
  const used = new Set<string>();

  for (const file of LIB_FILES) {
    const source = program.getSourceFile(file) as ts.SourceFile;
    walk(source, (node) => {
      if (ts.isAwaitExpression(node)) {
        const id = stepId(node.expression);
        if (id === null) violations.push(`await not through step at ${where(node)}`);
        else if (!keys.includes(id)) violations.push(`step('${id}') is not in MEM_SUGGEST_AWAITS at ${where(node)}`);
      }
      if (ts.isForOfStatement(node) && node.awaitModifier) violations.push(`for await at ${where(node)}`);
      const id = stepId(node);
      if (id !== null) used.add(id);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['then', 'catch', 'finally'].includes(node.expression.name.text)) {
        violations.push(`.${node.expression.name.text}( at ${where(node)}`);
      }
      if (ts.isVoidExpression(node) && isPromise(checker, checker.getTypeAtLocation(node.expression))) violations.push(`void of a promise at ${where(node)}`);
      if (isFunctionNode(node) && returnsPromise(checker, node)) {
        const name = nameOf(node);
        const isStepArrow = ts.isCallExpression(node.parent) && stepId(node.parent) !== null && node.parent.arguments[1] === node;
        if (!isStepArrow && !(name !== null && (ENTRANCES.has(name) || name === STEP_HELPER))) {
          violations.push(`a promise handed on by ${name ?? 'an anonymous function'} at ${where(node)}`);
        }
      }
    });
  }

  // (3)(4): the build of W5 and what it reaches.
  const builds: ts.Node[] = [];
  walk(serviceFile, (node) => {
    if (stepId(node) !== 'W5') return;
    walk(node, (inner) => {
      if (ts.isCallExpression(inner) && calleeName(inner) === 'withMemTarget' && inner.arguments[3]) builds.push(inner.arguments[3]);
    });
  });
  if (builds.length === 0) violations.push('no build is handed to withMemTarget in step(W5)');
  const reachable = new Set<ts.Node>();
  const queue: ts.Node[] = [];
  const declarationOf = (identifier: ts.Identifier): ts.Node | null => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile() !== serviceFile) return null;
    if (isFunctionNode(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionNode(declaration.initializer)) return declaration.initializer;
    return null;
  };
  for (const build of builds) {
    const node = ts.isIdentifier(build) ? declarationOf(build) : build;
    if (!node) continue;
    if (isFunctionNode(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) violations.push(`the W5 build is async at ${where(node)}`);
    if (isFunctionNode(node) && returnsPromise(checker, node)) violations.push(`the W5 build returns a promise at ${where(node)}`);
    reachable.add(node);
    queue.push(node);
  }
  while (queue.length > 0) {
    walk(queue.pop() as ts.Node, (inner) => {
      if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return;
      const target = declarationOf(inner.expression);
      if (target && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    });
  }
  const insideReachable = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (reachable.has(current)) return true;
    return false;
  };
  for (const file of LIB_FILES) {
    const source = program.getSourceFile(file) as ts.SourceFile;
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !RESTRICTED.has(calleeName(node) ?? '')) return;
      if (!insideReachable(node)) violations.push(`${calleeName(node)} outside the W5 build at ${where(node)}`);
      // A helper the build reaches may not be called from outside it as well.
      const owner = enclosingFunction(node);
      const ownerName = owner ? nameOf(owner) : null;
      if (ownerName === null || !owner) return;
      walk(serviceFile, (ref) => {
        if (ts.isCallExpression(ref) && ts.isIdentifier(ref.expression) && ref.expression.text === ownerName && !insideReachable(ref)) {
          violations.push(`${ownerName} (calls ${calleeName(node)}) is called outside the W5 build at ${where(ref)}`);
        }
      });
    });
  }

  const route = program.getSourceFile(ROUTE) as ts.SourceFile;
  const routeFindings = routeViolations(route);
  violations.push(...routeFindings);
  if (routeFindings.length === 0) used.add('W1');
  return { violations, unusedKeys: keys.filter((key) => !used.has(key)) };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mem-suggest-await-table-4226-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A changed copy of a source, written under the sandbox and read back. */
function changed(file: string, from: string, to: string): Record<string, string> {
  const source = readFileSync(file, 'utf8');
  expect(source.includes(from), from).toBe(true);
  const copy = path.join(dir, path.basename(file));
  writeFileSync(copy, source.replace(from, to));
  return { [file]: readFileSync(copy, 'utf8') };
}

describe('I-F13: the awaits of the prompts are the table, and INV-A holds', () => {
  it('the sources pass: every await is a step of the table, every key is used, the record is in the W5 build only', () => {
    const findings = analyze();
    expect(findings.violations).toEqual([]);
    expect(findings.unusedKeys).toEqual([]);
  }, 60_000);

  it('(negative control) a synchronous read-only helper outside the build (the fingerprint) is no violation', () => {
    const findings = analyze(
      changed(SERVICE, '  const step = deps.step ?? runStep;', "  const step = deps.step ?? runStep;\n  suggestionFingerprint('x', []);")
    );
    expect(findings.violations).toEqual([]);
  }, 60_000);
});

describe('(self-test) the checks fail on what they forbid', () => {
  it('a bare await (the branch listing awaited outside step)', () => {
    const findings = analyze(
      changed(SERVICE, '    const branches = branchesOf(listing);', '    await deps.listBranches?.(fixed.worktreePath);\n    const branches = branchesOf(listing);')
    );
    expect(findings.violations.some((v) => v.startsWith('await not through step'))).toBe(true);
  }, 60_000);

  it("a step that is not in the table (step('W9'))", () => {
    const findings = analyze(changed(SERVICE, "const listing = await step('W2',", "const listing = await step('W9',"));
    expect(findings.violations.some((v) => v.includes("step('W9')"))).toBe(true);
    expect(findings.unusedKeys).toEqual(['W2']);
  }, 60_000);

  it('a key of the table no await uses', () => {
    const findings = analyze(
      changed(SERVICE, "  W5: { await: 'withMemTarget (the closing", "  W6: { await: 'unused', paths: ['quiet'], position: 'nowhere' },\n  W5: { await: 'withMemTarget (the closing")
    );
    expect(findings.unusedKeys).toEqual(['W6']);
  }, 60_000);

  it('settleShown after W5 returned (outside the build)', () => {
    const findings = analyze(
      changed(
        SERVICE,
        '    const answer = await step(\'W5\', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));\n    return answer;',
        "    const answer = await step('W5', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));\n    settleShown(db, { worktreeId, instanceId: '', scopeHash: '', write: [], clear: [], rosterInstanceIds: [], knownCodes: [], liveScopeHashes: new Set() });\n    return answer;"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('settleShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('readShown in the build of W3 (outside the W5 build)', () => {
    const findings = analyze(
      changed(SERVICE, '  return { target: outcome, registration: registrationOf(db) };', "  readShown(db, fixed.worktreeId, 'claude', '');\n  return { target: outcome, registration: registrationOf(db) };")
    );
    expect(findings.violations.some((v) => v.startsWith('readShown outside the W5 build'))).toBe(true);
  }, 60_000);

  it('an async build', () => {
    const findings = analyze(
      changed(SERVICE, "(outcome) => closeRequest({ db, fixed, branches }, outcome)", 'async (outcome) => closeRequest({ db, fixed, branches }, outcome)')
    );
    expect(findings.violations.some((v) => v.startsWith('the W5 build is async'))).toBe(true);
  }, 60_000);

  it('a helper that hands a promise on without awaiting it, and a .then(', () => {
    const findings = analyze(
      changed(
        SERVICE,
        'function registrationOf(db: Database.Database): string {',
        "function later(): Promise<number> {\n  return Promise.resolve(1).then((n) => n);\n}\n\nfunction registrationOf(db: Database.Database): string {"
      )
    );
    expect(findings.violations.some((v) => v.startsWith('a promise handed on by later'))).toBe(true);
    expect(findings.violations.some((v) => v.startsWith('.then('))).toBe(true);
  }, 60_000);

  it('the route: an await after memSuggest, or something other than the JSON answer after it', () => {
    const findings = analyze(
      changed(
        ROUTE,
        '    return NextResponse.json(outcome.body, { status: outcome.status });\n  } catch',
        '    await Promise.resolve();\n    return NextResponse.json(outcome.body, { status: outcome.status });\n  } catch'
      )
    );
    expect(findings.violations.some((v) => v.startsWith('route awaits:'))).toBe(true);
    expect(findings.violations.some((v) => v.startsWith('after memSuggest:'))).toBe(true);
    expect(findings.unusedKeys).toEqual(['W1']);
  }, 60_000);
});
