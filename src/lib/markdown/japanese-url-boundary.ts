/**
 * Where a bare URL ends when Japanese punctuation follows it (Issue #2459).
 *
 * ## The defect
 *
 * GFM's autolink literal ends a bare URL at whitespace or at a small set of
 * ASCII trailing punctuation. Japanese punctuation is in neither list, so
 *
 *     **https://example.com/issue/2454**（注記）
 *
 * parses as a paragraph of two children — a `text` holding the opening `**`,
 * and a `link` whose destination is the whole rest of the line,
 * `https://example.com/issue/2454**（注記）`. The emphasis never closes (its
 * closing delimiter was eaten by the URL) so the bold is lost, and the `href`
 * points at a URL nobody wrote. Both halves of the damage come from the same
 * cause, so both are repaired here.
 *
 * ## Why `url === children[0].value` is not the test
 *
 * The obvious guard for "is this a bare URL?" is that the link's destination
 * equals its only text child. It is not sufficient: `[url](url)` and `<url>`
 * satisfy the same equation, and rewriting either would silently change a
 * destination a human typed on purpose. The authority is the source. `remark`
 * records `position.start.offset` / `position.end.offset` on every node, and
 * react-markdown hands the transformer the same `VFile` its `children` string
 * was put into, so the exact characters the link was built from can be sliced
 * back out:
 *
 *     source.slice(start, end) === node.url
 *
 * holds ONLY for an autolink literal. `<url>` slices back to `<url>`,
 * `[t](url)` to `[t](url)`, `[url](url)` to `[url](url)`, `www.example.com` to
 * `www.example.com` (the `url` gained an `http://`), and `foo@example.com` to
 * itself (the `url` gained a `mailto:`). Every one of them fails the equation
 * and is left exactly as it was. A link some other plugin synthesised has no
 * position, or a position that does not slice back to its own destination, and
 * is likewise left alone.
 *
 * ## What is repaired
 *
 * Only the destination and the emphasis around it — never the source. Inside a
 * confirmed autolink literal, the first of {@link JAPANESE_URL_BOUNDARY_CHARACTERS}
 * ends the URL; everything from there on goes back into the inline parent as
 * ordinary text. A `**` or `__` immediately in front of that boundary was
 * swallowed emphasis, not part of the path, so it comes out of the URL too —
 * and if the preceding sibling really is the matching opening delimiter, and
 * the source agrees that it is unescaped and adjacent, the link is wrapped in
 * `strong` and both delimiters disappear. When the opening delimiter cannot be
 * confirmed the `strong` is NOT invented: the delimiter stays as literal text
 * and only the destination is repaired.
 *
 * A `**` or `__` anywhere else in the URL is left alone — `/a__b` and `/a**b`
 * are ordinary paths, and there is no Japanese boundary in them to act on.
 *
 * The transform is a no-op on any tree it cannot vouch for, throws nothing, and
 * is idempotent: a repaired link no longer contains a boundary character, so a
 * second pass finds nothing to do.
 */

/**
 * The characters that end a bare URL, in addition to the ones GFM already
 * knows. Japanese prose runs a URL straight into these with no space, which is
 * exactly the case the autolink literal cannot see.
 *
 * Deliberately literal, and deliberately short. It is not "all of CJK" and not
 * "all full-width punctuation": a path segment written in Japanese
 * (`/日本語パス`) is a real path and must survive, and so must a percent-encoded
 * `%EF%BC%88`, which is why nothing here is decoded before the search.
 */
export const JAPANESE_URL_BOUNDARY_CHARACTERS = '（）、。「」【】';

/** The emphasis delimiters an autolink literal can swallow whole. */
const EMPHASIS_DELIMITERS = ['**', '__'] as const;

/** Only `http:` and `https:` literals are in scope (`www.` / mail are not). */
const AUTOLINK_SCHEME = /^https?:\/\/./i;

/** A unist point, as `remark-parse` fills it in. */
interface SourcePoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

/** A unist position. */
interface SourcePosition {
  start: SourcePoint;
  end: SourcePoint;
}

/**
 * The structural shape this file reads and writes.
 *
 * Written out rather than imported from `@types/mdast` so the plugin adds no
 * dependency of its own: it only ever touches `type`, `value`, `url`,
 * `children` and `position`, and every one of them is re-checked at runtime
 * before it is used.
 */
interface MarkdownNode {
  type: string;
  position?: SourcePosition | undefined;
  children?: MarkdownNode[] | undefined;
  value?: string | undefined;
  url?: string | undefined;
  title?: string | null | undefined;
}

