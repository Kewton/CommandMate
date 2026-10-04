/**
 * Issue #3185: the `bug-flow` metric reads the "分類" section of bug Issues.
 * Unfilled sections (missing, or a value outside the vocabulary) are left out
 * of the rates' denominators; a 0 denominator is null, not 0. The metric never
 * has candidates.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BUG_CLASSIFICATION_TEMPLATE,
  bugFlowRates,
  countBugFlow,
  measureBugFlow,
  parseBugClassification,
  parseBugIssues,
  type BugIssue,
} from '@/lib/agent-health/bug-flow';
import { buildQueue, evaluateMetric } from '@/lib/agent-health/metrics-rules';

const NOW = new Date('2026-10-04T00:00:00.000Z');

function section(cause: string, discovery: string, impact: string): string {
  return `## 概要\n\nなにか\n\n## 分類\n- 原因の PR: ${cause}\n- 発見経路: ${discovery}\n- 影響する経路: ${impact}\n`;
}

function issue(number: number, body: string, labels: string[] = ['bug'], createdAt = '2026-10-02T00:00:00Z'): BugIssue {
  return { number, body, labels, createdAt };
}

describe('the vocabulary is the same in every filing document', () => {
  const root = path.resolve(__dirname, '../../../..');
  it.each([
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.claude/commands/uat.md',
    '.claude/commands/uat-fix-loop.md',
    '.claude/commands/bug-fix.md',
    '.claude/commands/orchestrate.md',
  ])('%s carries the 分類 section verbatim', (file) => {
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain(BUG_CLASSIFICATION_TEMPLATE);
  });

  it('the template itself left as is counts as unfilled', () => {
    expect(parseBugClassification(BUG_CLASSIFICATION_TEMPLATE).state).toBe('invalid');
  });
});

describe('parseBugClassification', () => {
  it('a filled section', () => {
    expect(parseBugClassification(section('#3191', 'uat', 'chat, mobile'))).toEqual({
      state: 'classified',
      cause: { kind: 'pr', pr: 3191 },
      discovery: 'uat',
      impact: ['chat', 'mobile'],
    });
    expect(parseBugClassification(section('不明', 'daily-use', 'なし（内部）'))).toMatchObject({
      state: 'classified',
      cause: { kind: 'unknown' },
      impact: ['なし（内部）'],
    });
    expect(parseBugClassification(section('なし（以前から）', 'review', 'cli')).state).toBe('classified');
    expect(parseBugClassification(section('上流（codex 0.50.0）', 'automated', 'terminal、auto-yes'))).toMatchObject({
      cause: { kind: 'upstream', detail: 'codex 0.50.0' },
      impact: ['terminal', 'auto-yes'],
    });
  });

  it('no section', () => {
    expect(parseBugClassification('## 概要\n\n落ちる\n')).toEqual({ state: 'missing' });
    expect(parseBugClassification('')).toEqual({ state: 'missing' });
    // a section inside a code fence is not the Issue's own
    expect(parseBugClassification('```markdown\n' + section('#1', 'uat', 'chat') + '```\n')).toEqual({ state: 'missing' });
  });

  it('values outside the vocabulary', () => {
    expect(parseBugClassification(section('#3191', 'twitter', 'chat'))).toEqual({ state: 'invalid', fields: ['発見経路'] });
    expect(parseBugClassification(section('たぶん #3191', 'uat', 'chat'))).toEqual({ state: 'invalid', fields: ['原因の PR'] });
    expect(parseBugClassification(section('#3191', 'uat', 'chat, desktop'))).toEqual({ state: 'invalid', fields: ['影響する経路'] });
    expect(parseBugClassification(section('#3191', 'uat', 'chat, なし（内部）')).state).toBe('invalid');
    expect(parseBugClassification(section('上流（<CLI> <版>）', 'uat', 'chat')).state).toBe('invalid');
    expect(parseBugClassification('## 分類\n- 発見経路: uat\n')).toEqual({ state: 'invalid', fields: ['原因の PR', '影響する経路'] });
  });

  it('the section ends at the next heading; the last section wins', () => {
    const body = `${section('#1', 'uat', 'chat')}\n## 追記\n- 発見経路: twitter\n`;
    expect(parseBugClassification(body).state).toBe('classified');
    expect(parseBugClassification(`${section('#1', 'nope', 'chat')}\n${section('#2', 'uat', 'chat')}`)).toMatchObject({
      state: 'classified',
      cause: { kind: 'pr', pr: 2 },
    });
  });
});

describe('countBugFlow / bugFlowRates', () => {
  it('rates count classified Issues only', () => {
    const counts = countBugFlow([
      issue(1, section('#10', 'daily-use', 'chat')),
      issue(2, section('不明', 'uat', 'terminal')),
      issue(3, section('#11', 'review', 'なし（内部）'), ['bug', 'internal']),
      issue(4, section('#12', 'daily-use', 'なし（内部）'), ['bug', 'internal']),
      issue(5, '## 概要\n本文だけ'),
      issue(6, section('#13', 'twitter', 'chat')),
    ]);
    expect(counts).toEqual({
      total: 6,
      external: 4,
      classified: 4,
      invalid: 1,
      regression: 3,
      classifiedExternal: 2,
      reachedUsers: 1,
    });
    expect(bugFlowRates(counts)).toEqual({ regressionRate: 0.75, userReachRate: 0.5, classifiedRate: 0.667 });
  });

  it('a 0 denominator is null, not 0', () => {
    expect(bugFlowRates(countBugFlow([]))).toEqual({ regressionRate: null, userReachRate: null, classifiedRate: null });
    // only unfilled Issues: the regression / user-reach denominators are 0
    expect(bugFlowRates(countBugFlow([issue(1, ''), issue(2, '')]))).toEqual({
      regressionRate: null,
      userReachRate: null,
      classifiedRate: 0,
    });
    // only internal classified Issues: the user-reach denominator is 0
    const internalOnly = countBugFlow([issue(1, section('#1', 'uat', 'なし（内部）'), ['bug', 'internal'])]);
    expect(bugFlowRates(internalOnly)).toEqual({ regressionRate: 1, userReachRate: null, classifiedRate: 1 });
  });
});

describe('measureBugFlow', () => {
  const gh = (items: unknown[]) => JSON.stringify(items);

  it('counts the last 7 days and never makes a candidate', () => {
    const text = gh([
      { number: 1, body: section('#10', 'daily-use', 'chat'), labels: [{ name: 'bug' }], createdAt: '2026-10-03T12:00:00Z' },
      { number: 2, body: section('#11', 'uat', 'cli'), labels: [{ name: 'bug' }], createdAt: '2026-09-27T00:00:00Z' },
      // older than 7 days: not counted
      { number: 3, body: '', labels: [{ name: 'bug' }], createdAt: '2026-09-26T23:59:59Z' },
    ]);
    const measurement = measureBugFlow(text, NOW);
    expect(measurement).toMatchObject({ metricId: 'bug-flow', status: 'ok', value: 2, findings: {} });
    if (measurement.status !== 'ok') throw new Error('expected ok');
    expect(measurement.details).toMatchObject({ total: 2, external: 2, regressionRate: 1, userReachRate: 0.5, classifiedRate: 1 });

    const result = evaluateMetric(measurement, { measuredAt: '2026-10-03T00:00:00Z', value: 0, items: {} });
    expect(result).toMatchObject({ category: 'process', status: 'pass', value: 2, candidates: [] });
    expect(result.summary).toContain('bug 2 件');
    expect(buildQueue([result])).toEqual([]);
  });

  it('no Issues: rates are null in the details', () => {
    const measurement = measureBugFlow('[]', NOW);
    if (measurement.status !== 'ok') throw new Error('expected ok');
    expect(measurement.details).toMatchObject({ total: 0, regressionRate: null, userReachRate: null, classifiedRate: null });
    expect(evaluateMetric(measurement, null).summary).toContain('—');
  });

  it('unreadable gh output is a skip', () => {
    expect(measureBugFlow('not json', NOW)).toMatchObject({ metricId: 'bug-flow', status: 'skip' });
    expect(measureBugFlow('{"a":1}', NOW).status).toBe('skip');
    expect(parseBugIssues('[{"number":1}]')).toEqual([{ number: 1, body: '', labels: [], createdAt: '' }]);
  });
});
