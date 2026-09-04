/**
 * `scripts/check-npm-audit.mjs` (Issue #2313): the CI `Security Audit` step
 * must tell "the registry did not answer" apart from "the tree has a
 * vulnerability", because `npm audit` exits 1 for both.
 *
 * Two layers are pinned:
 *
 * 1. The classifier, imported directly, on every shape it can meet. The
 *    `unreachable` fixture is the stdout npm 11.3.0 actually wrote during the
 *    2026-09-04 outage (captured, not typed), so the branch that matters is
 *    exercised on the real thing rather than on a guess about npm's envelope.
 * 2. The CLI, spawned as CI spawns it, so the exit code and the
 *    `::warning::` / `::error::` annotations — the two things the runner
 *    reads — are what is asserted, not the classifier's return value.
 *
 * A vacuous version of this gate is easy to write (anything with `error` →
 * warn), so the report cases assert BOTH directions: a critical finding must
 * exit 1 even though npm also put `error`-like words in the JSON, and a clean
 * report must exit 0 without a warning.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// tsc reads the JSDoc types off the .mjs directly (allowJs), so `Verdict` narrows below.
import { classifyAuditOutput, AUDIT_LEVELS } from '../../../scripts/check-npm-audit.mjs';

const SCRIPT = resolve(__dirname, '../../../scripts/check-npm-audit.mjs');

/** Verbatim stdout of `npm audit --json --fetch-timeout=20000` on 2026-09-04 08:24 UTC. */
const UNREACHABLE_TIMEOUT = `{
  "message": "network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  "error": {
    "summary": "",
    "detail": ""
  }
}
`;

/** The 503 envelope the same outage produced earlier in the day (CI log, PR #2311). */
const UNREACHABLE_503 = JSON.stringify({
  message: '503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Service Unavailable',
  error: { code: 'E503', summary: 'Service Unavailable', detail: '' },
});

function report(counts: Partial<Record<string, number>>): string {
  const vulnerabilities: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  Object.assign(vulnerabilities, counts);
  vulnerabilities.total = Object.values(vulnerabilities).reduce((a, b) => a + b, 0);
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities, dependencies: { prod: 1, dev: 1, total: 2 } },
  });
}

function runCli(stdout: string, npmExit = '1', ...flags: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'));
  const file = join(dir, 'audit.json');
  writeFileSync(file, stdout);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, file, npmExit, ...flags], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: String(err.stdout) };
  }
}

describe('[#2313] classifyAuditOutput', () => {
  it('reads the real outage envelope as unreachable, not as a finding', () => {
    const v = classifyAuditOutput(UNREACHABLE_TIMEOUT);
    expect(v.kind).toBe('unreachable');
    if (v.kind === 'unreachable') expect(v.message).toContain('network timeout');
  });

  it('reads a 503 envelope as unreachable', () => {
    const v = classifyAuditOutput(UNREACHABLE_503);
    expect(v.kind).toBe('unreachable');
    if (v.kind === 'unreachable') expect(v.message).toContain('503');
  });

  it('reads a clean report as a report with nothing over the gate', () => {
    const v = classifyAuditOutput(report({}));
    expect(v.kind).toBe('report');
    if (v.kind === 'report') expect(v.overGate).toBe(0);
  });

  it('counts only the gate level and above', () => {
    const v = classifyAuditOutput(report({ high: 3, critical: 2 }), 'critical');
    expect(v.kind).toBe('report');
    if (v.kind === 'report') expect(v.overGate).toBe(2);

    const w = classifyAuditOutput(report({ high: 3, critical: 2 }), 'high');
    if (w.kind === 'report') expect(w.overGate).toBe(5);
  });

  it('lets a report win over an error-shaped field inside it', () => {
    // A report is the verdict even if something in it is called `error`;
    // the envelope branch must not steal a real finding.
    const text = JSON.stringify({ ...JSON.parse(report({ critical: 1 })), error: { summary: 'advisory text' } });
    const v = classifyAuditOutput(text);
    expect(v.kind).toBe('report');
    if (v.kind === 'report') expect(v.overGate).toBe(1);
  });

  it('refuses to guess on non-JSON, arrays, and unknown envelopes', () => {
    expect(classifyAuditOutput('npm ERR! something').kind).toBe('unreadable');
    expect(classifyAuditOutput('[]').kind).toBe('unreadable');
    expect(classifyAuditOutput('{"ok":true}').kind).toBe('unreadable');
    expect(classifyAuditOutput(report({}), 'severe').kind).toBe('unreadable');
  });

  it('exposes the severity ladder CI gates against', () => {
    expect(AUDIT_LEVELS).toEqual(['info', 'low', 'moderate', 'high', 'critical']);
  });
});

describe('[#2313] check-npm-audit.mjs as CI runs it', () => {
  it('turns a registry outage into a warning and exit 0 (job stays green, step says the tree was NOT audited)', () => {
    const r = runCli(UNREACHABLE_TIMEOUT, '1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('::warning');
    expect(r.out).toContain('NOT audited');
    expect(r.out).not.toContain('::error');
  });

  it('turns a 503 into the same warning', () => {
    const r = runCli(UNREACHABLE_503, '1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('::warning');
  });

  it('passes a clean report silently', () => {
    const r = runCli(report({}), '0');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('::warning');
    expect(r.out).not.toContain('::error');
  });

  it('fails a critical finding with exit 1 and an ::error annotation', () => {
    const r = runCli(report({ critical: 1 }), '1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error');
    expect(r.out).toContain("at or above 'critical'");
  });

  it('does not fail on high when the gate is critical, and does when the gate is high', () => {
    expect(runCli(report({ high: 4 }), '1').code).toBe(0);
    expect(runCli(report({ high: 4 }), '1', '--level=high').code).toBe(1);
  });

  it('fails loudly on unreadable output instead of waving it through', () => {
    const r = runCli('npm ERR! code ENOENT', '1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error');
    expect(r.out).toContain('Refusing to guess');
  });

  it('fails when the output file is missing', () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '/nonexistent/audit.json', '1'], { encoding: 'utf8' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});
