/**
 * The one remark plugin list every agent-authored Markdown surface renders with
 * (Issue #2459).
 *
 * Three components draw Markdown that a language model or a human wrote —
 * `ChatMessageBubble` (body, reasoning and tool activity, three renders of the
 * same kind of text), `ConversationPairCard` and `MarkdownPreview` — and each
 * of them used to build its own `[remarkGfm]` in its own `useMemo`. Three
 * copies of one list is three places a fix has to be remembered, which is
 * exactly how #2459's broken bold URL kept rendering on two screens after being
 * noticed on the third.
 *
 * ## Why a module constant and not a `useMemo`
 *
 * ReactMarkdown rebuilds its entire DOM tree when the identity of
 * `remarkPlugins` changes — the reason every call site memoised in the first
 * place, and the reason `MarkdownPreview`'s links used to stop being clickable.
 * A frozen module-level array is that same guarantee with nothing to get wrong:
 * one identity, for the life of the process, shared by every renderer.
 *
 * ## What is deliberately NOT shared
 *
 * Only the remark half. The rehype halves stay where they are, because they are
 * genuinely different: `MarkdownPreview` renders files a human asked to see and
 * needs `rehypeRaw` + a sanitize schema + `rehypeSlug` for its TOC and Mermaid,
 * while the two transcript renderers deliberately leave `rehypeRaw` off so that
 * an unfenced `<T>` in model prose stays prose. Flattening those into one list
 * would hand the HTML parser to the surface that was designed without it.
 */
import remarkGfm from 'remark-gfm';
import type { Options } from 'react-markdown';

import { remarkJapaneseUrlBoundary } from './japanese-url-boundary';

export {
  findJapaneseUrlBoundary,
  JAPANESE_URL_BOUNDARY_CHARACTERS,
  remarkJapaneseUrlBoundary,
} from './japanese-url-boundary';

/** The `remarkPlugins` value, exactly as ReactMarkdown wants it. */
type RemarkPlugins = NonNullable<Options['remarkPlugins']>;

/**
 * GFM, then #2459's boundary repair — in that order, because the repair reads
 * the autolink literals GFM produces.
 *
 * Frozen so the identity a component passes down can never be mutated into a
 * different list by anything holding a reference to it.
 */
export const SHARED_REMARK_PLUGINS: RemarkPlugins = Object.freeze([
  remarkGfm,
  remarkJapaneseUrlBoundary,
]) as RemarkPlugins;
