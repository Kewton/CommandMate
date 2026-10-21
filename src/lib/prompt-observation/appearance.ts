/**
 * Which appearance of a screen an observation saw (Issue #3755).
 *
 * The same trust screen can open, be answered, and open again with every word
 * the same — and a token issued on the first one must not answer the second.
 * The server keeps, per instance, the fingerprint of the decision screen it
 * last observed (kind, question, options, approval target, pane, generation)
 * and when that fingerprint was first observed. Observing anything else — a
 * different screen, `composer`, `none`, `unknown`, no session — forgets it, so
 * the next observation of the same words is a new appearance with a new
 * `firstSeenAt`, which the token binds (`./token`).
 *
 * What this cannot see: the screen going away and coming back between two
 * observations, with nothing observed in between (observations are opt-in, not
 * a poll). The two are one appearance here.
 *
 * In memory on `globalThis` (the route that issues and the route that verifies
 * are bundled apart under `next dev`), bounded; forgetting an instance only
 * makes its next observation a new appearance, which fails closed.
 *
 * @module lib/prompt-observation/appearance
 */

import { getOrInitGlobal } from '@/lib/global-state';
import { findNumberedOptionBlock, type NumberedOptionBlock } from '@/lib/detection/tools/dialog-block';

/** How many instances are tracked at once; the least recently observed is forgotten first. */
const MAX_TRACKED_INSTANCES = 1024;

interface Appearance {
  fingerprint: string;
  firstSeenAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __promptObservationScreenAppearances: Map<string, Appearance> | undefined;
}

const appearances = getOrInitGlobal('__promptObservationScreenAppearances', () => new Map<string, Appearance>());

/** The instance an appearance belongs to. */
export interface AppearanceInstance {
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
}

/** What a screen's fingerprint is made of. */
export interface FingerprintParts {
  sessionName: string;
  sessionGeneration: number;
  kind: string;
  question: string | null;
  options: readonly string[];
  approvalTarget: string | null;
}

/** Whitespace folded, so a re-render that only reflows a row is the same screen. */
function normalize(text: string | null): string | null {
  return text === null ? null : text.replace(/\s+/g, ' ').trim();
}

/**
 * How many rows under agy's bottom option row may be its wrapped tail: the
 * allowance `detection/tools/antigravity/dialog.ts` gives the same block
 * (`LAST_OPTION_TAIL_ROWS`, not exported). A tail longer than this reads as no
 * block here, which leaves the target as it is (fail closed).
 */
const PERMISSION_OPTION_TAIL_ROWS = 12;

/**
 * The gutter of an option row: the highlight's glyph or the blank of the others.
 * The glyphs are the block reader's (`dialog-block.ts`): agy's `>`, and claude's
 * `❯`, codex's `›` and `●` for the readers that share the poller (#3817).
 */
const OPTION_ROW_GUTTER_PATTERN = /^[ \t]*[>\u276F\u203A\u25CF]?[ \t]*/u;

/**
 * The rows the shared block reader adopted as option rows, option 1 first, or
 * null when they cannot be told.
 *
 * Taken from the reader itself, never re-judged here: `findNumberedOptionBlock`
 * names the rows of option 1 (`firstRow`) and of the bottom option (`lastRow`)
 * only, so option k's row is the `lastRow` of the block the reader finds above
 * option k+1's row. Between two adopted rows there is no row the reader could
 * parse as an option (it would have adopted it, or stopped there), so that
 * block is the same run cut one option shorter. A row the reader folds into a
 * label — `0. item`, `00. item` — is never in the list.
 */
function adoptedOptionRows(rows: readonly string[], block: NumberedOptionBlock): number[] | null {
  const adopted = [block.lastRow];
  for (let below = block.lastRow; adopted.length < block.options.length - 1; ) {
    const above = findNumberedOptionBlock(rows, below, rows.length);
    if (above === null || above.firstRow !== block.firstRow || above.lastRow >= below) return null;
    adopted.unshift(above.lastRow);
    below = above.lastRow;
  }
  adopted.unshift(block.firstRow);
  return adopted.length === block.options.length ? adopted : null;
}

