/**
 * Slash-command catalog drift report — parser + tracking-issue formatter (Issue #1705)
 *
 * `scripts/refresh-slash-command-catalog.ts --check` is fail-soft by design: it
 * exits 0 whether it found 104 missing commands or could not reach a single
 * source. Exit code therefore carries no signal, and the weekly drift workflow
 * has to read the *report* instead. This module owns that reading so the
 * regexes are unit-tested against real captured output rather than guessed at
 * inside a YAML `run:` block.
 *
 * Three verdicts, deliberately distinct:
 *   drift        — the reconcile would add N > 0 commands.
 *   clean        — it would add nothing and every source was actually compared.
 *   inconclusive — a source was skipped/unreachable/shape-changed, the runner
 *                  crashed, or the report did not have the shape we parse. NOT
 *                  the same as "clean": reporting 0 for an unchecked source is
 *                  exactly how an outage stays green for months.
 *
 * Nothing here is imported by the app runtime; it is CI/CLI tooling only.
 */

export type CatalogCheckStatus = 'drift' | 'clean' | 'inconclusive';

export interface CatalogCheckNoticeGroup {
  /** Reconcile notice category, e.g. `removed-row` / `description-conflict`. */
  category: string;
  count: number;
}

export interface CatalogCheckReport {
  status: CatalogCheckStatus;
  /** Commands the reconcile would add; null when the report did not state it. */
  newCount: number | null;
  /** Verbatim `+ [tool] /name — description` lines, without the `+ `. */
  newCommands: string[];
  /** Every warning line, without the `! `. */
  warnings: string[];
  /** Warnings on the known-state allowlist (see IGNORED_WARNING_PREFIXES). */
  ignoredWarnings: string[];
  /** Warnings that mean a source was not really compared → inconclusive. */
  blockingWarnings: string[];
  noticeGroups: CatalogCheckNoticeGroup[];
  /** Total rows the reconcile refused pending human review. */
  needsReviewCount: number;
  /** `codex: 0.146.0 -> 0.146.1` style stamp updates, without the `~ `. */
  verifiedAgainstUpdates: string[];
  /** Catalog entries the source no longer lists, without the `? `. */
  missingFromSource: string[];
  /** Machine-readable reasons; non-empty iff status === 'inconclusive'. */
  inconclusiveReasons: string[];
  /** The reconcile report with the npm run banner stripped. */
  reportText: string;
}

/**
 * Warning prefixes the weekly check treats as a known state rather than a
 * signal.
 *
 * Only the antigravity placeholder qualifies: `providers/antigravity.ts`
 * returns that warning unconditionally until Issue #1489 Phase 2 lands, so it
 * is on in *every* run. Treating it as blocking would make the workflow report
 * "inconclusive" forever, which is just as useless as reporting "clean"
 * forever.
 *
 * Matched by prefix on purpose, never by a loose `includes('antigravity')`:
 * once the provider is implemented, a real antigravity failure surfaces as
 * `http 404 for …` / `fetch failed for …` / `… parsed to zero commands`, none
 * of which match this prefix, so it correctly turns the run inconclusive.
 * Everything not listed here blocks — see the workflow comment in
 * .github/workflows/catalog-drift.yml.
 */
export const IGNORED_WARNING_PREFIXES: readonly string[] = [
  'antigravity provider not implemented yet',
];

/** True when `warning` is a known permanent state rather than a real outage. */
export function isIgnoredWarning(warning: string): boolean {
  return IGNORED_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix));
}

/** Label used to find the single tracking issue across runs. */
export const TRACKING_ISSUE_LABEL = 'catalog-drift';

/** Hidden marker so the tracking issue stays identifiable if the label is lost. */
export const TRACKING_ISSUE_MARKER = '<!-- slash-command-catalog-drift -->';

/** Issue bodies cap at 65536 chars on GitHub; leave room for the summary. */
export const DEFAULT_MAX_REPORT_CHARS = 45000;

// Sentinels straight out of printSummary() in
// scripts/refresh-slash-command-catalog.ts. Header + footer are both required:
// a run killed halfway prints the header but never the footer, and that is
// "inconclusive", not "clean".
const REPORT_HEADER = 'Slash-command catalog reconcile';
const CHECK_MODE_FOOTER = '(check mode';
const WARNINGS_HEADER = 'Warnings (fail-soft';
const NOTICES_HEADER = 'Not added / needs review';
const NEW_COMMANDS_HEADER = /^New commands \((\d+)\):$/;
const NO_NEW_COMMANDS = 'No new commands to add.';
const VERIFIED_HEADER = 'verifiedAgainst updates:';
const MISSING_HEADER = 'In catalog but not in source';
const NOTICE_GROUP = /^\[([^\]]+)\]\s+\((\d+)\)$/;

type Section = 'none' | 'warnings' | 'notices' | 'new' | 'verified' | 'missing';

