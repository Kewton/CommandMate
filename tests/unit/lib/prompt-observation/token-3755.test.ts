/**
 * The observation token (Issue #3755): issued with an observation, verified by
 * the strict `respond` (#3756) against a fresh one. Every bound field must
 * break it when it moves, and it must stop verifying after its TTL.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  consumeObservationToken,
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
  screenAppearedAt: NOW - 5_000,
  kind: 'antigravity-trust',
  question: 'Do you trust the contents of this project?',
  options: ['Yes, I trust this folder', 'No, exit'],
  approvalTarget: '/work/project',
  selectedPosition: 1,
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
    ['appearance (the screen went away and came back)', { screenAppearedAt: NOW - 1_000 }],
    ['highlighted option (the cursor moved to No)', { selectedPosition: 2 }],
    ['highlighted option (none highlighted)', { selectedPosition: null }],
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

  it('refuses an overlong token before parsing it', () => {
    expect(verifyObservationToken('po1.' + 'a'.repeat(200), BINDING, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts only the spelling it issues (no leading zero, no altered unused MAC bits)', () => {
    const token = issueObservationToken(BINDING, NOW);
    const [prefix, at, mac] = token.split('.');
    // The last base64url character of a 32-byte MAC carries 2 unused bits.
    const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(mac[42]);
    const sibling = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[lastIndex ^ 1];
    expect(verifyObservationToken(`${prefix}.0${at}.${mac}`, BINDING, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyObservationToken(`${prefix}.${at}.${mac.slice(0, 42)}${sibling}`, BINDING, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('[#3755] consumeObservationToken (single use)', () => {
  it('verifies once, then refuses the same token as consumed', () => {
    const binding = { ...BINDING, worktreeId: 'wt-consume-1' };
    const token = issueObservationToken(binding, NOW);
    expect(consumeObservationToken(token, binding, NOW + 1000)).toEqual({ ok: true, issuedAt: NOW });
    expect(consumeObservationToken(token, binding, NOW + 2000)).toEqual({ ok: false, reason: 'consumed' });
    // Plain verification is unaffected: consumption is the answering path's.
    expect(verifyObservationToken(token, binding, NOW + 2000).ok).toBe(true);
  });

  it('does not use up a token that fails verification', () => {
    const binding = { ...BINDING, worktreeId: 'wt-consume-2' };
    const token = issueObservationToken(binding, NOW);
    expect(consumeObservationToken(token, { ...binding, selectedPosition: 2 }, NOW + 1000)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(consumeObservationToken(token, binding, NOW + 1000).ok).toBe(true);
  });

  it('refuses another observation\'s token of the same appearance once one was consumed', () => {
    const binding = { ...BINDING, worktreeId: 'wt-consume-3' };
    const t1 = issueObservationToken(binding, NOW);
    const t2 = issueObservationToken(binding, NOW + 2_000); // wait's next poll, same appearance
    expect(t2).not.toBe(t1);
    expect(consumeObservationToken(t1, binding, NOW + 3_000).ok).toBe(true);
    expect(consumeObservationToken(t2, binding, NOW + 4_000)).toEqual({ ok: false, reason: 'consumed' });
    // Also with the cursor moved: the same appearance is answered once.
    const t3 = issueObservationToken({ ...binding, selectedPosition: 2 }, NOW + 5_000);
    expect(consumeObservationToken(t3, { ...binding, selectedPosition: 2 }, NOW + 6_000)).toEqual({
      ok: false,
      reason: 'consumed',
    });
  });

  it('negative: a new appearance (the screen went away and came back) can be consumed', () => {
    const binding = { ...BINDING, worktreeId: 'wt-consume-4' };
    expect(consumeObservationToken(issueObservationToken(binding, NOW), binding, NOW + 1_000).ok).toBe(true);
    const reappeared = { ...binding, screenAppearedAt: NOW + 10_000 };
    const fresh = issueObservationToken(reappeared, NOW + 11_000);
    expect(consumeObservationToken(fresh, reappeared, NOW + 12_000)).toEqual({ ok: true, issuedAt: NOW + 11_000 });
  });

  it('negative: a token that fails verification consumes nothing for its appearance', () => {
    const binding = { ...BINDING, worktreeId: 'wt-consume-5' };
    const t1 = issueObservationToken(binding, NOW);
    expect(consumeObservationToken(t1, { ...binding, question: 'other' }, NOW + 1_000)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    const expired = issueObservationToken(binding, NOW - PROMPT_OBSERVATION_TOKEN_TTL_MS - 1);
    expect(consumeObservationToken(expired, binding, NOW + 1_000)).toEqual({ ok: false, reason: 'expired' });
    const t2 = issueObservationToken(binding, NOW + 500);
    expect(consumeObservationToken(t2, binding, NOW + 1_000).ok).toBe(true);
  });
});
