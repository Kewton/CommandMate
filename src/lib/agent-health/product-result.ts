/**
 * The "execution result" of the product-path check (stage 2 of the daily
 * agent-health check, Issue #3312), as the dedicated user's side publishes it.
 *
 * The dedicated user (`cmcheck`) runs the supervisor
 * (`scripts/agent-health/product/supervisor.sh`); it, or the deadline guard
 * when the supervisor died, turns the run's state file and ledger into a
 * {@link ProductRunResult} (`scripts/agent-health/product/finalize.ts`) and
 * publishes it with {@link publishProductRunResult} to a shared directory the
 * user's side reads. The user's side adds the leak verdict and decides the
 * final result (`./product-judgement.ts`).
 *
 * What the result never carries: credentials, tokens, prompt bodies, agent
 * replies. Only the fields below are serialised ({@link normalizeProductRunResult}
 * drops anything else), and every free-text field is a short, single-line
 * reason with control characters removed.
 */

import fs from 'fs';
import path from 'path';

export const PRODUCT_RESULT_SCHEMA_VERSION = 1;

/** Where the dedicated user's side publishes; `CM_PRODUCT_PUBLISH_DIR` overrides. */
export const DEFAULT_PRODUCT_PUBLISH_DIR = '/Users/Shared/commandmate-check';

/** Longest reason kept; a longer one is cut (a reason is a line, not a log). */
export const PRODUCT_REASON_MAX_LENGTH = 200;

export type ProductStageStatus = 'pass' | 'fail' | 'skip' | 'unknown';
export type ProductCheckStatus = 'pass' | 'fail' | 'unknown';
export type ProductReclaimer = 'supervisor' | 'deadline-guard';

export interface ProductStageResult {
  /** `reclaim` / `safety` / `up` / `run` / `down`, in the order they ran. */
  id: string;
  status: ProductStageStatus;
  reason: string | null;
}

