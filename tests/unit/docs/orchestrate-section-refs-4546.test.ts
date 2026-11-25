/**
 * Section numbers of team.md, rule strings in one place, and the canon's pointers (Issue #4546 PR-1).
 *
 * team.md's section numbers are an API: design docs, script comments, tests,
 * .commandmate/flow.yaml and the role canon (approved by a person, held in the
 * database) cite `team.md §N` / `team.md §N-M`. Moving text out of team.md (PR-2)
 * must not leave such a citation pointing at nothing, and nothing else checks it.
 *
 * - G2: every `team.md §N[-M]` in the tracked files (CHANGELOG.md is history and
 *   is left out) names an existing `## N.` section of team.md and, with `-M`, an
 *   existing top-level `M.` item in it. Chains such as `team.md §6-6・§10-6` are
 *   read in full. Line-number citations (`team.md:64-78`) are not checked here.
 * - G3: a registered rule string appears in exactly one document of
 *   docs/orchestrate/ (top level, the index included) and the /orchestrate body,
 *   and that is the registered owner. Only strings that are in one place today are
 *   registered; the role canon is outside the scan (it may cite the same example).
 * - G4: every repository path the role canon names (`docs/…`, `scripts/…`,
 *   `.claude/…`, and the other top-level directories in REPO_PATH) exists, and a
 *   `#<anchor>` on it is an existing heading of that file (GitHub's rule, from
 *   orchestrate-doc-links-3481). The canon is a subdirectory 3481 does not scan.
 *   Paths under `workspace/` and `dev-reports/` are left out: they are gitignored,
 *   so they exist only on the machine that runs the team, and the canon names them
 *   as examples (「例: workspace/orchestration/same-kind-findings.md」), not as files
 *   of the repository.
 *
 * Citations that do not resolve on today's develop are listed in KNOWN_EXCEPTIONS
 * with the PR that fixes them, never silently skipped; an exception that resolves
 * again fails, so the table only shrinks.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokenReferences, headingAnchors, references } from './orchestrate-doc-links-3481.test';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs/orchestrate');
const ROLES_DIR = path.join(DOCS_DIR, 'roles');
const TEAM = path.join(DOCS_DIR, 'team.md');
const BODY = '.claude/commands/orchestrate.md';

// ---------------------------------------------------------------------------
// G2: team.md §N / §N-M
// ---------------------------------------------------------------------------

export interface SectionRef {
  from: string;
  section: number;
  item?: number;
}

const CITATION = /team\.md`?\s*(?:の\s*)?(§\d+(?:-\d+)?(?:\s*[・、,]\s*§\d+(?:-\d+)?)*)/g;

/** Every `team.md §N[-M]` in a text, chains included; `from` gets `:<line>`. */
export function sectionRefs(from: string, text: string): SectionRef[] {
  const refs: SectionRef[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CITATION)) {
      for (const one of m[1].matchAll(/§(\d+)(?:-(\d+))?/g)) {
        refs.push({
          from: `${from}:${i + 1}`,
          section: Number(one[1]),
          item: one[2] === undefined ? undefined : Number(one[2]),
        });
      }
    }
  });
  return refs;
}

/** team.md's `## N.` sections and the top-level `M.` items in each, outside fenced code. */
export function teamSections(markdown: string): Map<number, Set<number>> {
  const sections = new Map<number, Set<number>>();
  let current: Set<number> | undefined;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^## (\d+)\.\s/.exec(line);
    if (heading) {
      current = new Set<number>();
      sections.set(Number(heading[1]), current);
      continue;
    }
    if (line.startsWith('## ')) {
      current = undefined;
      continue;
    }
    const item = /^(\d+)\.\s/.exec(line);
    if (item && current) current.add(Number(item[1]));
  }
  return sections;
}

export const label = (ref: SectionRef): string =>
  `${ref.from}: team.md §${ref.section}${ref.item === undefined ? '' : `-${ref.item}`}`;

/** The citations whose section or item does not exist. */
export function brokenSectionRefs(refs: readonly SectionRef[], sections: Map<number, Set<number>>): string[] {
  return refs
    .filter((ref) => {
      const items = sections.get(ref.section);
      return items === undefined || (ref.item !== undefined && !items.has(ref.item));
    })
    .map(label);
}

/**
 * Citations that do not resolve on develop today, with why and the PR that fixes them.
 * Key: the label() string. Empty when PR-1 was written (every citation resolved).
 */
export const KNOWN_EXCEPTIONS: ReadonlyArray<{ ref: string; reason: string; fixedBy: 'PR-2' | 'PR-3' }> = [];

/** Files that are history and are not rewritten when a section moves. */
const HISTORY = new Set(['CHANGELOG.md']);

