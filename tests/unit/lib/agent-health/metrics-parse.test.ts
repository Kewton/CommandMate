/**
 * Issue #3044: turning each measuring tool's output into a measurement.
 * Unreadable output is a skip with the reason, never a finding.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyNpmAudit,
  countLines,
  countTypeSafety,
  describeAuditFix,
  fixedVersionOf,
  majorOf,
  measureComplexity,
  measureCoverage,
  measureDuplication,
  measureFileSize,
  measureGitleaks,
  measureKnip,
  measureNpmAudit,
  measureOutdated,
  measureSemgrep,
  measureTypeSafety,
} from '@/lib/agent-health/metrics-parse';
import type { MetricMeasurement } from '@/lib/agent-health/metrics-types';

type Ok = Extract<MetricMeasurement, { status: 'ok' }>;

function ok(m: MetricMeasurement): Ok {
  if (m.status !== 'ok') throw new Error(`expected ok, got skip: ${m.reason}`);
  return m;
}

const AUDIT_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    ws: {
      name: 'ws',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1101,
          name: 'ws',
          title: 'Uninitialized memory disclosure',
          url: 'https://github.com/advisories/GHSA-96hv-2xvq-fx4p',
          severity: 'high',
          range: '<8.18.4',
        },
      ],
      fixAvailable: true,
    },
    postcss: {
      name: 'postcss',
      severity: 'moderate',
      isDirect: false,
      via: [
        {
          source: 1102,
          name: 'postcss',
          title: 'Line return parsing error',
          url: 'https://github.com/advisories/GHSA-7fh5-64p2-3v2j',
          severity: 'moderate',
          range: '<8.4.31',
        },
        {
          source: 1103,
          name: 'postcss',
          title: 'Another high one',
          url: 'https://github.com/advisories/GHSA-6g55-p6wh-862q',
          severity: 'high',
          range: '<8.5.0',
        },
      ],
      fixAvailable: { name: 'next', version: '16.0.0', isSemVerMajor: true },
    },
    next: { name: 'next', severity: 'high', isDirect: true, via: ['postcss'], fixAvailable: true },
    xmldom: {
      name: 'xmldom',
      severity: 'critical',
      isDirect: false,
      via: [
        { source: 1, name: 'xmldom', title: 'a', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high' },
        { source: 2, name: 'xmldom', title: 'b', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'critical' },
      ],
      fixAvailable: false,
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 3, critical: 1 } },
});

describe('npm-audit', () => {
  it('classifies the three shapes the same way as scripts/check-npm-audit.mjs', () => {
    expect(classifyNpmAudit(AUDIT_REPORT).kind).toBe('report');
    expect(
      classifyNpmAudit(JSON.stringify({ message: 'network timeout at: x', error: { summary: '', detail: '' } }))
    ).toEqual({ kind: 'unreachable', message: 'network timeout at: x' });
    expect(classifyNpmAudit('not json').kind).toBe('unreadable');
    expect(classifyNpmAudit('{"foo":1}').kind).toBe('unreadable');
  });

  it('skips (does not report zero) when the registry did not answer', () => {
    const m = measureNpmAudit(JSON.stringify({ message: 'network timeout', error: {} }));
    expect(m.status).toBe('skip');
    if (m.status === 'skip') expect(m.reason).toContain('監査していない');
  });

  it('counts high-and-above advisories as value and groups findings per package', () => {
    const m = ok(measureNpmAudit(AUDIT_REPORT));
    expect(m.value).toBe(4);
    expect(Object.keys(m.items).sort()).toEqual([
      'postcss:GHSA-6g55-p6wh-862q',
      'ws:GHSA-96hv-2xvq-fx4p',
      'xmldom:GHSA-aaaa-bbbb-cccc',
      'xmldom:GHSA-dddd-eeee-ffff',
    ]);
    expect(Object.keys(m.findings).sort()).toEqual(['postcss', 'ws', 'xmldom']);
    expect(m.findings.xmldom.severity).toBe('critical');
    expect(m.findings.xmldom.itemKeys).toHaveLength(2);
    expect(m.details).toMatchObject({ high: 3, critical: 1, packages: 3 });
  });

  it('puts the fix (and whether it is a semver-major) in the evidence', () => {
    const m = ok(measureNpmAudit(AUDIT_REPORT));
    expect(m.findings.ws.evidence).toContain('直接依存');
    expect(m.findings.ws.evidence).toContain('npm audit fix');
    expect(m.findings.postcss.evidence).toContain('next@16.0.0');
    expect(m.findings.postcss.evidence).toContain('メジャー更新');
    expect(m.findings.postcss.evidence).not.toContain('Line return parsing error'); // moderate
    expect(m.findings.xmldom.evidence).toContain('修正版なし');
  });

  it('describes fixAvailable', () => {
    expect(describeAuditFix(true)).toContain('npm audit fix');
    expect(describeAuditFix({ name: 'next', version: '16.0.0', isSemVerMajor: false })).toContain('メジャー更新なし');
    expect(describeAuditFix(false)).toContain('修正版なし');
  });
});

describe('semgrep', () => {
  it('keeps only ERROR results, one finding per rule and file', () => {
    const text = JSON.stringify({
      results: [
        { check_id: 'a.b.eval-use', path: 'src/x.ts', start: { line: 3 }, extra: { severity: 'ERROR', message: 'eval' } },
        { check_id: 'a.b.eval-use', path: 'src/x.ts', start: { line: 9 }, extra: { severity: 'ERROR', message: 'eval' } },
        { check_id: 'a.b.style', path: 'src/y.ts', start: { line: 1 }, extra: { severity: 'WARNING' } },
      ],
      errors: [],
    });
    const m = ok(measureSemgrep(text));
    expect(m.value).toBe(2);
    expect(m.items).toEqual({ 'a.b.eval-use:src/x.ts': 2 });
    expect(m.findings['a.b.eval-use:src/x.ts'].evidence).toContain('src/x.ts:9');
    expect(m.details).toMatchObject({ error: 2, warning: 1 });
  });

  it('skips output without results (the rules could not be fetched)', () => {
    expect(measureSemgrep('').status).toBe('skip');
    expect(measureSemgrep('{"errors":[{}]}').status).toBe('skip');
  });
});

describe('secrets (gitleaks)', () => {
  it('reads a gitleaks report; an empty file is zero leaks', () => {
    const m = ok(
      measureGitleaks(
        JSON.stringify([{ RuleID: 'aws-key', File: 'a.env', StartLine: 2, Commit: 'abcdef1234567890', Fingerprint: 'fp1' }])
      )
    );
    expect(m.value).toBe(1);
    expect(m.findings.fp1.severity).toBe('critical');
    expect(ok(measureGitleaks('')).value).toBe(0);
    expect(measureGitleaks('{').status).toBe('skip');
  });
});

describe('file-size', () => {
  it('counts lines like wc -l', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  it('finds files over 1,500 lines and records the rest as counts', () => {
    const m = ok(measureFileSize({ 'src/a.ts': 1501, 'src/b.ts': 600, 'src/c.ts': 10 }));
    expect(Object.keys(m.findings)).toEqual(['src/a.ts']);
    expect(m.value).toBe(1);
    expect(m.details).toMatchObject({ files: 3, over500: 2, over1500: 1, maxLines: 1501, maxPath: 'src/a.ts' });
  });
});

describe('complexity', () => {
  it('keeps each file’s most complex function; 25 and up is a finding', () => {
    const text = JSON.stringify([
      {
        filePath: '/repo/src/a.ts',
        messages: [
          { ruleId: 'complexity', line: 3, message: "Function 'big' has a complexity of 30. Maximum allowed is 10." },
          { ruleId: 'complexity', line: 9, message: 'Arrow function has a complexity of 12. Maximum allowed is 10.' },
          { ruleId: 'no-undef', line: 1, message: 'x' },
        ],
      },
      { filePath: '/repo/src/b.ts', messages: [{ ruleId: 'complexity', line: 1, message: "Method 'm' has a complexity of 11." }] },
    ]);
    const m = ok(measureComplexity(text, '/repo'));
    expect(m.items).toEqual({ 'src/a.ts': 30, 'src/b.ts': 11 });
    expect(Object.keys(m.findings)).toEqual(['src/a.ts']);
    expect(m.findings['src/a.ts'].title).toContain("Function 'big'");
    expect(m.value).toBe(1);
  });

  it('skips non-JSON output', () => {
    expect(measureComplexity('Oops', '/repo').status).toBe('skip');
  });
});

describe('duplication / coverage', () => {
  it('reads jscpd statistics.total.percentage', () => {
    const m = ok(measureDuplication(JSON.stringify({ statistics: { total: { percentage: 1.1649, clones: 3 } } })));
    expect(m.value).toBe(1.16);
    expect(m.items).toEqual({ percentage: 1.16 });
    expect(measureDuplication('{}').status).toBe('skip');
  });

  it('reads vitest coverage-summary.json', () => {
    const m = ok(
      measureCoverage(JSON.stringify({ total: { lines: { pct: 71.234 }, branches: { pct: 60 }, functions: { pct: 'Unknown' } } }))
    );
    expect(m.value).toBe(71.23);
    expect(m.items).toEqual({ lines: 71.23, branches: 60 });
    expect(measureCoverage('{}').status).toBe('skip');
  });
});

describe('unused (knip)', () => {
  it('turns unused dependencies into findings and counts unused exports', () => {
    const text = JSON.stringify({
      files: ['src/dead.ts'],
      issues: [
        { file: 'package.json', dependencies: [{ name: 'left-pad' }], devDependencies: [{ name: 'old-tool' }], exports: [] },
        { file: 'src/a.ts', dependencies: [], exports: [{ name: 'x' }, { name: 'y' }], types: [{ name: 'T' }] },
      ],
    });
    const m = ok(measureKnip(text));
    expect(Object.keys(m.findings).sort()).toEqual(['left-pad', 'old-tool', 'src/dead.ts']);
    expect(m.value).toBe(2);
    expect(m.details).toEqual({ unusedExports: 3, unusedFiles: 1 });
    expect(measureKnip('knip crashed').status).toBe('skip');
  });

  it('saves the unused file paths as items (repo-relative) and reads per-issue files too', () => {
    const m = ok(measureKnip(JSON.stringify({ files: ['src/a.ts', 'src/b.ts'], issues: [{ file: 'src/c.ts', files: [{ name: 'src/c.ts' }] }] })));
    expect(m.items).toEqual({ 'src/a.ts': 1, 'src/b.ts': 1, 'src/c.ts': 1 });
    expect(m.details).toEqual({ unusedExports: 0, unusedFiles: 3 });
  });
});

describe('outdated', () => {
  it('counts majors behind for direct dependencies only', () => {
    const text = JSON.stringify({
      next: { current: '14.2.3', wanted: '14.2.30', latest: '16.0.1' },
      zod: { current: '3.22.0', wanted: '3.23.0', latest: '4.0.0' },
      transitive: { current: '1.0.0', latest: '9.0.0' },
      missing: { wanted: '1.0.0', latest: '3.0.0' },
    });
    const m = ok(measureOutdated(text, ['next', 'zod', 'missing']));
    expect(m.items).toEqual({ next: 2, zod: 1 });
    expect(Object.keys(m.findings)).toEqual(['next']);
    expect(ok(measureOutdated('', [])).value).toBe(0);
  });

  it('reads the major of a version', () => {
    expect(majorOf('14.2.3')).toBe(14);
    expect(majorOf('v8.0.0')).toBe(8);
    expect(majorOf(undefined)).toBeUndefined();
  });
});

describe('type-safety', () => {
  it('counts any in type positions, eslint-disable directives and @ts-ignore', () => {
    const text = [
      'const a: any = 1;',
      'const b = x as any;',
      'const c: Array<any> = [];',
      'type U = string | any;',
      'const many = 1; // any value is fine',
      '// eslint-disable-next-line no-console',
      '/* eslint-disable */',
      '// @ts-ignore',
    ].join('\n');
    expect(countTypeSafety(text)).toEqual({ any: 4, eslintDisable: 2, tsIgnore: 1 });
    expect(ok(measureTypeSafety({ any: 4, eslintDisable: 2, tsIgnore: 1 })).value).toBe(7);
  });
});

describe('npm-audit fixed version', () => {
  it('reads the upper bound of a range', () => {
    expect(fixedVersionOf('>=8.0.0 <8.21.0')).toBe('8.21.0');
    expect(fixedVersionOf('<1.2.3 || >=2.0.0 <2.10.1')).toBe('2.10.1');
    expect(fixedVersionOf('*')).toBeNull();
    expect(fixedVersionOf(undefined)).toBeNull();
  });

  it('states the target version in the evidence when every advisory has one', () => {
    const m = ok(measureNpmAudit(AUDIT_REPORT));
    expect(m.findings.ws.evidence).toContain('目標: ws を 8.18.4 以上にし');
    expect(m.findings.xmldom.evidence).not.toContain('目標:');
  });
});