export interface ProductUsage {
  tool: string;
  turns: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface ProductRunResult {
  schemaVersion: typeof PRODUCT_RESULT_SCHEMA_VERSION;
  /** Local `YYYY-MM-DD` of the run. */
  date: string;
  runId: string;
  /** The commit the run checked. */
  sha: string;
  startedAt: string;
  finishedAt: string;
  /** Started after the late-start limit: nothing ran, the leftovers were still reclaimed. */
  lateStart: boolean;
  stages: ProductStageResult[];
  /** This run's own resources after its cleanup. */
  cleanup: { status: ProductCheckStatus; unknown: string[] };
  /** Who reclaimed, and what (this run's and earlier runs' resources). */
  reclaim: { status: ProductCheckStatus; by: ProductReclaimer; reclaimed: string[]; unknown: string[] };
  usage: ProductUsage[];
}

const STAGE_STATUSES: readonly ProductStageStatus[] = ['pass', 'fail', 'skip', 'unknown'];
const CHECK_STATUSES: readonly ProductCheckStatus[] = ['pass', 'fail', 'unknown'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{7,40}$|^unknown$/;

/** One line, no control characters, at most {@link PRODUCT_REASON_MAX_LENGTH}. */
export function sanitizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (line === '') return null;
  return line.length > PRODUCT_REASON_MAX_LENGTH ? `${line.slice(0, PRODUCT_REASON_MAX_LENGTH - 1)}…` : line;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && ID_RE.test(item)) : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The result with only its own fields, each checked; null when a field the
 * user's side matches on (date, run id, sha, times) is missing or malformed.
 * An unknown status becomes `unknown`, never `pass`.
 */
export function normalizeProductRunResult(value: unknown): ProductRunResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== PRODUCT_RESULT_SCHEMA_VERSION) return null;
  if (typeof raw.date !== 'string' || !DATE_RE.test(raw.date)) return null;
  if (typeof raw.runId !== 'string' || !ID_RE.test(raw.runId)) return null;
  if (typeof raw.sha !== 'string' || !SHA_RE.test(raw.sha)) return null;
  const startedAt = isoOrNull(raw.startedAt);
  const finishedAt = isoOrNull(raw.finishedAt);
  if (startedAt === null || finishedAt === null) return null;

  const stages: ProductStageResult[] = Array.isArray(raw.stages)
    ? raw.stages
        .filter((stage): stage is Record<string, unknown> => typeof stage === 'object' && stage !== null)
        .filter((stage) => typeof stage.id === 'string' && ID_RE.test(stage.id))
        .map((stage) => ({
          id: stage.id as string,
          status: oneOf(stage.status, STAGE_STATUSES, 'unknown'),
          reason: sanitizeReason(stage.reason),
        }))
    : [];
  const cleanupRaw = (typeof raw.cleanup === 'object' && raw.cleanup !== null ? raw.cleanup : {}) as Record<
    string,
    unknown
  >;
  const reclaimRaw = (typeof raw.reclaim === 'object' && raw.reclaim !== null ? raw.reclaim : {}) as Record<
    string,
    unknown
  >;
  const usage: ProductUsage[] = Array.isArray(raw.usage)
    ? raw.usage
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .filter((item) => typeof item.tool === 'string' && ID_RE.test(item.tool))
        .map((item) => ({
          tool: item.tool as string,
          turns: count(item.turns),
          inputTokens: count(item.inputTokens),
          cachedInputTokens: count(item.cachedInputTokens),
          outputTokens: count(item.outputTokens),
        }))
    : [];

  return {
    schemaVersion: PRODUCT_RESULT_SCHEMA_VERSION,
    date: raw.date,
    runId: raw.runId,
    sha: raw.sha,
    startedAt,
    finishedAt,
    lateStart: raw.lateStart === true,
    stages,
    cleanup: { status: oneOf(cleanupRaw.status, CHECK_STATUSES, 'unknown'), unknown: ids(cleanupRaw.unknown) },
    reclaim: {
      status: oneOf(reclaimRaw.status, CHECK_STATUSES, 'unknown'),
      by: oneOf<ProductReclaimer>(reclaimRaw.by, ['supervisor', 'deadline-guard'], 'supervisor'),
      reclaimed: ids(reclaimRaw.reclaimed),
      unknown: ids(reclaimRaw.unknown),
    },
    usage,
  };
}

/** The published file's text; null when it is not a result. */
export function parseProductRunResult(text: string | null): ProductRunResult | null {
  if (text === null) return null;
  try {
    return normalizeProductRunResult(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Building the result from the supervisor's state file and ledger

/** One resource of the ledger (`scripts/agent-health/product/ledger.py`). */
export interface ProductLedgerResource {
  id: string;
  kind: string;
  /** `planned` → `acquired` → `released`, or `unknown` (left alone: identity did not match). */
  state: string;
}

export interface ProductLedger {
  runId: string;
  status: string;
  resources: ProductLedgerResource[];
  /** Earlier runs this run's reclaim step closed (run ids). */
  reclaimedRuns?: string[];
  /** Earlier runs' resources left as `unknown` (`<run id>/<resource id>`). */
  unknownElsewhere?: string[];
}

/** `key=value` lines (the supervisor's `run.state`); the last value of a key wins. */
export function parseStateFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) map.set(line.slice(0, at), line.slice(at + 1));
  }
  return map;
}

function epochToIso(value: string | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return new Date(Number(value) * 1000).toISOString();
}

/**
 * The result of one run, from its `run.state` and ledger. A stage the state
 * names but never finished is `unknown` (the supervisor died in it), and a
 * resource still `planned` / `acquired` / `unknown` after the reclaim makes
 * cleanup and reclaim `unknown`.
 */
