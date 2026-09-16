/**
 * Tests for the shared command-code print-gate warning wording (Issue #2576)
 *
 * The dialog note and the CMATE.md banner both render this text, so the
 * wording rules are pinned here once, for every supported locale.
 */

import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';
import { COMMAND_CODE_PERMISSIONS } from '@/config/schedule-config';
import { COMMAND_CODE_PRINT_GATED_TOOLS } from '@/lib/cmate-validator';
import { getCommandCodeWriteToolsWarningText } from '@/components/worktree/schedules/command-code-write-tools-warning';

describe('getCommandCodeWriteToolsWarningText', () => {
  describe.each(SUPPORTED_LOCALES)('locale %s', (locale) => {
    const { bannerTitle, body } = getCommandCodeWriteToolsWarningText(locale);

    it('has a banner title and a body', () => {
      expect(bannerTitle.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    });

    it('names every tool the print gate rejects', () => {
      for (const tool of COMMAND_CODE_PRINT_GATED_TOOLS) {
        expect(body).toContain(tool);
      }
    });

    // The judgment is "one of the five modes", and an empty cell runs with
    // `--yolo`. Wording that says "anything but yolo" would contradict it.
    it('names the five --permission-mode values instead of saying "anything but yolo"', () => {
      for (const permission of COMMAND_CODE_PERMISSIONS) {
        expect(body).toContain(permission);
      }
      expect(body).not.toMatch(/yolo`?\s*以外|(other than|anything but|except|not) `?yolo/i);
    });

    // A write routed through a sub-agent can still land, so the run is not
    // read-only -- only the directly-called write tools are rejected.
    it('does not claim the run is read-only', () => {
      expect(body.toLowerCase()).not.toContain('read-only');
      expect(body).not.toContain('読み取り専用');
    });
  });

  it('says "directly" in both locales', () => {
    expect(getCommandCodeWriteToolsWarningText('en').body).toContain('calls directly');
    expect(getCommandCodeWriteToolsWarningText('ja').body).toContain('エージェントが直接呼ぶ');
  });

  // It is a warning: saving and running go ahead. Wording that stops at "rejects
  // the write tools" reads like the schedule is refused.
  it('says it does not stop the schedule from being saved or run, in both locales', () => {
    expect(getCommandCodeWriteToolsWarningText('en').body).toContain(
      'does not stop the schedule from being saved or run',
    );
    expect(getCommandCodeWriteToolsWarningText('ja').body).toContain('登録も実行も止めません');
  });

  it('falls back to the default locale for an unsupported one', () => {
    expect(getCommandCodeWriteToolsWarningText('fr')).toEqual(getCommandCodeWriteToolsWarningText('en'));
  });
});
