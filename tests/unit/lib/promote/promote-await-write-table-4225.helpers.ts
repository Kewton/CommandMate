/**
 * Reading the promote service for its awaits and its writes (Issue #4225, design §11.1):
 * the two rules I1 (the generation is fixed before an entrance's first await and never
 * taken again) and I2 (a write that changes an operation's state is conditional on the
 * state as read) are kept by a table in the design, and this reads the source the table
 * must match. Pure functions of the source text, so a control can feed a changed copy.
 */
import ts from 'typescript';

/** What the service may call that writes (the database, the worktree's lifetime, A, outside). */
export const WRITES = new Set([
  // mem-promote-db
  'insertPromotePreview',
  'invalidatePromotePreview',
  'claimPromoteOperation',
  'settlePromoteOperation',
  'beginPromoteTransition',
  'finishPromoteTransition',
  'acknowledgePromoteTransition',
  'abandonPromoteOperation',
  'settleStalePromoteAttempts',
  'prunePromoteRecords',
  // the worktree's lifetime
  'getOrCreateWorktreeIncarnation',
  // A's entrance
  'memSettleDecisionTransition',
  // outside
  'writeDocBlock',
  'postGhComment',
]);

/** What the service may call from the same modules that only reads. */
export const READS = new Set([
  'destinationOf',
  'docOperationsFor',
  'getPromoteOperation',
  'getPromotePreview',
  'hasActivePromoteOperation',
  'listPromoteOperations',
  'listUnresolvedPromoteOperations',
  'recordedOperationIds',
  'getMemRecord',
  'listMem',
  'memModeOnFor',
  'getWorktreeById',
  'getWorktreesByRepository',
  'getRepositoryById',
  'resolveWorktreeIdWithAlias',
  'getWorktreeIncarnation',
  'worktreeIncarnationAlive',
  'docBlockOf',
  'reconcileDocBlock',
  'defaultGhRun',
  'fixedTokenEnv',
  'listGhComments',
  'readGhIssue',
  'readGhToken',
  'readGhUser',
]);

/** The modules whose value imports must each be classified (a new one fails until it is). */
export const WATCHED_MODULES = [
  '@/lib/db/mem-promote-db',
  '@/lib/db/mem-db',
  '@/lib/db/mem-close-db',
  '@/lib/db/worktree-db',
  '@/lib/db/db-repository',
  '@/lib/db/worktree-alias-db',
  '@/lib/mem/incarnation',
  '@/lib/mem/service',
  './doc-write',
  './github-write',
];

export interface Row {
  fn: string;
  kind: 'await' | 'write';
  callee: string;
}

