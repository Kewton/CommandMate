/**
 * `'claude'` may not spread as a resolution fallback (Issue #1923).
 *
 * ## What this pins
 *
 * §4 D5 決定 4 of `docs/design/multi-agent-state-architecture.md` says the default
 * agent may be named as a literal in exactly one place — `resolveSessionTarget`
 * (`src/lib/session/resolve-session-target.ts`) — and that every other copy of it
 * in the resolution layer is a duplicated default that Phase 2 removes. Phase 1
 * cannot pin the count at zero, so it pins the **exact set that exists today** and
 * lets it only shrink.
 *
 * The interesting property is therefore not "there are N of them" but "these are
 * the N, and each one has been looked at and classified". `BASELINE` below is that
 * classification: every occurrence carries a `verdict` saying whether it is a
 * resolution fallback (debt, counted by the ratchet) or something the design doc
 * deliberately leaves alone (not counted, and not to be "fixed" by deleting it).
 *
 * ## Why vitest and not `.eslintrc.json`
 *
 * `no-restricted-syntax` is one key with one severity, and `overrides.rules`
 * *replaces* the base entry instead of merging into it (DR2-005). Adding a
 * `'claude'` selector there and then scoping it with `overrides` would silently
 * drop the i18n selector for every scoped file — the exact "無音の失効" failure the
 * tmux guard (#1922) was restructured to avoid. So the rule config stays as #1922
 * left it (one key, `error`, i18n + the two tmux dynamic-access selectors) and
 * this guard runs its own selectors through ESLint programmatically.
 *
 * ## Deviations from the design doc, all measured on this branch
 *
 * 1. **The doc names 5 spellings; this guard runs 8.** `property`
 *    (`{ cliToolId: 'claude' }`) and `return` (`return 'claude'`) each catch a real
 *    in-scope occurrence that the 5 miss — and the `return` one,
 *    `slash-commands/route.ts`, is a resolution fallback that literally comments
 *    itself as "Default to Claude for backward compatibility". `param-default`
 *    (`function f(t = 'claude')`) is in-scope at zero and kept there.
 * 2. **The doc's baseline table (36 / 19, develop `90b67eb9`) is a raw `'claude'`
 *    grep, not the 5 spellings.** It counts `case 'claude':`, `=== 'claude'`,
 *    allowlist array elements and comments, none of which is a fallback spelling.
 *    Measured here with the AST detector: **21 occurrences / 13 files**, of which
 *    **10 are resolution fallbacks** and all 10 sit in a `route.ts` under `src/app/api`
 *    (`src/cli/commands/**` and `src/lib/session/**` contribute zero).
 * 3. Quoting is not part of the spelling: `'claude'`, `"claude"` and `` `claude` ``
 *    are all matched, by selecting the node and comparing its source text.
 *
 * ## Anti-vacuity
 *
 * A guard whose scan silently walks zero files passes forever. Three controls make
 * that impossible: the scan asserts it reached anchor files in each of the three
 * scope roots, every selector has a fixture it must catch (and near-misses it must
 * not), and the two Claude-specific modules that §4 D5 決定 4 (3) puts out of scope
 * are asserted to *still* produce matches when scanned — so the exclusion is proven
 * load-bearing rather than assumed.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { createRequire } from 'module';
import { ESLint } from 'eslint';

const REPO_ROOT = process.cwd();
const require_ = createRequire(import.meta.url);

// --------------------------------------------------------------------------
// Scope (§4 D5 決定 4 (3))
// --------------------------------------------------------------------------

/**
 * The three layers where a resolved CLI tool decides where a keystroke lands.
 * Everything else — `src/lib/db/**`, `src/components/**`, `src/types/**`,
 * `src/lib/hooks/sources/claude/**` — is 対象外, not allowlisted: guarding all of
 * `src` would mean 231 occurrences across 85 files (§4 D5 決定 4 (3), re-measured).
 */
