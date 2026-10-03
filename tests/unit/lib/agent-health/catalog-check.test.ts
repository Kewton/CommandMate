/**
 * Issue #3158: the pure half of the daily catalog drift check
 * (src/lib/agent-health/catalog-check.ts), against the real `--check` captures
 * in tests/unit/lib/slash-command-reconcile/fixtures/.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  attestedVersionsOf,
  buildCatalogRecord,
  catalogIssueBody,
  compareVersions,
  formatCatalogLine,
  formatVersionGaps,
  judgeCatalogCheck,
  parseCatalogCheckArgs,
  parseTrackingIssues,
  planIssueSync,
  versionToken,
} from '@/lib/agent-health/catalog-check';
import { parseCatalogCheckOutput } from '@/lib/slash-command-reconcile/check-report';

const FIXTURES = path.resolve(__dirname, '../slash-command-reconcile/fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The exact warning `providers/opencode.ts` returns when no port is given. */
const OPENCODE_SKIP =
  'opencode provider skipped: no loopback port given (pass { port } — the TUI built-ins are not in GET /command, see the module docblock)';

/** Adds the opencode skip to a real capture, the way the runner prints it. */
function withOpencodeSkip(output: string): string {
  if (output.includes('Warnings (fail-soft')) {
    return output.replace(/(Warnings \(fail-soft[^\n]*\n)/, `$1  ! ${OPENCODE_SKIP}\n`);
  }
  return output.replace(
    /(={10,}\n\n)/,
    `$1Warnings (fail-soft — affected sources left untouched):\n  ! ${OPENCODE_SKIP}\n\n`
  );
}

describe('judgeCatalogCheck', () => {
  it('does not turn inconclusive when the opencode skip is the only warning', () => {
    const output = withOpencodeSkip(fixture('check-clean.txt'));
    // The CI parser alone still calls this inconclusive — the exclusion is this check's.
    expect(parseCatalogCheckOutput(output).status).toBe('inconclusive');
    const report = judgeCatalogCheck(output, 0);
    expect(report.status).toBe('clean');
    expect(report.ignoredWarnings).toEqual([OPENCODE_SKIP]);
    expect(report.inconclusiveReasons).toEqual([]);
  });

  it('also ignores the runner bare `opencode provider skipped`, but not opencode-v2 or an opencode fetch failure', () => {
    const base = fixture('check-clean.txt');
    const bare = base.replace(/(={10,}\n\n)/, '$1Warnings (fail-soft — x):\n  ! opencode provider skipped\n\n');
    expect(judgeCatalogCheck(bare, 0).status).toBe('clean');
    const v2 = base.replace(/(={10,}\n\n)/, '$1Warnings (fail-soft — x):\n  ! opencode-v2 provider skipped\n\n');
    expect(judgeCatalogCheck(v2, 0).status).toBe('inconclusive');
    const down = base.replace(/(={10,}\n\n)/, '$1Warnings (fail-soft — x):\n  ! http 503 for http://127.0.0.1:4096/command\n\n');
    expect(judgeCatalogCheck(down, 0).status).toBe('inconclusive');
  });

  it('keeps drift, attestation drift and a real outage as they are', () => {
    expect(judgeCatalogCheck(withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), 0).status).toBe('drift');
    const attestation = judgeCatalogCheck(withOpencodeSkip(fixture('check-attestation-drift-2026-08-24.txt')), 0);
    expect(attestation.status).toBe('drift');
    expect(attestation.newCount).toBe(0);
    expect(attestation.attestationDrift).toHaveLength(1);
    expect(judgeCatalogCheck(withOpencodeSkip(fixture('check-source-down.txt')), 0).status).toBe('inconclusive');
    expect(judgeCatalogCheck(fixture('check-runner-crash.txt'), 1).status).toBe('inconclusive');
  });
});

