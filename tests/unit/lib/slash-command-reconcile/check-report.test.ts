/**
 * Tests for the catalog drift report parser (Issue #1705).
 *
 * The drift fixture is a byte-for-byte capture of
 * `npm run catalog:refresh -- --check` on this branch (2026-08-06), including
 * the npm banner the workflow will also capture. The other fixtures keep that
 * exact shape and vary only what is under test, so the parser is never
 * validated against output that printSummary() could not produce.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  parseCatalogCheckOutput,
  formatTrackingIssueBody,
  formatCheckSummaryLine,
  trackingIssueTitle,
  isIgnoredWarning,
  IGNORED_WARNING_PREFIXES,
  TRACKING_ISSUE_MARKER,
} from '@/lib/slash-command-reconcile/check-report';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

const DRIFT = fixture('check-drift-2026-08-06.txt');
const CLEAN = fixture('check-clean.txt');
const CLEAN_KNOWN_WARNING = fixture('check-clean-known-warning.txt');
const SOURCE_DOWN = fixture('check-source-down.txt');
const RUNNER_CRASH = fixture('check-runner-crash.txt');

describe('parseCatalogCheckOutput — real --check capture (3 new, exit 0)', () => {
  const report = parseCatalogCheckOutput(DRIFT, { exitCode: 0 });

  it('reads the new-command count out of the report, not the exit code', () => {
    // The whole point of Issue #1705: this run exited 0 while carrying drift.
    expect(report.newCount).toBe(3);
    expect(report.status).toBe('drift');
  });

  it('captures each new command verbatim', () => {
    expect(report.newCommands).toHaveLength(3);
    expect(report.newCommands[1]).toBe(
      '[claude] /schedule — Create, update, list, or run routines, which execute on Anthropic-managed cloud infrastructure'
    );
    expect(report.newCommands[2]).toBe('[claude] /ultraplan — (needs description)');
  });

  it('keeps the needs-review categories so the issue shows what needs a decision', () => {
    expect(report.noticeGroups).toEqual([
      { category: 'removed-row', count: 2 },
      { category: 'alias-row', count: 2 },
      { category: 'suspect-description', count: 1 },
    ]);
    expect(report.needsReviewCount).toBe(5);
  });

  it('treats the standing antigravity warning as known, not as an outage', () => {
    expect(report.warnings).toEqual(['antigravity provider not implemented yet (Issue #1489 Phase 2)']);
    expect(report.ignoredWarnings).toHaveLength(1);
    expect(report.blockingWarnings).toEqual([]);
    expect(report.inconclusiveReasons).toEqual([]);
  });

  it('records verifiedAgainst stamp updates', () => {
    expect(report.verifiedAgainstUpdates).toEqual(['codex: 0.146.0 -> 0.146.1']);
  });

  it('strips the npm banner from the text pasted into the issue', () => {
    expect(report.reportText.startsWith('Slash-command catalog reconcile')).toBe(true);
    expect(report.reportText).not.toContain('catalog:refresh');
    expect(report.reportText).toContain('New commands (3):');
  });
});

describe('parseCatalogCheckOutput — zero drift', () => {
  it('reports 0 and clean when nothing is new and no source warned', () => {
    const report = parseCatalogCheckOutput(CLEAN, { exitCode: 0 });
    expect(report.newCount).toBe(0);
    expect(report.status).toBe('clean');
    expect(report.inconclusiveReasons).toEqual([]);
  });

  it('stays clean when the only warning is the known antigravity placeholder', () => {
    // Regression guard: this warning is on in every run. If it blocked, the
    // workflow would report "inconclusive" forever and mean nothing.
    const report = parseCatalogCheckOutput(CLEAN_KNOWN_WARNING, { exitCode: 0 });
    expect(report.status).toBe('clean');
    expect(report.newCount).toBe(0);
    expect(report.blockingWarnings).toEqual([]);
  });
});

describe('parseCatalogCheckOutput — inconclusive', () => {
  it('refuses to call an unreachable source "0 new"', () => {
    const report = parseCatalogCheckOutput(SOURCE_DOWN, { exitCode: 0 });
    expect(report.newCount).toBe(0);
    expect(report.status).toBe('inconclusive');
    expect(report.blockingWarnings).toEqual([
      'http 503 for https://docs.claude.com/en/docs/claude-code/slash-commands',
      'codex enum parsed to zero commands at rust-v0.146.1 (format drift?)',
    ]);
    expect(report.inconclusiveReasons).toContain(
      'source-warning:http 503 for https://docs.claude.com/en/docs/claude-code/slash-commands'
    );
  });

  it('flags a crashed runner even though there is no report to parse', () => {
    const report = parseCatalogCheckOutput(RUNNER_CRASH, { exitCode: 1 });
    expect(report.status).toBe('inconclusive');
    expect(report.newCount).toBeNull();
    expect(report.inconclusiveReasons).toContain('runner-exit-code:1');
    expect(report.inconclusiveReasons).toContain('report-header-missing');
  });

  it('flags a report that was cut off before the check-mode footer', () => {
    const truncated = DRIFT.slice(0, DRIFT.indexOf('(check mode'));
    const report = parseCatalogCheckOutput(truncated, { exitCode: 0 });
    expect(report.status).toBe('inconclusive');
    expect(report.inconclusiveReasons).toContain('report-truncated');
  });

  it('flags a declared count that disagrees with the rows printed under it', () => {
    // A format change that drops rows must fail loud, not report a small number.
    const drifted = DRIFT.replace('New commands (3):', 'New commands (7):');
    const report = parseCatalogCheckOutput(drifted, { exitCode: 0 });
    expect(report.status).toBe('inconclusive');
    expect(report.inconclusiveReasons).toContain(
      'new-command-count-mismatch:declared=7,parsed=3'
    );
  });

  it('flags output with no new-command verdict at all', () => {
    const stripped = DRIFT.split('\n')
      .filter((line) => !line.startsWith('New commands (') && !line.trim().startsWith('+ '))
      .join('\n');
    const report = parseCatalogCheckOutput(stripped, { exitCode: 0 });
    expect(report.status).toBe('inconclusive');
    expect(report.inconclusiveReasons).toContain('new-command-count-missing');
  });
});

describe('isIgnoredWarning', () => {
  it('ignores only the declared placeholder prefix', () => {
    expect(IGNORED_WARNING_PREFIXES).toEqual(['antigravity provider not implemented yet']);
    expect(isIgnoredWarning('antigravity provider not implemented yet (Issue #1489 Phase 2)')).toBe(
      true
    );
  });

  it('does not ignore a real antigravity failure once the provider exists', () => {
    // Matching on "contains antigravity" would swallow exactly these.
    expect(isIgnoredWarning('http 404 for https://antigravity.google/docs/reference')).toBe(false);
    expect(isIgnoredWarning('fetch failed for https://antigravity.google/docs: ETIMEDOUT')).toBe(
      false
    );
    expect(isIgnoredWarning('antigravity provider skipped')).toBe(false);
  });
});

describe('trackingIssueTitle', () => {
  it('puts the count in the title so the trend is visible in the issue list', () => {
    expect(trackingIssueTitle(parseCatalogCheckOutput(DRIFT))).toBe(
      '[catalog-drift] スラッシュコマンドカタログ 未反映 3 件'
    );
  });

  it('names the inconclusive state distinctly from zero drift', () => {
    const inconclusive = trackingIssueTitle(parseCatalogCheckOutput(SOURCE_DOWN));
    const clean = trackingIssueTitle(parseCatalogCheckOutput(CLEAN));
    expect(inconclusive).toContain('検査不能');
    expect(clean).toContain('差分なし');
    expect(inconclusive).not.toBe(clean);
  });
});

describe('formatTrackingIssueBody', () => {
  const body = formatTrackingIssueBody(parseCatalogCheckOutput(DRIFT), {
    checkedAt: '2026-08-06T00:00:00.000Z',
    runUrl: 'https://github.com/Kewton/CommandMate/actions/runs/1',
    exitCode: 0,
  });

  it('pastes the --check output verbatim, review categories included', () => {
    expect(body).toContain('New commands (3):');
    expect(body).toContain('[removed-row] (2)');
    expect(body).toContain('[alias-row] (2)');
    expect(body).toContain('[suspect-description] (1)');
    expect(body).toContain('  + [claude] /agents — As of v2.1.198');
  });

  it('carries the marker, the counts, and the run link', () => {
    expect(body).toContain(TRACKING_ISSUE_MARKER);
    expect(body).toContain('未反映のコマンドが 3 件あります');
    expect(body).toContain('| 要レビュー（自動追加されない） | 5 |');
    expect(body).toContain('https://github.com/Kewton/CommandMate/actions/runs/1');
    expect(body).toContain('exit code: 0');
  });

  it('explains why an inconclusive run is not zero drift', () => {
    const inconclusive = formatTrackingIssueBody(parseCatalogCheckOutput(SOURCE_DOWN), {
      checkedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(inconclusive).toContain('検査不能と判定した理由');
    expect(inconclusive).toContain('source-warning:http 503');
  });

  it('truncates an oversized report so the body stays under GitHub limits', () => {
    const huge = parseCatalogCheckOutput(DRIFT);
    const body = formatTrackingIssueBody(huge, {
      checkedAt: '2026-08-06T00:00:00.000Z',
      maxReportChars: 80,
    });
    expect(body).toContain('以降を省略');
    expect(body.length).toBeLessThan(2000);
  });
});

describe('formatCheckSummaryLine', () => {
  it('summarises the verdict for the Actions log', () => {
    expect(formatCheckSummaryLine(parseCatalogCheckOutput(DRIFT))).toBe(
      'status=drift new=3 needsReview=5 warnings=1(blocking=0)'
    );
  });
});