export interface ServiceReading {
  rows: Row[];
  /** Value imports of the watched modules that are neither a write nor a read. */
  unclassified: string[];
  /** SQL the service runs itself that is not a SELECT. */
  rawWrites: string[];
  /** Per function: the offset of its first await (null when none) and of each `getOrCreateWorktreeIncarnation`. */
  timing: Map<string, { body: string; start: number; firstAwait: number | null; fixes: number[] }>;
  /** The exported async functions (the entrances). */
  entrances: string[];
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

export function readService(source: string): ServiceReading {
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const rows: Row[] = [];
  const unclassified: string[] = [];
  const rawWrites: string[] = [];
  const timing: ServiceReading['timing'] = new Map();
  const entrances: string[] = [];

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!WATCHED_MODULES.includes(statement.moduleSpecifier.text)) continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) unclassified.push(`* as ${clause.namedBindings.name.text}`);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const name = (element.propertyName ?? element.name).text;
          if (!WRITES.has(name) && !READS.has(name)) unclassified.push(name);
          else if (element.propertyName) unclassified.push(`${name} as ${element.name.text}`);
        }
      }
    }
  }

  const visitFunction = (name: string, node: ts.Node) => {
    const entry = { body: node.getText(file), start: node.getStart(file), firstAwait: null as number | null, fixes: [] as number[] };
    timing.set(name, entry);
    const walk = (child: ts.Node) => {
      if (ts.isAwaitExpression(child)) {
        const expression = child.expression;
        const callee = ts.isCallExpression(expression) ? flat(expression.expression.getText(file)) : flat(expression.getText(file));
        rows.push({ fn: name, kind: 'await', callee });
        if (entry.firstAwait === null || child.getStart(file) < entry.firstAwait) entry.firstAwait = child.getStart(file);
      }
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        if (ts.isIdentifier(callee) && WRITES.has(callee.text)) {
          rows.push({ fn: name, kind: 'write', callee: callee.text });
          if (callee.text === 'getOrCreateWorktreeIncarnation') entry.fixes.push(child.getStart(file));
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          ['prepare', 'exec'].includes(callee.name.text) &&
          !(child.arguments[0] && /^\s*SELECT\b/i.test(child.arguments[0].getText(file).replace(/^[`'"]/, '')))
        ) {
          rawWrites.push(flat(child.getText(file)).slice(0, 80));
        }
      }
      ts.forEachChild(child, walk);
    };
    ts.forEachChild(node, walk);
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      visitFunction(statement.name.text, statement);
      const modifiers = ts.getModifiers(statement) ?? [];
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        entrances.push(statement.name.text);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) visitFunction(declaration.name.text, declaration.initializer);
      }
    }
  }
  return { rows, unclassified, rawWrites, timing, entrances: entrances.sort() };
}

/** `fn|kind|callee` → how many times. */
export function countRows(rows: readonly Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.fn}|${row.kind}|${row.callee}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** The markdown table between `<!-- name:start -->` and `<!-- name:end -->`, as cells without the header. */
export function tableOf(markdown: string, name: string): string[][] {
  const start = markdown.indexOf(`<!-- ${name}:start -->`);
  const end = markdown.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) return [];
  return markdown
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split(' | ')
        .map((cell) => cell.trim().replace(/^`|`$/g, ''))
    );
}

/** The design's await/write table as counts (columns: function, kind, callee, count, rule). */
export function documentedCounts(markdown: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [fn, kind, callee, n] of tableOf(markdown, 'promote-await-write')) out.set(`${fn}|${kind}|${callee}`, Number(n));
  return out;
}

/** Where the counts differ: what the source has that the table does not, and the reverse. */
export function diffCounts(source: Map<string, number>, documented: Map<string, number>): string[] {
  const keys = new Set([...source.keys(), ...documented.keys()]);
  return [...keys].filter((key) => source.get(key) !== documented.get(key)).map((key) => `${key}: source ${source.get(key) ?? 0}, table ${documented.get(key) ?? 0}`).sort();
}

/**
 * I1 against the source: every `getOrCreateWorktreeIncarnation` of a function comes before
 * its first await (never taken again after one), and each entrance's fixed value named in
 * the generation table is read before its first await.
 */
export function generationViolations(reading: ServiceReading, generation: string[][]): string[] {
  const out: string[] = [];
  for (const [fn, entry] of reading.timing) {
    for (const at of entry.fixes) if (entry.firstAwait !== null && at > entry.firstAwait) out.push(`${fn}: the lifetime is taken after an await`);
  }
  const named = new Set(generation.map(([fn]) => fn));
  for (const fn of reading.entrances) if (!named.has(fn)) out.push(`${fn}: no row in the generation table`);
  for (const [fn, fixed] of generation) {
    const entry = reading.timing.get(fn);
    if (!entry) {
      out.push(`${fn}: not in the source`);
      continue;
    }
    if (fixed === '—') {
      if (entry.fixes.length > 0) out.push(`${fn}: takes a lifetime the table says it has none`);
      continue;
    }
    const at = entry.body.indexOf(fixed);
    if (at < 0) out.push(`${fn}: does not read ${fixed}`);
    else if (entry.firstAwait !== null && entry.start + at > entry.firstAwait) out.push(`${fn}: ${fixed} after the first await`);
  }
  return out.sort();
}

/**
 * I2 against the store: every UPDATE of an operation is conditional on its state, and every
 * one that changes the transition is conditional on the transition as read.
 */
export function conditionalWriteViolations(dbSource: string): string[] {
  const out: string[] = [];
  // The SQL is written in backticks or double quotes; its literals in single quotes.
  for (const match of dbSource.matchAll(/UPDATE mem_promote_operations SET([\s\S]*?)WHERE([\s\S]*?)[`"]/g)) {
    const [, set, where] = match;
    if (!/\bstate\s*(=|IN)/.test(where)) out.push(`no state condition: ${flat(where)}`);
    if (/transition_(pending|reason|claim)\s*=/.test(set) && !/transition_(pending|claim)\s*(=|IS)/.test(where)) {
      out.push(`a transition written without the transition read: ${flat(where)}`);
    }
    if (/transition_reason\s*=\s*\?/.test(set) && !/transition_claim\s*=\s*\?/.test(where)) {
      out.push(`a reason written without the request's claim: ${flat(where)}`);
    }
  }
  return out;
}

/**
 * The conditional writes (CAS) whose result says whether the write held (§11.1 I2 as
 * strengthened in 5-2e): the store's and the service's own wrapper. Their result goes back
 * to the caller, and a caller starts no later write and no transition after a false.
 */
export const CAS_WRITES = new Set([
  'claimPromoteOperation',
  'settlePromoteOperation',
  'beginPromoteTransition',
  'finishPromoteTransition',
  'acknowledgePromoteTransition',
  'abandonPromoteOperation',
  'settleOrUnknown',
]);

/**
 * I2 (5-2e) against a source: a call of a CAS whose result is thrown away — the call as a
 * statement of its own (awaited or not, in parentheses or not) or under `void`. Each is
 * `function|callee` (the enclosing function's name, or `(top)`).
 */
export function discardedCasResults(source: string, name = 'source.ts'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const enclosing = (node: ts.Node): string => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    }
    return '(top)';
  };
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CAS_WRITES.has(node.expression.text)) {
      let outer: ts.Node = node;
      while (ts.isParenthesizedExpression(outer.parent) || ts.isAwaitExpression(outer.parent)) outer = outer.parent;
      if (ts.isExpressionStatement(outer.parent) || ts.isVoidExpression(outer.parent)) out.push(`${enclosing(node)}|${node.expression.text}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out.sort();
}

/** The table's rows of a CAS whose rule does not say that the caller sees the result (`結果を見る`). */
export function casRowsWithoutResult(markdown: string): string[] {
  return tableOf(markdown, 'promote-await-write')
    .filter(([, kind, callee, , rule]) => kind === 'write' && CAS_WRITES.has(callee) && !(rule ?? '').includes('結果を見る'))
    .map(([fn, , callee]) => `${fn}|${callee}`)
    .sort();
}
