/**
 * Who builds a brief, read off the TypeScript syntax of `src/` (Issue #4223, codex-2
 * re-review P2 and PM re-review P3-2, 2026-11-09). Not a test file.
 *
 * Starting from `buildBrief`, every function whose body calls one already found joins
 * the chain, until nothing new is found — so a wrapper of a wrapper (the API around
 * `briefForRoute`) is a caller too. A function is any of: a function declaration, an
 * arrow function or function expression bound to a name (`const f = () => …`, an object
 * property), a class or object method. A call counts through an import alias
 * (`import { buildBrief as make }`), a local alias (`const make = buildBrief`), a
 * re-export alias, and `obj.name(…)` for a name that is a top-level function or method.
 * A call inside a loop (`for` / `while` / `do`), or a function that calls itself, is a
 * rebuild.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

export interface ChainCaller {
  /** Whether it calls a member of the chain inside a loop, or calls itself. */
  retries: boolean;
}

interface FunctionFacts {
  key: string;
  name: string;
  /** Reachable as `obj.name(…)` from elsewhere (a top-level function or a method). */
  public: boolean;
  /** Called names (resolved through aliases), with whether the call is inside a loop. */
  calls: Array<{ name: string; viaProperty: boolean; inLoop: boolean }>;
}

const LOOPS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

function nameOf(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name && !ts.isComputedPropertyName(node.name) ? node.name.getText() : null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && !ts.isComputedPropertyName(parent.name)) return parent.name.getText();
    if (ts.isPropertyDeclaration(parent) && !ts.isComputedPropertyName(parent.name)) return parent.name.getText();
    return null;
  }
  return null;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Whether a function is reachable by name from another module or object. */
function isPublic(node: ts.Node): boolean {
  if (ts.isMethodDeclaration(node)) return true;
  if (ts.isFunctionDeclaration(node)) return ts.isSourceFile(node.parent);
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return true;
  if (ts.isVariableDeclaration(parent)) return ts.isSourceFile(parent.parent.parent.parent);
  return false;
}

interface FileFacts {
  file: string;
  functions: FunctionFacts[];
  /** Names this file imports (their original names, aliases resolved). */
  imported: Set<string>;
  /** `export { a as b } from …`: b → a. */
  reexports: Map<string, string>;
}

export function analyseFile(file: string, text: string): FileFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = new Map<string, string>(); // local name → original name
  const reexports = new Map<string, string>(); // exported name → original name
  const imported = new Set<string>();
  const functions: FunctionFacts[] = [];
  const stack: Array<{ facts: FunctionFacts | null; loopDepth: number }> = [{ facts: null, loopDepth: 0 }];

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      imported.add((node.propertyName ?? node.name).text);
      if (node.propertyName) aliases.set(node.name.text, node.propertyName.text);
    }
    if (ts.isExportSpecifier(node) && node.propertyName) reexports.set(node.name.text, node.propertyName.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      aliases.set(node.name.text, node.initializer.text);
    }
    if (isFunctionLike(node)) {
      const own = nameOf(node);
      const className = ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name ? `${node.parent.name.text}.` : '';
      if (own) {
        const facts: FunctionFacts = { key: `${file}:${className}${own}`, name: own, public: isPublic(node), calls: [] };
        functions.push(facts);
        stack.push({ facts, loopDepth: 0 });
        ts.forEachChild(node, visit);
        stack.pop();
        return;
      }
      // An unnamed function (a callback): its calls belong to the function around it.
    }
    const top = stack[stack.length - 1];
    if (LOOPS.has(node.kind)) {
      top.loopDepth += 1;
      ts.forEachChild(node, visit);
      top.loopDepth -= 1;
      return;
    }
    if (ts.isCallExpression(node) && top.facts) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) top.facts.calls.push({ name: callee.text, viaProperty: false, inLoop: top.loopDepth > 0 });
      else if (ts.isPropertyAccessExpression(callee)) top.facts.calls.push({ name: callee.name.text, viaProperty: true, inLoop: top.loopDepth > 0 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolve = (name: string): string => {
    let current = name;
    for (let hops = 0; aliases.has(current) && hops < 8; hops += 1) current = aliases.get(current)!;
    return current;
  };
  for (const facts of functions) for (const call of facts.calls) if (!call.viaProperty) call.name = resolve(call.name);
  return { file, functions, imported, reexports };
}

/** Every caller of `root` in `sources`, directly or through the chain, keyed `file:function`. */
export function briefCallChain(sources: Record<string, string>, root = 'buildBrief'): Record<string, ChainCaller> {
  const analysed = Object.entries(sources).map(([file, text]) => analyseFile(file, text));
  /** Members of the chain: the root, and every caller found. */
  const members: Array<{ file: string | null; name: string; public: boolean }> = [{ file: null, name: root, public: true }];
  const isMember = (where: FileFacts, call: FunctionFacts['calls'][number]): boolean =>
    members.some((member) => {
      if (member.name !== call.name) return false;
      if (call.viaProperty) return member.public;
      // A bare call names a function of this file, or one this file imports.
      return member.file === where.file || (member.public && where.imported.has(call.name));
    });
  const found = new Map<string, ChainCaller>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const where of analysed) {
      for (const [exported, original] of where.reexports) {
        if (members.some((member) => member.public && member.name === original) && !members.some((member) => member.name === exported)) {
          members.push({ file: where.file, name: exported, public: true });
          grew = true;
        }
      }
      for (const facts of where.functions) {
        const hits = facts.calls.filter((call) => isMember(where, call) && call.name !== facts.name);
        if (hits.length === 0) continue;
        const retries = hits.some((call) => call.inLoop) || facts.calls.some((call) => call.name === facts.name && !call.viaProperty);
        const previous = found.get(facts.key);
        if (!previous || previous.retries !== retries) {
          found.set(facts.key, { retries });
          grew = true;
        }
        if (!members.some((member) => member.file === where.file && member.name === facts.name)) {
          members.push({ file: where.file, name: facts.name, public: facts.public });
          grew = true;
        }
      }
    }
  }
  return Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function sourcesUnder(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) sourcesUnder(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The files of `src/` that could be in the chain: grown by the names found, so only those
 * that name a member are parsed (the whole of `src/` is read as text).
 */
export function chainSources(root = path.join(process.cwd(), 'src'), seed = 'buildBrief'): Record<string, string> {
  const texts = new Map(sourcesUnder(root).map((file) => [path.relative(process.cwd(), file).split(path.sep).join('/'), readFileSync(file, 'utf8')]));
  const picked: Record<string, string> = {};
  let names = new Set([seed]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, text] of texts) {
      if (picked[file] || ![...names].some((name) => text.includes(name))) continue;
      picked[file] = text;
      grew = true;
    }
    const next = new Set([seed, ...Object.keys(briefCallChain(picked, seed)).map((key) => key.slice(key.lastIndexOf(':') + 1).split('.').pop()!)]);
    if (next.size !== names.size) grew = true;
    names = next;
  }
  return picked;
}