function citingFiles(): string[] {
  // --untracked: the files of a change are checked before they are committed, too.
  const out = execFileSync(
    'git',
    ['grep', '-l', '--untracked', '-F', 'team.md', '--', '*.md', '*.ts', '*.mjs', '*.yaml'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter((f) => f !== '' && !HISTORY.has(f) && !f.startsWith('workspace/') && !f.startsWith('dev-reports/'))
    .sort();
}

// ---------------------------------------------------------------------------
// G3: one place for a registered rule string
// ---------------------------------------------------------------------------

/**
 * Rule strings that must live in one document only (the owner). PR-1 registers
 * only strings that are in one place today. PR-3 made the cap on concurrent
 * workers one number (`マシンで 5 本`) and registers that string. The old
 * `5〜6 本` is not registered: contract.md uses it for concurrent CI runs, a
 * different count.
 */
export const ONE_PLACE: ReadonlyArray<{ text: string; owner: string; why: string }> = [
  { text: '30〜45 分', owner: 'docs/orchestrate/verify-queue.md', why: '重い検証 1 本の待ちの見込み（§10-4）' },
  { text: 'wip.total', owner: 'docs/orchestrate/team.md', why: 'WIP の上限の置き場（§7）' },
  { text: '目安は 3 レーン', owner: 'docs/orchestrate/team.md', why: 'レーンの目安（§7）' },
  { text: 'マシンで 5 本', owner: 'docs/orchestrate/verify-queue.md', why: '同時のワーカーの上限（§10-4、T1）' },
];

/** `<text>: <files>` for each registered string that is not in exactly its owner. */
export function duplicatedRules(
  registry: ReadonlyArray<{ text: string; owner: string }>,
  docs: ReadonlyArray<{ path: string; text: string }>,
): string[] {
  const problems: string[] = [];
  for (const { text, owner } of registry) {
    const where = docs.filter((d) => d.text.includes(text)).map((d) => d.path);
    if (where.length !== 1 || where[0] !== owner) problems.push(`${text}: [${where.join(', ')}] (owner ${owner})`);
  }
  return problems;
}

function ruleDocs(): Array<{ path: string; text: string }> {
  const names = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  return [...names.map((n) => `docs/orchestrate/${n}`), BODY].map((rel) => ({
    path: rel,
    text: fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
  }));
}

// ---------------------------------------------------------------------------
// G4: repository paths in the role canon
// ---------------------------------------------------------------------------

/** A repository path as the canon writes it (in backticks or prose): `<top>/<rest>[#<anchor>]`. */
const REPO_PATH =
  /(?<![\w./-])((?:docs|scripts|\.claude|src|tests|bin|locales|\.commandmate|\.github|workspace|dev-reports)\/[A-Za-z0-9._/-]*)(?:#([^\s`)）・、。]+))?/g;
/** Gitignored: present only where the team runs, named as examples (see the header). */
const NOT_IN_REPOSITORY = ['workspace/', 'dev-reports/'];

export interface RepoPath {
  from: string;
  path: string;
  anchor?: string;
}

/** The repository paths in a text, minus the gitignored ones; `from` gets `:<line>`. */
export function repoPaths(from: string, text: string): RepoPath[] {
  const found: RepoPath[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(REPO_PATH)) {
      const p = m[1].replace(/\.+$/, '');
      if (NOT_IN_REPOSITORY.some((prefix) => p.startsWith(prefix))) continue;
      found.push({ from: `${from}:${i + 1}`, path: p, anchor: m[2]?.replace(/\.+$/, '') });
    }
  });
  return found;
}

/** The paths that do not exist under `root`, or whose anchor is not a heading of the file. */
export function brokenRepoPaths(paths: readonly RepoPath[], root: string): string[] {
  const broken: string[] = [];
  for (const ref of paths) {
    const abs = path.join(root, ref.path);
    if (!fs.existsSync(abs)) {
      broken.push(`${ref.from}: ${ref.path} does not exist`);
      continue;
    }
    if (ref.anchor === undefined) continue;
    if (!fs.statSync(abs).isFile() || !headingAnchors(fs.readFileSync(abs, 'utf8')).has(ref.anchor)) {
      broken.push(`${ref.from}: ${ref.path}#${ref.anchor} has no such heading`);
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Controls (strings only; the repository is not written)
// ---------------------------------------------------------------------------

const TEAM_FIXTURE = [
  '# T',
  '## 6. 収束',
  '1. 一つ目',
  '6. **六つ目**',
  '   2. 入れ子は数えない',
  '```',
  '7. 囲みの中は数えない',
  '```',
  '## 10. リーダー',
  '4. 四つ目',
  '## Antigravity の扱い',
  '9. 番号の無い節の中',
].join('\n');

// Built from parts so that this file carries no citation of its own for G2 to read.
const T = 'team.md';

describe('G2 controls', () => {
  const sections = teamSections(TEAM_FIXTURE);

  it('reads sections and their top-level items only', () => {
    expect([...sections.keys()]).toEqual([6, 10]);
    expect([...(sections.get(6) ?? [])]).toEqual([1, 6]);
    expect([...(sections.get(10) ?? [])]).toEqual([4]);
  });

  it('reads chains, backticks and の', () => {
    const refs = sectionRefs('a.md', `例: ${T} §6-6・§10-6\n\`${T}\` §1 と ${T} の §10-4。`);
    expect(refs.map(label)).toEqual([
      `a.md:1: ${T} §6-6`,
      `a.md:1: ${T} §10-6`,
      `a.md:2: ${T} §1`,
      `a.md:2: ${T} §10-4`,
    ]);
  });

  it('positive: a missing section and a missing item are reported', () => {
    const refs = sectionRefs('a.md', `${T} §99 と ${T} §6-7 と ${T} §10-4・§10-5`);
    expect(brokenSectionRefs(refs, sections)).toEqual([
      `a.md:1: ${T} §99`,
      `a.md:1: ${T} §6-7`,
      `a.md:1: ${T} §10-5`,
    ]);
  });

  it('positive: an item that only exists nested or in fenced code does not count', () => {
    expect(brokenSectionRefs(sectionRefs('a.md', `${T} §6-2・§6-7`), sections)).toEqual([
      `a.md:1: ${T} §6-2`,
      `a.md:1: ${T} §6-7`,
    ]);
  });

  it('negative: existing sections and items pass, and other files are not read as team.md', () => {
    const refs = sectionRefs('a.md', `${T} §6・§6-6、${T} §10-4。ci-merge.md §6-2 は別`);
    expect(refs).toHaveLength(3);
    expect(brokenSectionRefs(refs, sections)).toEqual([]);
  });
});

describe('G3 controls', () => {
  const registry = [{ text: '30〜45 分', owner: 'a.md' }];

  it('positive: a registered string in a second document is reported', () => {
    const docs = [
      { path: 'a.md', text: '待ちは 30〜45 分' },
      { path: 'b.md', text: '見込み 30〜45 分' },
    ];
    expect(duplicatedRules(registry, docs)).toEqual(['30〜45 分: [a.md, b.md] (owner a.md)']);
  });

  it('positive: a registered string that moved away from its owner, or is gone, is reported', () => {
    expect(duplicatedRules(registry, [{ path: 'b.md', text: '30〜45 分' }])).toEqual([
      '30〜45 分: [b.md] (owner a.md)',
    ]);
    expect(duplicatedRules(registry, [{ path: 'a.md', text: '' }])).toEqual(['30〜45 分: [] (owner a.md)']);
  });

  it('negative: a string only in its owner, with a link elsewhere, passes', () => {
    const docs = [
      { path: 'a.md', text: '待ちは 30〜45 分（30〜45 分は 2 回でも同じファイル）' },
      { path: 'b.md', text: '見込みは [a.md](a.md) を見る' },
    ];
    expect(duplicatedRules(registry, docs)).toEqual([]);
  });
});

describe('G4 controls', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  const rootWith = (files: Record<string, string>): string => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-canon-paths-'));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpRoot, name)), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, name), text);
    }
    return tmpRoot;
  };

  it('reads paths in backticks and prose, drops a trailing period or 「・」, and leaves out workspace/ and dev-reports/', () => {
    const text = [
      '- 例: `node scripts/orchestrate/flow-wip.mjs check`。',
      '- 例: `workspace/orchestration/same-kind-findings.md`・dev-reports/x.md',
      '- 正本は `docs/orchestrate/` と docs/user-guide/uat-isolation.md#隔離.',
    ].join('\n');
    expect(repoPaths('r.md', text)).toEqual([
      { from: 'r.md:1', path: 'scripts/orchestrate/flow-wip.mjs', anchor: undefined },
      { from: 'r.md:3', path: 'docs/orchestrate/', anchor: undefined },
      { from: 'r.md:3', path: 'docs/user-guide/uat-isolation.md', anchor: '隔離' },
    ]);
  });

  it('positive: a canon path that does not exist, and a missing heading on an existing file, are reported', () => {
    const root = rootWith({ 'scripts/a.mjs': '', 'docs/g.md': '# G\n\n## 隔離\n' });
    const refs = repoPaths('roles/x.md', '例: `scripts/gone.mjs` と docs/g.md#無い節 と scripts/a.mjs');
    expect(brokenRepoPaths(refs, root)).toEqual([
      'roles/x.md:1: scripts/gone.mjs does not exist',
      'roles/x.md:1: docs/g.md#無い節 has no such heading',
    ]);
  });

  it('negative: existing files, a directory and an existing heading pass; workspace/ is not required', () => {
    const root = rootWith({ 'scripts/a.mjs': '', 'docs/g.md': '# G\n\n## 隔離\n' });
    const refs = repoPaths('roles/x.md', '`scripts/a.mjs`・`docs/`・docs/g.md#隔離・`workspace/none.md`');
    expect(refs).toHaveLength(3);
    expect(brokenRepoPaths(refs, root)).toEqual([]);
  });

  it('positive: a canon pointer to a missing heading is reported', () => {
    const refs = references('roles/x.md', '例: docs/orchestrate/team.md#99-無い節 を読む');
    expect(brokenReferences(refs, DOCS_DIR)).toEqual(['roles/x.md: team.md#99-無い節 has no such heading']);
  });

  it('negative: a canon pointer to an existing heading resolves', () => {
    const refs = references('roles/x.md', '例: docs/orchestrate/team.md#7-wip-の上限とレーンの組み方 を読む');
    expect(brokenReferences(refs, DOCS_DIR)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real files
// ---------------------------------------------------------------------------

describe('G2: team.md §N citations resolve (#4546)', () => {
  const sections = teamSections(fs.readFileSync(TEAM, 'utf8'));
  const files = citingFiles();
  const refs = files.flatMap((f) => sectionRefs(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')));
  const broken = brokenSectionRefs(refs, sections);
  const known = new Set(KNOWN_EXCEPTIONS.map((e) => e.ref));

  it('finds the sections and the citations (anti-vacuity)', () => {
    expect(sections.size).toBeGreaterThanOrEqual(13);
    expect(refs.length).toBeGreaterThanOrEqual(30);
    // The canon cites team.md as well and is read like any other file.
    expect(files).toContain('docs/orchestrate/roles/dev-leader.md');
    expect(refs.some((r) => r.from.startsWith('docs/orchestrate/roles/'))).toBe(true);
    expect(files).not.toContain('CHANGELOG.md');
  });

  it('every citation names an existing section and item, apart from the known exceptions', () => {
    expect(broken.filter((b) => !known.has(b))).toEqual([]);
  });

  it('every known exception is still broken (the table only shrinks)', () => {
    expect([...known].filter((k) => !broken.includes(k))).toEqual([]);
  });
});

describe('G3: registered rule strings live in one document (#4546)', () => {
  it('scans the top-level documents, the index and the body (anti-vacuity)', () => {
    const paths = ruleDocs().map((d) => d.path);
    expect(paths).toContain('docs/orchestrate/team.md');
    expect(paths).toContain('docs/orchestrate/ci-merge.md');
    expect(paths).toContain(BODY);
    expect(ONE_PLACE.length).toBeGreaterThanOrEqual(3);
  });

  it('every registered string is in its owner and nowhere else', () => {
    expect(duplicatedRules(ONE_PLACE, ruleDocs())).toEqual([]);
  });
});

describe('G4: the role canon points at existing headings (#4546)', () => {
  const canon = fs
    .readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const refs = canon.flatMap((name) =>
    references(`docs/orchestrate/roles/${name}`, fs.readFileSync(path.join(ROLES_DIR, name), 'utf8')),
  );

  it('reads the four canon files and finds their pointers (anti-vacuity)', () => {
    expect(canon).toHaveLength(4);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('every docs/orchestrate/*.md[#…] pointer in the canon exists', () => {
    expect(brokenReferences(refs, DOCS_DIR)).toEqual([]);
  });

  const paths = canon.flatMap((name) =>
    repoPaths(`docs/orchestrate/roles/${name}`, fs.readFileSync(path.join(ROLES_DIR, name), 'utf8')),
  );

  it('finds the repository paths the canon names (anti-vacuity)', () => {
    expect(paths.length).toBeGreaterThanOrEqual(7);
    expect(paths.map((p) => p.path)).toEqual(
      expect.arrayContaining([
        'docs/user-guide/uat-isolation.md',
        'scripts/orchestrate/templates/goal.md',
        'scripts/orchestrate/flow-wip.mjs',
      ]),
    );
    expect(paths.some((p) => p.path.startsWith('workspace/'))).toBe(false);
  });

  it('every repository path the canon names exists, with its heading when it has #…', () => {
    expect(brokenRepoPaths(paths, REPO_ROOT)).toEqual([]);
  });
});