const SCOPES = [
  { root: 'src/app/api', includes: (rel: string) => rel.endsWith('/route.ts') },
  { root: 'src/cli/commands', includes: () => true },
  { root: 'src/lib/session', includes: () => true },
] as const;

/**
 * Claude-specific modules. The `'claude'` in these is the module's own identity,
 * not a default chosen for someone else, so §4 D5 決定 4 (3) puts them outside the
 * scan rather than on an allowlist. `claude-session.ts` carries the #868 primary
 * anchor (`instanceId === 'claude'`); `claude-executor.ts` carries `case 'claude'`
 * and a default parameter. Deleting either would be a regression, not progress.
 */
const OUT_OF_SCOPE_MODULES = [
  'src/lib/session/claude-executor.ts',
  'src/lib/session/claude-session.ts',
] as const;

// --------------------------------------------------------------------------
// Detector
// --------------------------------------------------------------------------

type Kind =
  | 'call-arg'
  | 'const-init'
  | 'logical-or'
  | 'nullish'
  | 'param-default'
  | 'property'
  | 'return'
  | 'ternary';

/**
 * One esquery selector per fallback spelling. The selectors deliberately do NOT
 * filter on `[value='claude']`: they select the node in the fallback position and
 * the text of that node is compared afterwards, which is how `"claude"` and
 * `` `claude` `` are covered by the same rule as `'claude'`.
 */
const VALUE_NODES = ':matches(Literal, TemplateLiteral)';

const DETECTORS: { kind: Kind; selector: string }[] = [
  // x ?? 'claude'
  { kind: 'nullish', selector: `LogicalExpression[operator='??'] > ${VALUE_NODES}.right` },
  // x || 'claude'
  { kind: 'logical-or', selector: `LogicalExpression[operator='||'] > ${VALUE_NODES}.right` },
  // cond ? x : 'claude'  /  cond ? 'claude' : x
  { kind: 'ternary', selector: `ConditionalExpression > ${VALUE_NODES}.alternate` },
  { kind: 'ternary', selector: `ConditionalExpression > ${VALUE_NODES}.consequent` },
  // const DEFAULT_CLI_TOOL: CLIToolType = 'claude'  (and the `as` form)
  { kind: 'const-init', selector: `VariableDeclarator > ${VALUE_NODES}.init` },
  { kind: 'const-init', selector: `VariableDeclarator > TSAsExpression > ${VALUE_NODES}.expression` },
  // f(..., 'claude')
  { kind: 'call-arg', selector: `CallExpression > ${VALUE_NODES}.arguments` },
  { kind: 'call-arg', selector: `NewExpression > ${VALUE_NODES}.arguments` },
  // { cliToolId: 'claude' }
  { kind: 'property', selector: `Property > ${VALUE_NODES}.value` },
  // return 'claude'  /  () => 'claude'
  { kind: 'return', selector: `ReturnStatement > ${VALUE_NODES}.argument` },
  { kind: 'return', selector: `ArrowFunctionExpression > ${VALUE_NODES}.body` },
  // function f(cliToolId = 'claude')  /  const { cliToolId = 'claude' } = x
  { kind: 'param-default', selector: `AssignmentPattern > ${VALUE_NODES}.right` },
];

/** The three ways `claude` can be spelled as a value. */
const CLAUDE_TEXTS = new Set(["'claude'", '"claude"', '`claude`']);

const eslint = new ESLint({
  useEslintrc: false,
  cwd: REPO_ROOT,
  baseConfig: {
    root: true,
    parser: require_.resolve('@typescript-eslint/parser'),
    parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
    rules: {
      'no-restricted-syntax': [
        'error',
        ...DETECTORS.map(({ kind, selector }) => ({ selector, message: kind })),
      ],
    },
  } as never,
});

interface Occurrence {
  file: string;
  kind: Kind;
  /** The whole source line, whitespace-collapsed. Line numbers are not pinned. */
  snippet: string;
}

