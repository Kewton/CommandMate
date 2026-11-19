/**
 * The start calls `server.ts` makes, read off its source (Issue #4480).
 *
 * `tests/unit/tool-policy/agy-startup-sequence-4480.test.ts` runs the start
 * sequence itself; this reads, in execution order, every call `server.ts` makes
 * between `app.prepare().then(` and `function gracefulShutdown(` to a function it
 * imports from `./src/...` (static or dynamic, including a namespace import's
 * members) and to `server.listen` / `remoteServer.listen`. The body of
 * `initializeWorktrees()` is spliced in where it is called, so the list is the
 * order things start in. A call inside a `void (async () => …)()` is listed where
 * it is started (it is not awaited there).
 */

const START_MARK = 'app.prepare().then(';
const END_MARK = 'function gracefulShutdown(';
const INIT_HEAD = 'async function initializeWorktrees() {';
const INIT_CALL = 'initializeWorktrees';

/** Blank out comment lines and trailing `//` comments (offsets kept per line). */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
    .join('\n');
}

function importedNames(source: string): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const addList = (list: string): void => {
    for (const raw of list.split(',')) {
      const item = raw.trim();
      if (item === '' || item.startsWith('type ')) continue;
      const local = item.split(/\s+as\s+/).pop()?.trim();
      if (local) names.add(local);
    }
  };
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/src\/[^']+'/g)) addList(m[1]);
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*'\.\/src\/[^']+'\s*\)/g)) addList(m[1]);
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*await\s+import\(\s*'\.\/src\/[^']+'\s*\)/g)) namespaces.add(m[1]);
  return { names, namespaces };
}

/** Index just past the brace that closes the one opening at `open`. */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced braces');
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function callsIn(
  region: string,
  names: Set<string>,
  namespaces: Set<string>,
  extra: readonly string[] = [],
): { name: string; index: number }[] {
  const found: { name: string; index: number }[] = [];
  const alternatives = [...names, INIT_CALL].map(escape).join('|');
  for (const m of region.matchAll(new RegExp(`(?<![\\w.])(${alternatives})\\s*\\(`, 'g'))) {
    found.push({ name: m[1], index: m.index ?? 0 });
  }
  for (const ns of namespaces) {
    for (const m of region.matchAll(new RegExp(`(?<![\\w.])${escape(ns)}\\.(\\w+)\\s*\\(`, 'g'))) {
      found.push({ name: `${ns}.${m[1]}`, index: m.index ?? 0 });
    }
  }
  for (const listener of extra) {
    for (const m of region.matchAll(new RegExp(`(?<![\\w.])${escape(listener)}\\s*\\(`, 'g'))) {
      found.push({ name: listener, index: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The start calls of `server.ts`'s source, in the order they start. */
export function serverStartCalls(serverSource: string): string[] {
  const source = stripComments(serverSource);
  const { names, namespaces } = importedNames(source);
  const start = source.indexOf(START_MARK);
  const end = source.indexOf(END_MARK);
  if (start < 0 || end < 0 || end < start) throw new Error('start region not found in server.ts');
  let region = source.slice(start, end);

  const head = region.indexOf(INIT_HEAD);
  if (head < 0) throw new Error('initializeWorktrees() not found in server.ts');
  const bodyEnd = closingBrace(region, head + INIT_HEAD.length - 1);
  const body = region.slice(head + INIT_HEAD.length, bodyEnd - 1);
  region = region.slice(0, head) + ' '.repeat(bodyEnd - head) + region.slice(bodyEnd);

  const listeners = ['server.listen', 'remoteServer.listen'];
  const bodyCalls = callsIn(body, names, namespaces).map((call) => call.name);
  const calls: string[] = [];
  for (const call of callsIn(region, names, namespaces, listeners)) {
    if (call.name === INIT_CALL) calls.push(...bodyCalls);
    else calls.push(call.name);
  }
  return calls;
}
