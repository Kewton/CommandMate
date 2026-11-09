/**
 * Who builds a brief, read off the TypeScript syntax of `src/`, in every form the syntax
 * allows (Issue #4224, D2 design §3, R1〜R6). Not a test file.
 *
 * `brief-call-chain.ts` (#4223) follows bare calls, imports, local aliases, re-exports and
 * namespace imports. This walker follows those and also:
 *
 *  - a port's method: an object literal whose property holds a member (`{ build }`,
 *    `{ build: buildBrief }`, `{ make: buildBrief.bind(null) }`) makes the property's name
 *    callable as `x.build(…)` — so `getBriefProvider().build(r)` and `plan.provider.build(r)`
 *    reach C's `build`;
 *  - `obj['name'](…)` as `obj.name(…)`; `ns[expr](…)` on a namespace is an unresolved reference;
 *  - dynamic imports: `(await import('m')).f(…)`, `const m = await import('m')`,
 *    `const { f: g } = await import('m')`, `import('m').then((m) => m.f(…))`;
 *  - destructuring of a namespace (`const { f: g } = ns`), `.bind` aliases, `.call` / `.apply`;
 *  - repetition outside the loop statements: a call inside a callback handed to any call
 *    not on the once-only list (`forEach`, `map`, a `withRetry`…), and mutual recursion;
 *  - a member used as a value (passed, put in an array, returned) is an unresolved
 *    reference — the walk cannot say who calls it, so it fails rather than passes (R2);
 *  - stop entrances (R4): a caller named there is listed but not followed further.
 */
import ts from 'typescript';
import path from 'path';

export interface Ref {
  module: string;
  name: string;
}

export interface WideChain {
  /** `file:function` → whether it repeats a call of the chain. */
  callers: Record<string, { retries: boolean }>;
  /** References the walk cannot resolve (R2), `file:function: what`. */
  unresolved: string[];
  names: Set<string>;
}

/** Callees that call their callback once (design §3.3 (b)): each was read to have no loop around it. */
export const ONCE_CALLEES: Readonly<Record<string, string>> = {
  withMemTarget: 'hands its callback the settled target once (lib/mem/target.ts)',
  withInstanceInputLock: 'runs the delivery once under the lock (instance-input-lock.ts)',
  runInSendScope: 'AsyncLocalStorage.run: once (session-boundary.ts)',
  withinMs: 'races one promise against a timer (brief/deadline.ts)',
  race: 'Promise.race: settles once',
  resolve: 'Promise.resolve: one value',
  all: 'Promise.all: one call per element, each its own request (no element rebuilds another)',
  then: 'one step of a chain; a then that calls back into itself is caught as recursion',
  transaction: 'better-sqlite3 db.transaction: runs once',
};

const REPEATING = new Set(['forEach', 'map', 'flatMap', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'setInterval']);

const LOOPS = new Set([ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement]);

const moduleOf = (file: string): string => file.replace(/\.(tsx?|mjs|js)$/, '').replace(/\/index$/, '');

function resolveSpecifier(specifier: string, file: string): string | null {
  if (specifier.startsWith('@/')) return moduleOf(`src/${specifier.slice(2)}`);
  if (specifier.startsWith('.')) return moduleOf(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  return null;
}

interface Call {
  name: string;
  /** Resolved through a namespace (static or dynamic), or null for a bare / property call. */
  ref: Ref | null;
  viaProperty: boolean;
  repeated: boolean;
}

interface Fn {
  key: string;
  name: string;
  calls: Call[];
  /** Identifiers used as values here (R2), by name. */
  values: string[];
  /** `ns[expr](…)` on these modules (R2). */
  dynamicNs: string[];
}

interface FileFacts {
  file: string;
  module: string;
  fns: Fn[];
  resolve(name: string): Ref;
  reexports: Array<{ name: string; target: Ref }>;
  /** `{ prop: local }`: `prop` becomes callable by property when `local` is a member. */
  registrations: Array<{ prop: string; local: string }>;
}

function importSpecifierOf(node: ts.Expression): string | null {
  let expression = node;
  if (ts.isAwaitExpression(expression)) expression = expression.expression;
  if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isAwaitExpression(expression)) expression = expression.expression;
  if (ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = expression.arguments[0];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  }
  return null;
}

