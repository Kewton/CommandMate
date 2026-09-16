/**
 * Wording for the command-code print-gate warning (Issue #2576).
 *
 * Shared by the Schedules edit dialog note and the CMATE.md warnings banner so
 * the two surfaces cannot drift apart again. The wording says that the write
 * tools the agent calls *directly* are rejected, never that the run is
 * "read-only": `commandcode -p` gates the five tools an agent calls itself, and
 * a write routed through a sub-agent can still land (the 2026-09-12 run in
 * #2576 did exactly that). It names the five `--permission-mode` values rather
 * than saying "anything but `yolo`", because an empty cell runs with `--yolo`
 * (see `isCommandCodeDirectWriteToolsDenied`). It also avoids describing how
 * the run is recorded, which #2577 is changing.
 *
 * Why this is not in `locales/*`: #2576's task contract does not allow edits
 * there. The dictionary is keyed by `SupportedLocale`, so adding a language to
 * `SUPPORTED_LOCALES` fails tsc here until the entry is written. Moving it into
 * `locales/{en,ja}/schedule.json` (and dropping the now-unused
 * `schedule.edit.commandCodeReadOnlyNote`) is follow-up work.
 */

import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from '@/config/i18n-config';

export interface CommandCodeWriteToolsWarningText {
  /** Heading of the CMATE.md warnings banner */
  bannerTitle: string;
  /** The warning itself (dialog note and banner body) */
  body: string;
}

const TEXT: Record<SupportedLocale, CommandCodeWriteToolsWarningText> = {
  en: {
    bannerTitle: 'CMATE.md has schedules to check',
    body:
      'With a --permission-mode value as Permission (default / standard / plan / auto-accept / dont-ask), ' +
      'command-code print mode (`commandcode -p`) rejects the write tools the agent calls directly ' +
      '(edit_file / write_file / shell_command / monitor_command / kill_shell). ' +
      'This is a warning and does not stop the schedule from being saved or run. ' +
      'Set Permission to `yolo` if the task needs to write.',
  },
  ja: {
    bannerTitle: 'CMATE.md に確認が必要なスケジュールがあります',
    body:
      'Permission が --permission-mode の値（default / standard / plan / auto-accept / dont-ask）のとき、' +
      'command-code の print モード（`commandcode -p`）は、エージェントが直接呼ぶ書き込み系ツール' +
      '（edit_file / write_file / shell_command / monitor_command / kill_shell）を拒否します。' +
      'これは警告で、スケジュールの登録も実行も止めません。書き込みが必要な作業なら Permission を `yolo` にしてください。',
  },
};

/** Resolve the warning wording for a next-intl locale, falling back to the default locale. */
export function getCommandCodeWriteToolsWarningText(
  locale: string,
): CommandCodeWriteToolsWarningText {
  return TEXT[isSupportedLocale(locale) ? locale : DEFAULT_LOCALE];
}
