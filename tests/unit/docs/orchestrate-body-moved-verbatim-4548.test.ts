/**
 * Text moved out of .claude/commands/orchestrate.md is moved verbatim (Issue #4548 R6).
 *
 * #4548 adds the direction of the role canon (docs/orchestrate/roles/dev-leader.md:
 * when an escalation condition and the second finding of the same kind coincide,
 * STOP comes first) to 3-5 and 3-5b of the body, as a pointer to that canon. The
 * body is at the 108,000-byte target of orchestrate-size-headroom-4276 (not changed),
 * so one line of history with no rule in it (2-4-4, the result of the four-week
 * trial) moves verbatim to the section of docs/orchestrate/trials.md that 2-4-4
 * already links (`2-4-4 事前レビューの書き方と記録`, where
 * orchestrate-pre-design-review-3475 looks for it). This pins the move so that no
 * line of the body is reworded:
 *
 * - V1: each moved text is a line of its destination, exactly once, inside the
 *   registered heading's section (whole-line match on `split('\n')`).
 * - V2: each moved text is gone from the body, and some line of the body still names
 *   the destination as `docs/orchestrate/<file>#<anchor>`, with that file and exactly
 *   the slug of that heading (a `根拠:` line or a link inside a sentence, like 2-4-4's
 *   `docs/orchestrate/trials.md#2-4-4-事前レビューの書き方と記録 を読み`). The file
 *   alone, or a link to another heading, does not count.
 * - V3: every line of the changed sections of the body (SECTIONS: `### 2-4-4.`,
 *   `### 3-5.`, `### 3-5b.`, each from its heading to the next `###` or `##`) is (a) a
 *   line of those sections at develop 0112f1a49 (the commit before the move) or (b) a
 *   line of ALLOWED, at most as many times as it is registered and right before the
 *   original line it is registered before. Lines outside SECTIONS are not looked at,
 *   so a later change elsewhere in the body does not need this table rebuilt.
 * - V4: the `<file>#<anchor>` of each `根拠:` line of the body is an existing heading
 *   of that docs/orchestrate file (GitHub's rule, from orchestrate-doc-links-3481).
 * - V5: no original line is lost: each line of ORIGINAL_LINE_HASHES is a line of
 *   SECTIONS today, a moved text, or the line an ALLOWED item replaces. V3 alone
 *   passes when a line is only deleted.
 * - V6: no ALLOWED line is a rewording: each is (i) a whole line, verbatim, of the
 *   item's `source` (a file of docs/orchestrate/roles/), its leading `- ` or `* `
 *   aside (a part of a line, or a line of another role's file, does not count), or
 *   (ii) a pointer only, matching CANON_POINTER, whose file has a
 *   `## <the name in 「」>` heading.
 *
 * The original lines are held as hashes (ORIGINAL_LINE_HASHES): CI checks out one
 * commit, so `git show 0112f1a49:…` is not available there. The table was generated
 * from the SECTIONS of `git show 0112f1a49:.claude/commands/orchestrate.md`, not typed.
 *
 * To change SECTIONS of the body on purpose after this move (a new rule, a reworded
 * line), rebuild ORIGINAL_LINE_HASHES from today's develop body with REBUILD (the one
 * line below), and paste its output into the set:
 *   git show origin/develop:.claude/commands/orchestrate.md | node -e "const c=require('crypto');const l=require('fs').readFileSync(0,'utf8').split('\n');const p=['### 2-4-4. ','### 3-5. ','### 3-5b. '];const o=new Set();let on=false;for(const x of l){if(/^#{2,3} /.test(x))on=p.some((q)=>x.startsWith(q));if(on)o.add(x)}console.log([...o].map((x)=>\"  '\"+c.createHash('sha256').update(x).digest('hex').slice(0,16)+\"',\").sort().join('\n'))"
 * After the rebuild, MOVED and ALLOWED may be empty (the lines are originals again;
 * the test that pins MOVED's 1 item is changed with it).
 *
 * The controls run on a temporary directory; the real files are only read.
 *
 * @vitest-environment node
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubSlug, headingAnchors } from './orchestrate-doc-links-3481.test';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BODY_RELATIVE_PATH = '.claude/commands/orchestrate.md';
const DOCS_DIR = 'docs/orchestrate';
const ROLES_DIR = 'docs/orchestrate/roles';

/** The headings of the sections of the body that V3 and V5 look at. */
export const SECTIONS: ReadonlyArray<string> = ['### 2-4-4. ', '### 3-5. ', '### 3-5b. '];