export interface ParseCatalogCheckOptions {
  /** Exit code of the reconcile run; non-zero means the runner itself failed. */
  exitCode?: number;
}

/** Everything from the report header on, so the npm banner never reaches the issue. */
function stripRunnerBanner(output: string): string {
  const index = output.indexOf(REPORT_HEADER);
  return (index >= 0 ? output.slice(index) : output).trim();
}

/**
 * Parse the human-readable output of `catalog:refresh -- --check`.
 *
 * Deliberately strict: an unrecognised shape yields `inconclusive`, never a
 * comfortable `clean`. The declared `New commands (N)` count is cross-checked
 * against the number of `+` rows actually parsed, so a future format change
 * fails loud instead of silently reporting zero.
 */
export function parseCatalogCheckOutput(
  output: string,
  options: ParseCatalogCheckOptions = {}
): CatalogCheckReport {
  const lines = output.split(/\r?\n/);

  const warnings: string[] = [];
  const newCommands: string[] = [];
  const noticeGroups: CatalogCheckNoticeGroup[] = [];
  const verifiedAgainstUpdates: string[] = [];
  const missingFromSource: string[] = [];
  const inconclusiveReasons: string[] = [];

  let declaredNewCount: number | null = null;
  let sawNoNewCommands = false;
  let sawHeader = false;
  let sawFooter = false;
  let section: Section = 'none';

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      // Sections in printSummary() are blank-line separated and never contain
      // one internally, so a blank line always ends the current section.
      section = 'none';
      continue;
    }

    if (line.startsWith(REPORT_HEADER)) {
      sawHeader = true;
      section = 'none';
      continue;
    }
    if (line.startsWith(CHECK_MODE_FOOTER)) {
      sawFooter = true;
      section = 'none';
      continue;
    }
    if (line.startsWith(WARNINGS_HEADER)) {
      section = 'warnings';
      continue;
    }
    if (line.startsWith(NOTICES_HEADER)) {
      section = 'notices';
      continue;
    }
    const newHeader = NEW_COMMANDS_HEADER.exec(line);
    if (newHeader) {
      declaredNewCount = Number(newHeader[1]);
      section = 'new';
      continue;
    }
    if (line === NO_NEW_COMMANDS) {
      sawNoNewCommands = true;
      section = 'none';
      continue;
    }
    if (line.startsWith(VERIFIED_HEADER)) {
      section = 'verified';
      continue;
    }
    if (line.startsWith(MISSING_HEADER)) {
      section = 'missing';
      continue;
    }

    switch (section) {
      case 'warnings':
        if (line.startsWith('!')) warnings.push(line.slice(1).trim());
        break;
      case 'notices': {
        const group = NOTICE_GROUP.exec(line);
        if (group) noticeGroups.push({ category: group[1], count: Number(group[2]) });
        break;
      }
      case 'new':
        if (line.startsWith('+')) newCommands.push(line.slice(1).trim());
        break;
      case 'verified':
        if (line.startsWith('~')) verifiedAgainstUpdates.push(line.slice(1).trim());
        break;
      case 'missing':
        if (line.startsWith('?')) missingFromSource.push(line.slice(1).trim());
        break;
      default:
        break;
    }
  }

  const ignoredWarnings = warnings.filter(isIgnoredWarning);
  const blockingWarnings = warnings.filter((warning) => !isIgnoredWarning(warning));

  const exitCode = options.exitCode ?? 0;
  if (exitCode !== 0) inconclusiveReasons.push(`runner-exit-code:${exitCode}`);
  if (!sawHeader) inconclusiveReasons.push('report-header-missing');
  if (sawHeader && !sawFooter) inconclusiveReasons.push('report-truncated');
  if (declaredNewCount === null && !sawNoNewCommands) {
    inconclusiveReasons.push('new-command-count-missing');
  }
  if (declaredNewCount !== null && sawNoNewCommands) {
    inconclusiveReasons.push('new-command-count-ambiguous');
  }
  if (declaredNewCount !== null && declaredNewCount !== newCommands.length) {
    inconclusiveReasons.push(
      `new-command-count-mismatch:declared=${declaredNewCount},parsed=${newCommands.length}`
    );
  }
  for (const warning of blockingWarnings) {
    inconclusiveReasons.push(`source-warning:${warning}`);
  }

  const newCount = declaredNewCount ?? (sawNoNewCommands ? 0 : null);

  let status: CatalogCheckStatus;
  if (inconclusiveReasons.length > 0) {
    status = 'inconclusive';
  } else if ((newCount ?? 0) > 0) {
    status = 'drift';
  } else {
    status = 'clean';
  }

  return {
    status,
    newCount,
    newCommands,
    warnings,
    ignoredWarnings,
    blockingWarnings,
    noticeGroups,
    needsReviewCount: noticeGroups.reduce((total, group) => total + group.count, 0),
    verifiedAgainstUpdates,
    missingFromSource,
    inconclusiveReasons,
    reportText: stripRunnerBanner(output),
  };
}

