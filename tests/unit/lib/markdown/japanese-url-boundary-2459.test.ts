/**
 * Where a bare URL ends when Japanese punctuation follows it (Issue #2459).
 *
 * The reported line is one sentence:
 *
 *     **https://example.com/issue/2454**（注記）
 *
 * and it fails twice at once — the bold never closes, and the `href` carries
 * `**（注記）` into the destination. Both are assertions on the rendered DOM
 * here, because both are what a reader sees; the mdast in between is an
 * implementation detail and is only inspected where a real parser cannot
 * produce the input (a tree with no positions, a tree from another source).
 *
 * ## The pipeline is the real one
 *
 * Every case below goes through `ReactMarkdown` with the production plugin
 * list — `SHARED_REMARK_PLUGINS` for remark, `rehypeSanitize` +
 * `rehypeHighlight` for rehype, exactly as `ChatMessageBubble` and
 * `ConversationPairCard` configure it, in the shape
 * `tests/unit/hooks/sources/turn-separation-2234.test.ts` established. A
 * boundary rule asserted against a hand-built tree proves nothing about what
 * remark-gfm actually hands the plugin.
 *
 * ## The control
 *
 * `renderWithoutRepair` is the same pipeline with `[remarkGfm]` alone — the
 * mutation injection the acceptance criteria ask for, kept as a live control
 * rather than a claim: `describe('the control')` asserts that the reported
 * input renders the defect without the plugin, so none of the expectations
 * above it can be passing vacuously.
 *
 * No test here dereferences a URL. `example.com` is never fetched, and the
 * dangerous-scheme cases are asserted on the emitted markup only.
 *
 * @vitest-environment node
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { describe, expect, it } from 'vitest';
import {
  findJapaneseUrlBoundary,
  JAPANESE_URL_BOUNDARY_CHARACTERS,
  remarkJapaneseUrlBoundary,
  SHARED_REMARK_PLUGINS,
} from '@/lib/markdown';

/** The URL the Issue reports, and the `href` every repaired case must produce. */
const U = 'https://example.com/issue/2454';

/** `（注記）` percent-encoded, which is what a broken `href` carries. */
const ENCODED_NOTE = '%EF%BC%88%E6%B3%A8%E8%A8%98%EF%BC%89';

function renderPipeline(markdown: string, remarkPlugins: unknown): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown as never, {
      remarkPlugins,
      rehypePlugins: [rehypeSanitize, rehypeHighlight],
      children: markdown,
    } as never)
  );
}

/** The production render. */
function render(markdown: string): string {
  return renderPipeline(markdown, SHARED_REMARK_PLUGINS);
}

/** The same render with #2459's plugin removed — the mutation-injection control. */
function renderWithoutRepair(markdown: string): string {
  return renderPipeline(markdown, [remarkGfm]);
}

/** The anchor markup a correctly-ended bare `U` produces. */
const ANCHOR = `<a href="${U}">${U}</a>`;

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

