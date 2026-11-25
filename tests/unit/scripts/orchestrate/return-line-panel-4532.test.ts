/**
 * Issue #4532 (S10, review r4 P1-B) — the JS readers of the return line read a
 * row through the same normalization as the monitor (wait-verify.mjs
 * `normalizePaneLine`): claude 2.1.330's diff panel on the right
 * (`DONE: … exit 0      │ src/x.ts +12 -3`) and a one-line reply's marker
 * (`⏺ DONE: …`) no longer hide the line from wait-verify's completion signal
 * or launch-worker's ending report. The table that pins the bash and JS halves
 * to the same answers is tests/unit/skills/orchestrate-monitor/
 * pane-line-agreement-4532.test.ts; this file pins the two callers.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { endingOfAnswer } from '../../../../scripts/orchestrate/launch-worker.mjs';
import { hasCompletionSignal } from '../../../../scripts/orchestrate/wait-verify.mjs';

const HEAD = '00c08aaf7';
const DONE = `DONE: #4532 ${HEAD} verify exit 0`;
const PANEL = `${' '.repeat(36)}\u001b[38;5;244m│\u001b[39m src/x.ts +12 -3`;

describe('hasCompletionSignal reads the left column of a panel row (P1-B)', () => {
  it('a DONE naming this HEAD, followed by the panel, completes', () => {
    expect(hasCompletionSignal(`work\n${DONE}${PANEL}\n`, { head: `${HEAD}abc` })).toBe(true);
  });

  it('the legacy IMPL_COMPLETED head=<sha> followed by the panel completes', () => {
    expect(hasCompletionSignal(`IMPL_COMPLETED head=${HEAD}${PANEL}\n`, { head: `${HEAD}abc`, requireHead: true })).toBe(true);
  });

  it('negative control: a DONE only in the panel column, or naming another HEAD, does not complete', () => {
    expect(hasCompletionSignal(`working on it${PANEL.replace('src/x.ts +12 -3', DONE)}\n`)).toBe(false);
    expect(hasCompletionSignal(`${DONE.replace(HEAD, 'b'.repeat(9))}${PANEL}\n`, { head: `${HEAD}abc` })).toBe(false);
  });

  it('a one-line reply carrying a reply marker is read like its own row (lead r1)', () => {
    expect(hasCompletionSignal(`⏺ ${DONE}\n`, { head: `${HEAD}abc` })).toBe(true);
    expect(hasCompletionSignal(`⠶ IMPL_COMPLETED head=${HEAD}\n`, { head: `${HEAD}abc`, requireHead: true })).toBe(true);
  });

  it('negative control: the composer row and a doubled marker do not complete', () => {
    expect(hasCompletionSignal(`❯ ${DONE}\n`)).toBe(false);
    expect(hasCompletionSignal(`⏺⏺ ${DONE}\n`)).toBe(false);
  });

  it('negative control: requireHead still refuses a bare IMPL_COMPLETED, marker or not', () => {
    expect(hasCompletionSignal('⏺ IMPL_COMPLETED\n', { requireHead: true })).toBe(false);
  });
});

describe('endingOfAnswer reads a panel row and a marked row like the monitor (P1-B)', () => {
  function answer(rows: string[]): Record<string, unknown> {
    const text = rows.join('\n');
    return { isRunning: true, cliToolId: 'claude', content: text, realtimeSnippet: text, promptData: null };
  }

  it('DONE / WAIT followed by the panel: the line carries no panel text', () => {
    expect(endingOfAnswer(answer(['working', `${DONE}${PANEL}`]))).toEqual({ kind: 'DONE', line: DONE });
    expect(endingOfAnswer(answer([`WAIT: 人の判断が要る${PANEL}`]))).toEqual({ kind: 'WAIT', line: 'WAIT: 人の判断が要る' });
  });

  it('a one-line reply with the claude marker: IMPL_COMPLETED is named shape-outside, WAIT is a WAIT', () => {
    expect(endingOfAnswer(answer(['⏺ IMPL_COMPLETED']))).toEqual({ kind: 'SHAPE_OUTSIDE', line: 'IMPL_COMPLETED' });
    expect(endingOfAnswer(answer(['• WAIT: 人の判断が要る']))).toEqual({ kind: 'WAIT', line: 'WAIT: 人の判断が要る' });
  });

  it('the escaped form a capture --json carries, with the panel', () => {
    const escaped = `working\\n${DONE}${' '.repeat(36)}\\u001b[38;5;244m│\\u001b[39m src/x.ts +12 -3`;
    expect(endingOfAnswer({ content: escaped })).toEqual({ kind: 'DONE', line: DONE });
  });

  it('negative control: a DONE only in the panel column is not an ending', () => {
    expect(endingOfAnswer(answer([`working on it${PANEL.replace('src/x.ts +12 -3', DONE)}`])).kind).toBe('none');
  });
});
