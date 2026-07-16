/**
 * Unit-level i18n guard for the `review` namespace (Issue #1274).
 *
 * The global next-intl mock in tests/setup.ts echoes `namespace.key`, so a
 * component test can assert a Review label while the real dictionary has no
 * such entry. Only a real-dictionary assert like this proves the key resolves.
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key missing from one
 * locale surfaces the raw key path in production and would otherwise go
 * undetected.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadReview(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'review.json'), 'utf-8'));
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

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/**
 * Issue #1274: every key the Review screen resolves at runtime. Listed
 * explicitly so deleting one fails here rather than rendering `review.x.y`
 * verbatim to the user.
 */
const RUNTIME_KEYS = [
  'status.done',
  'status.inReview',
  'status.approval',
  'status.stalled',
  'filters.ariaLabel',
  'filters.loading',
  'empty.inReview',
  'empty.approval',
  'empty.stalled',
  'datePicker.previousDay',
  'datePicker.nextDay',
  'report.regenerateConfirm',
  'report.toolLabel',
  'report.modelPlaceholder',
  'report.generationMode',
  'report.modes.none',
  'report.modes.template',
  'report.modes.custom',
  'report.selectTemplate',
  'report.loadingTemplates',
  'report.noTemplates',
  'report.templatePlaceholderOption',
  'report.instructionPlaceholderTemplate',
  'report.instructionPlaceholderCustom',
  'report.generate',
  'report.generating',
  'report.noMessages',
  'report.messagesFound',
  'report.generatingRemote',
  'report.generatingRemoteWithTime',
  'report.generatingSummary',
  'report.generatedBy',
  'report.copy',
  'report.copied',
  'report.edit',
  'report.save',
  'report.saving',
  'report.errors.fetch',
  'report.errors.rateLimited',
  'report.errors.generate',
  'report.errors.emptyContent',
  'report.errors.save',
  'template.deleteConfirm',
  'template.heading',
  'template.loading',
  'template.empty',
  'template.edit',
  'template.delete',
  'template.save',
  'template.saving',
  'template.cancel',
  'template.newHeading',
  'template.namePlaceholder',
  'template.contentPlaceholder',
  'template.create',
  'template.creating',
  'template.errors.fetch',
  'template.errors.nameAndContentRequired',
  'template.errors.create',
  'template.errors.update',
  'template.errors.delete',
] as const;

/**
 * Issue #1274 migrated these from hardcoded JSX to the dictionary. The values
 * are the pre-migration English markup verbatim — i18n must not change what an
 * English user reads, so a diff here is a regression, not a wording tweak.
 */
const EN_PRE_MIGRATION: Record<string, string> = {
  'status.done': 'Done',
  'status.inReview': 'In Review',
  'status.approval': 'Approval',
  'status.stalled': 'Stalled',
  'filters.ariaLabel': 'Review filters',
  'filters.loading': 'Loading reviews',
  'empty.inReview': 'No worktrees in review.',
  'empty.approval': 'No worktrees waiting for approval.',
  'empty.stalled': 'No stalled worktrees detected.',
  'datePicker.previousDay': 'Previous day',
  'datePicker.nextDay': 'Next day',
  'report.toolLabel': 'Tool:',
  'report.modelPlaceholder': 'Model (optional)',
  'report.generationMode': 'Generation Mode',
  'report.modes.none': 'No instruction',
  'report.modes.template': 'Template',
  'report.modes.custom': 'Custom',
  'report.selectTemplate': 'Select Template',
  'report.loadingTemplates': 'Loading templates',
  'report.noTemplates': 'No templates available. Create one in the Template tab.',
  'report.templatePlaceholderOption': '-- Select a template --',
  'report.instructionPlaceholderTemplate': 'Select a template above to populate this field',
  'report.instructionPlaceholderCustom': 'Additional instructions for summary generation',
  'report.generate': 'Generate Summary',
  'report.generating': 'Generating...',
  'report.noMessages': 'No messages for this date.',
  'report.generatingSummary': 'Generating summary...',
  'report.copy': 'Copy',
  'report.copied': 'Copied!',
  'report.edit': 'Edit',
  'report.save': 'Save',
  'report.saving': 'Saving...',
  'report.errors.fetch': 'Failed to fetch report',
  'report.errors.rateLimited': 'Another summary is being generated. Please wait.',
  'report.errors.generate': 'Failed to generate summary',
  'report.errors.emptyContent': 'Content cannot be empty',
  'report.errors.save': 'Failed to save report',
  'template.loading': 'Loading templates',
  'template.empty': 'No templates yet.',
  'template.edit': 'Edit',
  'template.delete': 'Delete',
  'template.save': 'Save',
  'template.saving': 'Saving...',
  'template.cancel': 'Cancel',
  'template.newHeading': 'New Template',
  'template.namePlaceholder': 'Template name',
  'template.contentPlaceholder': 'Template content (instructions for report generation)',
  'template.create': 'Create Template',
  'template.creating': 'Creating...',
  'template.errors.fetch': 'Failed to fetch templates',
  'template.errors.nameAndContentRequired': 'Name and content are required',
  'template.errors.create': 'Failed to create template',
  'template.errors.update': 'Failed to update template',
  'template.errors.delete': 'Failed to delete template',
};