/** `line` / `column` are 1-based and `endColumn` is exclusive, as ESLint reports them. */
function sliceNode(lines: string[], m: { line: number; column: number; endLine?: number; endColumn?: number }): string {
  if (m.endLine !== m.line || m.endColumn === undefined) return '';
  return lines[m.line - 1].slice(m.column - 1, m.endColumn - 1);
}

async function scanText(file: string, text: string): Promise<Occurrence[]> {
  const results = await eslint.lintText(text, { filePath: join(REPO_ROOT, file) });
  const lines = text.split('\n');
  const found: Occurrence[] = [];
  for (const m of results.flatMap((r) => r.messages)) {
    if (m.ruleId !== 'no-restricted-syntax') continue;
    if (!CLAUDE_TEXTS.has(sliceNode(lines, m))) continue;
    found.push({ file, kind: m.message as Kind, snippet: lines[m.line - 1].trim().replace(/\s+/g, ' ') });
  }
  return found;
}

const keyOf = (o: Occurrence): string => `${o.file} :: ${o.kind} :: ${o.snippet}`;

function tally(occurrences: Occurrence[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of occurrences) counts.set(keyOf(o), (counts.get(keyOf(o)) ?? 0) + 1);
  return counts;
}

// --------------------------------------------------------------------------
// Source enumeration
// --------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

function scopedFiles(): string[] {
  const out: string[] = [];
  for (const scope of SCOPES) {
    for (const abs of walk(join(REPO_ROOT, scope.root))) {
      const rel = relative(REPO_ROOT, abs).split(sep).join('/');
      if (scope.includes(rel)) out.push(rel);
    }
  }
  return out.filter((rel) => !(OUT_OF_SCOPE_MODULES as readonly string[]).includes(rel)).sort();
}

/**
 * The prefilter cannot hide a match: a node whose source text is one of
 * `CLAUDE_TEXTS` necessarily contains the substring `claude`, so a file without it
 * has nothing to find. It exists so the scan parses ~15 files instead of ~170.
 */
async function scanScope(): Promise<{ files: string[]; occurrences: Occurrence[] }> {
  const files = scopedFiles();
  const occurrences: Occurrence[] = [];
  for (const rel of files) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    if (!text.includes('claude')) continue;
    occurrences.push(...(await scanText(rel, text)));
  }
  return { files, occurrences };
}

// --------------------------------------------------------------------------
// The baseline
// --------------------------------------------------------------------------

type Verdict =
  /** A default agent chosen for a caller that did not name one. Debt; counted. */
  | 'resolution-fallback'
  /** Correct code the design doc says not to delete. Not counted as progress. */
  | 'not-a-fallback'
  /** §4 D5 決定 4: the one place the literal may be written. */
  | 'allowed';

interface BaselineEntry {
  file: string;
  kind: Kind;
  snippet: string;
  /** Occurrences sharing this file+kind+line text. `applyAgentStopEvent` passes it twice. */
  count: number;
  verdict: Verdict;
  reason: string;
}

/**
 * Measured on this branch, not copied from the Issue. Sorted by file, then kind,
 * then snippet; the only edit this list should ever receive is a **deletion**.
 */
