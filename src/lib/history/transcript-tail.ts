/**
 * Reading the end of an agent's own transcript file (Issue #2197).
 *
 * The second half of the pull-mode reader that is the same whatever the agent
 * is, alongside `./user-turn-recorder`: every one of them keeps a file that
 * grows for the life of a session, and every one of them only ever needs its
 * newest turn.
 *
 * The shape is `lib/hooks/sources/claude/history`'s, which #2121 wrote inline
 * because it was the only reader. It is here rather than there because #2197
 * added the second and #2198 adds the third, and three private copies of "read
 * the last 4 MiB and drop the partial first line" is how the bound and the
 * partial-line rule quietly stop agreeing with each other.
 *
 * @module lib/history/transcript-tail
 */

import { open } from 'fs/promises';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/history/transcript-tail');

/**
 * How much of a transcript's tail is read.
 *
 * These files grow for the life of a session and a long one is tens of
 * megabytes — the largest claude transcript on this machine was 23 MB on
 * 2026-08-31, and the largest codex rollout was **273 MB** on 2026-09-01 — so
 * reading one whole on every finished turn would be the most expensive thing the
 * poller does. Only the newest turn is ever written, so only the newest turn has
 * to be in the window.
 *
 * 4 MiB is roughly two orders of magnitude above the measured size of a single
 * turn and still small enough to read and parse in one tick. A turn that
 * genuinely does not fit produces a turn with no prompt in it, which each reader
 * detects and reports rather than writing as a headless reply.
 */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The last {@link TRANSCRIPT_TAIL_BYTES} of a file, as UTF-8.
 *
 * Read at an offset rather than whole, and the first line of a windowed read is
 * dropped: starting mid-line would hand the caller's parser a fragment that it
 * would count as malformed anyway, and dropping it deliberately keeps that
 * counter meaning "the writer was mid-append", which is the thing worth seeing.
 *
 * Never throws.
 *
 * @param path - An absolute path the caller has already validated
 * @returns The text, or null when the file could not be read
 */
export async function readTranscriptTail(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - offset;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset === 0) return text;

    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch (error) {
    logger.warn('transcript-tail-read-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
