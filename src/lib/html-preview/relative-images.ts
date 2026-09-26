/**
 * Relative image inlining helpers for the HTML preview (Issue #2861).
 *
 * The HTML preview renders files through `<iframe srcDoc>`, whose base URL is
 * `about:srcdoc`, so relative `<img src>` paths cannot load. The parent page
 * fetches those images through the worktree file API and swaps each `src` for
 * a data URI before handing the HTML to the iframe. These are the pure parts:
 * finding the relative sources and rewriting them.
 *
 * Only `<img src>` is handled. `<a href>`, CSS, `<source>` and `srcset` are
 * intentionally out of scope.
 */

import { resolveRelativePath } from '@/lib/link-utils';

/** Prefixes that mark a `src` as NOT relative (compared case-insensitively). */
const NON_RELATIVE_PREFIXES = [
  'http:',
  'https:',
  'data:',
  'blob:',
  '//',
  '/',
  '#',
  'mailto:',
  'javascript:',
] as const;

const DOCTYPE_PATTERN = /^\s*<!doctype/i;

function isRelativeSrc(src: string): boolean {
  if (!src) return false;
  const lower = src.toLowerCase();
  return !NON_RELATIVE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** HTML の中の相対パスの <img src> を、ファイルからの相対で解決したパスと対にして返す（重複は 1 件にまとめる） */
export function collectRelativeImageSources(
  html: string,
  filePath: string,
): Array<{ src: string; resolvedPath: string }> {
  const doc = parseHtml(html);
  const seen = new Set<string>();
  const result: Array<{ src: string; resolvedPath: string }> = [];
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? '';
    if (seen.has(src) || !isRelativeSrc(src)) continue;
    const resolvedPath = resolveRelativePath(filePath, src);
    if (resolvedPath === null) continue;
    seen.add(src);
    result.push({ src, resolvedPath });
  }
  return result;
}

/** HTML の <img src> のうち、map のキー（元の src）に一致するものを値（データ URI）に置き換えた HTML を返す */
export function replaceImageSources(html: string, replacements: ReadonlyMap<string, string>): string {
  if (replacements.size === 0) return html;
  const doc = parseHtml(html);
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const replacement = replacements.get(img.getAttribute('src') ?? '');
    if (replacement !== undefined) {
      img.setAttribute('src', replacement);
    }
  }
  const serialized = doc.documentElement.outerHTML;
  return DOCTYPE_PATTERN.test(html) ? `<!DOCTYPE html>\n${serialized}` : serialized;
}
