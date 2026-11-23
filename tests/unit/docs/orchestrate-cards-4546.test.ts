/**
 * The index of the operations docs and the cards it points at (Issue #4546 PR-1).
 *
 * The cards are the role canon's 「場面ごとに必ずすること」 sections
 * (docs/orchestrate/roles/*.md, #4548): one bold line that says when a scene
 * applies, then the few lines to do. docs/orchestrate/README.md is the index:
 * for each reader (PM・開発リーダー・ワーカー・審判・イネーブラー) and each scene
 * (着手・依頼・見張り・裁定・マージ・受け入れ・振り返り) it links the card and the
 * reference (the operations docs that hold the numbers and commands).
 *
 * Pinned here:
 * - G1: every scene of every canon file stays short (at most 10 non-empty lines).
 *   A card that grows past that has started to carry the reference's numbers.
 * - G1c: every link in the index tables resolves — the file exists, the anchor is
 *   an existing heading (GitHub's rule, imported from orchestrate-doc-links-3481),
 *   and a link into a 場面 section names a scene that the section has. No cell is
 *   empty or a bare dash; a cell with nothing to point at says so. Every scene of
 *   every canon file is pointed at from some cell (a scene the index misses is a
 *   card nobody is sent to).
 * - The index reaches every document of docs/orchestrate/. The body reaches the
 *   index in turn (one line in orchestrate.md; orchestrate-doc-links-3481 checks it).
 *
 * Each check runs against strings or a temporary directory first (controls),
 * then against the real files. The real files are only read.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headingAnchors } from './orchestrate-doc-links-3481.test';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs/orchestrate');
const ROLES_DIR = path.join(DOCS_DIR, 'roles');
const INDEX = path.join(DOCS_DIR, 'README.md');

const SCENE_SECTION = '場面ごとに必ずすること';
const SCENE_ANCHOR = SCENE_SECTION; // GitHub's anchor of the heading is the heading itself.
export const MAX_SCENE_LINES = 10;
export const READERS = ['PM', '開発リーダー', 'ワーカー', '審判', 'イネーブラー'] as const;
export const SCENES = ['着手', '依頼', '見張り', '裁定', 'マージ', '受け入れ', '振り返り'] as const;
/** What a cell says when no section applies (a cell is never empty or a bare dash). */
export const NO_SECTION = '当てはまる節は無い';

// ---------------------------------------------------------------------------
// G1: scenes of the canon
// ---------------------------------------------------------------------------

export interface Scene {
  label: string;
  lines: number;
}

/** The scenes of a canon file's 「場面ごとに必ずすること」 section: the bold label and its non-empty lines. */
export function scenesOf(markdown: string): Scene[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l === `## ${SCENE_SECTION}`);
  if (start === -1) return [];
  const scenes: Scene[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const label = /^\*\*([^*]+)\*\*/.exec(line);
    if (label) {
      scenes.push({ label: label[1], lines: 0 });
    } else if (line.trim() !== '' && scenes.length > 0) {
      scenes[scenes.length - 1].lines += 1;
    }
  }
  return scenes;
}

/** `<label>: <n> lines` for each scene over the limit. */
export function longScenes(from: string, markdown: string, max = MAX_SCENE_LINES): string[] {
  return scenesOf(markdown)
    .filter((s) => s.lines > max)
    .map((s) => `${from}: 「${s.label}」 has ${s.lines} lines (max ${max})`);
}

// ---------------------------------------------------------------------------
// G1c: the index
// ---------------------------------------------------------------------------

export interface IndexRow {
  reader: string;
  scene: string;
  card: string;
  reference: string;
}

const splitRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

/** The rows of the index tables: one `### <reader>` table per reader, rows `| 場面 | カード | 参照 |`. */
export function indexRows(markdown: string): IndexRow[] {
  const rows: IndexRow[] = [];
  let reader: string | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      reader = heading[1] === '###' ? heading[2] : undefined;
      continue;
    }
    if (reader === undefined || !line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length !== 3 || cells[0] === '場面' || /^-+$/.test(cells[0])) continue;
    rows.push({ reader, scene: cells[0], card: cells[1], reference: cells[2] });
  }
  return rows;
}