/** Issue title; carries the count so the trend is visible in the issue list. */
export function trackingIssueTitle(report: CatalogCheckReport): string {
  switch (report.status) {
    case 'drift':
      return `[catalog-drift] スラッシュコマンドカタログ 未反映 ${report.newCount ?? 0} 件`;
    case 'inconclusive':
      return '[catalog-drift] スラッシュコマンドカタログ 検査不能（ソース未照合）';
    default:
      return '[catalog-drift] スラッシュコマンドカタログ 差分なし';
  }
}

export interface TrackingIssueBodyMeta {
  /** ISO timestamp of the run. */
  checkedAt: string;
  /** Link back to the Actions run that produced this body. */
  runUrl?: string;
  /** Exit code of the reconcile run, shown to document that 0 ≠ no drift. */
  exitCode?: number;
  maxReportChars?: number;
}

/**
 * Render the tracking-issue body: a summary a reader can act on, followed by
 * the `--check` output verbatim (its `[removed-row]` / `[alias-row]` /
 * `[suspect-description]` / `[description-conflict]` rows are what separate
 * "just add these" from "someone has to decide").
 */
export function formatTrackingIssueBody(
  report: CatalogCheckReport,
  meta: TrackingIssueBodyMeta
): string {
  const maxReportChars = meta.maxReportChars ?? DEFAULT_MAX_REPORT_CHARS;
  const truncated = report.reportText.length > maxReportChars;
  const reportText = truncated
    ? `${report.reportText.slice(0, maxReportChars)}\n… (出力が長いため以降を省略。全文は Actions のログを参照)`
    : report.reportText;

  const headline =
    report.status === 'drift'
      ? `未反映のコマンドが ${report.newCount ?? 0} 件あります`
      : report.status === 'inconclusive'
        ? 'カタログを検査できませんでした（ソースを照合できていません）'
        : '差分はありません';

  const sections: string[] = [
    TRACKING_ISSUE_MARKER,
    '> このIssueは `.github/workflows/catalog-drift.yml` が週次で自動更新します。',
    '> 本文を手で編集しても次回の実行で上書きされます。',
    '',
    `## ${headline}`,
    '',
    '| 項目 | 件数 |',
    '| --- | --- |',
    `| 新規コマンド（\`--write\` で自動追加される） | ${report.newCount ?? '不明'} |`,
    `| 要レビュー（自動追加されない） | ${report.needsReviewCount} |`,
    `| verifiedAgainst の更新 | ${report.verifiedAgainstUpdates.length} |`,
    `| カタログにあるがソースに無い | ${report.missingFromSource.length} |`,
    `| 警告（既知・無視） | ${report.ignoredWarnings.length} |`,
    `| 警告（要調査） | ${report.blockingWarnings.length} |`,
  ];

  if (report.noticeGroups.length > 0) {
    sections.push('', '### 要レビューの内訳');
    for (const group of report.noticeGroups) {
      sections.push(`- \`[${group.category}]\` ${group.count} 件`);
    }
  }

  if (report.status === 'inconclusive') {
    sections.push(
      '',
      '### 検査不能と判定した理由',
      '',
      'ソースを照合できていないため「差分 0」ではありません。この状態では Issue を close しません。'
    );
    for (const reason of report.inconclusiveReasons) {
      sections.push(`- \`${reason}\``);
    }
  }

  sections.push(
    '',
    '### 対応',
    '',
    '```bash',
    'npm run catalog:refresh -- --write',
    '```',
    '',
    '実行後 `locales/en/worktree.json` / `locales/ja/worktree.json` の説明文を確認し、',
    '要レビュー分（`[removed-row]` / `[alias-row]` / `[suspect-description]` /',
    '`[description-conflict]`）は手で判断してから PR を作成してください。',
    '',
    '### `--check` の出力',
    '',
    '```text',
    reportText,
    '```',
    ''
  );

  const footer = [`最終チェック: ${meta.checkedAt}`];
  if (meta.exitCode !== undefined) {
    footer.push(
      `reconcile の exit code: ${meta.exitCode}（\`--check\` はドリフト検出時も 0 を返すため判定には使っていません）`
    );
  }
  if (meta.runUrl) footer.push(`実行: ${meta.runUrl}`);
  sections.push('---', '', footer.map((line) => `- ${line}`).join('\n'));

  return sections.join('\n');
}

/** One-line summary for logs and the Actions step summary. */
export function formatCheckSummaryLine(report: CatalogCheckReport): string {
  const parts = [
    `status=${report.status}`,
    `new=${report.newCount ?? 'unknown'}`,
    `needsReview=${report.needsReviewCount}`,
    `warnings=${report.warnings.length}(blocking=${report.blockingWarnings.length})`,
  ];
  return parts.join(' ');
}
