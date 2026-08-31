/**
 * The cross-device dismissal UAT asks only for things the default log prints (#2133).
 *
 * ## Why this file exists
 *
 * A procedure whose pass condition cannot be observed is worse than a missing
 * one: the operator runs the step, finds nothing, and has to decide alone
 * whether "nothing" means pass or means broken. That is what happened on
 * 2026-08-29 — T-4 and T-6 asked for `resolution-push-skipped / reason: no-card`,
 * which `resolution-push-notifier` logs at `debug` on purpose, so the line is
 * structurally absent at the default level and both steps came back
 * "cannot mark as passed".
 *
 * #2133 resolved that in the procedure rather than in the logger (`no-card` and
 * `still-waiting` are the structural defaults — every Auto-Yes-answered wait
 * produces one — and promoting them would flood the log the operator is reading).
 * So the invariant is a documentation invariant, and nothing else in the suite
 * reads this file: without this test the doc half of the fix can be reverted with
 * the whole repository still green. Same shape, and same reason, as
 * `push-setup-docs-2123` and `guidance-url-matches-bind-2113`.
 *
 * The sender-side half — that the line really carries `worktreeId` — is
 * `tests/unit/push/fanout-attribution-2133.test.ts`, which also compares the
 * guides' sample against a real fan-out. This file is about the procedure.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const UAT = 'docs/qa/2001-cross-device-dismissal-uat.md';

function read(file: string): string {
  const abs = path.join(REPO_ROOT, file);
  expect(fs.existsSync(abs), `${file} is missing`).toBe(true);
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * The checklist items, each folded back together with its continuation lines.
 *
 * A bullet is the unit that matters here: the qualifier that makes a `no-card`
 * mention legitimate ("do not look for this") is usually on the line below the
 * `- [ ]`, so asserting line by line would flag the honest wording too.
 */
function checkboxes(markdown: string): string[] {
  const items: string[] = [];
  let open = false;
  for (const line of markdown.split('\n')) {
    if (/^- \[[ x]\]/.test(line)) {
      items.push(line);
      open = true;
    } else if (open && /^\s+\S/.test(line)) {
      items[items.length - 1] += `\n${line}`;
    } else {
      open = false;
    }
  }
  return items;
}

describe('the UAT procedure only asks for observable log lines (Issue #2133)', () => {
  it('never makes `reason: no-card` a pass condition without saying it is invisible', () => {
    // The exact defect #2133 was filed for. `no-card` may still be *named* — the
    // procedure has to explain why the reader should not go looking for it — but
    // a bullet that names it and does not say it is absent is an unpassable step.
    const offenders = checkboxes(read(UAT))
      .filter((item) => item.includes('no-card'))
      .filter((item) => !/出力されない|見えない|探さないこと/.test(item));

    expect(offenders, `unobservable expectations:\n${offenders.join('\n---\n')}`).toEqual([]);
  });

  it('tells the reader to count fan-outs filtered by worktreeId', () => {
    // The replacement criterion. Counting `push-fanout-complete` unfiltered is
    // how a neighbouring worktree's notification gets read as your own, which is
    // the other half of the same Issue.
    const text = read(UAT);
    expect(text).toContain('push-fanout-complete');
    expect(text).toMatch(/worktreeId[^\n]*で絞|で絞[^\n]*worktreeId/);
  });

  it('does not describe #2133 as still pending', () => {
    // The pre-fix note said "do not count `push-fanout-complete` alone — Issue
    // #2133", i.e. the step was blocked on this change. Leaving that in after the
    // change lands tells the operator to skip a check that now works.
    expect(read(UAT)).not.toMatch(/#2133[^\n]*(整備中|待ち|未対応|未実装)/);
  });

  it('keeps the debug-level sample marked as not printed by default', () => {
    // §1 shows a `[DEBUG] resolution-push-skipped … no-card` line as an example
    // of what to expect. It is honest only while the surrounding text says the
    // default level does not print it.
    const text = read(UAT);
    const sampleIndex = text.indexOf('[DEBUG] [push/resolution] resolution-push-skipped');
    expect(sampleIndex, 'the debug sample line is gone; update this test with it').toBeGreaterThan(
      -1
    );
    expect(text.slice(sampleIndex, sampleIndex + 600)).toMatch(/既定設定では出ません|CM_LOG_LEVEL=debug/);
  });
});

describe('the user guides describe the fan-out line as it is emitted (Issue #2133)', () => {
  it.each([
    { lang: 'ja', file: 'docs/user-guide/webapp-guide.md' },
    { lang: 'en', file: 'docs/en/user-guide/webapp-guide.md' },
  ])('$file ($lang) shows worktreeId and explains filtering by it', ({ file }) => {
    // The shape of the sample is checked against a real fan-out in
    // `tests/unit/push/fanout-attribution-2133.test.ts`; what is checked here is
    // that the guide actually teaches the filter, which is the operational point.
    const text = read(file);
    expect(text).toMatch(/push-fanout-complete \{[^\n]*"worktreeId"/);
    expect(text).toMatch(/grep[^\n]*"worktreeId"/);
  });
});
