/**
 * The central claim of Issue #2069, asserted rather than asserted-in-a-comment.
 *
 * **The updater must never run inside an agent's tmux pane.** codex's own
 * "Update now" terminates codex and does not restart it, so a pane that runs
 * the installer is left at a bare shell (#2070) — which is the entire reason
 * this feature exists as a separate process rather than as a keystroke.
 *
 * Nothing in the behavioural suites can see that. A `POST /api/agents/update`
 * that ALSO typed into the pane would still emit `plan` / `output` / `done`, so
 * every assertion about the stream stays green. What actually distinguishes the
 * two implementations is which modules the update path can reach at all, so
 * that is what this file measures: the **transitive import closure** of both
 * entry points (the route and the CLI command) must contain no module that owns
 * a session or can type into one.
 *
 * A closure walk rather than a call-count spy because a spy only covers the
 * function somebody thought to mock; the closure covers `sendKeys`,
 * `killSession`, `startSession`, `capturePane` and whatever is added next, in
 * one rule, including the `await import()` and `require()` spellings ESLint's
 * `no-restricted-imports` cannot see (the same reasoning as
 * `tests/unit/guards/security-no-hooks-import.test.ts`).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

/** The two ways a user reaches the updater. */
const ENTRY_POINTS = [
  'src/app/api/agents/update/route.ts',
  'src/cli/commands/agents.ts',
] as const;

/**
 * Modules that own an agent session or can type into one.
 *
 * `src/lib/cli-tools/copilot-executable.ts` is deliberately NOT here: it
 * resolves an executable path on PATH and spawns `--version`, touching no tmux
 * and no session, and `agent-updater` uses it for exactly that.
 */
const SESSION_OWNING = [
  /^src\/lib\/tmux\//,
  /^src\/lib\/session\//,
  /^src\/lib\/polling\//,
  /^src\/lib\/cli-tools\/(manager|base|index|graceful-exit|submit-verified-sender|session-liveness|session-name)\.ts$/,
  /^src\/lib\/cli-tools\/(claude|codex|gemini|copilot|opencode|antigravity|vibe-local)\.ts$/,
];

/** Every way one module can name another, in any of the four spellings. */
const IMPORT_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Resolve one specifier to a repo-relative `.ts`/`.tsx` file, or null. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(join(REPO_ROOT, fromFile)), specifier);
  } else {
    return null; // node builtin or npm package
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(REPO_ROOT, candidate);
    }
  }
  return null;
}

/** Every repo module reachable from `entry`, including `entry` itself. */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(join(REPO_ROOT, file), 'utf-8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const next = resolveSpecifier(file, match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('[#2069] the walker itself is not vacuous', () => {
  it('resolves both alias and relative edges', () => {
    // `@/lib/updates/agent-updater` (alias, from the route) and
    // `../../lib/updates/agent-versions` (relative, from the CLI command).
    expect(
      resolveSpecifier('src/app/api/agents/update/route.ts', '@/lib/updates/agent-updater')
    ).toBe('src/lib/updates/agent-updater.ts');
    expect(
      resolveSpecifier('src/cli/commands/agents.ts', '../../lib/updates/agent-versions')
    ).toBe('src/lib/updates/agent-versions.ts');
    expect(resolveSpecifier('src/app/api/agents/update/route.ts', 'child_process')).toBeNull();
  });

  it('matches every import spelling, including the two ESLint cannot see', () => {
    const spellings = [
      "import { A } from '@/lib/tmux/tmux';",
      "export { B } from '../tmux/tmux';",
      "const m = await import('@/lib/cli-tools/manager');",
      "const m = require('../../lib/session/claude-session');",
    ];
    for (const line of spellings) {
      expect([...line.matchAll(IMPORT_RE)].length, line).toBe(1);
    }
  });

  it('walks transitively, not just one level', () => {
    const closure = closureOf('src/app/api/agents/update/route.ts');
    // Two hops from the route: route -> agent-updater -> env-sanitizer.
    expect(closure).toContain('src/lib/updates/agent-updater.ts');
    expect(closure).toContain('src/lib/security/env-sanitizer.ts');
    expect(closure.size).toBeGreaterThan(5);
  });

  it('has a positive control: the forbidden patterns name real modules', () => {
    // A rule that matched nothing in the repository would pass forever.
    const realSessionModules = [
      'src/lib/tmux/tmux.ts',
      'src/lib/cli-tools/manager.ts',
      'src/lib/cli-tools/codex.ts',
    ];
    for (const file of realSessionModules) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
      expect(SESSION_OWNING.some((rule) => rule.test(file)), file).toBe(true);
    }
    // And it does not flag the one cli-tools module the updater legitimately uses.
    expect(
      SESSION_OWNING.some((rule) => rule.test('src/lib/cli-tools/copilot-executable.ts'))
    ).toBe(false);
  });
});

describe('[#2069] the updater cannot reach an agent pane', () => {
  it.each(ENTRY_POINTS)('%s reaches no session-owning module', (entry) => {
    const offenders = [...closureOf(entry)].filter((file) =>
      SESSION_OWNING.some((rule) => rule.test(file))
    );

    expect(
      offenders.sort(),
      `${entry} must not be able to reach tmux or an agent session. codex's own ` +
        'updater terminates codex without restarting it, so running the install ' +
        'inside a pane drops that pane to a bare shell (#2070) — the failure this ' +
        'whole Issue exists to avoid. Run the installer as a child process ' +
        '(lib/updates/agent-updater) instead.\n' +
        offenders.map((f) => `  ${f}`).join('\n')
    ).toEqual([]);
  });

  it.each(ENTRY_POINTS)('%s names no session verb in its own source', (entry) => {
    // The closure rule covers imports; this covers the other half of the same
    // claim — a call written against a module that is somehow already in scope.
    const source = readFileSync(join(REPO_ROOT, entry), 'utf-8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const verb of ['sendKeys', 'killSession', 'startSession', 'capturePane', 'tmux']) {
      expect(code, `${entry} must not mention ${verb}`).not.toContain(verb);
    }
  });
});
