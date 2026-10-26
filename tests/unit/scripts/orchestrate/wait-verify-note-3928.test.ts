import { describe, it, expect } from 'vitest';
import { summarizeVerdict } from '../../../../scripts/orchestrate/wait-verify.mjs';

const row = (gateId: string, status: string, extra: Record<string, unknown> = {}) => ({ gateId, status, logTail: null, ...extra });

// unit ran once; the failing gate's echoed body repeats GATE lines (#3928).
const ECHOED = [
  'Verifying: wt-1 (run 12)',
  'GATE scope FAIL (exit=1, 0.1s)',
  'GATE unit PASS (exit=0, 5.0s)',
  'outside scope: src/x.ts',
  'GATE unit PASS (exit=0, 600.0s)',
  'RESULT failed',
  '',
].join('\n');

describe('summarizeVerdict gate list (#3928)', () => {
  it('stored run: each gate once, even when the log body echoes GATE lines', () => {
    const view = { gates: [row('scope', 'failed'), row('unit', 'passed')] };
    const v = summarizeVerdict(ECHOED, 20, view);
    expect(v.passed).toEqual(['unit']);
    expect(v.failed).toEqual(['scope:FAIL']);
    expect(v.line).toContain('passed=unit failed=scope:FAIL');
  });

  it('stored run: the gates come from the run, not from the log', () => {
    const view = { gates: [row('lint', 'passed'), row('unit', 'passed', { source: 'contract' })] };
    expect(summarizeVerdict(ECHOED, 0, view).passed).toEqual(['lint', 'unit@contract']);
  });

  it('log fallback: an id echoed twice is counted once', () => {
    const v = summarizeVerdict(ECHOED, 20, null);
    expect(v.passed).toEqual(['unit']);
    expect(v.line).not.toContain('unit,unit');
  });

  it('negative control: distinct gates keep their order, once each', () => {
    const log = 'GATE lint PASS (exit=0, 1s)\nGATE typecheck PASS (exit=0, 1s)\nGATE unit PASS (exit=0, 1s)\nRESULT passed\n';
    expect(summarizeVerdict(log, 0).line).toContain('passed=lint,typecheck,unit failed=-');
    const view = { gates: [row('lint', 'passed'), row('typecheck', 'passed'), row('unit', 'passed')] };
    expect(summarizeVerdict(log, 0, view).line).toContain('passed=lint,typecheck,unit failed=-');
  });
});
