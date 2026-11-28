/**
 * The ask envelope (Issue #4344, design `docs/design/ask-attribution-4344.md`
 * §3.2 M2・M3).
 *
 * One machine line, `[cmate-ask v1 <askId>]`, put on the text the tool types
 * for a synchronous `commandmate ask`, so the tool's own transcript names which
 * ask an input was. The model is not asked to repeat it; only the user record
 * the transcript keeps is read.
 *
 * ## Where it goes (M3)
 *
 * Right after a session brief's closing fence and right before the operator's
 * body — at the very start when there is no brief. Never in front of the brief:
 * History's adoption recognises a brief by `^<<<cmate-brief:` (`afterDeliveredBrief`),
 * and an envelope ahead of it would hide the brief from that rule.
 *
 * ## Taking it off (M2)
 *
 * Only when the line sits exactly there: the first line of the text (after any
 * leading blank lines), or the first line after a brief (which itself may follow
 * leading blank lines). Claude Code records a multi-line tmux send as a paste
 * with two newlines outside the wrapper (#4582), so the unwrapped text opens with
 * `"\n\n"`. Text with no envelope there — a relay body, a
 * brief-only send, an operator's message quoting an envelope further down — is
 * returned unchanged (`null`), so nothing that never carried one reads
 * differently.
 *
 * Pure: no database, no tool.
 */

/** The envelope line's version tag. Bumped only with {@link ASK_ENVELOPE_PATTERN}. */
export const ASK_ENVELOPE_VERSION = 'v1';

/** The whole envelope line; the capture is the askId (a UUID). */
export const ASK_ENVELOPE_PATTERN = /^\[cmate-ask v1 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/;

/** A brief's opening fence (`session-brief`'s `drawText`): the tag is repeated on the closing one. */
const BRIEF_OPEN = /^<<<cmate-brief:([0-9a-f]{8})\n/;

/** Whether `askId` is an id the envelope can carry (a lower-case UUID). */
export function isAskId(value: unknown): value is string {
  return typeof value === 'string' && ASK_ENVELOPE_PATTERN.test(formatAskEnvelope(value));
}

/** The envelope line for `askId`. */
export function formatAskEnvelope(askId: string): string {
  return `[cmate-ask ${ASK_ENVELOPE_VERSION} ${askId}]`;
}

/**
 * Where the operator's part of `text` starts: past any leading blank lines
 * (`\n` only, #4582), then after a session brief's closing fence and its blank
 * line when the text opens with a brief there.
 */
function bodyStart(text: string): number {
  const lead = /^\n*/.exec(text)?.[0].length ?? 0;
  const open = BRIEF_OPEN.exec(text.slice(lead));
  if (!open) return lead;
  const close = `\ncmate-brief:${open[1]}>>>\n\n`;
  const end = text.indexOf(close, lead);
  return end < 0 ? lead : end + close.length;
}

/**
 * The text to type with the envelope in its place (M3), or null when the
 * envelope cannot be put there.
 *
 * `typedText` is what the send would type — the operator's `content`, or a
 * claimed brief in front of it. The envelope goes immediately before `content`;
 * a `typedText` that does not end with `content` is a shape this does not know,
 * and the send then goes out without an envelope (the ask reads `unmatched`,
 * never a wrong reply). A prefix that is not a fenced brief still gets the
 * envelope in front of the body, where {@link stripAskEnvelope} does not look —
 * that ask, too, reads `unmatched` rather than a wrong reply.
 */
export function insertAskEnvelope(typedText: string, content: string, askId: string): string | null {
  if (!typedText.endsWith(content)) return null;
  const prefix = typedText.slice(0, typedText.length - content.length);
  return `${prefix}${formatAskEnvelope(askId)}\n${content}`;
}

/** What {@link stripAskEnvelope} found. */
export interface StrippedAskEnvelope {
  askId: string;
  /** The text with the envelope line taken out; a brief in front of it is kept. */
  text: string;
}

/**
 * The envelope at its canonical place in `text`, and the text without it — or
 * null when there is none there (M2). Leading blank lines in front of the
 * envelope (or of the brief) are skipped and kept in the returned text (#4582):
 * History compares prompts with blank lines at either end trimmed, so they do
 * not change which row is adopted. Line endings are read as the transcript
 * keeps them (`\r\n` too); trailing blanks on the envelope line are tolerated.
 */
export function stripAskEnvelope(text: string): StrippedAskEnvelope | null {
  if (!text.includes('[cmate-ask ')) return null;
  const normalized = text.replace(/\r\n?/g, '\n');
  const start = bodyStart(normalized);
  const rest = normalized.slice(start);
  const lineEnd = rest.indexOf('\n');
  const line = (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).replace(/[ \t]+$/, '');
  const match = ASK_ENVELOPE_PATTERN.exec(line);
  if (!match) return null;
  const after = lineEnd < 0 ? '' : rest.slice(lineEnd + 1);
  return { askId: match[1], text: `${normalized.slice(0, start)}${after}` };
}