const BASELINE: BaselineEntry[] = [
  {
    file: 'src/app/api/hooks/claude-done/route.ts',
    kind: 'call-arg',
    snippet: "await applyAgentStopEvent(db, worktree, 'claude', 'claude');",
    count: 2,
    verdict: 'not-a-fallback',
    reason:
      'Claude 固有の hook 受信ルート。tool と instanceId は「どのエージェントが発火したか」であって、名乗らなかった呼び出し元に選んでやる既定ではない',
  },
  {
    file: 'src/app/api/hooks/claude-done/route.ts',
    kind: 'call-arg',
    snippet: "await recordClaudeConversation(db, body.worktreeId, parsed.content, 'claude');",
    count: 1,
    verdict: 'not-a-fallback',
    reason: 'Claude 固有の hook 受信ルート（上に同じ）',
  },
  {
    file: 'src/app/api/hooks/claude-done/route.ts',
    kind: 'call-arg',
    snippet: "updateSessionState(db, body.worktreeId, 'claude', lineCount);",
    count: 1,
    verdict: 'not-a-fallback',
    reason: 'Claude 固有の hook 受信ルート（上に同じ）',
  },
  {
    file: 'src/app/api/hooks/claude-done/route.ts',
    kind: 'property',
    snippet: "cliToolId: 'claude',",
    count: 1,
    verdict: 'not-a-fallback',
    reason: 'Claude 固有の hook が記録するメッセージの発話者。解決結果ではない',
  },
  {
    file: 'src/app/api/worktrees/[id]/cmate/schedules/route.ts',
    kind: 'ternary',
    snippet: "cliToolId: typeof body.cliToolId === 'string' ? body.cliToolId.trim() : 'claude',",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/prompt-response/route.ts',
    kind: 'logical-or',
    snippet: ": (worktree.cliToolId || 'claude');",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/respond/route.ts',
    kind: 'logical-or',
    snippet: "const cliToolId = message.cliToolId || worktree.cliToolId || 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/route.ts',
    kind: 'logical-or',
    snippet: "const cliToolId = updatedWorktree?.cliToolId || 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/route.ts',
    kind: 'logical-or',
    snippet: "let nextCliToolId: CLIToolType = worktree.cliToolId || 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/schedules/route.ts',
    kind: 'logical-or',
    snippet: "const toolId = cliToolId || 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/send/route.ts',
    kind: 'const-init',
    snippet: "const DEFAULT_CLI_TOOL: CLIToolType = 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/slash-commands/route.ts',
    kind: 'return',
    snippet: "return 'claude'; // Default to Claude for backward compatibility",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/[id]/tasks/route.ts',
    kind: 'nullish',
    snippet: "cliToolId: (payload.cliToolId as string | undefined) ?? worktree.cliToolId ?? 'claude',",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/app/api/worktrees/route.ts',
    kind: 'nullish',
    snippet: "const cliToolId = worktree.cliToolId ?? 'claude';",
    count: 1,
    verdict: 'resolution-fallback',
    reason: '',
  },
  {
    file: 'src/cli/commands/report.ts',
    kind: 'call-arg',
    // Issue #2044: the tool list is interpolated from ALLOWED_TOOLS now (adding
    // `opencode` to a hand-written list was how the sibling message in
    // `/api/daily-summary` came to say "claude, codex, copilot" for a year).
    // The `'claude'` this entry classifies is commander's default value, which
    // is unchanged — only the line it sits on was reworded.
    snippet: ".option('--tool <tool>', `AI tool to use (${ALLOWED_TOOLS.join(', ')})`, 'claude')",
    count: 1,
    verdict: 'not-a-fallback',
    reason: 'commander の option 既定（§4 D5 決定 4 (3) (b)）。--help に出る既定値であって送り先の解決ではない',
  },
  {
    file: 'src/cli/commands/report.ts',
    kind: 'logical-or',
    snippet: "tool: options.tool || 'claude',",
    count: 1,
    verdict: 'not-a-fallback',
    reason:
      'commander が既に既定を入れているため到達しない二重既定。日次レポートの生成ツール選択であって、セッションの送り先ではない（§4 D5 決定 4 (3) (b)）',
  },
  {
    file: 'src/cli/commands/wait.ts',
    kind: 'logical-or',
    snippet: "cliToolId: data.cliToolId || 'claude',",
    count: 3,
    verdict: 'not-a-fallback',
    reason:
      '表示既定（§4 D5 決定 4 (3) (a)）。exit 10 の JSON と NOT_STARTED メッセージのラベルで、削ると cliToolId が undefined になる。tests/unit/skills/orchestrate-monitor/monitor-session-target.test.ts の規律と表裏',
  },
  {
    file: 'src/lib/session/resolve-session-target.ts',
    kind: 'const-init',
    snippet: "export const DEFAULT_SESSION_CLI_TOOL: CLIToolType = 'claude';",
    count: 1,
    verdict: 'allowed',
    reason:
      '§4 D5 決定 4 最終行「resolveSessionTarget 内部のみ \'claude\' を書いてよい」。他の全コピーはこの 1 件へ吸収されて消える（#1925）',
  },
];

