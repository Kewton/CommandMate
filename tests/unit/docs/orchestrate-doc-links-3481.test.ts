/**
 * References from the /orchestrate runbook into docs/orchestrate/ resolve (Issue #3481).
 *
 * #3481 split `.claude/commands/orchestrate.md`: the body keeps one line per
 * rule, and points at the measurements and on-demand procedures with
 * `根拠: docs/orchestrate/<file>.md#<heading>` or "… を読む" lines. A pointer
 * whose file or heading is gone sends the orchestrator nowhere, and nothing
 * else checks it: the README link test (readme-relative-links-2996) resolves
 * files only, and never anchors. This pins every `docs/orchestrate/*.md#…`
 * reference in the body and in docs/orchestrate/ itself to an existing file
 * and an existing heading, with the anchor built by GitHub's heading rule.
 *
 * It also pins the shape of the body's 「必ず守ること」 section: each collected
 * rule names the heading it came from, and that heading exists in the body.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BODY = '.claude/commands/orchestrate.md';
const DOCS_DIR = 'docs/orchestrate';

/** GitHub's heading anchor: lower case, punctuation and symbols dropped (but `-` / `_`), spaces → `-`. */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (c) => (c === '-' || c === '_' ? c : ''))
    .replace(/ /g, '-');
}

/** The anchors of a markdown text's headings, outside fenced code, with GitHub's `-1` suffix for repeats. */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const match = inFence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = githubSlug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** `docs/orchestrate/<file>.md` with an optional `#<anchor>`, as the body writes it (an anchor ends at a space). */
const REFERENCE = /docs\/orchestrate\/([A-Za-z0-9._-]+\.md)(?:#([^\s`)）]+))?/g;

interface Reference {
  from: string;
  file: string;
  anchor?: string;
}

export function references(from: string, text: string): Reference[] {
  return [...text.matchAll(REFERENCE)].map((m) => ({ from, file: m[1], anchor: m[2] }));
}

/** The references whose file or heading does not exist under `docsDir`. */
export function brokenReferences(refs: readonly Reference[], docsDir: string): string[] {
  const broken: string[] = [];
  for (const ref of refs) {
    const file = path.join(docsDir, ref.file);
    if (!fs.existsSync(file)) {
      broken.push(`${ref.from}: ${ref.file} does not exist`);
      continue;
    }
    if (ref.anchor !== undefined && !headingAnchors(fs.readFileSync(file, 'utf8')).has(ref.anchor)) {
      broken.push(`${ref.from}: ${ref.file}#${ref.anchor} has no such heading`);
    }
  }
  return broken;
}

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const body = read(BODY);
const docFiles = fs.readdirSync(path.join(REPO_ROOT, DOCS_DIR)).filter((name) => name.endsWith('.md')).sort();
const allRefs = [
  ...references(BODY, body),
  ...docFiles.flatMap((name) => references(`${DOCS_DIR}/${name}`, read(`${DOCS_DIR}/${name}`))),
];

describe('orchestrate.md → docs/orchestrate/ references resolve (#3481)', () => {
  it('finds the references (anti-vacuity)', () => {
    expect(docFiles.length).toBeGreaterThanOrEqual(4);
    expect(references(BODY, body).filter((ref) => ref.anchor !== undefined).length).toBeGreaterThanOrEqual(30);
  });

  it('every file and heading the body and the documents point at exists', () => {
    expect(brokenReferences(allRefs, path.join(REPO_ROOT, DOCS_DIR))).toEqual([]);
  });

  it('every document under docs/orchestrate/ is reachable from the body', () => {
    const named = new Set(references(BODY, body).map((ref) => ref.file));
    expect(docFiles.filter((name) => !named.has(name))).toEqual([]);
  });
});

describe('the anchor rule', () => {
  it.each([
    ['1-2b 中の範囲を広げた実測', '1-2b-中の範囲を広げた実測'],
    ['3-1 assign.tsv を stdin で読んで止まった実測', '3-1-assigntsv-を-stdin-で読んで止まった実測'],
    ['2.5-4 写しと全経路のテストの実例', '25-4-写しと全経路のテストの実例'],
    // The anchor GitHub itself produced, pinned by readme-relative-links-2996.
    ['スマホ通知（プッシュ通知）', 'スマホ通知プッシュ通知'],
  ])('%s → %s', (heading, anchor) => {
    expect(githubSlug(heading)).toBe(anchor);
  });

  it('numbers a repeated heading and ignores headings inside fenced code', () => {
    const anchors = headingAnchors('## A b\n\n## A b\n\n```bash\n## not a heading\n```\n');
    expect([...anchors]).toEqual(['a-b', 'a-b-1']);
  });
});

describe('controls', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const docsWith = (files: Record<string, string>): string => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-links-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, name), text);
    return tmpDir;
  };

  it('positive: a pointer to a heading that does not exist is reported', () => {
    const dir = docsWith({ 'a.md': '# A\n\n## 3-4 20 の対応\n' });
    const refs = references('body', '根拠: docs/orchestrate/a.md#3-4-21-の対応\n');
    expect(brokenReferences(refs, dir)).toEqual(['body: a.md#3-4-21-の対応 has no such heading']);
  });

  it('positive: a pointer to a file that does not exist is reported', () => {
    const dir = docsWith({});
    expect(brokenReferences(references('body', 'docs/orchestrate/gone.md#x を読む'), dir)).toEqual([
      'body: gone.md does not exist',
    ]);
  });

  it('positive: a heading that only appears inside fenced code does not count', () => {
    const dir = docsWith({ 'a.md': '```bash\n## 分析要求\n```\n' });
    expect(brokenReferences(references('body', 'docs/orchestrate/a.md#分析要求 を読む'), dir)).toHaveLength(1);
  });

  it('negative: an existing heading resolves, and the anchor stops at the space before を読む', () => {
    const dir = docsWith({ 'a.md': '## 3-4 20 の対応\n' });
    const refs = references('body', 'exit 20 を受けたら docs/orchestrate/a.md#3-4-20-の対応 を読む。');
    expect(refs).toEqual([{ from: 'body', file: 'a.md', anchor: '3-4-20-の対応' }]);
    expect(brokenReferences(refs, dir)).toEqual([]);
  });
});

describe('orchestrate.md: 必ず守ること (#3481)', () => {
  const start = body.indexOf('\n## 必ず守ること\n');
  const end = body.indexOf('\n## ', start + 1);
  const section = body.slice(start, end);
  const rules = section.split('\n').filter((line) => line.startsWith('- '));

  it('sits at the top of the body, before 使用方法', () => {
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(body.indexOf('\n## 使用方法\n'));
  });

  it('says where measurements and rationale go', () => {
    expect(section).toContain('実測・根拠は docs/orchestrate/ へ。本体には規則を 1 行だけ');
  });

  it('collects the rules one per line, each naming the heading it came from', () => {
    expect(rules.length).toBeGreaterThanOrEqual(20);
    const missing = rules
      .map((line) => ({ line, id: /（([^（）]+)）$/.exec(line)?.[1] }))
      .filter(({ id }) => {
        if (id === undefined) return true;
        const lines = body.split('\n');
        return !lines.some((l) => l === `## ${id}` || l.startsWith(`## ${id}:`) || l.startsWith(`### ${id}.`));
      })
      .map(({ line }) => line);
    expect(missing, 'a rule without an existing source heading').toEqual([]);
  });
});