export function buildProductRunResult(
  state: Map<string, string>,
  ledger: ProductLedger | null,
  options: { by: ProductReclaimer; finishedAt: Date; usage?: unknown }
): ProductRunResult | null {
  const stageIds = (state.get('stages') ?? '').split(/\s+/).filter((id) => ID_RE.test(id));
  const stages: ProductStageResult[] = stageIds.map((id) => ({
    id,
    status: oneOf(state.get(`stage_${id}`), STAGE_STATUSES, 'unknown'),
    reason:
      sanitizeReason(state.get(`stage_${id}_reason`)) ??
      (STAGE_STATUSES.includes(state.get(`stage_${id}`) as ProductStageStatus) ? null : 'did not finish'),
  }));

  const own = ledger?.resources ?? [];
  const left = own.filter((resource) => resource.state !== 'released').map((resource) => resource.id);
  const unknownElsewhere = ledger?.unknownElsewhere ?? [];
  const reclaimed = (ledger?.reclaimedRuns ?? []).filter((id) => ID_RE.test(id));
  const cleanupStatus: ProductCheckStatus = ledger === null ? 'unknown' : left.length > 0 ? 'unknown' : 'pass';
  const reclaimStatus: ProductCheckStatus =
    ledger === null ? 'unknown' : left.length > 0 || unknownElsewhere.length > 0 ? 'unknown' : 'pass';

  return normalizeProductRunResult({
    schemaVersion: PRODUCT_RESULT_SCHEMA_VERSION,
    date: state.get('date'),
    runId: state.get('run_id'),
    sha: state.get('sha') || 'unknown',
    startedAt: epochToIso(state.get('started_at')),
    finishedAt: options.finishedAt.toISOString(),
    lateStart: state.get('late_start') === '1',
    stages,
    cleanup: { status: cleanupStatus, unknown: left },
    reclaim: {
      status: reclaimStatus,
      by: options.by,
      reclaimed,
      unknown: [...left, ...unknownElsewhere.map((entry) => entry.replace(/[^A-Za-z0-9._-]/g, '_'))],
    },
    usage: options.usage ?? [],
  });
}

// ---------------------------------------------------------------------------
// Publishing

export class ProductPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductPublishError';
  }
}

export function resolveProductPublishDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.CM_PRODUCT_PUBLISH_DIR || DEFAULT_PRODUCT_PUBLISH_DIR;
}

export function productResultFileName(date: string): string {
  return `product-${date}.json`;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * Write `product-<date>.json` into `dir` atomically: a new temp file in the
 * same directory (created exclusively, so a planted symlink there fails the
 * open), `0644`, fsync'd, then renamed over the target. A directory or target
 * that is a symlink is refused before anything is written, so the result can
 * never be redirected to another file.
 *
 * @returns The published path
 * @throws {ProductPublishError}
 */
export function publishProductRunResult(result: ProductRunResult, dir: string = resolveProductPublishDir()): string {
  const normalized = normalizeProductRunResult(result);
  if (normalized === null) throw new ProductPublishError('the result is not a valid product run result');

  const dirStat = lstatOrNull(dir);
  if (dirStat === null) throw new ProductPublishError(`${dir} does not exist`);
  if (dirStat.isSymbolicLink()) throw new ProductPublishError(`${dir} is a symlink`);
  if (!dirStat.isDirectory()) throw new ProductPublishError(`${dir} is not a directory`);

  const target = path.join(dir, productResultFileName(normalized.date));
  const targetStat = lstatOrNull(target);
  if (targetStat !== null && targetStat.isSymbolicLink()) throw new ProductPublishError(`${target} is a symlink`);
  if (targetStat !== null && !targetStat.isFile()) throw new ProductPublishError(`${target} is not a regular file`);

  const temp = path.join(dir, `.${productResultFileName(normalized.date)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o644);
    created = true;
    fs.writeSync(fd, `${JSON.stringify(normalized, null, 2)}\n`);
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    // Only a temp file this call created; one that was already there is not ours.
    if (created) fs.rmSync(temp, { force: true });
    throw new ProductPublishError(
      `could not publish ${target}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return target;
}