export interface Link {
  text: string;
  target: string;
}

export function linksOf(text: string): Link[] {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({ text: m[1], target: m[2] }));
}

/** Problems with one cell: empty or a dash, or neither a link nor the no-section phrase. */
export function cellProblems(where: string, cell: string): string[] {
  if (cell === '' || /^[-—–‐]+$/.test(cell)) return [`${where}: empty cell`];
  if (linksOf(cell).length === 0 && !cell.includes(NO_SECTION)) {
    return [`${where}: no link and no 「${NO_SECTION}」`];
  }
  return [];
}

/** Links from `fromDir` whose file, heading or scene does not exist. */
export function brokenLinks(where: string, links: readonly Link[], fromDir: string): string[] {
  const broken: string[] = [];
  for (const link of links) {
    if (/^[a-z]+:/.test(link.target)) {
      broken.push(`${where}: ${link.target} is not a repository link`);
      continue;
    }
    const [rel, anchor] = link.target.split('#');
    const file = path.resolve(fromDir, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      broken.push(`${where}: ${rel} does not exist`);
      continue;
    }
    if (anchor === undefined) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!headingAnchors(text).has(anchor)) {
      broken.push(`${where}: ${rel}#${anchor} has no such heading`);
      continue;
    }
    if (anchor === SCENE_ANCHOR) {
      const labels = scenesOf(text).map((s) => s.label);
      if (link.text.length < 2 || !labels.some((label) => label.includes(link.text))) {
        broken.push(`${where}: ${rel} has no scene 「${link.text}」`);
      }
    }
  }
  return broken;
}

/**
 * The canon scenes that no link of the index points at. A link points at a scene
 * when it targets `<file>#場面ごとに必ずすること` and its text is part of the
 * scene's label (the rule brokenLinks uses). `canon` maps `roles/<name>` to its text.
 */
export function unlinkedScenes(markdown: string, canon: Readonly<Record<string, string>>): string[] {
  const links = indexRows(markdown).flatMap((r) => [...linksOf(r.card), ...linksOf(r.reference)]);
  const missing: string[] = [];
  for (const [file, text] of Object.entries(canon)) {
    const texts = links.filter((l) => l.target === `${file}#${SCENE_ANCHOR}`).map((l) => l.text);
    for (const { label } of scenesOf(text)) {
      if (!texts.some((t) => t.length >= 2 && label.includes(t))) missing.push(`${file}: 「${label}」`);
    }
  }
  return missing;
}