function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && !ts.isComputedPropertyName(node.name)) return node.name.getText();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && !ts.isComputedPropertyName(parent.name)) return parent.name.getText();
  }
  return null;
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/** The name a callee is known by, for the once-only list (`Promise.race` → `race`). */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** Whether an identifier stands where a value is used (not called, declared, imported or typed). */
function isValueUse(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isCallExpression(parent) && parent.expression === id) return false;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name === id) return false;
    // `f.bind / call / apply`: the receiver of a known form.
    return !['bind', 'call', 'apply'].includes(parent.name.text);
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  if (ts.isVariableDeclaration(parent) && parent.initializer === id) return false; // an alias
  if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isParameter(parent)) return false;
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return false; // a registration
  if (ts.isBindingElement(parent)) return false;
  if (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isClassDeclaration(parent)) return false;
  if (ts.isExportAssignment(parent)) return false;
  return true;
}

export function analyseWide(file: string, text: string): FileFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const module = moduleOf(file);
  const aliases = new Map<string, string>();
  const imports = new Map<string, Ref>();
  const namespaces = new Map<string, string>();
  const reexports: Array<{ name: string; local?: string; target?: Ref }> = [];
  const registrations: Array<{ prop: string; local: string }> = [];
  const fns: Fn[] = [];
  const top: Fn = { key: `${file}:<module>`, name: '<module>', calls: [], values: [], dynamicNs: [] };
  const stack: Array<{ fn: Fn; repeated: number }> = [{ fn: top, repeated: 0 }];

  const nsOf = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) return namespaces.get(expression.text) ?? null;
    const specifier = importSpecifierOf(expression);
    return specifier ? resolveSpecifier(specifier, file) : null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = resolveSpecifier(node.moduleSpecifier.text, file);
      const bindings = node.importClause?.namedBindings;
      if (from && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.set(element.name.text, { module: from, name: (element.propertyName ?? element.name).text });
      }
      if (from && bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, from);
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? resolveSpecifier(node.moduleSpecifier.text, file) : null;
      for (const element of node.exportClause.elements) {
        const original = (element.propertyName ?? element.name).text;
        if (original === element.name.text && !node.moduleSpecifier) continue;
        if (from) reexports.push({ name: element.name.text, target: { module: from, name: original } });
        else if (!node.moduleSpecifier) reexports.push({ name: element.name.text, local: original });
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const exported = ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && (ts.getModifiers(node.parent.parent) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isIdentifier(node.name)) {
        if (ts.isIdentifier(init)) {
          aliases.set(node.name.text, init.text);
          if (exported) reexports.push({ name: node.name.text, local: init.text });
        } else if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'bind' && ts.isIdentifier(init.expression.expression)) {
          aliases.set(node.name.text, init.expression.expression.text);
        } else {
          const specifier = importSpecifierOf(init);
          const from = specifier ? resolveSpecifier(specifier, file) : null;
          if (from) namespaces.set(node.name.text, from);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const from = (() => {
          const specifier = importSpecifierOf(init);
          if (specifier) return resolveSpecifier(specifier, file);
          return ts.isIdentifier(init) ? namespaces.get(init.text) ?? null : null;
        })();
        if (from) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const original = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            imports.set(element.name.text, { module: from, name: original });
          }
        }
      }
    }
    // `import('m').then((m) => …)`: the parameter is the namespace.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then') {
      const specifier = importSpecifierOf(node.expression.expression);
      const from = specifier ? resolveSpecifier(specifier, file) : null;
      const callback = node.arguments[0];
      if (from && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const param = callback.parameters[0];
        if (param && ts.isIdentifier(param.name)) namespaces.set(param.name.text, from);
      }
    }
    // Object literal registrations.
    if (ts.isShorthandPropertyAssignment(node)) registrations.push({ prop: node.name.text, local: node.name.text });
    if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
      const value = node.initializer;
      if (ts.isIdentifier(value)) registrations.push({ prop: node.name.getText(), local: value.text });
      else if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === 'bind' && ts.isIdentifier(value.expression.expression)) {
        registrations.push({ prop: node.name.getText(), local: value.expression.expression.text });
      }
    }

    if (isFunctionLike(node)) {
      const own = functionName(node);
      const parent = node.parent;
      // An unnamed callback handed to a call: repeated unless the callee runs it once.
      const handedTo = !own && ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) ? calleeName(parent.expression) : null;
      const repeats = handedTo !== null && (REPEATING.has(handedTo) || !(handedTo in ONCE_CALLEES));
      if (own) {
        const className = ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name ? `${node.parent.name.text}.` : '';
        const fn: Fn = { key: `${file}:${className}${own}`, name: own, calls: [], values: [], dynamicNs: [] };
        fns.push(fn);
        stack.push({ fn, repeated: 0 });
        ts.forEachChild(node, visit);
        stack.pop();
        return;
      }
      const frame = stack[stack.length - 1];
      frame.repeated += repeats ? 1 : 0;
      ts.forEachChild(node, visit);
      frame.repeated -= repeats ? 1 : 0;
      return;
    }
    const frame = stack[stack.length - 1];
    if (LOOPS.has(node.kind)) {
      frame.repeated += 1;
      ts.forEachChild(node, visit);
      frame.repeated -= 1;
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const repeated = frame.repeated > 0;
      if (ts.isIdentifier(callee)) frame.fn.calls.push({ name: callee.text, ref: null, viaProperty: false, repeated });
      else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if ((method === 'call' || method === 'apply') && ts.isIdentifier(callee.expression)) {
          frame.fn.calls.push({ name: callee.expression.text, ref: null, viaProperty: false, repeated });
        } else {
          const ns = nsOf(callee.expression);
          frame.fn.calls.push({ name: method, ref: ns ? { module: ns, name: method } : null, viaProperty: ns === null, repeated });
        }
      } else if (ts.isElementAccessExpression(callee)) {
        const ns = nsOf(callee.expression);
        const arg = callee.argumentExpression;
        if (ts.isStringLiteralLike(arg)) frame.fn.calls.push({ name: arg.text, ref: ns ? { module: ns, name: arg.text } : null, viaProperty: ns === null, repeated });
        else if (ns) frame.fn.dynamicNs.push(ns);
      }
    }
    if (ts.isIdentifier(node) && isValueUse(node)) frame.fn.values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (top.calls.length || top.values.length || top.dynamicNs.length) fns.push(top);

  const resolve = (name: string): Ref => {
    let current = name;
    for (let hops = 0; aliases.has(current) && hops < 8; hops += 1) current = aliases.get(current)!;
    return imports.get(current) ?? { module, name: current };
  };
  return {
    file,
    module,
    fns,
    resolve,
    registrations,
    reexports: reexports.map((entry) => ({ name: entry.name, target: entry.target ?? resolve(entry.local!) })),
  };
}