describe('[#2459] a bold bare URL followed by Japanese punctuation', () => {
  it('renders the reported line as strong > a, with the note outside it', () => {
    expect(render(`**${U}**（注記）`)).toBe(`<p><strong>${ANCHOR}</strong>（注記）</p>`);
  });

  it('treats `__` as the same delimiter', () => {
    expect(render(`__${U}__（注記）`)).toBe(`<p><strong>${ANCHOR}</strong>（注記）</p>`);
  });

  it('leaves no raw delimiter behind in either form', () => {
    for (const markdown of [`**${U}**（注記）`, `__${U}__（注記）`]) {
      const html = render(markdown);
      expect(html).not.toContain('**');
      expect(html).not.toContain('__');
      expect(html).not.toContain(ENCODED_NOTE);
    }
  });

  it('ends the URL at a comma or a full stop just the same', () => {
    expect(render(`**${U}**、次へ`)).toBe(`<p><strong>${ANCHOR}</strong>、次へ</p>`);
    expect(render(`**${U}**。`)).toBe(`<p><strong>${ANCHOR}</strong>。</p>`);
  });

  it('ends an unbolded URL at every boundary character', () => {
    for (const character of JAPANESE_URL_BOUNDARY_CHARACTERS) {
      expect(render(`${U}${character}あと`)).toBe(`<p>${ANCHOR}${character}あと</p>`);
    }
  });

  it('ends the URL at the punctuation with nothing else around it', () => {
    expect(render(`${U}）`)).toBe(`<p>${ANCHOR}）</p>`);
    expect(render(`${U}、次へ`)).toBe(`<p>${ANCHOR}、次へ</p>`);
  });

  it('repairs the whole reported sentence, code span and trailing emphasis included', () => {
    expect(render(`\`bug\` の再現は **${U}**（注記）を参照。 *強調*`)).toBe(
      `<p><code>bug</code> の再現は <strong>${ANCHOR}</strong>（注記）を参照。 <em>強調</em></p>`
    );
  });

  it('repairs both links in a sentence that has two', () => {
    // The splice that inserts the trailing text moves every later sibling along
    // by one. Miss that and the second link is skipped entirely.
    expect(render(`**${U}**（注記）と **${U}**。おわり`)).toBe(
      `<p><strong>${ANCHOR}</strong>（注記）と <strong>${ANCHOR}</strong>。おわり</p>`
    );
  });

  it('works in a list item, a blockquote and a table cell', () => {
    expect(render(`- **${U}**（注記）`)).toContain(`<li><strong>${ANCHOR}</strong>（注記）</li>`);
    expect(render(`> **${U}**（注記）`)).toContain(`<p><strong>${ANCHOR}</strong>（注記）</p>`);
    expect(render(`| a |\n|---|\n| **${U}**（注記） |`)).toContain(
      `<td><strong>${ANCHOR}</strong>（注記）</td>`
    );
  });

  it('reads offsets correctly after a surrogate pair and after Japanese text', () => {
    // `position.offset` counts UTF-16 code units. An emoji in front of the link
    // is two of them, and a slice that assumed code points would land inside the
    // pair and fail the source check — which would show up here as a no-op.
    expect(render(`🎉 **${U}**（注記）`)).toBe(`<p>🎉 <strong>${ANCHOR}</strong>（注記）</p>`);
    expect(render(`日本語 **${U}**（注記）`)).toBe(
      `<p>日本語 <strong>${ANCHOR}</strong>（注記）</p>`
    );
  });
});

// ---------------------------------------------------------------------------
// The emphasis is repaired, never invented
// ---------------------------------------------------------------------------

describe('[#2459] the swallowed emphasis delimiter', () => {
  it('comes out of the href but stays as text when no opening delimiter exists', () => {
    expect(render(`${U}**（注記）`)).toBe(`<p>${ANCHOR}**（注記）</p>`);
  });

  it('does not become strong when the opening delimiter was escaped', () => {
    // `\**` is an escaped star followed by one literal star: not an opening
    // `**`, however much the parsed text value looks like one.
    const html = render(`\\**${U}**（注記）`);
    expect(html).toBe(`<p>**${ANCHOR}**（注記）</p>`);
    expect(html).not.toContain('<strong>');
  });

  it('does not become strong when the preceding sibling is something else', () => {
    // `*強調*` is an `emphasis` node, not a text ending in `**`.
    const html = render(`*強調*${U}**（注記）`);
    expect(html).toBe(`<p><em>強調</em>${ANCHOR}**（注記）</p>`);
    expect(html).not.toContain('<strong>');
  });

  it('keeps a `__` or `**` inside the path when nothing ends the URL', () => {
    for (const url of [
      'https://example.com/a__b',
      'https://example.com/a**b',
      'https://example.com/?a=1&b=2#frag',
    ]) {
      expect(render(url)).toBe(renderWithoutRepair(url));
    }
  });

  it('cuts at the punctuation, not at a `__` earlier in the path', () => {
    expect(render(`**https://example.com/a__b**（注記）`)).toBe(
      `<p><strong><a href="https://example.com/a__b">https://example.com/a__b</a></strong>（注記）</p>`
    );
  });
});

// ---------------------------------------------------------------------------
// Everything it must not touch
// ---------------------------------------------------------------------------