/** The one line that rebuilds ORIGINAL_LINE_HASHES (shown when V3 or V5 fails). */
export const REBUILD = String.raw`git show origin/develop:.claude/commands/orchestrate.md | node -e "const c=require('crypto');const l=require('fs').readFileSync(0,'utf8').split('\n');const p=['### 2-4-4. ','### 3-5. ','### 3-5b. '];const o=new Set();let on=false;for(const x of l){if(/^#{2,3} /.test(x))on=p.some((q)=>x.startsWith(q));if(on)o.add(x)}console.log([...o].map((x)=>\"  '\"+c.createHash('sha256').update(x).digest('hex').slice(0,16)+\"',\").sort().join('\n'))"`;

/** V6 (ii): a new line that only points at a heading of the role canon. */
export const CANON_POINTER = /^STOP が先になる条件: docs\/orchestrate\/roles\/([a-z-]+\.md)「([^」]+)」$/;

export interface Moved {
  /** Where the text was in the body at 0112f1a49. */
  from: string;
  /** The whole original line, verbatim. */
  text: string;
  /** The destination, from the repository root. */
  to: string;
  /** The destination heading, without the `#`s. */
  heading: string;
}

export interface Allowed {
  /** The new line of the body, verbatim. */
  line: string;
  /** The hash of the original line it replaces, or 'new' when it replaces none. */
  replaces: string;
  /** The hash of the original line that comes right after it. */
  before: string;
  /** The role canon file the line comes from or points at (e.g. 'docs/orchestrate/roles/dev-leader.md'). */
  source: string;
  why: string;
}

export interface Registry {
  originals: ReadonlySet<string>;
  moved: ReadonlyArray<Moved>;
  allowed: ReadonlyArray<Allowed>;
}

/** The short hash ORIGINAL_LINE_HASHES holds for one line. */
export const lineHash = (line: string): string =>
  crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);