/**
 * The chain of `roots` in `sources`. `stops` are callers listed but not followed (R4):
 * their own callers are covered by the send callers' walk instead.
 */
const analysed = new Map<string, FileFacts>();

/** {@link analyseWide}, parsed once per (file, text). */
function analyseCached(file: string, text: string): FileFacts {
  const key = `${file}\0${text}`;
  let facts = analysed.get(key);
  if (!facts) {
    facts = analyseWide(file, text);
    analysed.set(key, facts);
  }
  return facts;
}

export function wideChain(sources: Record<string, string>, roots: Ref[], stops: ReadonlySet<string> = new Set()): WideChain {
  const files = Object.entries(sources).map(([file, text]) => analyseCached(file, text));
  const members = new Map<string, Ref>(roots.map((root) => [`${root.module}#${root.name}`, root]));
  const byProperty = new Set<string>();
  const has = (ref: Ref) => members.has(`${ref.module}#${ref.name}`);
  const found = new Map<string, { retries: boolean; via: Set<string> }>();
  const keyOfMember = new Map<string, string>(); // module#name → caller key
  for (let grew = true; grew; ) {
    grew = false;
    for (const where of files) {
      for (const reexport of where.reexports) {
        const key = `${where.module}#${reexport.name}`;
        if (has(reexport.target) && !members.has(key)) {
          members.set(key, { module: where.module, name: reexport.name });
          grew = true;
        }
      }
      for (const registration of where.registrations) {
        if (has(where.resolve(registration.local)) && !byProperty.has(registration.prop)) {
          byProperty.add(registration.prop);
          grew = true;
        }
      }
      for (const fn of where.fns) {
        const hits = fn.calls.filter((call) => (call.ref ? has(call.ref) : call.viaProperty ? byProperty.has(call.name) : has(where.resolve(call.name))) && !(call.name === fn.name && !call.viaProperty && !call.ref));
        if (hits.length === 0) continue;
        const retries = hits.some((call) => call.repeated) || fn.calls.some((call) => call.name === fn.name && !call.viaProperty && !call.ref);
        const via = new Set(hits.map((call) => (call.ref ? `${call.ref.module}#${call.ref.name}` : call.viaProperty ? `.${call.name}` : `${where.resolve(call.name).module}#${where.resolve(call.name).name}`)));
        const previous = found.get(fn.key);
        if (!previous || previous.retries !== retries || previous.via.size !== via.size) {
          found.set(fn.key, { retries, via });
          grew = true;
        }
        const memberKey = `${where.module}#${fn.name}`;
        keyOfMember.set(memberKey, fn.key);
        if (!stops.has(fn.key) && !members.has(memberKey)) {
          members.set(memberKey, { module: where.module, name: fn.name });
          grew = true;
        }
      }
    }
  }
  // Mutual recursion: a caller on a cycle of the callers' graph repeats.
  const edges = new Map<string, string[]>();
  for (const [key, entry] of found) {
    edges.set(key, [...entry.via].map((member) => keyOfMember.get(member)).filter((k): k is string => k !== undefined && found.has(k)));
  }
  const onCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const walk = (key: string): boolean => (edges.get(key) ?? []).some((next) => next === start || (!seen.has(next) && (seen.add(next), walk(next))));
    return walk(start);
  };
  const callers: Record<string, { retries: boolean }> = {};
  for (const key of [...found.keys()].sort()) callers[key] = { retries: found.get(key)!.retries || onCycle(key) };

  const names = new Set([...members.values()].map((member) => member.name));
  const chainModules = new Set([...members.values()].map((member) => member.module));
  const unresolved: string[] = [];
  for (const where of files) {
    for (const fn of where.fns) {
      for (const value of fn.values) {
        if (has(where.resolve(value))) unresolved.push(`${fn.key}: ${value} used as a value`);
      }
      for (const ns of fn.dynamicNs) if (chainModules.has(ns)) unresolved.push(`${fn.key}: ${ns}[…] called with a computed name`);
    }
  }
  return { callers, unresolved: [...new Set(unresolved)].sort(), names: new Set([...names, ...byProperty]) };
}

