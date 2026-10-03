/**
 * Issue #3046: the release-readiness HTML — self-contained, both colour
 * schemes, everything from outside escaped, "依頼なし" on an empty day.
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  markdownToHtml,
  renderReleaseReadinessHtml,
  type ReleaseReadinessModel,
} from '@/lib/agent-health/release-readiness-html';
import { decideReadiness } from '@/lib/agent-health/release-readiness';

function model(overrides: Partial<ReleaseReadinessModel> = {}): ReleaseReadinessModel {
  return {
    date: '2026-10-01',
    generatedAt: '2026-10-01T10:00:00.000Z',
    repo: 'Kewton/CommandMate',
    decision: decideReadiness({
      developCi: 'success',
      mergedToday: [],
      audit: { current: null, atLastRelease: null },
      dispatchStatus: null,
      dispatched: [],
      prLookupOk: true,
      deferred: [],
    }),
    developCi: { state: 'success', ref: 'origin/develop', sha: 'b104f8e74b2e', runsUrl: null },
    release: { tag: 'v0.43.0', commitsSince: 3, fragments: [{ file: '3046.md', entry: '**feat: x** (#3046): y' }] },
    dispatch: null,
    dispatched: [],
    mergedToday: [],
    audit: { current: null, atLastRelease: null, source: '' },
    metrics: { rows: null, todayFile: null, previousDayDate: null, releaseDate: null },
    openIssues: [],
    findings: null,
    summaries: [],
    collectionErrors: [],
    ...overrides,
  };
}

describe('renderReleaseReadinessHtml', () => {
  it('is one file with no external resources and a dark-mode palette', () => {
    const html = renderReleaseReadinessHtml(model());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/<(script|link|img)\b/);
    expect(html).not.toMatch(/src=|@import|url\(/);
  });

  it('shows the verdict banner with its reasons and "依頼なし" on an empty day', () => {
    const html = renderReleaseReadinessHtml(model());
    expect(html).toContain('<section class="banner go"');
    expect(html).toContain('<div class="verdict">GO</div>');
    expect(html).toContain('develop HEAD の CI は緑');
    expect(html).toContain('依頼なし');
    expect(html).toContain('v0.43.0');
    expect(html).toContain('3046.md');
  });

  it('renders the dispatched table', () => {
    const html = renderReleaseReadinessHtml(
      model({
        dispatch: { schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [], deferred: [3052] },
        dispatched: [
          {
            number: 3050,
            kind: 'bug',
            title: 'codex <screen>',
            agent: 'claude (opus)',
            pr: { number: 3060, url: 'https://github.com/o/r/pull/3060', state: 'MERGED' },
            ci: 'success',
            verifyExit: 20,
            merged: true,
            mergedAt: null,
            commit: '0123456789abcdef',
            agentHealthKey: 'agent-health:codex:screen-idle',
            reproducedFail: true,
          },
        ],
      })
    );
    expect(html).toContain('codex &lt;screen&gt;');
    expect(html).toContain('claude (opus)');
    expect(html).toContain('href="https://github.com/o/r/pull/3060"');
    expect(html).toContain('exit 20');
    expect(html).toContain('01234567');
    expect(html).toContain('develop で fail 再現');
    expect(html).toContain('/issues/3052');
  });

  it('escapes findings and never links non-http URLs', () => {
    const html = renderReleaseReadinessHtml(
      model({
        findings: { source: 'f.md', markdown: '# Title\n<script>alert(1)</script>\n[x](javascript:alert(1))' },
        mergedToday: [{ number: 1, title: 't', url: 'javascript:alert(1)', checks: 'failure' }],
      })
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
});

describe('markdownToHtml', () => {
  it('renders headings, lists, tables and code', () => {
    const html = markdownToHtml(
      ['## 結果', '', '- **a** `b`', '- c', '', '| x | y |', '|---|---|', '| 1 | 2 |', '', '```', '<x>', '```', 'para'].join('\n')
    );
    expect(html).toContain('<h5>結果</h5>');
    expect(html).toContain('<li><strong>a</strong> <code>b</code></li>');
    expect(html).toContain('<th>x</th>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<pre><code>&lt;x&gt;</code></pre>');
    expect(html).toContain('<p>para</p>');
  });

  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
