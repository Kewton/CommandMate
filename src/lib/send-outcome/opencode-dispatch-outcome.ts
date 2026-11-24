/**
 * What OpenCode's HTTP dispatch proves about a message (Issue #4535, design
 * `docs/design/send-outcome-4535.md` §2.3).
 *
 * The sender posts `prompt_async` with a message id it chose, then reads that
 * id back. `not_sent` — which lets the keyboard fallback type the body — only
 * when the loopback server said it did not take the prompt (a 4xx, or the web
 * UI's SPA shell — `200 text/html`, that status only), or when every read of the ladder said the message does not
 * exist. Everything else (5xx, 3xx, an unexpected 2xx — an HTML 201 or 202
 * included — no answer, a read-back
 * that mixes 404 with other answers, a message under the id with other text) is
 * `unknown`: the message may be in, so nothing else is typed or posted.
 *
 * Pure. `sendOpencodePrompt` (`client.ts`) reads its POST's answer through
 * {@link classifyOpencodePromptAnswer}, and the sender's `verifyPostedMessage`
 * (`opencode.ts`) its read-backs through {@link classifyOpencodeReadbacks}.
 */

/** The `prompt_async` POST's answer. */
export type OpencodePromptAnswer =
  | { kind: 'response'; status: number; contentType: string | null }
  | { kind: 'no-answer' };

export type OpencodePromptVerdict = 'accepted' | 'not_sent' | 'unknown';

/** One read-back of the posted id: found (and whether the sent body is among its texts), a 404, or anything else. */
export type OpencodeReadbackAnswer =
  | { kind: 'found'; matches: boolean }
  | { kind: 'missing' }
  | { kind: 'unknown' };

export type OpencodeReadbackVerdict = 'delivered' | 'not_sent' | 'unknown';

function mediaType(contentType: string | null): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** Classify the `prompt_async` answer (design §2.3). */
export function classifyOpencodePromptAnswer(answer: OpencodePromptAnswer): OpencodePromptVerdict {
  if (answer.kind === 'no-answer') return 'unknown';
  const { status } = answer;
  if (status === 204) return 'accepted';
  // #1931: an unknown route answers with the web UI's shell — `200 text/html` —
  // which never took the prompt. Only that status: another HTML 2xx (a 201, a
  // 202) may have taken it, so it stays unknown with every other 2xx.
  if (status === 200 && mediaType(answer.contentType) === 'text/html') return 'not_sent';
  if (status >= 200 && status < 300) return 'unknown';
  if (status >= 400 && status < 500) return 'not_sent';
  // 5xx: the server may have created the message before it failed. 3xx: not an answer of the route.
  return 'unknown';
}

/**
 * Classify the read-backs of one accepted prompt, in the order they were made.
 *
 * @param reads - The answers, oldest first; reads after the first `found` are ignored
 * @param ladderLength - How many reads the ladder makes; `not_sent` needs that many 404s
 */
export function classifyOpencodeReadbacks(
  reads: readonly OpencodeReadbackAnswer[],
  ladderLength: number
): OpencodeReadbackVerdict {
  let missing = 0;
  for (const read of reads) {
    if (read.kind === 'found') return read.matches ? 'delivered' : 'unknown';
    if (read.kind === 'missing') missing += 1;
  }
  // A 404 while the message is still being written is the race the ladder is for:
  // only a ladder of nothing but 404s says it does not exist.
  return ladderLength > 0 && missing === reads.length && missing >= ladderLength ? 'not_sent' : 'unknown';
}
