/**
 * The wording and the docs of Issue #4105 agree with the code.
 *
 *  - `badgePrompt` / `promptTitle` no longer say the requester WAS told: the
 *    `prompt` state is set when the notice is queued, not when it arrives.
 *  - Every new badge key exists in both dictionaries with the same
 *    placeholders.
 *  - The ja / en guides and the CLI's embedded docs describe
 *    `lastDeliveryBlock` / `blocked=`, and say that null is not "deliverable".
 *
 * Positive cases fail before the change; reading only, nothing is written.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import en from '../../../locales/en/worktree.json';
import ja from '../../../locales/ja/worktree.json';
import { AGENT_OPERATIONS_GUIDE } from '@/cli/docs/agent-operations';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const dictionaries: Array<[string, Record<string, string>]> = [
  ['en', (en as unknown as Record<string, Record<string, string>>).relay],
  ['ja', (ja as unknown as Record<string, Record<string, string>>).relay],
];

describe('relay wording (Issue #4105)', () => {
  it('the worker-prompt badge does not claim the requester was told', () => {
    const [, enRelay] = dictionaries[0];
    const [, jaRelay] = dictionaries[1];
    expect(jaRelay.badgePrompt).not.toContain('通知済み');
    expect(jaRelay.promptTitle).not.toContain('通知済み');
    expect(enRelay.badgePrompt).not.toMatch(/reported/i);
    expect(enRelay.promptTitle).not.toMatch(/has been told/);
    expect(enRelay.promptTitle).toMatch(/queued/);
  });

  it('every new key exists in both dictionaries with matching placeholders', () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of [
      'badgeBlockedByPrompt',
      'badgeBlockedByPromptMany',
      'blockedByPromptTitle',
      'stripBlockedByPrompt',
      'stripBlockedByPromptMany',
    ]) {
      const [enText, jaText] = dictionaries.map(([, d]) => d[key]);
      expect(typeof enText, key).toBe('string');
      expect(typeof jaText, key).toBe('string');
      expect(names(jaText), key).toEqual(names(enText));
    }
  });
});

describe('relay docs (Issue #4105)', () => {
  it.each([
    ['docs/user-guide/cli-operations-guide.md', '「配送できる」ではありません'],
    ['docs/en/user-guide/cli-operations-guide.md', 'does not mean "deliverable"'],
  ])('%s documents lastDeliveryBlock and blocked=', (file, notDeliverable) => {
    const text = read(file);
    expect(text).toContain('Issue #4105');
    expect(text).toContain('lastDeliveryBlock');
    expect(text).toContain('blocked=<');
    expect(text).toContain('prompt_waiting');
    expect(text).toContain(notDeliverable);
  });

  it('the embedded CLI docs say the prompt notice was queued, and explain blocked=', () => {
    expect(AGENT_OPERATIONS_GUIDE).not.toContain('the requester was told');
    expect(AGENT_OPERATIONS_GUIDE).toContain('blocked=<reason>@<time>');
  });
});
