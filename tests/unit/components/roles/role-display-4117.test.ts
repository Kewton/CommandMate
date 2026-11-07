/**
 * The wording of a role's state (Issue #4117), against the real dictionaries. Every
 * key of `agentRoles` used here also has to exist in both languages.
 */
import { describe, expect, it } from 'vitest';
import ja from '../../../../locales/ja/common.json';
import en from '../../../../locales/en/common.json';
import {
  effectiveRoleLabel,
  roleApplicationView,
  roleChoiceOf,
  roleInputOf,
  roleSourceText,
  roleToolNoteKeys,
  type RoleTranslate,
} from '@/components/roles/role-display';
import type { InstanceRoleEntry } from '@/types/agent-roles';
import { instanceSettingsExample } from '@tests/integration/fixtures/agent-roles-api-examples';
import { TOOL_DEFAULTS, launched } from './fake-role-server';

function translator(dictionary: unknown): RoleTranslate {
  return (key, values = {}) => {
    const template = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], dictionary);
    if (typeof template !== 'string') throw new Error(`no such key: ${key}`);
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  };
}

const tJa = translator(ja);
const tEn = translator(en);

function entry(application: Partial<InstanceRoleEntry['application']>, overrides: Partial<InstanceRoleEntry> = {}): InstanceRoleEntry {
  const template = instanceSettingsExample.instances[0];
  return { ...template, ...overrides, application: { ...template.application, ...application } };
}

const nextRole = { effectiveNext: { ...TOOL_DEFAULTS.codex, injectionFingerprint: null } };

describe('[#4117] where a value comes from', () => {
  it.each([
    ['claude', true, '継承中: マーケター［システム］', 'Inherited: マーケター [system]'],
    ['codex', true, '継承中: レビュー担当［リポジトリ］', 'Inherited: レビュー担当 [repository]'],
    ['opencode', true, '継承中: なし［リポジトリで明示］', 'Inherited: None [set on the repository]'],
    ['copilot', true, '継承中: なし［既定なし］', 'Inherited: None [no default]'],
    ['codex', false, '指定中: レビュー担当［リポジトリ］', 'Set: レビュー担当 [repository]'],
  ])('%s, inherited=%s', (tool, inherited, wordsJa, wordsEn) => {
    expect(roleSourceText(TOOL_DEFAULTS[tool], inherited, tJa)).toBe(wordsJa);
    expect(roleSourceText(TOOL_DEFAULTS[tool], inherited, tEn)).toBe(wordsEn);
  });

  it('an ambiguous answer has no label, only its reason and roots', () => {
    const ambiguous = TOOL_DEFAULTS['command-code'];
    expect(effectiveRoleLabel(ambiguous, tJa)).toBe('');
    expect(roleSourceText(ambiguous, true, tJa)).toContain('/repos/app (なし)');
    expect(
      roleSourceText({ ...ambiguous, reason: 'membership-undetermined' } as typeof ambiguous, true, tEn),
    ).toContain('git could not confirm');
  });
});

describe('[#4117] start and next', () => {
  it('pending comes from the server and nowhere else', () => {
    const view = roleApplicationView(entry({ ...nextRole, launched: launched({ roleName: 'PM' }), restartPending: 'yes' }), true, tJa);
    expect(view).toEqual({ text: '起動時: PM／次回: レビュー担当／適用待ち', restartable: true, pending: true });
    // Same fingerprint under another name: the server says no, so it is not pending.
    const same = roleApplicationView(entry({ ...nextRole, launched: launched({ roleName: 'PM' }), restartPending: 'no' }), true, tJa);
    expect(same).toEqual({ text: '起動時: PM', restartable: false, pending: false });
  });

  it('unknown stays unknown', () => {
    const view = roleApplicationView(entry({ ...nextRole, launched: null, restartPending: 'unknown' }), true, tEn);
    expect(view).toEqual({ text: 'At start: Unknown / Next: レビュー担当', restartable: true, pending: false });
  });

  it('a recorded launch with no role is "none", not "unknown"', () => {
    const view = roleApplicationView(
      entry({ ...nextRole, launched: launched({ roleName: null, roleId: null }), restartPending: 'yes' }),
      true,
      tJa,
    );
    expect(view?.text).toBe('起動時: なし／次回: レビュー担当／適用待ち');
  });

  it('a request that was never confirmed still shows as unknown when nothing is set now', () => {
    const view = roleApplicationView(
      entry({ launched: null, requested: launched({ phase: 'requested' }), restartPending: 'unknown' }),
      true,
      tJa,
    );
    expect(view?.text).toBe('起動時: 不明');
  });

  it('negative control: no role anywhere and a tool outside the roles say nothing', () => {
    expect(roleApplicationView(entry({ restartPending: 'unknown' }), true, tJa)).toBeNull();
    expect(roleApplicationView(entry({}), false, tJa)).toBeNull();
    expect(roleApplicationView(entry(nextRole, { supported: false }), true, tJa)).toBeNull();
  });

  it('the wording never claims "applied" in either language', () => {
    expect(JSON.stringify(ja.agentRoles)).not.toContain('適用済み');
    expect(JSON.stringify(en.agentRoles).toLowerCase()).not.toContain('applied');
  });
});

describe('[#4117] the three choices', () => {
  it('round-trips', () => {
    expect(roleChoiceOf({ state: 'inherit' })).toBe('inherit');
    expect(roleChoiceOf({ state: 'none' })).toBe('none');
    expect(roleChoiceOf({ state: 'role', roleId: 'abc', roleName: 'x' })).toBe('abc');
    expect(roleInputOf('inherit')).toEqual({ state: 'inherit' });
    expect(roleInputOf('none')).toEqual({ state: 'none' });
    expect(roleInputOf('abc')).toEqual({ state: 'role', roleId: 'abc' });
  });

  it('only OpenCode carries the persona note, and V2 its warning', () => {
    expect(roleToolNoteKeys('claude')).toEqual([]);
    expect(roleToolNoteKeys('opencode')).toEqual(['agentRoles.personaNote']);
    expect(roleToolNoteKeys('opencode-v2')).toContain('agentRoles.replacesDefaultNote');
    for (const key of roleToolNoteKeys('opencode-v2')) expect(tEn(key)).not.toBe('');
  });
});