describe('versions', () => {
  const attested = attestedVersionsOf({
    attestations: [
      { tool: 'claude', version: '2.1.283' },
      { tool: 'codex', version: '0.159.3' },
      { tool: 'antigravity', version: '1.2.12' },
      { tool: 'opencode', version: '1.18.22' },
      { tool: 'opencode-v2', version: '2.0.18' },
    ],
  });
  const report = {
    tools: [
      { tool: 'claude', version: '2.1.288 (Claude Code)' },
      { tool: 'codex', version: 'codex-cli 0.159.3' },
      { tool: 'antigravity', version: '1.2.15' },
      { tool: 'opencode', version: '1.18.34' },
      { tool: 'opencode-v2', version: 'opencode v2.0.18' },
      { tool: 'command-code', version: '1.66.0' },
      { tool: 'claude-broken', version: null },
    ],
  };

  it('reads the dotted number out of a --version line', () => {
    expect(versionToken('2.1.288 (Claude Code)')).toBe('2.1.288');
    expect(versionToken('codex-cli 0.159.3')).toBe('0.159.3');
    expect(versionToken('opencode v2.0.18')).toBe('2.0.18');
    expect(versionToken('unknown')).toBeNull();
  });

  it('lists the gaps, leaving out opencode 1.x and tools without an attestation', () => {
    const comparison = compareVersions(report, attested);
    expect(comparison).toEqual({
      available: true,
      gaps: [
        { tool: 'claude', attested: '2.1.283', local: '2.1.288' },
        { tool: 'antigravity', attested: '1.2.12', local: '1.2.15' },
      ],
    });
    expect(formatVersionGaps(comparison)).toBe('claude:2.1.283->2.1.288,antigravity:1.2.12->1.2.15');
  });

  it('says none / unknown', () => {
    expect(formatVersionGaps(compareVersions({ tools: [] }, attested))).toBe('none');
    expect(formatVersionGaps(compareVersions(undefined, attested))).toBe('unknown');
  });

  it('a version gap alone does not make drift, but shows in the body and the line', () => {
    const check = judgeCatalogCheck(withOpencodeSkip(fixture('check-clean.txt')), 0);
    const comparison = compareVersions(report, attested);
    expect(check.status).toBe('clean');
    expect(planIssueSync(check.status, null)).toBe('none');
    const record = buildCatalogRecord({
      date: '2026-10-04', checkedAt: 'x', dryRun: false, report: check, versions: comparison, issue: null, action: 'none',
    });
    expect(formatCatalogLine(record)).toBe(
      'AGENT_HEALTH_CATALOG date=2026-10-04 status=clean new=0 attestation_drift=0 ' +
        'version_gaps=claude:2.1.283->2.1.288,antigravity:1.2.12->1.2.15 issue=none action=none'
    );
    const body = catalogIssueBody(check, comparison, { checkedAt: 'x', exitCode: 0 });
    expect(body).toContain('### 版の差');
    expect(body).toContain('| claude | 2.1.283 | 2.1.288 |');
  });
});

describe('Issue sync', () => {
  it('follows the table in Issue #3158 §4', () => {
    const open = { number: 9, title: 't' };
    expect(planIssueSync('drift', null)).toBe('create');
    expect(planIssueSync('drift', open)).toBe('update');
    expect(planIssueSync('clean', open)).toBe('close');
    expect(planIssueSync('clean', null)).toBe('none');
    expect(planIssueSync('inconclusive', open)).toBe('none');
    expect(planIssueSync('inconclusive', null)).toBe('none');
  });

  it('only counts Issues the owner wrote, oldest first', () => {
    expect(
      parseTrackingIssues([
        { number: 3200, title: 'b', author: { login: 'Kewton' } },
        { number: 2036, title: 'bot', author: { login: 'app/github-actions' } },
        { number: 3170, title: 'a', author: { login: 'kewton' } },
        { number: 'x' },
      ])
    ).toEqual([
      { number: 3170, title: 'a' },
      { number: 3200, title: 'b' },
    ]);
    expect(parseTrackingIssues({})).toBeNull();
  });

  it('the body says to follow /catalog-reconcile and keeps the drift-report shape', () => {
    const check = judgeCatalogCheck(withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), 0);
    const body = catalogIssueBody(check, { available: false, gaps: [] }, { checkedAt: '2026-10-04T00:00:00Z', exitCode: 0 });
    const lines = body.split('\n');
    expect(lines[0]).toBe('<!-- slash-command-catalog-drift -->');
    expect(lines[1]).toBe('> 対応は `/catalog-reconcile` の無人実行節に従う。');
    expect(body).not.toContain('catalog-drift.yml');
    expect(body).toContain('## 未反映のコマンドが 3 件あります');
    expect(body).toContain('当日の agent-health レポートが無いため比べていません。');
    expect(body.indexOf('### 版の差')).toBeLessThan(body.indexOf('### 対応'));
  });
});

describe('formatCatalogLine', () => {
  it('marks a dry run and quotes the reason', () => {
    const check = judgeCatalogCheck(withOpencodeSkip(fixture('check-source-down.txt')), 0);
    const record = buildCatalogRecord({
      date: '2026-10-04', checkedAt: 'x', dryRun: true, report: check, versions: { available: true, gaps: [] },
      issue: null, action: 'none', wouldDo: 'none', reason: 'a "b"\nc',
    });
    expect(formatCatalogLine(record)).toBe(
      'AGENT_HEALTH_CATALOG date=2026-10-04 status=inconclusive new=0 attestation_drift=0 version_gaps=none ' +
        `issue=none action=none dry_run=would-none reason="a 'b' c"`
    );
  });
});

describe('parseCatalogCheckArgs', () => {
  it('accepts --dry-run and --state-dir, rejects the rest', () => {
    expect(parseCatalogCheckArgs(['--dry-run', '--state-dir=/s'])).toEqual({ ok: true, options: { dryRun: true, stateDir: '/s' } });
    expect(parseCatalogCheckArgs(['--state-dir'])).toMatchObject({ ok: false });
    expect(parseCatalogCheckArgs(['--write'])).toMatchObject({ ok: false });
    expect(parseCatalogCheckArgs(['-h'])).toMatchObject({ ok: false, help: true });
  });
});