/**
 * An approval target with the gutters of its option rows made the same, or null
 * when its option rows cannot be told (Issue #3812, shared since #3817).
 *
 * The option block is found the way the readers find it
 * (`findNumberedOptionBlock`, bottom up to `1.`), and taken only when each label
 * the block reader read is `sameLabel` to the one the screen names. Only the
 * gutter of the rows the reader adopted as options ({@link adoptedOptionRows})
 * is made the same; every row above option 1 (the command, a here-document's
 * `1. item`, its `>` and its indent) and every row folded into a label
 * (`0. item` included) stays byte for byte.
 *
 * @param sameLabel - Whether the label the block reader read (rows under the
 *   bottom option folded in) is the one the screen names
 */
export function approvalTargetWithOptionRowsAligned(
  approvalTarget: string,
  options: readonly string[],
  sameLabel: (read: string, named: string) => boolean
): string | null {
  const rows = approvalTarget.split('\n');
  const block = findNumberedOptionBlock(rows, rows.length, PERMISSION_OPTION_TAIL_ROWS);
  if (block === null) return null;
  // The reader folds the rows under the bottom option into its label.
  const labels = [...block.options];
  const last = labels.length - 1;
  if (block.footer !== '') labels[last] = [labels[last], ...block.footer.split('\n')].join(' ').trim();
  if (labels.length !== options.length || labels.some((label, i) => !sameLabel(label, options[i]))) return null;
  const adopted = adoptedOptionRows(rows, block);
  if (adopted === null) return null;
  const optionRows = new Set(adopted);
  return rows.map((row, i) => (optionRows.has(i) ? row.replace(OPTION_ROW_GUTTER_PATTERN, '  ') : row)).join('\n');
}

/**
 * An approval target with the highlight's mark taken out (Issue #3812).
 *
 * agy's permission dialog reads its approval target down to the footer
 * (`detection/tools/antigravity/dialog.ts`), so its option rows are the tail
 * of the target and the `>` moves with every ↑/↓. Its option rows are aligned
 * by {@link approvalTargetWithOptionRowsAligned} when the block's labels are
 * exactly the screen's `options` — what the reader named.
 *
 * Any other kind, a target with no such block, or a block whose labels are not
 * the screen's, is returned as is: a moved highlight then reads as another
 * screen, which stops the strict respond rather than letting it through.
 */
export function approvalTargetWithoutHighlight(
  kind: string,
  approvalTarget: string | null,
  options: readonly string[]
): string | null {
  if (approvalTarget === null || kind !== 'antigravity-permission') return approvalTarget;
  return approvalTargetWithOptionRowsAligned(approvalTarget, options, (read, named) => read === named) ?? approvalTarget;
}

/** One fixed form of what a screen asks. The highlight is not in it: moving the cursor is the same appearance. */
export function screenFingerprint(parts: FingerprintParts): string {
  return JSON.stringify([
    parts.sessionName,
    parts.sessionGeneration,
    parts.kind,
    normalize(parts.question),
    parts.options.map(normalize),
    normalize(approvalTargetWithoutHighlight(parts.kind, parts.approvalTarget, parts.options)),
  ]);
}

function keyOf(instance: AppearanceInstance): string {
  return JSON.stringify([instance.worktreeId, instance.cliToolId, instance.instanceId]);
}

/**
 * Record an observation of a decision screen and return when this appearance
 * of it was first observed.
 *
 * @param fingerprint - {@link screenFingerprint} of the screen
 */
export function noteScreenAppearance(instance: AppearanceInstance, fingerprint: string, now: number): number {
  const key = keyOf(instance);
  const previous = appearances.get(key);
  // Re-inserted, so the map's order is least recently observed first.
  appearances.delete(key);
  const firstSeenAt = previous?.fingerprint === fingerprint ? previous.firstSeenAt : Math.floor(now);
  appearances.set(key, { fingerprint, firstSeenAt });
  while (appearances.size > MAX_TRACKED_INSTANCES) {
    const oldest = appearances.keys().next().value;
    if (oldest === undefined) break;
    appearances.delete(oldest);
  }
  return firstSeenAt;
}

/** Record an observation of anything else: the instance's last screen has gone. */
export function forgetScreenAppearance(instance: AppearanceInstance): void {
  appearances.delete(keyOf(instance));
}
