/**
 * Unit-level i18n parity test for the `home` namespace (Issue #1072).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale would surface the raw key string in production and go undetected.
 * This test enforces full deep-key parity for the `home` namespace across
 * en / ja, mirroring the existing command-palette-keys parity test.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadHome(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'home.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Collect all dot-joined leaf key paths from a nested object. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

describe('home i18n keys (Issue #1072)', () => {
  it.each(['en', 'ja'])('%s/home.json has non-empty values for every leaf', (locale) => {
    const dict = loadHome(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dict);
      expect(value, `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadHome('en')).sort();
    const ja = leafKeys(loadHome('ja')).sort();
    expect(en).toEqual(ja);
  });

  /**
   * Issue #1199: OnboardingChecklist resolves these at
   * runtime. Same rationale as the block above — the echoing next-intl mock
   * makes component tests blind to a missing dictionary entry.
   */
  it('includes the onboarding checklist keys', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of [
        'onboarding.title',
        'onboarding.dismiss',
        'onboarding.steps.registerRepository',
        'onboarding.steps.sendFirstMessage',
        'onboarding.actions.registerRepository',
        'onboarding.actions.sendFirstMessage',
      ]) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });

  /**
   * Issue #1274: AssistantChatPanel / AssistantMessageList /
   * AssistantMessageInput resolve these at runtime. Same
   * rationale as the blocks above — the echoing next-intl mock makes component
   * tests blind to a missing dictionary entry.
   */
  it('includes the assistant panel keys', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of [
        'assistant.repositoryLabel',
        'assistant.cliLabel',
        'assistant.noRepositories',
        'assistant.toolNotInstalled',
        'assistant.start',
        'assistant.starting',
        'assistant.stop',
        'assistant.stopping',
        'assistant.startDirectory',
        'assistant.startDirectoryHint',
        'assistant.history',
        'assistant.clearHistory',
        'assistant.clearing',
        'assistant.loadingConversation',
        'assistant.inputPlaceholder',
        'assistant.inputPlaceholderWaiting',
        'assistant.inputPlaceholderNoSession',
        'assistant.working',
        'assistant.emptyState',
        'assistant.thinking',
        'assistant.input.defaultPlaceholder',
        'assistant.input.send',
        'assistant.message.you',
        'assistant.message.sending',
        'assistant.message.sent',
        'assistant.message.failed',
        'assistant.message.cancel',
        'assistant.message.saveAndResend',
        'assistant.message.resending',
        'assistant.message.edit',
        'assistant.message.editMessage',
        'assistant.message.editAndResend',
        'assistant.errors.loadConversation',
        'assistant.errors.startSession',
        'assistant.errors.stopSession',
        'assistant.errors.clearHistory',
        'assistant.errors.sendMessage',
        'assistant.errors.notReadyToResend',
        'assistant.errors.resubmitMessage',
      ]) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });

  /**
   * Issue #1274: i18n must not change what an English user reads, so these are
   * the pre-migration English markup verbatim. A diff is a regression, not a
   * wording tweak.
   */
  it('keeps every English label byte-identical to the pre-i18n markup', () => {
    const en = loadHome('en');
    const expected: Record<string, string> = {
      'assistant.repositoryLabel': 'Repository to Work In',
      'assistant.cliLabel': 'Assistant CLI',
      'assistant.noRepositories': 'No repositories',
      'assistant.start': 'Start',
      'assistant.starting': 'Starting...',
      'assistant.stop': 'Stop',
      'assistant.stopping': 'Stopping...',
      'assistant.startDirectoryHint':
        'Select the repository used as the assistant session start directory.',
      'assistant.history': 'History',
      'assistant.clearHistory': 'Clear history',
      'assistant.clearing': 'Clearing...',
      'assistant.loadingConversation': 'Loading conversation',
      'assistant.inputPlaceholder': 'Type your message... (Enter to send)',
      'assistant.inputPlaceholderWaiting': 'Waiting for the current run to finish',
      'assistant.inputPlaceholderNoSession': 'Start a session first',
      'assistant.working': 'Assistant is working...',
      'assistant.emptyState':
        'Select a repository and click Start to open an assistant session.',
      'assistant.input.defaultPlaceholder': 'Type your message...',
      'assistant.input.send': 'Send message',
      'assistant.message.you': 'You',
      'assistant.message.sending': 'Sending',
      'assistant.message.sent': 'Sent',
      'assistant.message.failed': 'Failed',
      'assistant.message.cancel': 'Cancel',
      'assistant.message.saveAndResend': 'Save & Resend',
      'assistant.message.resending': 'Resending...',
      'assistant.message.edit': 'Edit',
      'assistant.message.editMessage': 'Edit message',
      'assistant.message.editAndResend': 'Edit and resend',
      'assistant.errors.loadConversation': 'Failed to load conversation',
      'assistant.errors.startSession': 'Failed to start session',
      'assistant.errors.stopSession': 'Failed to stop session',
      'assistant.errors.clearHistory': 'Failed to clear history',
      'assistant.errors.sendMessage': 'Failed to send message',
      'assistant.errors.notReadyToResend': 'Session is not ready to resend messages',
      'assistant.errors.resubmitMessage': 'Failed to resubmit message',
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], en);
      expect(actual, `en: ${key} changed the rendered label`).toBe(value);
    }
  });

  /**
   * Issue #1274: key parity only proves ja *has* an entry, not that anyone
   * translated it — a copy-paste of the English value passes every other check
   * here and ships English text to a Japanese user.
   */
  it('translates every label rather than leaving it in English', () => {
    const en = loadHome('en');
    const ja = loadHome('ja');
    for (const key of leafKeys(en)) {
      const enValue = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], en);
      const jaValue = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], ja);
      expect(jaValue, `ja: ${key} is still the English string`).not.toBe(enValue);
    }
  });

  /**
   * Issue #1274: the placeholders are the contract between the dictionary and
   * the t() call site. A renamed placeholder renders a literal `{count}` to
   * the user, which no parity check would catch.
   */
  it('keeps interpolation placeholders intact in both locales', () => {
    const placeholders: Record<string, string[]> = {
      'assistant.toolNotInstalled': ['{name}'],
      'assistant.startDirectory': ['{repository}', '{path}'],
      'assistant.thinking': ['{label}'],
    };
    for (const locale of ['en', 'ja']) {
      const dict = loadHome(locale);
      for (const [key, expected] of Object.entries(placeholders)) {
        const value = key
          .split('.')
          .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dict) as string;
        for (const placeholder of expected) {
          expect(value, `${locale}: ${key} lost ${placeholder}`).toContain(placeholder);
        }
      }
    }
  });
});