/** Everything wrong with an index text: missing reader × scene rows, bad cells and broken links. */
export function indexProblems(markdown: string, fromDir: string): string[] {
  const rows = indexRows(markdown);
  const problems: string[] = [];
  for (const reader of READERS) {
    for (const scene of SCENES) {
      const found = rows.filter((r) => r.reader === reader && r.scene === scene);
      if (found.length !== 1) problems.push(`${reader} × ${scene}: ${found.length} rows`);
    }
  }
  for (const row of rows) {
    const where = `${row.reader} × ${row.scene}`;
    problems.push(...cellProblems(`${where} カード`, row.card), ...cellProblems(`${where} 参照`, row.reference));
    problems.push(...brokenLinks(where, [...linksOf(row.card), ...linksOf(row.reference)], fromDir));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Controls (strings and a temporary directory; the repository is not written)
// ---------------------------------------------------------------------------

const sceneBody = (n: number): string => Array.from({ length: n }, (_, i) => `- line ${i + 1}`).join('\n');

describe('G1 controls', () => {
  it('positive: an 11-line scene is reported', () => {
    const md = `# R\n\n## ${SCENE_SECTION}\n前置き\n\n**長い場面のとき**\n${sceneBody(11)}\n\n**短い場面**\n- a\n`;
    expect(longScenes('r.md', md)).toEqual(['r.md: 「長い場面のとき」 has 11 lines (max 10)']);
  });

  it('negative: a 10-line scene passes, and lines after the next ## heading are not counted', () => {
    const md = `## ${SCENE_SECTION}\n**ちょうど 10 行**\n${sceneBody(10)}\n\n## 権限\n${sceneBody(20)}\n`;
    expect(scenesOf(md)).toEqual([{ label: 'ちょうど 10 行', lines: 10 }]);
    expect(longScenes('r.md', md)).toEqual([]);
  });
});

describe('G1c controls', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const docsWith = (files: Record<string, string>): string => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-cards-'));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, name)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, name), text);
    }
    return tmpDir;
  };

  const files = {
    'roles/pm.md': `# PM\n\n## ${SCENE_SECTION}\n\n**計画を出す前（着手の確かめ）**\n- a\n\n## 判断の基準\n- b\n`,
    'team.md': '# T\n\n## 7. WIP の上限\n',
  };

  it('positive: a link to a heading that does not exist is reported', () => {
    const dir = docsWith(files);
    const links = linksOf('[§7](team.md#7-wip-の下限)');
    expect(brokenLinks('PM × 着手', links, dir)).toEqual(['PM × 着手: team.md#7-wip-の下限 has no such heading']);
  });

  it('positive: a link to a file that does not exist is reported', () => {
    const dir = docsWith(files);
    expect(brokenLinks('x', linksOf('[g](gone.md)'), dir)).toEqual(['x: gone.md does not exist']);
  });

  it('positive: a link into the 場面 section that names no scene is reported', () => {
    const dir = docsWith(files);
    const links = linksOf(`[振り返り](roles/pm.md#${SCENE_ANCHOR})`);
    expect(brokenLinks('x', links, dir)).toEqual(['x: roles/pm.md has no scene 「振り返り」']);
  });

  it('positive: an empty cell, a dash and a cell with neither link nor reason are reported', () => {
    expect(cellProblems('c', '')).toEqual(['c: empty cell']);
    expect(cellProblems('c', '—')).toEqual(['c: empty cell']);
    expect(cellProblems('c', '無し')).toEqual([`c: no link and no 「${NO_SECTION}」`]);
  });

  it('positive: a missing reader × scene row is reported', () => {
    const dir = docsWith(files);
    const md = `### PM\n\n| 場面 | カード | 参照 |\n|---|---|---|\n| 着手 | [着手の確かめ](roles/pm.md#${SCENE_ANCHOR}) | [§7](team.md#7-wip-の上限) |\n`;
    const problems = indexProblems(md, dir);
    expect(problems).toContain('PM × 依頼: 0 rows');
    expect(problems).not.toContain('PM × 着手: 0 rows');
    expect(problems).toHaveLength(READERS.length * SCENES.length - 1);
  });

  it('positive: a canon scene that no cell points at is reported', () => {
    const canon = { 'roles/pm.md': `## ${SCENE_SECTION}\n**着手の確かめ**\n- a\n**人の答えを待つとき**\n- b\n` };
    const md = `### PM\n\n| 場面 | カード | 参照 |\n|---|---|---|\n| 着手 | [着手の確かめ](roles/pm.md#${SCENE_ANCHOR}) | ${NO_SECTION} |\n`;
    expect(unlinkedScenes(md, canon)).toEqual(['roles/pm.md: 「人の答えを待つとき」']);
  });

  it('negative: every scene pointed at (by a part of its label) passes', () => {
    const canon = { 'roles/pm.md': `## ${SCENE_SECTION}\n**着手の確かめ**\n- a\n**動いている間（30 分ごと）**\n- b\n` };
    const md = `### PM\n\n| 場面 | カード | 参照 |\n|---|---|---|\n| 着手 | [着手の確かめ](roles/pm.md#${SCENE_ANCHOR}) | ${NO_SECTION} |\n| 見張り | [動いている間](roles/pm.md#${SCENE_ANCHOR}) | ${NO_SECTION} |\n`;
    expect(unlinkedScenes(md, canon)).toEqual([]);
  });

  it('negative: existing headings, an existing scene and a stated absence pass', () => {
    const dir = docsWith(files);
    const md = [
      '### PM',
      '',
      '| 場面 | カード | 参照 |',
      '|---|---|---|',
      `| 着手 | [着手の確かめ](roles/pm.md#${SCENE_ANCHOR})・[判断の基準](roles/pm.md#判断の基準) | [§7](team.md#7-wip-の上限) |`,
      `| マージ | ${NO_SECTION}（PM はマージしない） | [team.md](team.md) |`,
    ].join('\n');
    const rows = indexRows(md);
    expect(rows.map((r) => r.scene)).toEqual(['着手', 'マージ']);
    for (const row of rows) {
      const where = `${row.reader} × ${row.scene}`;
      expect(cellProblems(where, row.card)).toEqual([]);
      expect(cellProblems(where, row.reference)).toEqual([]);
      expect(brokenLinks(where, [...linksOf(row.card), ...linksOf(row.reference)], dir)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The real files
// ---------------------------------------------------------------------------

const roleFiles = fs
  .readdirSync(ROLES_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

describe('G1: the canon scenes stay short (#4546)', () => {
  it('finds the scenes of the four canon files (anti-vacuity)', () => {
    expect(roleFiles).toHaveLength(4);
    for (const name of roleFiles) {
      expect(scenesOf(fs.readFileSync(path.join(ROLES_DIR, name), 'utf8')).length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it(`every scene has at most ${MAX_SCENE_LINES} non-empty lines`, () => {
    const long = roleFiles.flatMap((name) =>
      longScenes(`roles/${name}`, fs.readFileSync(path.join(ROLES_DIR, name), 'utf8')),
    );
    expect(long).toEqual([]);
  });
});

describe('G1c: docs/orchestrate/README.md, the index (#4546)', () => {
  const index = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';

  it('exists and has a row for every reader × scene', () => {
    expect(fs.existsSync(INDEX)).toBe(true);
    expect(indexRows(index)).toHaveLength(READERS.length * SCENES.length);
  });

  it('every cell links an existing card or reference, or says that no section applies', () => {
    expect(indexProblems(index, DOCS_DIR)).toEqual([]);
  });

  it('links a scene of every canon file', () => {
    const cards = indexRows(index).flatMap((r) => linksOf(r.card).map((l) => l.target));
    for (const name of roleFiles) {
      expect(cards, name).toContain(`roles/${name}#${SCENE_ANCHOR}`);
    }
  });

  it('points at every scene of every canon file', () => {
    const canon = Object.fromEntries(
      roleFiles.map((name) => [`roles/${name}`, fs.readFileSync(path.join(ROLES_DIR, name), 'utf8')]),
    );
    expect(Object.values(canon).reduce((n, text) => n + scenesOf(text).length, 0)).toBeGreaterThanOrEqual(21);
    expect(unlinkedScenes(index, canon)).toEqual([]);
  });

  it('states the three rules of where things go', () => {
    const start = index.indexOf('\n## 置き場の原則\n');
    expect(start).toBeGreaterThan(-1);
    const section = index.slice(start + 1, index.indexOf('\n## ', start + 1));
    const bullets = section.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toContain('1 か所');
    expect(bullets[1]).toContain('参照');
    expect(bullets[2]).toContain('経緯');
  });

  it('reaches every document of docs/orchestrate/ and roles/ (the index is how they are found)', () => {
    const targets = new Set(linksOf(index).map((l) => l.target.split('#')[0]));
    const docs = fs
      .readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .concat(roleFiles.map((f) => `roles/${f}`));
    expect(docs.filter((d) => !targets.has(d))).toEqual([]);
  });

  it('every link outside the tables resolves as well', () => {
    expect(brokenLinks('README.md', linksOf(index), DOCS_DIR)).toEqual([]);
  });
});
