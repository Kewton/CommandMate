/**
 * The FINAL result of the product-path check (stage 2, Issue #3312), decided on
 * the user's side.
 *
 * The dedicated user publishes the execution result (`./product-result.ts`);
 * whether the run's hooks leaked to production is judged on the user's side
 * from the production log (a later contract). This module merges the two into
 * the one result the release decision reads, by fixed rules:
 *
 *   - no execution result, a stale one, or one whose run id / SHA is not the
 *     expected one → `not-run`
 *   - any of execution / cleanup / reclaim / leak `fail` → `fail`
 *   - else any of them `unknown` → `unknown`
 *   - else the execution was skipped (late start, a known outside condition)
 *     → `skip`, with its reason
 *   - else → `pass`
 *
 * For the release decision (`./release-readiness.ts`): `fail` is a NO-GO
 * ground, `unknown` and `not-run` need a look (要判断), and `skip` needs a look
 * once it has lasted {@link PRODUCT_SKIP_STREAK_ALERT_DAYS} days.
 *
 * Pure: the caller reads the files.
 */

import type { ProductRunResult, ProductStageResult } from './product-result';

export type ProductVerdict = 'pass' | 'fail' | 'unknown' | 'skip' | 'not-run';
export type ProductLeakVerdict = 'pass' | 'fail' | 'unknown';

/** Days of `skip` in a row after which the skip itself needs action. */
export const PRODUCT_SKIP_STREAK_ALERT_DAYS = 3;

/** An execution result older than this (from its end) is stale. */
export const PRODUCT_RESULT_MAX_AGE_HOURS = 24;

export const PRODUCT_FINAL_SCHEMA_VERSION = 1;

export interface ProductFinalResult {
  schemaVersion: typeof PRODUCT_FINAL_SCHEMA_VERSION;
  date: string;
  status: ProductVerdict;
  reasons: string[];
  runId: string | null;
  sha: string | null;
  /** `deadline-guard` when the supervisor did not finish the run itself. */
  reclaimedBy: ProductRunResult['reclaim']['by'] | null;
}

export interface ProductJudgementInput {
  /** The day being judged (local `YYYY-MM-DD`). */
  date: string;
  runResult: ProductRunResult | null;
  leak: ProductLeakVerdict;
  /** When given, a result for another run is `not-run`. */
  expectedRunId?: string | null;
  /** When given, a result for another commit is `not-run`. */
  expectedSha?: string | null;
  now: Date;
}

type Part = 'pass' | 'fail' | 'unknown' | 'skip';

function executionOf(result: ProductRunResult): { status: Part; reason: string } {
  if (result.lateStart) return { status: 'skip', reason: 'late-start（開始が遅れたので実行していない）' };
  const stages: ProductStageResult[] = result.stages;
  if (stages.length === 0) return { status: 'unknown', reason: '段の結果が無い' };
  const describe = (stage: ProductStageResult) => `${stage.id}${stage.reason ? `（${stage.reason}）` : ''}`;
  const failed = stages.filter((stage) => stage.status === 'fail');
  if (failed.length > 0) return { status: 'fail', reason: `失敗した段: ${failed.map(describe).join(', ')}` };
  const unknown = stages.filter((stage) => stage.status === 'unknown');
  if (unknown.length > 0) return { status: 'unknown', reason: `結果の分からない段: ${unknown.map(describe).join(', ')}` };
  const skipped = stages.filter((stage) => stage.status === 'skip');
  if (skipped.length > 0) return { status: 'skip', reason: `skip した段: ${skipped.map(describe).join(', ')}` };
  return { status: 'pass', reason: 'すべての段が pass' };
}

