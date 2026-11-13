/**
 * Issue #3754: the command / agent lists in the user guides (ja and en) are the
 * single list of record, and must match `.claude/commands/*.md` and
 * `.claude/agents/*.md` exactly, in both directions. Only the list section is
 * read, so a `/foo` used as an example elsewhere in a guide is not counted.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** Body of the section whose heading line matches, up to the next heading or `---`. */
export function sectionBody(doc: string, heading: RegExp): string | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && heading.test(l));
  if (start === -1) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(l) || l === '---') break;
    out.push(l);
  }
  return out.join('\n');
}

/** First-column entries (`[`/name`](link)`) of every table row, with their link targets. */
export function listEntries(
  section: string,
  prefix: '/' | '',
): Array<{ key: string; link: string }> {
  const rows: Array<{ key: string; link: string }> = [];
  const re = new RegExp('^\\| \\[`' + prefix + '([^`]+)`\\]\\(([^)]+)\\) \\|');
  for (const line of section.split('\n')) {
    const m = re.exec(line);
    if (m) rows.push({ key: m[1], link: m[2] });
  }
  return rows;
}

const mdNames = (dir: string): string[] =>
  fs
    .readdirSync(path.join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();

const GUIDES = [
  {
    kind: 'commands',
    dir: '.claude/commands',
    prefix: '/' as const,
    ja: { file: 'docs/user-guide/commands-guide.md', heading: /^### 全コマンド/ },
    en: { file: 'docs/en/user-guide/commands-guide.md', heading: /^### All \d+ Commands/ },
  },
  {
    kind: 'agents',
    dir: '.claude/agents',
    prefix: '' as const,
    ja: { file: 'docs/user-guide/agents-guide.md', heading: /^## エージェント一覧/ },
    en: { file: 'docs/en/user-guide/agents-guide.md', heading: /^## Agent List/ },
  },
];

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true });
});

describe('Issue #3754: command / agent lists match the definition files', () => {
  for (const g of GUIDES) {
    const defs = mdNames(g.dir);
    const perLang = {} as Record<'ja' | 'en', string[]>;
    for (const lang of ['ja', 'en'] as const) {
      const spec = g[lang];
      describe(`${g.kind} (${lang})`, () => {
        const doc = read(spec.file);
        const section = sectionBody(doc, spec.heading);
        it('has the list section', () => {
          expect(section).not.toBeNull();
        });
        const entries = listEntries(section ?? '', g.prefix);
        perLang[lang] = entries.map((e) => e.key).sort();
        it('heading count equals the number of listed keys', () => {
          const headingLine = doc.split('\n').find((l) => spec.heading.test(l)) ?? '';
          const n = /\d+/.exec(headingLine);
          if (g.kind === 'commands') {
            expect(n).not.toBeNull();
            expect(Number(n![0])).toBe(perLang[lang].length);
          }
        });
        it('has no duplicate', () => {
          expect(new Set(perLang[lang]).size).toBe(perLang[lang].length);
        });
        it('equals the definition files (both directions)', () => {
          expect(defs.length).toBeGreaterThan(0);
          expect(perLang[lang]).toEqual(defs);
        });
        it('links to a definition file that exists', () => {
          for (const e of entries) {
            const target = path.resolve(path.dirname(path.join(REPO_ROOT, spec.file)), e.link);
            expect(target).toBe(path.join(REPO_ROOT, g.dir, `${e.key}.md`));
            expect(fs.existsSync(target)).toBe(true);
          }
        });
      });
    }
    it(`${g.kind}: ja and en have the same keys`, () => {
      expect(perLang.ja.length).toBeGreaterThan(0);
      expect(perLang.en).toEqual(perLang.ja);
    });
  }

  describe('CLAUDE.md points at the guides instead of carrying the tables', () => {
    const claude = read('CLAUDE.md');
    it('links commands-guide and agents-guide', () => {
      expect(claude).toContain('./docs/user-guide/commands-guide.md');
      expect(claude).toContain('./docs/user-guide/agents-guide.md');
    });
    it('has no command / agent table left', () => {
      expect(claude).not.toMatch(/^\| コマンド \| 説明 \|/m);
      expect(claude).not.toMatch(/^\| エージェント \| 説明 \|/m);
    });
  });

  describe('controls (parser behaviour on temp files)', () => {
    it('positive: a missing entry is detected', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-3754-'));
      tmp.push(dir);
      fs.writeFileSync(path.join(dir, 'a.md'), '');
      fs.writeFileSync(path.join(dir, 'b.md'), '');
      const doc = '### 全コマンド\n\n| c | d |\n|--|--|\n| [`/a`](x/a.md) | A |\n\n---\n';
      const keys = listEntries(sectionBody(doc, /^### 全コマンド/) ?? '', '/').map((e) => e.key);
      expect(keys).not.toEqual(['a', 'b']);
    });
    it('positive: a heading count that differs from the listed keys is detected', () => {
      const doc = '### 全コマンド（3 件）\n\n| [`/a`](x/a.md) | A |\n';
      const heading = /^### 全コマンド/;
      const line = doc.split('\n').find((l) => heading.test(l)) ?? '';
      const n = Number(/\d+/.exec(line)![0]);
      expect(n).not.toBe(listEntries(sectionBody(doc, heading) ?? '', '/').length);
    });
    it('negative: an example /foo outside the list section is not counted', () => {
      const doc =
        '## 例\n\n| [`/foo`](x/foo.md) | ex |\n\n### 全コマンド\n\n| [`/a`](x/a.md) | A |\n\n## 他\n\n| [`/bar`](x/bar.md) | ex |\n';
      const keys = listEntries(sectionBody(doc, /^### 全コマンド/) ?? '', '/').map((e) => e.key);
      expect(keys).toEqual(['a']);
    });
  });
});
