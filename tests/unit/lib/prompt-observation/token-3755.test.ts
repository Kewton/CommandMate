/**
 * The observation token (Issue #3755): issued with an observation, verified by
 * the strict `respond` (#3756) against a fresh one. Every bound field must
 * break it when it moves, and it must stop verifying after its TTL.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  issueObservationToken,
  observationTokenExpiresAt,
  PROMPT_OBSERVATION_TOKEN_TTL_MS,
  verifyObservationToken,
  type ObservationTokenBinding,
} from '@/lib/prompt-observation/token';

const NOW = 1_800_000_000_000;

const BINDING: ObservationTokenBinding = {
  worktreeId: 'wt-1',
  cliToolId: 'antigravity',
  instanceId: 'antigravity-2',
  sessionName: 'mcbd-antigravity-wt-1-antigravity-2',
  sessionGeneration: NOW - 60_000,
  kind: 'antigravity-trust',
  question: 'Do you trust the contents of this project?',
  options: ['Yes, I trust this folder', 'No, exit'],
  approvalTarget: '/work/project',
};

describe('[#3755] observation token', () => {
  it('verifies against the same binding within its TTL', () => {
    const token = issueObservationToken(BINDING, NOW);
    expect(token).toMatch(/^po1\.[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyObservationToken(token, { ...BINDING, options: [...BINDING.options] }, NOW + 30_000)).toEqual({
      ok: true,
      issuedAt: NOW,
    });
  });

  it.each<[string, Partial<ObservationTokenBinding>]>([
    ['instance', { instanceId: 'antigravity' }],
    ['worktree', { worktreeId: 'wt-2' }],
    ['tool', { cliToolId: 'claude' }],
    ['session generation (a relaunch)', { sessionGeneration: NOW }],
    ['unknown generation', { sessionGeneration: null }],
    ['pane', { sessionName: 'mcbd-antigravity-wt-1' }],
    ['kind', { kind: 'antigravity-permission' }],
    ['question', { question: 'Do you want to proceed?' }],
    ['option labels', { options: ['Yes', 'No'] }],
    ['option order', { options: ['No, exit', 'Yes, I trust this folder'] }],
    ['approval target', { approvalTarget: '/work/other' }],
  ])('does not verify once the %s moved', (_name, change) => {
    const token = issueObservationToken(BINDING, NOW);
    expect(verifyObservationToken(token, { ...BINDING, ...change }, NOW + 1000)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('does not let one field bleed into another', () => {
    const a = issueObservationToken({ ...BINDING, question: 'a', approvalTarget: 'b c' }, NOW);
    expect(verifyObservationToken(a, { ...BINDING, question: 'a b', approvalTarget: 'c' }, NOW).ok).toBe(false);
  });

  it('expires after its TTL', () => {
    const token = issueObservationToken(BINDING, NOW);
    expect(observationTokenExpiresAt(NOW)).toBe(NOW + PROMPT_OBSERVATION_TOKEN_TTL_MS);
    expect(verifyObservationToken(token, BINDING, NOW + PROMPT_OBSERVATION_TOKEN_TTL_MS - 1).ok).toBe(true);
    expect(verifyObservationToken(token, BINDING, NOW + PROMPT_OBSERVATION_TOKEN_TTL_MS)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a token issued in the future', () => {
    const token = issueObservationToken(BINDING, NOW + 60_000);
    expect(verifyObservationToken(token, BINDING, NOW)).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('refuses a forged issue time (the MAC covers it)', () => {
    const token = issueObservationToken(BINDING, NOW);
    const [prefix, , mac] = token.split('.');
    const forged = `${prefix}.${(NOW + 100_000).toString(36)}.${mac}`;
    expect(verifyObservationToken(forged, BINDING, NOW + 200_000)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it.each(['', 'po1', 'po1..', 'po2.abc.' + 'A'.repeat(43), 'po1.ABC.' + 'A'.repeat(43), 'po1.abc.short'])(
    'calls %j malformed',
    (token) => {
      expect(verifyObservationToken(token, BINDING, NOW)).toEqual({ ok: false, reason: 'malformed' });
    },
  );
});