describe('[#2459] notations the repair leaves exactly as they were', () => {
  const untouched = [
    // Already correct: no boundary character anywhere in the destination.
    `**${U}** (label)`,
    `**${U}**`,
    `__${U}__`,
    // Explicit links and angle autolinks — `url === childText` cannot tell
    // these apart from a bare URL, and the source slice can.
    `[t](${U}**x)`,
    `[${U}**x](${U}**x)`,
    `<${U}**x>`,
    `[t](https://example.com/（注記）)`,
    `<https://example.com/（注記）>`,
    `[https://example.com/（注記）](https://example.com/（注記）)`,
    // Not `http(s)` literals at all.
    'www.example.com（注記）',
    'foo@example.com（注記）',
    // Paths that only look like they hold a delimiter or a boundary.
    'https://example.com/日本語パス',
    'https://example.com/%EF%BC%88x',
    // Code, references and images.
    `\`${U}**（注記）\``,
    `\`\`\`\n${U}**（注記）\n\`\`\``,
    `[ref]\n\n[ref]: ${U}**（注記）`,
    `![alt](${U}**x)`,
  ];

  it.each(untouched)('renders %j identically with and without the plugin', (markdown) => {
    expect(render(markdown)).toBe(renderWithoutRepair(markdown));
  });

  it('keeps a percent-encoded boundary encoded, and cuts only the literal one', () => {
    // `%EF%BC%88` is `（` percent-encoded. Decoding before the search would cut
    // the path in half; the search is deliberately on the raw string.
    expect(render('https://example.com/%EF%BC%88x（注記）')).toBe(
      '<p><a href="https://example.com/%EF%BC%88x">https://example.com/%EF%BC%88x</a>（注記）</p>'
    );
  });

  it('keeps a Japanese path segment and cuts only at the punctuation', () => {
    expect(render('https://example.com/日本語パス（注記）')).toBe(
      '<p><a href="https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%91%E3%82%B9">' +
        'https://example.com/日本語パス</a>（注記）</p>'
    );
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe('[#2459] the repair adds no new way through the sanitizer', () => {
  const hazards = [
    'javascript:alert(1)（注記）',
    '[x](javascript:alert(1)（注記）)',
    '<javascript:alert(1)（注記）>',
    'data:text/html,<script>alert(1)</script>（注記）',
    '**javascript:alert(1)**（注記）',
    `**${U}**（注記）<script>alert(1)</script>`,
    `**${U}**（注記）<img src=x onerror=alert(1)>`,
  ];

  it.each(hazards)('emits no script, no handler and no dangerous href for %j', (markdown) => {
    const html = render(markdown);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
  });

  it.each(hazards.slice(0, 5))('changes nothing at all about %j', (markdown) => {
    // None of these holds an `http(s)` literal for the repair to act on, so the
    // markup is the sanitizer's, byte for byte. The two cases left out are the
    // ones that DO carry a repairable URL alongside raw HTML: their anchor is
    // expected to change, and only the assertions above apply to them.
    expect(render(markdown)).toBe(renderWithoutRepair(markdown));
  });

  it('is idempotent: running the repair twice renders what running it once does', () => {
    const twice = [remarkGfm, remarkJapaneseUrlBoundary, remarkJapaneseUrlBoundary];
    for (const markdown of [
      `**${U}**（注記）`,
      `${U}**（注記）`,
      `**${U}**（注記）と **${U}**。おわり`,
      `- **${U}**（注記）`,
    ]) {
      expect(renderPipeline(markdown, twice)).toBe(render(markdown));
    }
  });
});

// ---------------------------------------------------------------------------
// Trees a parser cannot produce
// ---------------------------------------------------------------------------

describe('[#2459] the transformer on a tree it cannot vouch for', () => {
  interface TestNode {
    type: string;
    value?: string;
    url?: string;
    title?: string | null;
    children?: TestNode[];
    position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
  }

  const SOURCE = `${U}（注記）`;

  function at(start: number, end: number) {
    return {
      start: { line: 1, column: start + 1, offset: start },
      end: { line: 1, column: end + 1, offset: end },
    };
  }

  /** A well-formed autolink literal for `SOURCE`, so the negatives are one edit away. */
  function tree(overrides: Partial<TestNode> = {}): TestNode {
    const url = SOURCE;
    return {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url,
              title: null,
              position: at(0, url.length),
              children: [{ type: 'text', value: url, position: at(0, url.length) }],
              ...overrides,
            },
          ],
        },
      ],
    };
  }

  function run(node: TestNode, file: unknown): TestNode {
    remarkJapaneseUrlBoundary()(node, file);
    return node;
  }

  function link(node: TestNode): TestNode {
    return node.children![0].children![0];
  }

  it('repairs the positive control, so the negatives below mean something', () => {
    const result = run(tree(), { value: SOURCE });
    expect(link(result).type).toBe('link');
    expect(link(result).url).toBe(U);
    expect(node0Text(result)).toBe('（注記）');
  });

  function node0Text(root: TestNode): string | undefined {
    return root.children![0].children![1]?.value;
  }

  it('leaves a link with no position alone', () => {
    const result = run(tree({ position: undefined }), { value: SOURCE });
    expect(link(result).url).toBe(SOURCE);
    expect(result.children![0].children).toHaveLength(1);
  });

  it('leaves a link whose range runs past the source alone', () => {
    const result = run(tree({ position: at(0, SOURCE.length + 40) }), { value: SOURCE });
    expect(link(result).url).toBe(SOURCE);
  });

  it('leaves a link whose range is inverted or negative alone', () => {
    expect(link(run(tree({ position: at(9, 2) }), { value: SOURCE })).url).toBe(SOURCE);
    expect(link(run(tree({ position: at(-4, 9) }), { value: SOURCE })).url).toBe(SOURCE);
  });

  it('leaves a link whose offsets are not integers alone', () => {
    const position = {
      start: { line: 1, column: 1, offset: Number.NaN },
      end: { line: 1, column: 2, offset: SOURCE.length },
    };
    expect(link(run(tree({ position }), { value: SOURCE })).url).toBe(SOURCE);
  });

  it('leaves a link alone when the source does not slice back to its own url', () => {
    // The tree of one message applied to the text of another: the offsets are
    // well-formed and index into something else entirely.
    const result = run(tree(), { value: 'まったく別の本文がここにある' });
    expect(link(result).url).toBe(SOURCE);
  });

  it('leaves a synthesised link — one carrying a title, or a mismatched label — alone', () => {
    expect(link(run(tree({ title: 'a title' }), { value: SOURCE })).url).toBe(SOURCE);
    const relabelled = tree({
      children: [{ type: 'text', value: 'label', position: at(0, SOURCE.length) }],
    });
    expect(link(run(relabelled, { value: SOURCE })).url).toBe(SOURCE);
  });

  it('does nothing, and throws nothing, when there is no source to check against', () => {
    for (const file of [undefined, null, {}, { value: new Uint8Array([1, 2]) }, 42]) {
      const node = tree();
      expect(() => run(node, file)).not.toThrow();
      expect(link(node).url).toBe(SOURCE);
    }
  });

  it('does nothing, and throws nothing, on a tree that is not a node', () => {
    for (const bad of [undefined, null, 'text', [], { children: [] }]) {
      expect(() => remarkJapaneseUrlBoundary()(bad, { value: SOURCE })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The shared list
// ---------------------------------------------------------------------------

describe('SHARED_REMARK_PLUGINS', () => {
  it('is GFM followed by the repair, and nothing else', () => {
    expect(SHARED_REMARK_PLUGINS).toHaveLength(2);
    expect(SHARED_REMARK_PLUGINS[0]).toBe(remarkGfm);
    expect(SHARED_REMARK_PLUGINS[1]).toBe(remarkJapaneseUrlBoundary);
  });

  it('is frozen, so the one identity every renderer holds cannot be edited', () => {
    // The identity is the point: a new array reference makes ReactMarkdown
    // rebuild its whole DOM tree, which is what detached MarkdownPreview's
    // links and made them unclickable.
    expect(Object.isFrozen(SHARED_REMARK_PLUGINS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------

describe('findJapaneseUrlBoundary', () => {
  it('lists exactly the eight characters the rule names', () => {
    expect([...JAPANESE_URL_BOUNDARY_CHARACTERS]).toEqual([
      '（', '）', '、', '。', '「', '」', '【', '】',
    ]);
  });

  it('reports the first boundary character, not the nearest', () => {
    expect(findJapaneseUrlBoundary(`${U}（注記）`)).toBe(U.length);
    expect(findJapaneseUrlBoundary(`${U}。まとめ（注記）`)).toBe(U.length);
  });

  it('reports -1 for a URL that never runs into one', () => {
    expect(findJapaneseUrlBoundary(U)).toBe(-1);
    expect(findJapaneseUrlBoundary('https://example.com/日本語パス')).toBe(-1);
    expect(findJapaneseUrlBoundary('https://example.com/%EF%BC%88')).toBe(-1);
    expect(findJapaneseUrlBoundary('https://example.com/a__b**c')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// The control (mutation injection)
// ---------------------------------------------------------------------------

describe('[#2459] the control: the same pipeline without the repair', () => {
  it('renders the reported line with the defect the Issue describes', () => {
    const html = renderWithoutRepair(`**${U}**（注記）`);
    // The bold never closed …
    expect(html).not.toContain('<strong>');
    expect(html).toContain('>**<a');
    // … and the destination swallowed the delimiter and the note.
    expect(html).toContain(`href="${U}**${ENCODED_NOTE}"`);
    expect(html).not.toContain(`href="${U}"`);
  });

  it('fails every expectation the repaired render meets', () => {
    for (const markdown of [
      `**${U}**（注記）`,
      `__${U}__（注記）`,
      `**${U}**、次へ`,
      `${U}）`,
      `${U}**（注記）`,
      `**${U}**（注記）と **${U}**。おわり`,
      `\`bug\` の再現は **${U}**（注記）を参照。 *強調*`,
      `- **${U}**（注記）`,
      `| a |\n|---|\n| **${U}**（注記） |`,
      `🎉 **${U}**（注記）`,
    ]) {
      expect(renderWithoutRepair(markdown)).not.toBe(render(markdown));
    }
  });
});
