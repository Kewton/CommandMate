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
 * A numbered option row of an approval target, with the `>` gutter agy draws on
 * the highlighted one (`> 2. No, cancel`) or the blank gutter of the others.
 */
const OPTION_ROW_GUTTER_PATTERN = /^[ \t]*>?[ \t]*(?=\d+\.[ \t])/gm;

/**
 * An approval target with the highlight's mark taken out (Issue #3812).
 *
 * agy's permission dialog reads its approval target down to the footer
 * (`detection/tools/antigravity/dialog.ts`), so the option rows are in it and
 * the `>` moves with every ↑/↓. Every numbered row gets the same gutter here;
 * the words of every row, the question and the command above stay as they are.
 * A target with no numbered row (the trust screen's folder) is returned as is.
 */
export function approvalTargetWithoutHighlight(approvalTarget: string | null): string | null {
  return approvalTarget === null ? null : approvalTarget.replace(OPTION_ROW_GUTTER_PATTERN, '  ');
}

/** One fixed form of what a screen asks. The highlight is not in it: moving the cursor is the same appearance. */
export function screenFingerprint(parts: FingerprintParts): string {
  return JSON.stringify([
    parts.sessionName,
    parts.sessionGeneration,
    parts.kind,
    normalize(parts.question),
    parts.options.map(normalize),
    normalize(approvalTargetWithoutHighlight(parts.approvalTarget)),
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
