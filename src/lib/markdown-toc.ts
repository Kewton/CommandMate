/**
 * Markdown Table-of-Contents extraction (Issue #1007)
 *
 * `extractToc` is a pure function that scans a Markdown source string and
 * returns the ATX headings (`#`〜`######`) it contains, together with the
 * GitHub-flavoured slug `id` for each one.
 *
 * The `id` MUST match the `id` that `rehype-slug` assigns to the rendered
 * heading so that TOC links jump to the correct anchor. To guarantee this we
 * use the very same slug engine `rehype-slug` uses — `github-slugger` — with a
 * single stateful instance applied in document order (so duplicate headings get
 * the same `-1` / `-2` suffixes as the rendered markup).
 *
 * Scope / known limitations (documented, intentional):
 * - Only ATX headings are extracted. setext headings (`===` / `---`
 *   underlines) are NOT recognised. `rehype-slug` still assigns ids to setext
 *   headings, so a document that mixes setext headings with duplicate ATX
 *   headings can desync the duplicate counter. Target documents are assumed to
 *   use ATX headings.
 * - Fenced code blocks (``` and ~~~, variable length, backtick vs. tilde) and
 *   indented code blocks (4+ leading spaces / tab — never valid ATX indent) are
 *   excluded so `#` inside code is not mistaken for a heading.
 */

import GithubSlugger from 'github-slugger';

/** A single table-of-contents entry. */
export interface TocEntry {
  /** Heading level, 1–6 (number of leading `#`). */
  depth: number;
  /** Plain-text heading label (inline markdown flattened away). */
  text: string;
  /** GitHub-flavoured slug id, matching `rehype-slug`. */
  id: string;
}

/** Matches an ATX heading line: 0–3 leading spaces, 1–6 `#`, then space+content or EOL. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Matches a fenced-code opening/closing line, capturing indent and fence run. */
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Flatten inline Markdown in a heading to the plain text that `hast-util-to-string`
 * (used by `rehype-slug`) would produce, so the derived slug matches the anchor.
 *
 * Handles: images (dropped, like an `<img>` with no text children), links
 * (label kept), inline code (delimiters removed), emphasis/strong/strikethrough
 * (markers removed) and backslash escapes.
 */
function flattenHeadingText(raw: string): string {
  let text = raw;

  // Images: ![alt](url) / ![alt][ref] -> '' (hast-util-to-string ignores <img>).
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');

  // Links: [label](url) / [label][ref] / [label] -> label.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/\[([^\]]*)\]/g, '$1');

  // Inline code: `code` / ``co`de`` -> inner content (drop the backtick run).
  text = text.replace(/(`+)([\s\S]*?)\1/g, '$2');

  // Strong / emphasis / strikethrough markers.
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');

  // Backslash escapes: keep the escaped character.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1');

  return text.trim();
}

/**
 * Strip an optional ATX closing sequence (`## Heading ##` -> `Heading`).
 * The closing `#` run must be at the start of the content or preceded by
 * whitespace; a `#` glued to a word (`foo#`) is content, not a closer.
 */
function stripClosingSequence(content: string): string {
  return content.replace(/([ \t]|^)#+[ \t]*$/, '');
}

/**
 * Extract the ATX heading structure of a Markdown document.
 *
 * @param markdown - Raw Markdown source.
 * @returns Ordered list of headings with matching `rehype-slug` ids.
 */
export function extractToc(markdown: string): TocEntry[] {
  if (!markdown) {
    return [];
  }

  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];

  // Fence tracking: null when outside a code block.
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  const lines = markdown.split('\n');

  for (const line of lines) {
    const fence = FENCE_LINE.exec(line);

    if (fenceChar) {
      // Inside a fenced block: only a matching, long-enough fence closes it.
      if (fence) {
        const run = fence[2];
        const char = run[0] as '`' | '~';
        // A closing fence must be the same char, at least as long, and have no
        // trailing content after the fence run.
        if (char === fenceChar && run.length >= fenceLen && fence[3].trim() === '') {
          fenceChar = null;
          fenceLen = 0;
        }
      }
      continue; // Never treat lines inside a fence as headings.
    }

    if (fence) {
      const run = fence[2];
      const char = run[0] as '`' | '~';
      // Backtick info strings may not contain a backtick (else it's not a fence).
      if (char === '`' && fence[3].includes('`')) {
        // Not a valid fence opener; fall through to heading detection.
      } else {
        fenceChar = char;
        fenceLen = run.length;
        continue;
      }
    }

    const heading = ATX_HEADING.exec(line);
    if (!heading) {
      continue;
    }

    const depth = heading[1].length;
    const rawContent = heading[2] ?? '';
    const text = flattenHeadingText(stripClosingSequence(rawContent));
    const id = slugger.slug(text);

    entries.push({ depth, text, id });
  }

  return entries;
}