/** A node that owns a children array — the only thing this transform walks. */
type MarkdownParent = MarkdownNode & { children: MarkdownNode[] };

/**
 * The index of the first boundary character in `url`, or `-1`.
 *
 * Exported because it is the whole of rule #3 and is worth pinning on its own,
 * without a parser in the way.
 */
export function findJapaneseUrlBoundary(url: string): number {
  for (let index = 0; index < url.length; index += 1) {
    if (JAPANESE_URL_BOUNDARY_CHARACTERS.includes(url[index])) return index;
  }
  return -1;
}

function isNode(value: unknown): value is MarkdownNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function asParent(node: MarkdownNode): MarkdownParent | null {
  return Array.isArray(node.children) ? (node as MarkdownParent) : null;
}

/**
 * The markdown the tree was parsed from, or `null`.
 *
 * react-markdown puts its `children` prop on `file.value` verbatim, so this is
 * the exact string every `position.offset` in the tree indexes into. Anything
 * else — a `Uint8Array` value, no file at all — means the offsets cannot be
 * checked, which means nothing is touched.
 */
function readSource(file: unknown): string | null {
  if (typeof file === 'string') return file;
  if (typeof file === 'object' && file !== null) {
    const value = (file as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  return null;
}

/** A position whose offsets are usable indices into `source`. */
function sourceRange(
  node: MarkdownNode,
  source: string
): { start: number; end: number } | null {
  const position = node.position;
  if (!position) return null;
  const start = position.start?.offset;
  const end = position.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || end > source.length) return null;
  return { start, end };
}

/**
 * Whether `node` is a bare `http(s)` URL that the source agrees was written
 * bare — see the file header for why the source, and not the text child, is
 * what decides.
 */
function isAutolinkLiteral(node: MarkdownNode, source: string): boolean {
  if (node.type !== 'link') return false;
  if (node.title !== null && node.title !== undefined) return false;
  const url = node.url;
  if (typeof url !== 'string' || !AUTOLINK_SCHEME.test(url)) return false;

  const range = sourceRange(node, source);
  if (!range) return false;
  if (source.slice(range.start, range.end) !== url) return false;

  const children = node.children;
  if (!Array.isArray(children) || children.length !== 1) return false;
  const only = children[0];
  if (!isNode(only) || only.type !== 'text' || only.value !== url) return false;

  const childRange = sourceRange(only, source);
  return childRange !== null && childRange.start === range.start && childRange.end === range.end;
}

/** What a repair of one link changes, worked out before anything is mutated. */
interface RepairPlan {
  /** The destination the link keeps. */
  keptUrl: string;
  /** The text that goes back into the inline parent after the link. */
  tailText: string;
  /** Offset, relative to the link's start, where `tailText` begins in source. */
  tailOffset: number;
  /** The swallowed closing delimiter, when there was one. */
  delimiter: string | null;
}

/**
 * How `url` should be split, or `null` when it should be left alone.
 *
 * `boundary` is the first Japanese punctuation character. The delimiter — if
 * one sits immediately in front of it — always comes out of the destination;
 * whether it also disappears from the rendered text is decided later, by
 * whether an opening delimiter can be confirmed, and is what `delimiter`
 * reports back.
 */
function planRepair(url: string): RepairPlan | null {
  const boundary = findJapaneseUrlBoundary(url);
  if (boundary <= 0) return null;

  const beforeBoundary = url.slice(0, boundary);
  const delimiter = EMPHASIS_DELIMITERS.find((candidate) => beforeBoundary.endsWith(candidate));
  const cut = delimiter ? boundary - delimiter.length : boundary;
  if (cut <= 0) return null;

  const keptUrl = url.slice(0, cut);
  // A cut that leaves nothing but a scheme is not a repair, it is a broken
  // link with a shorter href. Leave the whole thing alone instead.
  if (!AUTOLINK_SCHEME.test(keptUrl)) return null;

  return {
    keptUrl,
    tailText: url.slice(cut),
    tailOffset: cut,
    delimiter: delimiter ?? null,
  };
}

/**
 * Whether the sibling in front of the link is the opening `delimiter` of the
 * emphasis whose closing half the URL swallowed.
 *
 * Three things have to line up, and all three are checked against the source
 * rather than against the parsed value:
 *
 *  - the sibling is a `text` node that ends with the same delimiter,
 *  - its source range ends exactly where the link's begins (nothing between),
 *  - the character in front of that delimiter is not a backslash. `\**URL**（注記）`
 *    parses to a `text` whose *value* is `**` — the escape is gone by then —
 *    but whose *source* is `\**`, where the first star is escaped and only one
 *    literal star is left. That is not an opening `**`, and inventing a `strong`
 *    for it would put emphasis on text the author escaped out of it.
 */
function opensEmphasis(
  previous: MarkdownNode | undefined,
  delimiter: string,
  linkStart: number,
  source: string
): boolean {
  if (!previous || previous.type !== 'text') return false;
  if (typeof previous.value !== 'string' || !previous.value.endsWith(delimiter)) return false;

  const range = sourceRange(previous, source);
  if (!range || range.end !== linkStart) return false;

  const raw = source.slice(range.start, range.end);
  if (!raw.endsWith(delimiter)) return false;

  const beforeDelimiter = raw.length - delimiter.length - 1;
  return beforeDelimiter < 0 || raw[beforeDelimiter] !== '\\';
}

/** A point `characters` further along the same line as `from`. */
function advance(from: SourcePoint, characters: number): SourcePoint {
  return {
    line: from.line,
    column: from.column + characters,
    offset: (from.offset ?? 0) + characters,
  };
}

/**
 * Repair every autolink literal directly under `parent`.
 *
 * The loop walks a list it also splices into, so the index is moved on by hand
 * past each node it inserts. Getting that wrong is how the second link in
 * `**URL**（注記）と **URL**。おわり` gets skipped, which is why both links in
 * that sentence are a test.
 */
function repairChildren(parent: MarkdownParent, source: string): void {
  const children = parent.children;

  for (let index = 0; index < children.length; index += 1) {
    const link = children[index];
    if (!isNode(link) || !isAutolinkLiteral(link, source)) continue;

    const plan = planRepair(link.url as string);
    if (!plan) continue;

    // Checked by `isAutolinkLiteral`; re-read here for the offsets.
    const range = sourceRange(link, source);
    const linkStart = link.position?.start;
    const linkEnd = link.position?.end;
    if (!range || !linkStart || !linkEnd) continue;

    const strongify =
      plan.delimiter !== null &&
      opensEmphasis(children[index - 1], plan.delimiter, range.start, source);

    // With the opening delimiter confirmed, both halves of the emphasis are
    // markup and neither is rendered; without it, the closing half stays put as
    // the literal text the author will see.
    const tailText = strongify ? plan.tailText.slice(plan.delimiter?.length ?? 0) : plan.tailText;
    const tailOffset = strongify
      ? plan.tailOffset + (plan.delimiter?.length ?? 0)
      : plan.tailOffset;

    const keptEnd = advance(linkStart, plan.keptUrl.length);
    link.url = plan.keptUrl;
    const only = link.children?.[0];
    if (only) {
      only.value = plan.keptUrl;
      only.position = { start: { ...linkStart }, end: { ...keptEnd } };
    }
    link.position = { start: { ...linkStart }, end: keptEnd };

    const tail: MarkdownNode = {
      type: 'text',
      value: tailText,
      position: { start: advance(linkStart, tailOffset), end: { ...linkEnd } },
    };

    if (strongify && plan.delimiter) {
      const previous = children[index - 1];
      const openingStart = advance(linkStart, -plan.delimiter.length);
      const strong: MarkdownNode = {
        type: 'strong',
        children: [link],
        position: { start: openingStart, end: advance(linkStart, tailOffset) },
      };

      const trimmed = (previous.value as string).slice(0, -plan.delimiter.length);
      if (trimmed.length === 0) {
        children.splice(index - 1, 1);
        index -= 1;
      } else {
        previous.value = trimmed;
        if (previous.position) previous.position = { ...previous.position, end: openingStart };
      }
      children[index] = strong;
    }

    children.splice(index + 1, 0, tail);
    index += 1;
  }
}

/** Repair `parent`, then everything under it. */
function walk(node: MarkdownNode, source: string): void {
  const parent = asParent(node);
  if (!parent) return;
  repairChildren(parent, source);
  for (const child of parent.children) {
    if (isNode(child)) walk(child, source);
  }
}

/**
 * The remark plugin. See the file header for what it repairs and what it
 * refuses to touch.
 */
export function remarkJapaneseUrlBoundary() {
  return function transformer(tree: unknown, file: unknown): void {
    const source = readSource(file);
    if (source === null || !isNode(tree)) return;
    walk(tree, source);
  };
}
