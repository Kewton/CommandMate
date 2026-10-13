/**
 * The dialog's strings exist in both locales, including one reason per
 * failure kind (Issue #3511).
 */

import { describe, it, expect } from 'vitest';
import en from '../../../../locales/en/common.json';
import ja from '../../../../locales/ja/common.json';
import type { NewTaskFailureKind } from '@/lib/new-task/send-new-task';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

const FAILURE_KINDS: Record<NewTaskFailureKind, true> = {
  auto_yes_failed: true,
  prompt_waiting: true,
  conflict: true,
  starting: true,
  start_failed: true,
  model_rejected: true,
  invalid: true,
  failed: true,
};

describe('[#3511] common.newTask strings', () => {
  it('has the same keys in en and ja', () => {
    expect(keyPaths(ja.newTask).sort()).toEqual(keyPaths(en.newTask).sort());
  });

  it('names every failure kind', () => {
    for (const messages of [en, ja]) {
      expect(Object.keys(messages.newTask.errors).sort()).toEqual(Object.keys(FAILURE_KINDS).sort());
    }
  });

  it('says a stopped agent will be started', () => {
    expect(ja.newTask.willStart).toBe('{agent} を起動して送ります。');
    expect(en.newTask.willStart).toContain('{agent}');
  });
});
