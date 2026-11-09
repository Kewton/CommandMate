/**
 * Reading the sources for the chain of writes (Issue #4225, design T23): which exported
 * functions of a source write (directly or through its own helpers), who imports them
 * (aliases, namespace imports and re-exports resolved), and which entrances of the
 * promote service reach a write.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

export const ROOT = process.cwd();
export const SRC = path.join(ROOT, 'src');
export const MEM_DB = path.join(SRC, 'lib/db/mem-db.ts');
export const MEM_SERVICE = path.join(SRC, 'lib/mem/service.ts');
export const PROMOTE_DB = path.join(SRC, 'lib/db/mem-promote-db.ts');
export const PROMOTE_SERVICE = path.join(SRC, 'lib/promote/service.ts');

export interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}

/** Top-level `function` / `const … =` declarations of a source, each with its text. */
export function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({
    name: match[2] ?? match[3],
    exported: Boolean(match[1]),
    body: source.slice(match.index, starts[i + 1]?.index ?? source.length),
  }));
}

export const callsAny = (body: string, names: Iterable<string>) => [...names].some((name) => new RegExp(`(?:^|[^\\w.])${name}\\s*\\(`).test(body));

/** Names of `chunks` that do `seed`, or call (within the file) one that does. */
export function closure(chunks: Chunk[], seed: (chunk: Chunk) => boolean): Set<string> {
  const found = new Set(chunks.filter(seed).map((chunk) => chunk.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of chunks) {
      if (!found.has(chunk.name) && callsAny(chunk.body.slice(chunk.body.indexOf('{')), found)) {
        found.add(chunk.name);
        grew = true;
      }
    }
  }
  return found;
}

/** A source's exported functions that INSERT / UPDATE / DELETE (or call `fs` writes), directly or through its helpers. */
export function exportedWriters(source: string, pattern: RegExp = /\b(INSERT|UPDATE|DELETE)\b/): Set<string> {
  const chunks = chunksOf(source);
  const writes = closure(chunks, (chunk) => pattern.test(chunk.body));
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The local names under which `source` uses the exports `names` of the module `spec`
 * (`import { a as b }`, `import * as ns` → `ns.a`), and whether it re-exports one.
 */
export function importedAs(source: string, specs: readonly string[], names: ReadonlySet<string>): { locals: Map<string, string>; reexports: string[] } {
  const code = stripComments(source);
  const locals = new Map<string, string>();
  const reexports: string[] = [];
  const specPattern = specs.map((spec) => spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  for (const match of code.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"](?:${specPattern})['"]`, 'g'))) {
    for (const part of match[1].split(',')) {
      const [imported, local] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (imported && names.has(imported)) locals.set(local ?? imported, imported);
    }
  }
  for (const match of code.matchAll(new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"](?:${specPattern})['"]`, 'g'))) {
    for (const name of names) locals.set(`${match[1]}.${name}`, name);
  }
  for (const match of code.matchAll(new RegExp(`export\\s+(\\*|\\{([^}]*)\\})\\s+from\\s+['"](?:${specPattern})['"]`, 'g'))) {
    if (match[1] === '*') reexports.push('*');
    else for (const part of (match[2] ?? '').split(',')) {
      const imported = part.trim().split(/\s+as\s+/)[0];
      if (names.has(imported)) reexports.push(imported);
    }
  }
  return { locals, reexports };
}

/** Which of `names` a source calls (through any local name) or re-exports. */
export function usesOf(source: string, specs: readonly string[], names: ReadonlySet<string>): string[] {
  const { locals, reexports } = importedAs(source, specs, names);
  const code = stripComments(source);
  const used = new Set<string>(reexports);
  for (const [local, imported] of locals) {
    const escaped = local.replace(/[.$]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\w.])${escaped}\\s*\\(`).test(code)) used.add(imported);
  }
  return [...used].sort();
}

export function sourcesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The specifiers by which a file under `src/` may name a module (alias and relative). */
export function specifiersOf(fromFile: string, module: string): string[] {
  const noExt = module.replace(/\.tsx?$/, '');
  const alias = `@/${path.relative(SRC, noExt).split(path.sep).join('/')}`;
  let relative = path.relative(path.dirname(fromFile), noExt).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return [alias, relative];
}

/** The modules of the promote path whose functions write outside or to the database. */
export const PROMOTE_WRITE_MODULES = (): Array<{ file: string; writers: Set<string> }> => [
  { file: PROMOTE_DB, writers: exportedWriters(readFileSync(PROMOTE_DB, 'utf8')) },
  { file: MEM_SERVICE, writers: new Set(['memSettleDecisionTransition']) },
  { file: path.join(SRC, 'lib/promote/github-write.ts'), writers: new Set(['postGhComment']) },
  {
    file: path.join(SRC, 'lib/promote/doc-write.ts'),
    writers: exportedWriters(readFileSync(path.join(SRC, 'lib/promote/doc-write.ts'), 'utf8'), /\b(?:writeSync|linkSync|unlinkSync|fsyncSync)\s*\(/),
  },
];

/** The exported functions of the promote service (given as source) that reach a write, helpers included. */
export function writeEntrancesOfPromote(serviceSource: string = readFileSync(PROMOTE_SERVICE, 'utf8')): string[] {
  const used = new Set<string>();
  const localWriters = new Set<string>();
  for (const module of PROMOTE_WRITE_MODULES()) {
    const { locals } = importedAs(serviceSource, specifiersOf(PROMOTE_SERVICE, module.file), module.writers);
    for (const local of locals.keys()) localWriters.add(local);
    for (const name of module.writers) used.add(name);
  }
  const chunks = chunksOf(serviceSource);
  const reach = closure(chunks, (chunk) => callsAny(chunk.body, localWriters));
  return chunks.filter((chunk) => chunk.exported && reach.has(chunk.name)).map((chunk) => chunk.name).sort();
}

/** The first statement of an exported function's body. */
export function firstStatementOf(source: string, name: string): string | null {
  const chunk = chunksOf(source).find((entry) => entry.name === name);
  if (!chunk) return null;
  const open = chunk.body.indexOf('{', chunk.body.indexOf(')'));
  // The body's brace follows the return type: find the `{` after `): Promise<…>`.
  const bodyStart = chunk.body.search(/\)\s*:\s*Promise<[^>]*>\s*\{|\)\s*\{/);
  const start = bodyStart >= 0 ? chunk.body.indexOf('{', bodyStart) : open;
  return chunk.body.slice(start + 1).trim().split('\n')[0] ?? null;
}