/** The names that select a file (the members' names and the properties they are callable by). */
export function wideChainSources(all: Record<string, string>, roots: Ref[], stops: ReadonlySet<string> = new Set()): Record<string, string> {
  const picked: Record<string, string> = {};
  let names = new Set(roots.map((root) => root.name));
  for (let grew = true; grew; ) {
    grew = false;
    const pattern = new RegExp(`\\b(${[...names].join('|')})\\b`);
    for (const [file, text] of Object.entries(all)) {
      if (picked[file] || !pattern.test(text)) continue;
      picked[file] = text;
      grew = true;
    }
    const next = wideChain(picked, roots, stops).names;
    if ([...next].some((name) => !names.has(name))) grew = true;
    names = new Set([...names, ...next]);
  }
  return picked;
}

/**
 * Whether, in function `fn` of `text`, the call `second` follows `first` with no `await`
 * between them (the same synchronous stretch, D2 design §3.3 (e)). Null when either is absent.
 */
export function sameStretch(file: string, text: string, fn: string, first: string, second: string): boolean | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.Node | null = null;
  const find = (node: ts.Node): void => {
    if (body) return;
    if (isFunctionLike(node) && functionName(node) === fn) body = node;
    else ts.forEachChild(node, find);
  };
  find(source);
  if (!body) return null;
  const calls = new Map<string, number>();
  const awaits: number[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && !calls.has(name)) calls.set(name, node.getStart());
    }
    if (ts.isAwaitExpression(node)) awaits.push(node.getStart());
    ts.forEachChild(node, walk);
  };
  walk(body);
  const a = calls.get(first);
  const b = calls.get(second);
  if (a === undefined || b === undefined || b < a) return null;
  return !awaits.some((at) => at > a && at < b);
}

