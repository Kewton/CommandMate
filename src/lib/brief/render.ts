/**
 * Drawing the brief (Issue #4223, design §2.2・§3): the fixed part, one line per entry,
 * the omitted form of an entry too long for a line, and the data block's fences.
 *
 * Everything an agent reads is framed as data (D12): the fences carry a tag made from
 * the content (no randomness, so the same state draws the same text), free text is a
 * JSON string on its entry's line, and only values of a known alphabet stand bare.
 *
 * @module lib/brief/render
 */

import { createHash } from 'crypto';
import { BRIEF_ITEM_MAX_BYTES, BRIEF_TEXT_NOTICE, type BriefAuthor, type BriefEntry, type BriefFieldValue } from '@/types/brief';
import type { BriefFixed } from './model';

export const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

const BARE_VALUE = /^[A-Za-z0-9._:/@+#-]+$/;

/** A structured value as it stands on a line: bare when its alphabet is known, else a JSON string. */
export function fieldText(value: BriefFieldValue): string {
  if (value === null) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return BARE_VALUE.test(value) ? value : JSON.stringify(value);
}

export function authorText(author: BriefAuthor): string {
  switch (author.type) {
    case 'server':
      return 'server';
    case 'human':
      return 'human';
    case 'agent':
      return `agent:${author.instanceId ?? '-'}`;
    case 'prev':
      return `prev:${author.instanceId ?? '-'}@${author.createdAt ?? '-'}`;
  }
}

function isStatusRow(entry: BriefEntry): boolean {
  return 'unavailable' in entry.fields || 'unsupported' in entry.fields;
}

/** The body an entry leaves out: its free text, which is then not on the line at all. */
export function omittedFormOf(entry: BriefEntry, read: string): BriefEntry {
  if (entry.text === undefined) return entry;
  const { text, ...rest } = entry;
  return { ...rest, omittedBody: { bytes: bytesOf(text), read } };
}

/** One entry, one line (design §3.2). Never cut: a long one is drawn in the omitted form. */
export function entryLine(entry: BriefEntry): string {
  const head = `[${entry.rank}] src=${entry.source}`;
  const fields = Object.entries(entry.fields).map(([key, value]) => `${key}=${fieldText(value)}`);
  if (isStatusRow(entry)) return [head, ...fields].join(' ');
  const parts = [head, `id=${fieldText(entry.id)}`, `by=${authorText(entry.author)}`, `updated=${entry.updatedAt ?? '-'}`, ...fields];
  if (entry.withheld) {
    parts.push(`withheld=${entry.withheld.code}${entry.withheld.rule ? `:${entry.withheld.rule}` : ''}`);
  }
  if (entry.text !== undefined) parts.push(`text=${JSON.stringify(entry.text)}`);
  if (entry.omittedBody) parts.push(`…(本文 ${entry.omittedBody.bytes} bytes を省略。読む: ${entry.omittedBody.read})`);
  return parts.join(' ');
}

/** The line of an entry within {@link BRIEF_ITEM_MAX_BYTES}, unless `all`. */
export function fittedEntryLine(entry: BriefEntry, read: string, all: boolean): { line: string; entry: BriefEntry } {
  const line = entryLine(entry);
  if (all || bytesOf(line) <= BRIEF_ITEM_MAX_BYTES || entry.text === undefined) return { line, entry };
  const omitted = omittedFormOf(entry, read);
  return { line: entryLine(omitted), entry: omitted };
}

/** The entry for `--json` within {@link BRIEF_ITEM_MAX_BYTES}, unless `all`. */
export function fittedJsonEntry(entry: BriefEntry, read: string, all: boolean): BriefEntry {
  if (all || entry.text === undefined || bytesOf(JSON.stringify(entry)) <= BRIEF_ITEM_MAX_BYTES) return entry;
  return omittedFormOf(entry, read);
}

export function branchText(fixed: BriefFixed): string {
  if (fixed.detached || fixed.branch === null) return '(detached)';
  if (fixed.branch.kind === 'ok') return fixed.branch.value;
  return `(省略 ${fixed.branch.bytes} bytes。commandmate mem mode で読む)`;
}

/** Line 3 (design §2.2), with `at=` last: the tag is computed without it. */
export function stateLine(fixed: BriefFixed, withAt: boolean): string {
  return (
    `mode=${fixed.mode} worktree=${fixed.worktreeId} instance=${fixed.instanceId} branch=${branchText(fixed)}` +
    ` boundary=${fixed.boundaryKind ?? 'none'}${withAt ? ` at=${fixed.generatedAt}` : ''}`
  );
}

export function omittedLine(fixed: BriefFixed, omitted: number): string {
  return `omitted=${omitted} all=${JSON.stringify(fixed.readAll)}`;
}

/** The tag of the fences: the first 8 hex of the content's SHA-256, salted until the content does not name it. */
export function fenceTag(contentLines: readonly string[]): string {
  const content = contentLines.join('\n');
  for (let salt = 0; ; salt += 1) {
    const tag = createHash('sha256')
      .update(salt === 0 ? content : `${content}:${salt}`)
      .digest('hex')
      .slice(0, 8);
    if (!content.includes(`cmate-brief:${tag}`)) return tag;
  }
}

/** The whole text (no trailing newline): fences, notice, state, omitted count, the lines. */
export function drawText(fixed: BriefFixed, lines: readonly string[], omitted: number): string {
  const tagged = [BRIEF_TEXT_NOTICE, stateLine(fixed, false), omittedLine(fixed, omitted), ...lines];
  const tag = fenceTag(tagged);
  return [
    `<<<cmate-brief:${tag}`,
    BRIEF_TEXT_NOTICE,
    stateLine(fixed, true),
    omittedLine(fixed, omitted),
    ...lines,
    `cmate-brief:${tag}>>>`,
  ].join('\n');
}
