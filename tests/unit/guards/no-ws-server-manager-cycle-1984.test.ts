/**
 * `ws-server` と `cli-tools/manager` は、モジュールスコープの循環に入っていない
 * （Issue #1984）。
 *
 * ## 何が起きていたか
 *
 * `import('@/lib/ws-server')` は冷えたプロセスで 1043ms、
 * `import('@/lib/cli-tools/manager')` は 1025ms かかっていた。両者がほぼ同値なのは
 * 偶然ではなく、**同じ 1 つの強連結成分**だったから — どちらを import しても
 * グラフ全体（`polling/response-checker` -> `session/cli-session` -> tmux / child_process）が
 * 一緒にロードされる:
 *
 *     ws-server -> cli-tools/manager -> polling/response-poller
 *       -> polling/response-poller-core -> polling/response-checker -> ws-server
 *       -> polling/response-poller-core -> realtime/terminal-broadcast -> ws-server
 *
 * 実測で `ws-server` を通る循環は 2 本、`manager` を通る循環は 8 本あった。
 * 切ったのは 2 辺:
 *
 * | 切った辺 | どう切ったか |
 * |---|---|
 * | `cli-tools/manager -> polling/response-poller` | `stopPollers()` を `await import()` 化（manager を通る 8 本すべてがこの辺を通っていた） |
 * | `ws-server -> cli-tools/manager` | セッション名の規則を `cli-tools/session-name.ts` に抽出し、`ws-server` はそれだけを引く |
 *
 * 実測: ws-server 1043ms -> 228ms、manager 1025ms -> 417ms。
 *
 * ## なぜ「テストで速くなった」で終わらせないのか
 *
 * 循環はテストの遅さとして現れただけで、本体は本番の import グラフにある。
 * そして循環は**静かに戻る** — 誰かが `ws-server.ts` に
 * `import { CLIToolManager } from './cli-tools/manager'` を 1 行足せば復活し、
 * 型検査も lint もそれを止めない。だから戻ったことを赤にできるのはこの検査だけになる。
 *
 * ## この検査が空振りしないことの担保
 *
 * 「循環 0 件」は、パーサが壊れて辺を 1 本も採れていない場合にも成立する。実際に
 * 起こしたのがそれで、`export { ... } from './response-poller-core'`（**再 export**）を
 * 数えない実装では `response-poller` の出次数が 0 になり、循環は 0 件に見えた。
 * よって 0 件を主張する前に:
 *
 *   1. 合成グラフで検出器そのものが循環を見つけることを確認する（陽性対照）
 *   2. 実ファイルから辺が採れていることを確認する（`ws-server` / `manager` の既知の辺）
 *   3. 再 export だけで構成された barrel（`polling/response-poller.ts`）から
 *      辺が採れていることを確認する — 上で踏んだ穴そのもの
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

/** Every `.ts` / `.tsx` under `src/`, absolute paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Apply TypeScript's extension/index resolution to a specifier-derived path. */
function resolveModulePath(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@/')) return resolveModulePath(join(SRC, spec.slice(2)));
  if (spec.startsWith('.')) return resolveModulePath(resolve(dirname(fromFile), spec));
  return null; // bare package specifier: not part of the repo graph
}

/**
 * True when the clause brings nothing into the module at runtime, so the edge
 * is erased by the compiler and cannot participate in a load-time cycle.
 *
 * Two shapes: `import type { A } from` (clause-level) and
 * `import { type A, type B } from` (every specifier inline-typed).
 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return true;
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!braced) return false;
  const specifiers = braced[1].split(',').map((s) => s.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
}

/**
 * Value-level module graph. Covers the three forms that execute a module:
 * `import ... from`, bare `import '...'`, and `export ... from` (re-export —
 * the form whose omission made an earlier draft of this guard report 0 cycles).
 * `await import()` is deliberately NOT an edge: deferring the load is exactly
 * how the cycles below were cut.
 */
function buildGraph(files: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const src = readFileSync(file, 'utf-8');
    const deps = new Set<string>();
    const add = (spec: string) => {
      const target = resolveSpecifier(spec, file);
      if (target) deps.add(target);
    };

    let m: RegExpExecArray | null;
    const importFrom = /(^|\n)\s*import\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
    while ((m = importFrom.exec(src))) {
      if (!isTypeOnlyClause(m[2])) add(m[3]);
    }
    const sideEffect = /(^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    while ((m = sideEffect.exec(src))) add(m[2]);
    const exportFrom = /(^|\n)\s*export\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
    while ((m = exportFrom.exec(src))) {
      if (!isTypeOnlyClause(m[2])) add(m[3]);
    }

    graph.set(file, deps);
  }
  return graph;
}