/** The calls of `name` made by a method `Class.method` of `text`. */
export function callsIn(file: string, text: string, className: string, method: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name?.text === className && functionName(node) === method) {
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner)) {
          const name = calleeName(inner.expression);
          if (name) out.push(name);
        }
        ts.forEachChild(inner, walk);
      };
      walk(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export interface SendCaller {
  /** `file:function`. */
  caller: string;
  /** The `brief` property's text, `(none)` without one, or `(unresolved: …)`. */
  brief: string;
}

/** Every call of `sendUserMessage` in `sources` (aliases followed) and the `brief` it names (R6). */
export function sendCallers(sources: Record<string, string>): SendCaller[] {
  const out: SendCaller[] = [];
  const target = { module: 'src/lib/session/send-user-message', name: 'sendUserMessage' };
  for (const [file, text] of Object.entries(sources)) {
    if (moduleOf(file) === target.module) continue;
    if (!/\bsendUserMessage\b/.test(text)) continue;
    const facts = analyseCached(file, text);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const stack: string[] = ['<module>'];
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && functionName(node)) {
        stack.push(functionName(node)!);
        ts.forEachChild(node, visit);
        stack.pop();
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const ref = facts.resolve(node.expression.text);
        if (ref.module === target.module && ref.name === target.name) {
          let params = node.arguments[1];
          while (params && (ts.isAsExpression(params) || ts.isParenthesizedExpression(params) || ts.isSatisfiesExpression(params))) params = params.expression;
          let brief = '(unresolved: not an object literal)';
          if (params && ts.isObjectLiteralExpression(params)) {
            const spread = params.properties.find((property) => ts.isSpreadAssignment(property));
            const property = params.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'brief');
            if (spread) brief = '(unresolved: spread)';
            else if (!property) brief = '(none)';
            else brief = ts.isPropertyAssignment(property) ? property.initializer.getText() : '(unresolved: shorthand)';
          }
          out.push({ caller: `${file}:${stack[stack.length - 1]}`, brief });
        }
      }
      // A value use of the function (handed elsewhere) cannot be followed.
      if (ts.isIdentifier(node) && isValueUse(node)) {
        const ref = facts.resolve(node.text);
        if (ref.module === target.module && ref.name === target.name) out.push({ caller: `${file}:${stack[stack.length - 1]}`, brief: '(unresolved: used as a value)' });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out.sort((a, b) => (a.caller < b.caller ? -1 : a.caller > b.caller ? 1 : 0));
}