/**
 * Interpolated messages: the placeholders are the contract between the
 * dictionary and the t() call site. A renamed/dropped placeholder renders the
 * literal `{tool}` to the user, which no parity check would catch.
 */
const PLACEHOLDERS: Record<string, string[]> = {
  'report.messagesFound': ['{count}'],
  'report.generatingRemote': ['{tool}'],
  'report.generatingRemoteWithTime': ['{tool}', '{seconds}'],
  'report.generatedBy': ['{tool}'],
  'template.heading': ['{count}', '{max}'],
};

describe('review i18n keys (Issue #1274)', () => {
  it.each(['en', 'ja'])('%s/review.json has non-empty values for every leaf', (locale) => {
    const dict = loadReview(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolve(dict, key), `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    expect(leafKeys(loadReview('en')).sort()).toEqual(leafKeys(loadReview('ja')).sort());
  });

  it.each(['en', 'ja'])('%s defines every key the Review screen resolves', (locale) => {
    const dict = loadReview(locale);
    for (const key of RUNTIME_KEYS) {
      expect(resolve(dict, key), `${locale} missing ${key}`).toEqual(expect.any(String));
    }
  });

  it('keeps every English label byte-identical to the pre-i18n markup', () => {
    const en = loadReview('en');
    for (const [key, expected] of Object.entries(EN_PRE_MIGRATION)) {
      expect(resolve(en, key), `en: ${key} changed the rendered label`).toBe(expected);
    }
  });

  it('translates labels rather than leaving them in English', () => {
    const en = loadReview('en');
    const ja = loadReview('ja');
    for (const key of Object.keys(EN_PRE_MIGRATION)) {
      expect(resolve(ja, key), `ja: ${key} is still the English string`).not.toBe(resolve(en, key));
    }
  });

  it('keeps interpolation placeholders intact in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadReview(locale);
      for (const [key, placeholders] of Object.entries(PLACEHOLDERS)) {
        const value = resolve(dict, key) as string;
        for (const placeholder of placeholders) {
          expect(value, `${locale}: ${key} lost ${placeholder}`).toContain(placeholder);
        }
      }
    }
  });

  /**
   * ReviewCard and ReviewTab both read `status.*`, so the badge and the filter
   * chip cannot drift apart. Distinct labels also matter because the chip's
   * colour alone does not distinguish the filters.
   */
  it('gives every review status a distinct label in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadReview(locale);
      const labels = RUNTIME_KEYS.filter((k) => k.startsWith('status.')).map((k) =>
        resolve(dict, k)
      );
      expect(new Set(labels).size, `${locale}: two statuses share a label`).toBe(labels.length);
    }
  });
});