/** Every simple cycle that passes through `target`, as node-name paths. */
function cyclesThrough(
  graph: Map<string, Set<string>>,
  target: string,
  name: (n: string) => string,
  maxDepth = 12
): string[][] {
  const found: string[][] = [];
  const path = [target];
  const onPath = new Set([target]);

  const visit = (node: string, depth: number): void => {
    if (depth > maxDepth || found.length >= 100) return;
    for (const next of graph.get(node) ?? []) {
      if (next === target) {
        found.push([...path, target].map(name));
        continue;
      }
      if (onPath.has(next)) continue;
      onPath.add(next);
      path.push(next);
      visit(next, depth + 1);
      path.pop();
      onPath.delete(next);
    }
  };

  visit(target, 0);
  return found;
}

const files = sourceFiles(SRC);
const graph = buildGraph(files);
const rel = (p: string) => relative(SRC, p);
const node = (relPath: string): string => {
  const abs = join(SRC, relPath);
  if (!graph.has(abs)) throw new Error(`no such source file: ${relPath}`);
  return abs;
};

describe('module-scope import cycles (Issue #1984)', () => {
  describe('the detector is not vacuous', () => {
    it('finds a cycle in a synthetic graph', () => {
      const a = '/a', b = '/b', c = '/c';
      const synthetic = new Map([
        [a, new Set([b])],
        [b, new Set([c])],
        [c, new Set([a])],
      ]);
      const cycles = cyclesThrough(synthetic, a, (n) => n);

      expect(cycles).toEqual([[a, b, c, a]]);
    });

    it('reports no cycle for a synthetic DAG', () => {
      const a = '/a', b = '/b', c = '/c';
      const dag = new Map([
        [a, new Set([b, c])],
        [b, new Set([c])],
        [c, new Set<string>()],
      ]);

      expect(cyclesThrough(dag, a, (n) => n)).toEqual([]);
    });

    it('reads real edges out of the two modules under guard', () => {
      // Known static imports. If the parser breaks, these go empty and every
      // "no cycle" assertion below becomes true for the wrong reason.
      expect([...graph.get(node('lib/ws-server.ts'))!].map(rel)).toContain('lib/security/auth.ts');
      expect([...graph.get(node('lib/cli-tools/manager.ts'))!].map(rel)).toContain(
        'lib/cli-tools/claude.ts'
      );
    });

    it('reads edges out of a barrel built only from re-exports', () => {
      // `polling/response-poller.ts` has no `import ... from` at all — it is
      // `export { ... } from` top to bottom. Missing this form is what made an
      // earlier draft of this guard report 0 cycles on the unfixed tree.
      const barrel = readFileSync(join(SRC, 'lib/polling/response-poller.ts'), 'utf-8');
      expect(barrel).toMatch(/export\s*\{[\s\S]*?\}\s*from\s*'\.\/response-poller-core'/);

      expect([...graph.get(node('lib/polling/response-poller.ts'))!].map(rel)).toContain(
        'lib/polling/response-poller-core.ts'
      );
    });

    it('still reports the cycle this issue did not touch', () => {
      // `response-checker` and `response-poller-core` import each other. That
      // pair is out of scope here, and its presence is a live proof that this
      // detector reports real cycles in real repository files — not only in the
      // synthetic fixture above.
      const cycles = cyclesThrough(graph, node('lib/polling/response-checker.ts'), rel);

      expect(cycles).toContainEqual([
        'lib/polling/response-checker.ts',
        'lib/polling/response-poller-core.ts',
        'lib/polling/response-checker.ts',
      ]);
    });
  });

  it('leaves lib/ws-server.ts outside every module-scope cycle', () => {
    const cycles = cyclesThrough(graph, node('lib/ws-server.ts'), rel);

    expect(cycles.map((c) => c.join(' -> '))).toEqual([]);
  });

  it('leaves lib/cli-tools/manager.ts outside every module-scope cycle', () => {
    const cycles = cyclesThrough(graph, node('lib/cli-tools/manager.ts'), rel);

    expect(cycles.map((c) => c.join(' -> '))).toEqual([]);
  });

  it('keeps the two cut edges cut', () => {
    // The cycles above are absent because these specific edges are gone. Naming
    // them makes the failure message point at the line to look at, instead of
    // only at a path through five modules.
    expect([...graph.get(node('lib/ws-server.ts'))!].map(rel)).not.toContain(
      'lib/cli-tools/manager.ts'
    );
    expect([...graph.get(node('lib/cli-tools/manager.ts'))!].map(rel)).not.toContain(
      'lib/polling/response-poller.ts'
    );
  });
});
