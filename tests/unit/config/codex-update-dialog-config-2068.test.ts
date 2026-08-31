/**
 * Issue #2068 — the update-dialog policy, as a value.
 *
 * The four policies, the key each sends, and the resolution order. Kept apart
 * from the tool test because this half has no tmux in it at all: it is a pure
 * function over an environment, and the thing most likely to go wrong with it
 * is a typo in an operator's shell export being read as a decision.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  CODEX_UPDATE_DIALOG_ENV_VAR,
  CODEX_UPDATE_DIALOG_KEYS,
  CODEX_UPDATE_DIALOG_POLICIES,
  DEFAULT_CODEX_UPDATE_DIALOG_POLICY,
  codexUpdateDialogAnswerKey,
  isCodexUpdateDialogPolicy,
  normalizeCodexUpdateDialogPolicy,
  resolveCodexUpdateDialogPolicy,
  type CodexUpdateDialogPolicy,
} from '@/config/codex-update-dialog-config';

/** An environment with nothing set, so `process.env` can never leak in. */
const EMPTY_ENV: Record<string, string | undefined> = {};

describe('[#2068] the policy vocabulary', () => {
  it('is exactly the four values the Issue names', () => {
    expect([...CODEX_UPDATE_DIALOG_POLICIES]).toEqual([
      'skip',
      'skip-until-next-version',
      'update',
      'ask',
    ]);
  });

  it('maps each policy to codex’s own option number, and `ask` to nobody', () => {
    expect(codexUpdateDialogAnswerKey('skip')).toBe('2');
    expect(codexUpdateDialogAnswerKey('skip-until-next-version')).toBe('3');
    expect(codexUpdateDialogAnswerKey('update')).toBe('1');
    expect(codexUpdateDialogAnswerKey('ask')).toBeNull();
  });

  it('has a key for every policy — a new one cannot be added without an answer', () => {
    for (const policy of CODEX_UPDATE_DIALOG_POLICIES) {
      expect(Object.prototype.hasOwnProperty.call(CODEX_UPDATE_DIALOG_KEYS, policy)).toBe(true);
    }
    expect(Object.keys(CODEX_UPDATE_DIALOG_KEYS).sort()).toEqual(
      [...CODEX_UPDATE_DIALOG_POLICIES].sort()
    );
  });

  it('defaults to the one key that persists', () => {
    // Measured on codex-cli 0.149.1 (2026-08-31, isolated CODEX_HOME):
    // '2' leaves `dismissed_version: null` and the dialog returns on the very
    // next launch; '3' writes `dismissed_version: "0.151.0"` and it does not.
    expect(DEFAULT_CODEX_UPDATE_DIALOG_POLICY).toBe('skip-until-next-version');
    expect(codexUpdateDialogAnswerKey(DEFAULT_CODEX_UPDATE_DIALOG_POLICY)).toBe('3');
  });

  it('never defaults to the key that quits codex', () => {
    expect(DEFAULT_CODEX_UPDATE_DIALOG_POLICY).not.toBe('update');
  });
});

describe('[#2068] normalizeCodexUpdateDialogPolicy', () => {
  it('accepts every policy verbatim', () => {
    for (const policy of CODEX_UPDATE_DIALOG_POLICIES) {
      expect(normalizeCodexUpdateDialogPolicy(policy)).toBe(policy);
    }
  });

  it('accepts what an operator actually types into a shell export', () => {
    expect(normalizeCodexUpdateDialogPolicy('  Update ')).toBe('update');
    expect(normalizeCodexUpdateDialogPolicy('ASK')).toBe('ask');
    expect(normalizeCodexUpdateDialogPolicy('Skip-Until-Next-Version')).toBe(
      'skip-until-next-version'
    );
  });

  it('refuses anything else rather than guessing', () => {
    // `updates` must NOT be read as `update`: the difference is whether a
    // session start runs `npm install -g` on the operator's machine.
    for (const bad of ['updates', 'skip-until', 'yes', '1', '', '   ', null, undefined, 3, {}]) {
      expect(normalizeCodexUpdateDialogPolicy(bad)).toBeNull();
    }
  });

  it('agrees with the type guard', () => {
    expect(isCodexUpdateDialogPolicy('ask')).toBe(true);
    expect(isCodexUpdateDialogPolicy('ASK')).toBe(false);
    expect(isCodexUpdateDialogPolicy('nope')).toBe(false);
  });
});

describe('[#2068] resolveCodexUpdateDialogPolicy', () => {
  it('is the default when nothing is configured', () => {
    expect(resolveCodexUpdateDialogPolicy({ env: EMPTY_ENV })).toBe(
      DEFAULT_CODEX_UPDATE_DIALOG_POLICY
    );
  });

  it('takes the environment when it names a policy', () => {
    for (const policy of CODEX_UPDATE_DIALOG_POLICIES) {
      expect(
        resolveCodexUpdateDialogPolicy({
          env: { [CODEX_UPDATE_DIALOG_ENV_VAR]: policy },
        })
      ).toBe(policy);
    }
  });

  it('falls back to the default on an unrecognised environment value', () => {
    // Fail SAFE, not silent: a typo must not become `update`.
    expect(
      resolveCodexUpdateDialogPolicy({ env: { [CODEX_UPDATE_DIALOG_ENV_VAR]: 'updat' } })
    ).toBe(DEFAULT_CODEX_UPDATE_DIALOG_POLICY);
  });

  it('lets the instance setting win over the environment', () => {
    const env = { [CODEX_UPDATE_DIALOG_ENV_VAR]: 'skip' };
    expect(resolveCodexUpdateDialogPolicy({ env, instanceSetting: 'ask' })).toBe('ask');
    // …but only when the instance setting says something usable.
    expect(resolveCodexUpdateDialogPolicy({ env, instanceSetting: 'nonsense' })).toBe('skip');
    expect(resolveCodexUpdateDialogPolicy({ env, instanceSetting: null })).toBe('skip');
  });

  it('always returns a policy, never null', () => {
    const resolved: CodexUpdateDialogPolicy = resolveCodexUpdateDialogPolicy({ env: EMPTY_ENV });
    expect(CODEX_UPDATE_DIALOG_POLICIES).toContain(resolved);
  });
});
