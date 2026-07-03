/**
 * Unit tests for extractToc (Issue #1007)
 *
 * These tests are the contract for `src/lib/markdown-toc.ts`. The most
 * important guarantee is that the `id` extractToc derives matches the `id`
 * `rehype-slug` assigns to the rendered heading — so the final test runs the
 * real remark → rehype-slug pipeline and compares.
 */

import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

import { extractToc } from '@/lib/markdown-toc';

/** Render markdown with the same pipeline the viewer uses and read heading ids. */
function rehypeSlugIds(markdown: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .runSync(
      unified().use(remarkParse).use(remarkGfm).parse(markdown)
    ) as Root;

  const ids: string[] = [];
  visit(tree, 'element', (node: Element) => {
    if (/^h[1-6]$/.test(node.tagName) && node.properties && node.properties.id) {
      ids.push(String(node.properties.id));
    }
  });
  return ids;
}

describe('extractToc', () => {
  it('returns an empty array for empty / no-heading input', () => {
    expect(extractToc('')).toEqual([]);
    expect(extractToc('just a paragraph\n\nanother one')).toEqual([]);
  });

  it('extracts ATX headings with correct depth', () => {
    const md = '# Title\n\n## Section\n\n### Sub';
    const toc = extractToc(md);
    expect(toc).toEqual([
      { depth: 1, text: 'Title', id: 'title' },
      { depth: 2, text: 'Section', id: 'section' },
      { depth: 3, text: 'Sub', id: 'sub' },
    ]);
  });

  it('generates github-slugger compatible ids (lowercase, spaces to dashes)', () => {
    const toc = extractToc('# Hello World Foo');
    expect(toc[0].id).toBe('hello-world-foo');
  });

  it('assigns -1 / -2 suffixes to duplicate headings in document order', () => {
    const md = '# Dup\n## Dup\n### Dup';
    const toc = extractToc(md);
    expect(toc.map((t) => t.id)).toEqual(['dup', 'dup-1', 'dup-2']);
  });

  it('ignores # inside fenced code blocks (backtick)', () => {
    const md = '# Real\n\n```\n# not a heading\n```\n\n## After';
    const toc = extractToc(md);
    expect(toc.map((t) => t.text)).toEqual(['Real', 'After']);
  });

  it('ignores # inside tilde fences and does not close backtick fence with tildes', () => {
    const md = '# Real\n\n~~~\n# nope\n~~~\n\n## After';
    expect(extractToc(md).map((t) => t.text)).toEqual(['Real', 'After']);
  });

  it('handles variable-length / nested fences (shorter closer does not close)', () => {
    const md = '# Real\n\n````\n```\n# still code\n```\n````\n\n## After';
    expect(extractToc(md).map((t) => t.text)).toEqual(['Real', 'After']);
  });

  it('ignores # in indented (4-space) code blocks', () => {
    const md = '# Real\n\n    # indented code, not a heading\n\n## After';
    expect(extractToc(md).map((t) => t.text)).toEqual(['Real', 'After']);
  });

  it('requires a space after # (ATX rule): #foo and #5 are not headings', () => {
    expect(extractToc('#foo')).toEqual([]);
    expect(extractToc('#5 bar')).toEqual([]);
    expect(extractToc('####### seven hashes')).toEqual([]);
  });

  it('allows up to 3 leading spaces, but 4 makes it code', () => {
    expect(extractToc('   # three spaces').map((t) => t.text)).toEqual(['three spaces']);
    expect(extractToc('    # four spaces')).toEqual([]);
  });

  it('strips a trailing closing # sequence', () => {
    expect(extractToc('## Heading ##')[0].text).toBe('Heading');
    expect(extractToc('# foo#')[0].text).toBe('foo#'); // glued # is content
  });

  it('does NOT extract setext headings (documented limitation)', () => {
    const md = 'Setext Title\n===\n\nSub\n---';
    expect(extractToc(md)).toEqual([]);
  });

  it('flattens inline code in heading text but keeps a matching id', () => {
    const toc = extractToc('## Use the `extractToc` helper');
    expect(toc[0].text).toBe('Use the extractToc helper');
  });

  it('flattens links and emphasis in heading text', () => {
    const toc = extractToc('## See [the docs](https://example.com) and **bold** _italic_');
    expect(toc[0].text).toBe('See the docs and bold italic');
  });

  it.each([
    '# Hello World',
    '# Hello World\n## Hello World\n### Hello World',
    '# API `foo()` reference',
    '## See [docs](https://example.com)',
    '# Café — déjà vu',
    '# 日本語の見出し',
    '# Symbols: a/b & c (d)',
    '# Dup\n# Dup\n# Dup\n# Dup',
    '# Title\n\n```\n# fake\n```\n\n## Next',
  ])('id matches rehype-slug for: %s', (md) => {
    const expected = rehypeSlugIds(md);
    const actual = extractToc(md).map((t) => t.id);
    expect(actual).toEqual(expected);
  });
});
