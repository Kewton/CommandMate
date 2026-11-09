/**
 * Fitting the brief to its budget (Issue #4223, design §2.5).
 *
 * The budget is the UTF-8 byte count of the final output. Entries are taken in the
 * fixed order and the first one that does not fit stops the take, so a wider budget's
 * brief starts with a narrower one's. Only whole entries are dropped: never part of an
 * entry, of a character or of the JSON. The result is counted again at the end; one
 * over the budget is a bug, and throws.
 *
 * @module lib/brief/fit
 */

import { BRIEF_DATA_NOTICE, BRIEF_FIXED_LIMITS, BRIEF_SCHEMA, BRIEF_TEXT_FIXED_LINES, type BriefJson } from '@/types/brief';
import type { BriefItem, BriefModel } from './model';
import { bytesOf, drawText, fittedEntryLine, fittedJsonEntry } from './render';

export interface FitTextOptions {
  /** null: `--all`, every entry and no omitted form. */
  maxBytes: number | null;
  /** The CLI writes a newline after the text, and the budget counts it. The provider's body has none. */
  trailingNewline: boolean;
  /** The provider's line budget (#2464). */
  maxLines?: number;
}

export interface FittedText {
  /** Without the trailing newline. */
  text: string;
  included: BriefItem[];
  omitted: number;
}

export class BriefOverBudgetError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`brief is ${bytes} bytes, over its budget of ${maxBytes}`);
  }
}

function takePrefix(count: number, fits: (taken: number) => boolean): number {
  let taken = 0;
  while (taken < count && fits(taken + 1)) taken += 1;
  return taken;
}

export function fitText(model: BriefModel, options: FitTextOptions): FittedText {
  const all = options.maxBytes === null;
  const drawn = model.items.map((item) => fittedEntryLine(item.entry, model.fixed.readAll, all).line);
  const total = drawn.length;
  const extra = options.trailingNewline ? 1 : 0;
  const draw = (taken: number): string => drawText(model.fixed, drawn.slice(0, taken), total - taken);
  const fits = (taken: number): boolean =>
    (options.maxBytes === null || bytesOf(draw(taken)) + extra <= options.maxBytes) &&
    (options.maxLines === undefined || BRIEF_TEXT_FIXED_LINES + taken <= options.maxLines);
  const taken = all ? total : takePrefix(total, fits);
  const text = draw(taken);
  if (options.maxBytes !== null && bytesOf(text) + extra > options.maxBytes) {
    throw new BriefOverBudgetError(bytesOf(text) + extra, options.maxBytes);
  }
  return { text, included: model.items.slice(0, taken), omitted: total - taken };
}

export interface FittedJson {
  json: BriefJson;
  included: BriefItem[];
}

function jsonOf(model: BriefModel, items: readonly BriefItem[], taken: number, maxBytes: number | null): BriefJson {
  const { fixed } = model;
  const all = maxBytes === null;
  const byRank: Record<string, number> = {};
  for (const item of items.slice(taken)) {
    const key = String(item.entry.rank);
    byRank[key] = (byRank[key] ?? 0) + 1;
  }
  const included = items.slice(0, taken);
  const branch = fixed.detached || fixed.branch === null ? null : fixed.branch;
  const repositoryOk = fixed.repositoryId !== null && fixed.repositoryId.length <= BRIEF_FIXED_LIMITS.repositoryIdChars;
  return {
    ok: true,
    schema: BRIEF_SCHEMA,
    dataNotice: BRIEF_DATA_NOTICE,
    mode: fixed.mode,
    source: 'commandmate',
    generatedAt: fixed.generatedAt,
    target: {
      worktreeId: fixed.worktreeId,
      instanceId: fixed.instanceId,
      cliToolId: fixed.cliToolId,
      repositoryId: repositoryOk ? fixed.repositoryId : null,
      ...(repositoryOk || fixed.repositoryId === null ? {} : { repositoryIdOmitted: { bytes: fixed.repositoryIdBytes } }),
      branch: branch && branch.kind === 'ok' ? branch.value : null,
      ...(branch && branch.kind === 'omitted' ? { branchOmitted: { bytes: branch.bytes, reason: branch.reason } } : {}),
      detached: fixed.detached,
      boundaryKind: fixed.boundaryKind,
    },
    budget: { unit: 'utf8-bytes', maxBytes, all },
    omitted: { count: items.length - taken, byRank },
    readAll: `${fixed.readAll} --json`,
    sources: model.sources,
    entries: included.map((item) => fittedJsonEntry(item.entry, `${fixed.readAll} --json`, all)),
    includedNoticeIds: included.flatMap((item) => (item.notice ? [item.notice.id] : [])),
  };
}

/** `--json`: `JSON.stringify(json)` and a newline within `maxBytes`. */
export function fitJson(model: BriefModel, maxBytes: number | null): FittedJson {
  const total = model.items.length;
  const size = (taken: number): number => bytesOf(JSON.stringify(jsonOf(model, model.items, taken, maxBytes))) + 1;
  const taken = maxBytes === null ? total : takePrefix(total, (n) => size(n) <= maxBytes);
  const json = jsonOf(model, model.items, taken, maxBytes);
  const bytes = bytesOf(JSON.stringify(json)) + 1;
  if (maxBytes !== null && bytes > maxBytes) throw new BriefOverBudgetError(bytes, maxBytes);
  return { json, included: model.items.slice(0, taken) };
}
