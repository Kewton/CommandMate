/**
 * The settings copy is action-based, in both locales (Issue #2000).
 *
 * `notifications.types.*` labels the two stored toggles. Before #2000 they were
 * named after agent events ("Prompt waiting" / "Session complete"), which is
 * exactly the axis the Epic re-cut: the reader has to be able to tell, from the
 * switch, whether turning it off will cost them something they have to act on.
 *
 * These are guards rather than prose review, so they pin the two things a
 * regression would actually break:
 *
 *  1. the pre-#2000 event-based wording does not come back;
 *  2. the copy states the facts the adjudication made the UI responsible for —
 *     what the action bucket now covers, and that completions are off by
 *     default on a newly registered device (an existing device keeps its own
 *     setting and has to be told it can turn it off here).
 *
 * Read from the real dictionaries, not through next-intl: tests/setup.ts mocks
 * next-intl globally, so a component-level assertion would pass on key strings.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadNotifications(locale: string): Record<string, Record<string, string> | string> {
  const filePath = path.join(LOCALES_DIR, locale, 'notifications.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
    string,
    Record<string, string> | string
  >;
}

function types(locale: string): Record<string, string> {
  return loadNotifications(locale).types as Record<string, string>;
}

const TYPE_KEYS = ['heading', 'promptWaiting', 'promptWaitingDesc', 'completion', 'completionDesc'];

/** The exact strings #2000 replaced. Their return would undo the Issue. */
const PRE_2000_WORDING: Record<string, string[]> = {
  ja: ['応答待ち', 'エージェントがあなたの応答を待っているとき', 'セッション完了', 'エージェントがセッションを完了したとき'],
  en: ['Prompt waiting', 'When an agent is waiting for your reply', 'Session complete', 'When an agent finishes a session'],
};

describe('notifications.types copy (Issue #2000)', () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(`locale: ${locale}`, () => {
      it('defines every key as a non-empty string', () => {
        const dict = types(locale);
        for (const key of TYPE_KEYS) {
          expect(typeof dict[key], `notifications.types.${key} missing in ${locale}`).toBe('string');
          expect(dict[key].trim().length).toBeGreaterThan(0);
        }
      });

      it('no longer names the toggles after agent events', () => {
        const dict = types(locale);
        for (const stale of PRE_2000_WORDING[locale] ?? []) {
          // `toBe`, not `toContain`: the new copy legitimately mentions waiting
          // for a reply as one of several things in the bucket. What must not
          // survive is a LABEL that is only the event.
          expect(dict.promptWaiting).not.toBe(stale);
          expect(dict.promptWaitingDesc).not.toBe(stale);
          expect(dict.completion).not.toBe(stale);
          expect(dict.completionDesc).not.toBe(stale);
        }
      });

      it('is translated rather than copied from the other locale', () => {
        for (const key of TYPE_KEYS) {
          expect(types('ja')[key], `notifications.types.${key} is untranslated in ja`).not.toBe(
            types('en')[key]
          );
        }
      });
    });
  }

  it('says what the action bucket now covers, in both locales', () => {
    // The four signals of the "you need to act" bucket. A reader deciding
    // whether to switch it off has to see that it is more than prompts.
    expect(types('ja').promptWaitingDesc).toContain('応答待ち');
    expect(types('ja').promptWaitingDesc).toContain('不合格');
    expect(types('ja').promptWaitingDesc).toContain('上流');
    expect(types('ja').promptWaitingDesc).toContain('起動');

    const en = types('en').promptWaitingDesc.toLowerCase();
    expect(en).toContain('prompt');
    expect(en).toContain('verification');
    expect(en).toContain('upstream');
    expect(en).toContain('start');
  });

  it('tells the reader completions are optional and off for new devices', () => {
    expect(types('ja').completion).toContain('任意');
    expect(types('ja').completionDesc).toContain('既定でオフ');

    expect(types('en').completion.toLowerCase()).toContain('optional');
    expect(types('en').completionDesc.toLowerCase()).toContain('off by default');
  });

  it('carries the same shift into the card description', () => {
    expect(loadNotifications('ja').description as string).toContain('対応が必要');
    expect((loadNotifications('en').description as string).toLowerCase()).toContain('needs you');
  });
});