/** The lines of SECTIONS of a body, with their 0-based index in the whole body. */
export function sectionEntries(body: string): Array<{ index: number; line: string }> {
  const out: Array<{ index: number; line: string }> = [];
  let on = false;
  body.split('\n').forEach((line, index) => {
    if (/^#{2,3} /.test(line)) on = SECTIONS.some((h) => line.startsWith(h));
    if (on) out.push({ index, line });
  });
  return out;
}

/** The hashes ORIGINAL_LINE_HASHES holds for a body (what REBUILD prints). */
export const sectionHashes = (body: string): Set<string> => new Set(sectionEntries(body).map((e) => lineHash(e.line)));

/** A `根拠:` line of the body: `根拠: docs/orchestrate/<file>#<anchor>` and nothing else. */
const POINTER = /^\s*根拠: docs\/orchestrate\/([^#\s]+)#(\S+)$/;
/** Each `docs/orchestrate/<file>#<anchor>` anywhere in a line (the anchor ends at a space, `)` or the line's end). */
const REFERENCE = /docs\/orchestrate\/([^#\s()（）]+)#([^\s()（）、。]+)/g;

/** The lines of the section under `heading` (to the next heading of the same or a higher level). */
export function sectionLines(markdown: string, heading: string): string[] | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#{1,6} /, '') === heading);
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start])?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#{1,6}) /.exec(l);
    return m !== null && m[1].length <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
}

/** V1: `<from>: <why>` for each text that is not a line of its destination section exactly once. */
export function notInDestination(moved: ReadonlyArray<Moved>, read: (rel: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const m of moved) {
    const doc = read(m.to);
    if (doc === undefined) {
      problems.push(`${m.from}: ${m.to} does not exist`);
      continue;
    }
    const section = sectionLines(doc, m.heading);
    if (section === undefined) {
      problems.push(`${m.from}: ${m.to} has no heading "${m.heading}"`);
      continue;
    }
    const count = section.filter((l) => l === m.text).length;
    if (count !== 1) problems.push(`${m.from}: ${count} lines in ${m.to} "${m.heading}" (expected 1): ${m.text.slice(0, 40)}`);
  }
  return problems;
}

/** V2: each text is gone from the body, and a line of the body names its destination file and heading exactly. */
export function stillInBody(body: string, moved: ReadonlyArray<Moved>): string[] {
  const problems: string[] = [];
  const lines = body.split('\n');
  for (const m of moved) {
    if (body.includes(m.text)) problems.push(`${m.from}: still in the body: ${m.text.slice(0, 40)}`);
    const pointed = lines.some((l) =>
      [...l.matchAll(REFERENCE)].some((r) => `${DOCS_DIR}/${r[1]}` === m.to && r[2] === githubSlug(m.heading)),
    );
    if (!pointed) problems.push(`${m.from}: no line of the body points at ${m.to}#${githubSlug(m.heading)}`);
  }
  return problems;
}

/** V3: `body:<n>: <line>` for each line of SECTIONS that is neither original nor an allowed line in its place. */
export function unknownBodyLines(body: string, registry: Registry): string[] {
  const problems: string[] = [];
  const lines = body.split('\n');
  const seen = new Map<string, number>();
  sectionEntries(body).forEach(({ index: i, line }) => {
    if (registry.originals.has(lineHash(line))) return;
    const entries = registry.allowed.filter((a) => a.line === line);
    if (entries.length === 0) {
      problems.push(`body:${i + 1}: ${line.slice(0, 60)}`);
      return;
    }
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    if (count > entries.length) problems.push(`body:${i + 1}: allowed line more often than registered: ${line.slice(0, 60)}`);
    const next = lineHash(lines[i + 1] ?? '');
    if (!entries.some((a) => a.before === next)) problems.push(`body:${i + 1}: allowed line not before its registered line: ${line.slice(0, 60)}`);
  });
  return problems;
}

/** V4: `body:<n>: <file>#<anchor>` for each `根拠:` line whose file or heading does not exist. */
export function brokenPointers(body: string, read: (rel: string) => string | undefined): string[] {
  const problems: string[] = [];
  body.split('\n').forEach((line, i) => {
    const p = POINTER.exec(line);
    if (p === null) return;
    const doc = read(`${DOCS_DIR}/${p[1]}`);
    if (doc === undefined || !headingAnchors(doc).has(p[2])) problems.push(`body:${i + 1}: ${p[1]}#${p[2]}`);
  });
  return problems;
}

/** V5: `original <hash>: …` for each original line that is not in SECTIONS, not moved and not replaced. */
export function lostOriginals(body: string, registry: Registry): string[] {
  const kept = sectionHashes(body);
  for (const m of registry.moved) kept.add(lineHash(m.text));
  for (const a of registry.allowed) if (a.replaces !== 'new') kept.add(a.replaces);
  return [...registry.originals]
    .filter((h) => !kept.has(h))
    .map((h) => `original ${h}: not in the body, not moved and not replaced by an allowed line`);
}

/** The text of a file of the role canon (`docs/orchestrate/roles/<name>.md`) under `root`; undefined otherwise. */
function roleText(root: string, rel: string): string | undefined {
  if (path.posix.dirname(rel) !== ROLES_DIR || !rel.endsWith('.md')) return undefined;
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

/** V6: `allowed <n>: …` for each allowed line that is neither a whole line of its source nor a pointer to a canon heading. */
export function notFromCanon(allowed: ReadonlyArray<Allowed>, root: string): string[] {
  const problems: string[] = [];
  allowed.forEach((a, i) => {
    const source = roleText(root, a.source);
    if (a.line.length > 0 && source !== undefined && source.split('\n').some((l) => l.replace(/^[-*] /, '') === a.line)) return;
    const p = CANON_POINTER.exec(a.line);
    if (p !== null && (roleText(root, `${ROLES_DIR}/${p[1]}`) ?? '').split('\n').includes(`## ${p[2]}`)) return;
    problems.push(`allowed ${i + 1}: neither a whole line of ${a.source} nor a pointer to a heading of ${ROLES_DIR}/*.md: ${a.line.slice(0, 60)}`);
  });
  return problems;
}

/** A reader of repository-relative paths under `root`; undefined when the file is missing. */
export function readerAt(root: string): (rel: string) => string | undefined {
  return (rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
  };
}

/** All six checks for the repository (or a copy of it) under `root`. */
export function checkMoved(root: string, registry: Registry): Record<'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6', string[]> {
  const read = readerAt(root);
  const body = read(BODY_RELATIVE_PATH);
  if (body === undefined) throw new Error(`${BODY_RELATIVE_PATH} not found under ${root}`);
  return {
    v1: notInDestination(registry.moved, read),
    v2: stillInBody(body, registry.moved),
    v3: unknownBodyLines(body, registry),
    v4: brokenPointers(body, read),
    v5: lostOriginals(body, registry),
    v6: notFromCanon(registry.allowed, root),
  };
}

// ---------------------------------------------------------------------------
// The registry (generated from `git show 0112f1a49:.claude/commands/orchestrate.md`)
// ---------------------------------------------------------------------------

/** The line added to 3-5 and to 3-5b: a pointer to the canon only (the PM's decision on #4548 R6, re-instruction 4). */
export const STOP_FIRST_LINE = 'STOP が先になる条件: docs/orchestrate/roles/dev-leader.md「難易度とワーカー」';

/** The line re-instruction 1 added, which words the condition itself (V6 rejects it). */
export const REWORDED_STOP_FIRST_LINE = '同じ種類の 2 回目と重なれば STOP が先（docs/orchestrate/roles/dev-leader.md）。';

/** 3-5's line `ユーザーには確認しない（2026-09-17 合意）。…` at 0112f1a49. */
const LINE_3_5_NO_ASK = '7f91af142938d15e';
/** 3-5b's line `ユーザーには確認しない。格上げしたことは…` at 0112f1a49. */
const LINE_3_5B_NO_ASK = '48fafd4424738fea';

/** New lines of the body, each with why it is allowed. */
export const ALLOWED: ReadonlyArray<Allowed> = [
  {
    line: STOP_FIRST_LINE,
    replaces: 'new',
    before: LINE_3_5_NO_ASK,
    source: 'docs/orchestrate/roles/dev-leader.md',
    why: '3-5: 格上げの条件と同じ種類の指摘の 2 回目が重なるときの向きは正本 roles/dev-leader.md の「難易度とワーカー」が持つので、条件の語を含めず指し先だけを置く。「ユーザーには確認しない」の行の直前',
  },
  {
    line: STOP_FIRST_LINE,
    replaces: 'new',
    before: LINE_3_5B_NO_ASK,
    source: 'docs/orchestrate/roles/dev-leader.md',
    why: '3-5b: 同じ（sonnet から opus への格上げ）。指し先だけ。「ユーザーには確認しない」の行の直前',
  },
];

export const MOVED: ReadonlyArray<Moved> = [
  {
    from: 'orchestrate.md 2-4-4',
    text: '4 週間の試行（2026-11-06 まで）の後、**実装の前に重大な設計の誤りを見つける安全策**として常設した。5-2b の再レビューを減らす効果は示せていない。',
    to: 'docs/orchestrate/trials.md',
    heading: '2-4-4 事前レビューの書き方と記録',
  },
];

export const ORIGINAL_LINE_HASHES: ReadonlySet<string> = new Set([
  '032137c29b3f9771',
  '17d520ba28dd97fd',
  '48fafd4424738fea',
  '500f6e7f3301fa8b',
  '559b55c519718b15',
  '5893c77a7d26c896',
  '5a95f4f199dbccdc',
  '64e333c23eb72198',
  '6f27ade2652fc21f',
  '79de402fd45804e0',
  '7ea14d1468096b5b',
  '7f91af142938d15e',
  '9290b32f09b433c6',
  '9886fb60601a8a28',
  'b0c32f57bfbbd88d',
  'c462dd94ecd139ff',
  'cb3f91d54eee30e5',
  'cbe0d21481f4ed62',
  'd000adb58ee95ac0',
  'd2b336e4cc06b8f2',
  'd995d3fc65a570b9',
  'e3b0c44298fc1c14',
  'ebed3be31fb0662f',
  'f1bc611034fb8c16',
  'f624600baf16a1dd',
  'f9601f5454a7a355',
]);

export const REGISTRY: Registry = { originals: ORIGINAL_LINE_HASHES, moved: MOVED, allowed: ALLOWED };

// ---------------------------------------------------------------------------
// Controls (a temporary directory)
// ---------------------------------------------------------------------------

const FIXTURE_ORIGINAL = [
  '# T',
  '',
  '### 2-4-3. 前の節',
  '',
  '節の外の行。',
  '',
  '### 2-4-4. 節',
  '',
  '規則の行。',
  '経緯の行。',
  '',
  '根拠: docs/orchestrate/a.md#1-1-移した節',
  '',
  '### 3-5. 節',
  '',
  'ユーザーには確認しない。',
  '',
  '## 次の章',
  '',
  '章の行。',
  '',
];
const FIXTURE_NEW = 'STOP が先になる条件: docs/orchestrate/roles/x.md「場面」';
const FIXTURE_REGISTRY: Registry = {
  originals: sectionHashes(FIXTURE_ORIGINAL.join('\n')),
  moved: [{ from: 'f 2-4-4', text: '経緯の行。', to: 'docs/orchestrate/a.md', heading: '1-1 移した節' }],
  allowed: [{ line: FIXTURE_NEW, replaces: 'new', before: lineHash('ユーザーには確認しない。'), source: `${ROLES_DIR}/x.md`, why: 'fixture' }],
};
const FIXTURE_BODY = FIXTURE_ORIGINAL.filter((l) => l !== '経緯の行。')
  .flatMap((l) => (l === 'ユーザーには確認しない。' ? [FIXTURE_NEW, l] : [l]))
  .join('\n');
const FIXTURE_DEST = ['# A', '', '## 1-1 移した節', '', '元の場所: …', '経緯の行。', '', '## 次の節', ''].join('\n');
const FIXTURE_ROLE = ['# X', '', '## 場面', '', '- 二つが重なるときは、STOP が先。替えも直しも送らない', ''].join('\n');

describe('body moved verbatim: controls (#4548)', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const rootWith = (body: string, dest: string): string => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-body-moved-'));
    fs.mkdirSync(path.join(root, '.claude/commands'), { recursive: true });
    fs.mkdirSync(path.join(root, ROLES_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, BODY_RELATIVE_PATH), body);
    fs.writeFileSync(path.join(root, DOCS_DIR, 'a.md'), dest);
    fs.writeFileSync(path.join(root, ROLES_DIR, 'x.md'), FIXTURE_ROLE);
    return root;
  };
  const none = { v1: [], v2: [], v3: [], v4: [], v5: [], v6: [] };
  const withAllowed = (line: string): Registry => ({ ...FIXTURE_REGISTRY, allowed: [{ ...FIXTURE_REGISTRY.allowed[0], line }] });
  const bodyWith = (line: string): string => FIXTURE_BODY.replace(FIXTURE_NEW, line);

  it('positive: a verbatim move with the allowed line in its place passes', () => {
    expect(checkMoved(rootWith(FIXTURE_BODY, FIXTURE_DEST), FIXTURE_REGISTRY)).toEqual(none);
  });

  it('negative (V1): one character changed in the destination is reported', () => {
    const result = checkMoved(rootWith(FIXTURE_BODY, FIXTURE_DEST.replace('経緯の行。', '経緯の業。')), FIXTURE_REGISTRY);
    expect(result.v1).toEqual(['f 2-4-4: 0 lines in docs/orchestrate/a.md "1-1 移した節" (expected 1): 経緯の行。']);
    expect([result.v2, result.v3, result.v4, result.v5, result.v6]).toEqual([[], [], [], [], []]);
  });

  it('negative (V2): the original line left in the body is reported', () => {
    const body = FIXTURE_BODY.replace('規則の行。', '規則の行。\n経緯の行。');
    const result = checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v2).toEqual(['f 2-4-4: still in the body: 経緯の行。']);
    expect([result.v1, result.v3, result.v4, result.v5, result.v6]).toEqual([[], [], [], [], []]);
  });

  it('positive (V2): a link inside a sentence, not a 根拠 line, keeps the moved text reachable', () => {
    const body = FIXTURE_BODY.replace('根拠: docs/orchestrate/a.md#1-1-移した節', '詳しくは docs/orchestrate/a.md#1-1-移した節 を読む。');
    expect(checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY).v2).toEqual([]);
  });

  it('negative (V2): the line that points at the destination removed is reported', () => {
    const body = FIXTURE_BODY.replace('根拠: docs/orchestrate/a.md#1-1-移した節\n', '');
    expect(checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY).v2).toEqual([
      'f 2-4-4: no line of the body points at docs/orchestrate/a.md#1-1-移した節',
    ]);
  });

  it.each([
    '根拠: docs/orchestrate/a.md#次の節',
    '詳しくは docs/orchestrate/a.md#1-1-移した節の続き を読む。',
    '詳しくは docs/orchestrate/a.md を読む。',
  ])('negative (V2): only %s is reported', (other) => {
    const body = FIXTURE_BODY.replace('根拠: docs/orchestrate/a.md#1-1-移した節', other);
    expect(checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY).v2).toEqual([
      'f 2-4-4: no line of the body points at docs/orchestrate/a.md#1-1-移した節',
    ]);
  });

  it("negative (V2): 2-4-4's link to trials.md removed from a copy of the real body is reported", () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, BODY_RELATIVE_PATH), 'utf8');
    const link = 'docs/orchestrate/trials.md#2-4-4-事前レビューの書き方と記録';
    expect(real.split(link)).toHaveLength(2);
    expect(stillInBody(real.replace(link, 'docs/orchestrate/trials.md'), MOVED)).toEqual([
      'orchestrate.md 2-4-4: no line of the body points at docs/orchestrate/trials.md#2-4-4-事前レビューの書き方と記録',
    ]);
  });

  it('negative (V3): a reworded line inside SECTIONS is reported', () => {
    const body = FIXTURE_BODY.replace('規則の行。', '規則の行（言い換え）。');
    const result = checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v3).toEqual(['body:9: 規則の行（言い換え）。']);
    expect([result.v1, result.v2, result.v4, result.v6]).toEqual([[], [], [], []]);
  });

  it('positive (V3・V5): a line outside SECTIONS changed or deleted is not looked at', () => {
    const body = FIXTURE_BODY.replace('節の外の行。', '節の外の行（言い換え）。').replace('章の行。\n', '');
    expect(checkMoved(rootWith(body, FIXTURE_DEST), FIXTURE_REGISTRY)).toEqual(none);
  });

  it('negative (V4): a 根拠 line whose heading was removed is reported', () => {
    const result = checkMoved(rootWith(FIXTURE_BODY, FIXTURE_DEST.replace('## 1-1 移した節', '1-1 移した節')), FIXTURE_REGISTRY);
    expect(result.v4).toEqual(['body:11: a.md#1-1-移した節']);
    expect([result.v2, result.v3, result.v5, result.v6]).toEqual([[], [], [], []]);
  });

  it('negative (V5): an original line only deleted from SECTIONS is reported (V3 does not see it)', () => {
    const result = checkMoved(rootWith(FIXTURE_BODY.replace('規則の行。\n', ''), FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v5).toEqual([
      `original ${lineHash('規則の行。')}: not in the body, not moved and not replaced by an allowed line`,
    ]);
    expect([result.v1, result.v2, result.v3, result.v4, result.v6]).toEqual([[], [], [], [], []]);
  });

  it('positive (V6): a whole line of the source, its leading `- ` aside, passes', () => {
    const cut = '二つが重なるときは、STOP が先。替えも直しも送らない';
    expect(checkMoved(rootWith(bodyWith(cut), FIXTURE_DEST), withAllowed(cut))).toEqual(none);
  });

  it.each(['二つが重なるときは、STOP が先。', 'STOP が先。替えも直しも送らない', '- 二つが重なるときは、STOP が先。替えも直しも送らない'])(
    'negative (V6): a part of a line of the source (%s) is reported',
    (part) => {
      expect(checkMoved(rootWith(bodyWith(part), FIXTURE_DEST), withAllowed(part)).v6).toEqual([
        `allowed 1: neither a whole line of ${ROLES_DIR}/x.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${part}`,
      ]);
    },
  );

  it('negative (V6): a reworded line, neither a whole line nor a pointer, is reported', () => {
    const reworded = '二つが重なれば STOP が先（docs/orchestrate/roles/x.md）。';
    const result = checkMoved(rootWith(bodyWith(reworded), FIXTURE_DEST), withAllowed(reworded));
    expect(result.v6).toEqual([`allowed 1: neither a whole line of ${ROLES_DIR}/x.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${reworded}`]);
    expect([result.v1, result.v2, result.v3, result.v4, result.v5]).toEqual([[], [], [], [], []]);
  });

  it('negative (V6): a pointer to a heading that does not exist, or to a missing file, is reported', () => {
    for (const pointer of ['STOP が先になる条件: docs/orchestrate/roles/x.md「無い見出し」', 'STOP が先になる条件: docs/orchestrate/roles/y.md「場面」']) {
      expect(checkMoved(rootWith(bodyWith(pointer), FIXTURE_DEST), withAllowed(pointer)).v6).toEqual([
        `allowed 1: neither a whole line of ${ROLES_DIR}/x.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${pointer}`,
      ]);
    }
  });

  it("negative (V6): re-instruction 1's line in ALLOWED is reported against the real role canon", () => {
    const allowed = ALLOWED.map((a) => ({ ...a, line: REWORDED_STOP_FIRST_LINE }));
    expect(notFromCanon(allowed, REPO_ROOT)).toEqual([
      `allowed 1: neither a whole line of ${ROLES_DIR}/dev-leader.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${REWORDED_STOP_FIRST_LINE.slice(0, 60)}`,
      `allowed 2: neither a whole line of ${ROLES_DIR}/dev-leader.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${REWORDED_STOP_FIRST_LINE.slice(0, 60)}`,
    ]);
  });

  it('negative (V6): a pointer to a heading dev-leader.md does not have is reported against the real role canon', () => {
    const line = 'STOP が先になる条件: docs/orchestrate/roles/dev-leader.md「無い見出し」';
    expect(notFromCanon([{ ...ALLOWED[0], line }], REPO_ROOT)).toEqual([
      `allowed 1: neither a whole line of ${ROLES_DIR}/dev-leader.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${line}`,
    ]);
  });

  const devLeaderStopLine = (): string => {
    const line = fs
      .readFileSync(path.join(REPO_ROOT, ROLES_DIR, 'dev-leader.md'), 'utf8')
      .split('\n')
      .find((l) => l.includes('STOP が先（運用文書の自動の格上げより先）'));
    expect(line).toBeDefined();
    expect((line as string).startsWith('- ')).toBe(true);
    return line as string;
  };

  it('positive (V6): the new line, and a whole line of dev-leader.md without its `- `, pass against the real role canon', () => {
    const whole = devLeaderStopLine().slice(2);
    expect(notFromCanon([{ ...ALLOWED[0], line: STOP_FIRST_LINE }, { ...ALLOWED[1], line: whole }], REPO_ROOT)).toEqual([]);
  });

  it.each(['STOP が先（運用文書の自動の格上げより先）。替えも直しも送らない', 'が先'])(
    'negative (V6): a part of dev-leader.md:16 (%s) is reported against the real role canon',
    (part) => {
      expect(devLeaderStopLine().endsWith(part)).toBe(part !== 'が先');
      expect(notFromCanon([{ ...ALLOWED[0], line: part }], REPO_ROOT)).toEqual([
        `allowed 1: neither a whole line of ${ROLES_DIR}/dev-leader.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${part}`,
      ]);
    },
  );

  it('negative (V6): a whole line of another role file, with dev-leader.md as its source, is reported', () => {
    const other = fs
      .readFileSync(path.join(REPO_ROOT, ROLES_DIR, 'enabler.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('- 技術調査: '));
    expect(other).toBeDefined();
    const line = (other as string).slice(2);
    expect(notFromCanon([{ ...ALLOWED[0], source: `${ROLES_DIR}/enabler.md`, line }], REPO_ROOT)).toEqual([]);
    expect(notFromCanon([{ ...ALLOWED[0], line }], REPO_ROOT)).toEqual([
      `allowed 1: neither a whole line of ${ROLES_DIR}/dev-leader.md nor a pointer to a heading of ${ROLES_DIR}/*.md: ${line.slice(0, 60)}`,
    ]);
  });

  it('throws when the body is missing instead of passing', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-body-moved-'));
    expect(() => checkMoved(root as string, FIXTURE_REGISTRY)).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// The real files
// ---------------------------------------------------------------------------

describe('body moved verbatim: this repository (#4548)', () => {
  const result = checkMoved(REPO_ROOT, REGISTRY);

  it('has the registry (anti-vacuity)', () => {
    expect(MOVED).toHaveLength(1);
    expect(ALLOWED).toHaveLength(2);
    expect(ORIGINAL_LINE_HASHES.size).toBeGreaterThanOrEqual(20);
    expect(sectionEntries(readerAt(REPO_ROOT)(BODY_RELATIVE_PATH) ?? '').length).toBeGreaterThanOrEqual(20);
    for (const m of MOVED) expect(ORIGINAL_LINE_HASHES.has(lineHash(m.text))).toBe(true);
    for (const a of ALLOWED) expect(ORIGINAL_LINE_HASHES.has(lineHash(a.line))).toBe(false);
    for (const a of ALLOWED) expect(ORIGINAL_LINE_HASHES.has(a.before)).toBe(true);
  });

  it('V1: every moved text is a line of its destination section, exactly once', () => {
    expect(result.v1).toEqual([]);
  });

  it('V2: every moved text is gone from the body, which still points at its destination', () => {
    expect(result.v2).toEqual([]);
  });

  it('V3: every line of SECTIONS of the body is original or an allowed line in its place', () => {
    expect(result.v3, `a line of SECTIONS changed; if on purpose, rebuild ORIGINAL_LINE_HASHES with: ${REBUILD}`).toEqual([]);
  });

  it('V4: every 根拠 line of the body names an existing heading', () => {
    expect(result.v4).toEqual([]);
  });

  it('V5: no original line of SECTIONS is lost (kept, moved or replaced)', () => {
    expect(result.v5, `a line of SECTIONS is gone; if on purpose, rebuild ORIGINAL_LINE_HASHES with: ${REBUILD}`).toEqual([]);
  });

  it('V6: every allowed line is a whole line of its source or a pointer to a canon heading', () => {
    expect(result.v6).toEqual([]);
  });

  it('the STOP-first line is in 3-5 and in 3-5b, right before the line that does not ask the user', () => {
    const lines = (readerAt(REPO_ROOT)(BODY_RELATIVE_PATH) ?? '').split('\n');
    const nexts = lines.flatMap((l, i) => (l === STOP_FIRST_LINE ? [lineHash(lines[i + 1] ?? '')] : []));
    expect(nexts).toEqual([LINE_3_5_NO_ASK, LINE_3_5B_NO_ASK]);
  });
});