/** See the module comment for the rules. */
export function judgeProductRun(input: ProductJudgementInput): ProductFinalResult {
  const base = { schemaVersion: PRODUCT_FINAL_SCHEMA_VERSION, date: input.date } as const;
  const result = input.runResult;
  const notRun = (reason: string): ProductFinalResult => ({
    ...base,
    status: 'not-run',
    reasons: [reason],
    runId: result?.runId ?? null,
    sha: result?.sha ?? null,
    reclaimedBy: result?.reclaim.by ?? null,
  });

  if (result === null) return notRun('実行の結果（JSON）が無い、または読めない');
  if (result.date !== input.date) return notRun(`実行の結果の日付が ${result.date}（${input.date} のものではない）`);
  const age = input.now.getTime() - Date.parse(result.finishedAt);
  if (!(age <= PRODUCT_RESULT_MAX_AGE_HOURS * 3_600_000)) {
    return notRun(`実行の結果が古い（終了 ${result.finishedAt}）`);
  }
  if (input.expectedRunId && result.runId !== input.expectedRunId) {
    return notRun(`run id が合わない（${result.runId}、期待 ${input.expectedRunId}）`);
  }
  if (input.expectedSha && result.sha !== input.expectedSha) {
    return notRun(`SHA が合わない（${result.sha}、期待 ${input.expectedSha}）`);
  }

  const execution = executionOf(result);
  const parts: Array<{ name: string; status: Part; reason: string }> = [
    { name: '実行', ...execution },
    {
      name: '後始末',
      status: result.cleanup.status,
      reason: result.cleanup.unknown.length > 0 ? `残った資源: ${result.cleanup.unknown.join(', ')}` : result.cleanup.status,
    },
    {
      name: '回収',
      status: result.reclaim.status,
      reason:
        result.reclaim.unknown.length > 0
          ? `本人確認できず残した資源: ${result.reclaim.unknown.join(', ')}`
          : result.reclaim.status,
    },
    {
      name: '漏れ',
      status: input.leak,
      reason: input.leak === 'unknown' ? '本番のログで漏れを判定できていない' : input.leak,
    },
  ];

  const pick = (status: Part) => parts.filter((part) => part.status === status);
  let status: ProductVerdict;
  let chosen: typeof parts;
  if (pick('fail').length > 0) {
    status = 'fail';
    chosen = pick('fail');
  } else if (pick('unknown').length > 0) {
    status = 'unknown';
    chosen = pick('unknown');
  } else if (pick('skip').length > 0) {
    status = 'skip';
    chosen = pick('skip');
  } else {
    status = 'pass';
    chosen = parts;
  }
  const reasons = chosen.map((part) => `${part.name}: ${part.reason}`);
  if (result.reclaim.by === 'deadline-guard') reasons.push('期限の番人が回収した（監督役が自分で終えていない）');

  return {
    ...base,
    status,
    reasons,
    runId: result.runId,
    sha: result.sha,
    reclaimedBy: result.reclaim.by,
  };
}

/** A final-result file's text; null when it is not one. */
export function parseProductFinalResult(text: string | null): ProductFinalResult | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const statuses: ProductVerdict[] = ['pass', 'fail', 'unknown', 'skip', 'not-run'];
    if (raw.schemaVersion !== PRODUCT_FINAL_SCHEMA_VERSION) return null;
    if (typeof raw.date !== 'string' || !statuses.includes(raw.status as ProductVerdict)) return null;
    return {
      schemaVersion: PRODUCT_FINAL_SCHEMA_VERSION,
      date: raw.date,
      status: raw.status as ProductVerdict,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === 'string') : [],
      runId: typeof raw.runId === 'string' ? raw.runId : null,
      sha: typeof raw.sha === 'string' ? raw.sha : null,
      reclaimedBy: raw.reclaimedBy === 'supervisor' || raw.reclaimedBy === 'deadline-guard' ? raw.reclaimedBy : null,
    };
  } catch {
    return null;
  }
}

function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Days in a row, ending on `date`, whose final result is `skip`. A day with no
 * result, or with any other status, ends the streak.
 */
export function countProductSkipStreak(
  results: ReadonlyArray<Pick<ProductFinalResult, 'date' | 'status'>>,
  date: string
): number {
  const byDate = new Map(results.map((result) => [result.date, result.status]));
  let streak = 0;
  let day = date;
  while (byDate.get(day) === 'skip') {
    streak += 1;
    day = previousDate(day);
  }
  return streak;
}