const BASELINE_COUNTS = new Map(BASELINE.map((e) => [`${e.file} :: ${e.kind} :: ${e.snippet}`, e.count]));

const fallbackTotal = (entries: BaselineEntry[]): number =>
  entries.filter((e) => e.verdict === 'resolution-fallback').reduce((n, e) => n + e.count, 0);

// --------------------------------------------------------------------------

describe("no-claude-fallback: the baseline's own shape", () => {
  it('is sorted, deduplicated and inside the guarded scope', () => {
    const keys = BASELINE.map((e) => `${e.file} :: ${e.kind} :: ${e.snippet}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of BASELINE) {
      expect(entry.count).toBeGreaterThanOrEqual(1);
      expect(scopedFiles(), `${entry.file} is pinned but not in scope`).toContain(entry.file);
    }
  });

  it('gives every non-debt entry a reason and every debt entry none', () => {
    // A `not-a-fallback` line without a reason is indistinguishable from an
    // unreviewed one, and that is how correct code gets deleted "for progress".
    for (const entry of BASELINE) {
      if (entry.verdict === 'resolution-fallback') expect(entry.reason).toBe('');
      else expect(entry.reason.length, `${entry.file} (${entry.kind}) has no reason`).toBeGreaterThan(20);
    }
  });

  it('names exactly one allowed site: resolveSessionTarget', () => {
    expect(BASELINE.filter((e) => e.verdict === 'allowed').map((e) => e.file)).toEqual([
      'src/lib/session/resolve-session-target.ts',
    ]);
  });

  it('measures 21 occurrences / 13 files, of which 10 are resolution fallbacks', () => {
    // Not the Issue's "36 箇所 / 19 ファイル": that is a raw `'claude'` grep at
    // develop 90b67eb9 and counts `case`/`===`/allowlist arrays/comments. See the
    // header. All 10 fallbacks are in `src/app/api/**/route.ts`; the CLI and
    // session scopes contribute none.
    expect(BASELINE.reduce((n, e) => n + e.count, 0)).toBe(21);
    expect(new Set(BASELINE.map((e) => e.file)).size).toBe(13);
    expect(fallbackTotal(BASELINE)).toBe(10);
    expect(BASELINE.filter((e) => e.verdict === 'resolution-fallback').every((e) => e.file.endsWith('/route.ts'))).toBe(
      true,
    );
  });
});

describe('no-claude-fallback: positive controls', () => {
  const FILE = 'src/app/api/worktrees/[id]/send/route.ts';

  const caught: [Kind, string][] = [
    ['nullish', "const t = worktree.cliToolId ?? 'claude';"],
    ['logical-or', "const t = worktree.cliToolId || 'claude';"],
    ['ternary', "const t = ok ? worktree.cliToolId : 'claude';"],
    ['ternary', "const t = ok ? 'claude' : worktree.cliToolId;"],
    ['const-init', "const DEFAULT_CLI_TOOL: CLIToolType = 'claude';"],
    ['const-init', "const DEFAULT_CLI_TOOL = 'claude' as CLIToolType;"],
    ['call-arg', "getAutoYesState(id, 'claude');"],
    ['call-arg', "const x = new Runner('claude');"],
    ['property', "const body = { cliToolId: 'claude' };"],
    ['return', "function pick() { return 'claude'; }"],
    ['return', "const pick = () => 'claude';"],
    ['param-default', "function pick(cliToolId = 'claude') { return cliToolId; }"],
    ['param-default', "const { cliToolId = 'claude' } = body;"],
  ];

  it.each(caught)('catches the %s spelling: %s', async (kind, source) => {
    expect((await scanText(FILE, source)).map((o) => o.kind)).toEqual([kind]);
  });

  const quoting: [string, string][] = [
    ['double quotes', 'const t = worktree.cliToolId ?? "claude";'],
    ['a template literal', 'const t = worktree.cliToolId ?? `claude`;'],
  ];

  it.each(quoting)('catches %s too', async (_label, source) => {
    expect(await scanText(FILE, source)).toHaveLength(1);
  });

  const ignored: [string, string][] = [
    ['a comparison', "if (cliToolId === 'claude') { run(); }"],
    ['a switch case', "switch (t) { case 'claude': run(); break; }"],
    ['an allowlist array element', "const ALLOWED = ['claude', 'codex'] as const;"],
    ['a comment', "// default to 'claude' when nothing else is known"],
    ['a longer tool id that merely starts with it', "const t = worktree.cliToolId ?? 'claude-code';"],
    ['an interpolated template', 'const s = `${t} claude`;'],
    ['a different default', "const t = worktree.cliToolId ?? 'codex';"],
    ['an import specifier', "import { x } from '@/lib/session/claude-session';"],
  ];

  it.each(ignored)('leaves %s alone', async (_label, source) => {
    expect(await scanText(FILE, source)).toEqual([]);
  });
});

describe('no-claude-fallback: the scan', () => {
  it('reaches every scope root and finds nothing outside the baseline', async () => {
    const { files, occurrences } = await scanScope();

    // Anti-vacuity: a broken enumeration would make the subset check below pass
    // over an empty scan. These anchors are the three scope roots.
    expect(files.length).toBeGreaterThanOrEqual(150);
    expect(files).toContain('src/app/api/worktrees/route.ts');
    expect(files).toContain('src/cli/commands/wait.ts');
    expect(files).toContain('src/lib/session/resolve-session-target.ts');
    expect(occurrences.length).toBeGreaterThan(0);

    // 増加は赤・減少は緑（§4 D5 決定 4）. Exact equality is deliberately NOT used:
    // Phase 2 removes these one at a time, from branches that must stay green.
    const surplus: string[] = [];
    for (const [key, count] of tally(occurrences)) {
      const allowed = BASELINE_COUNTS.get(key);
      if (allowed === undefined) surplus.push(key);
      else if (count > allowed) surplus.push(`${key}  (${count} > ${allowed})`);
    }
    expect(surplus).toEqual([]);
  }, 60_000);

  it('keeps the resolution-fallback debt at or below 10', async () => {
    const { occurrences } = await scanScope();
    const debt = [...tally(occurrences)]
      .filter(([key]) => BASELINE.find((e) => `${e.file} :: ${e.kind} :: ${e.snippet}` === key)?.verdict === 'resolution-fallback')
      .reduce((n, [, count]) => n + count, 0);
    expect(debt).toBeLessThanOrEqual(fallbackTotal(BASELINE));
  }, 60_000);

  it('keeps the param-default spelling at zero in scope', async () => {
    // Nothing in scope uses it today, so it has no baseline entry to shrink; the
    // first `function f(cliToolId = 'claude')` here is a straight regression.
    const { occurrences } = await scanScope();
    expect(occurrences.filter((o) => o.kind === 'param-default')).toEqual([]);
  }, 60_000);
});

describe('no-claude-fallback: the out-of-scope exclusion is load-bearing', () => {
  it('names Claude-specific modules that do exist and would otherwise be flagged', async () => {
    for (const rel of OUT_OF_SCOPE_MODULES) {
      const abs = join(REPO_ROOT, rel);
      expect(existsSync(abs), `${rel} is excluded but not on disk`).toBe(true);
      // If these ever stop matching, the exclusion has become a no-op and should
      // be deleted rather than carried as a comment that says nothing.
      expect((await scanText(rel, readFileSync(abs, 'utf-8'))).length, rel).toBeGreaterThan(0);
    }
  }, 60_000);

  it('excludes them from the scan itself', () => {
    for (const rel of OUT_OF_SCOPE_MODULES) expect(scopedFiles()).not.toContain(rel);
  });
});
