#!/usr/bin/env tsx
/**
 * catalog-drift-report (Issue #1705)
 *
 * Turns a captured `npm run catalog:refresh -- --check` transcript into the
 * three-way verdict the weekly drift workflow acts on (drift / clean /
 * inconclusive) plus the tracking-issue body.
 *
 * It reads a *file* rather than running the reconcile itself so the workflow
 * keeps "capture" and "decide" in separate steps: the raw transcript stays in
 * the Actions log even when parsing goes wrong, and this script is exercisable
 * offline against a fixture.
 *
 * Usage:
 *   tsx scripts/catalog-drift-report.ts --input <file> [--exit-code <n>]
 *                                       [--body-out <file>] [--run-url <url>]
 *                                       [--checked-at <iso>] [--json]
 *
 * Outputs (when the matching env var is set):
 *   $GITHUB_OUTPUT        status / new_count / needs_review_count /
 *                         attestation_drift_count / blocking_warning_count / title
 *   $GITHUB_STEP_SUMMARY  human summary
 *
 * Always exits 0 for a parse it understood — the verdict travels in `status`,
 * never in the exit code. Exits 1 only on an I/O or usage error.
 */

import * as fs from 'fs';
import {
  parseCatalogCheckOutput,
  formatTrackingIssueBody,
  formatCheckSummaryLine,
  trackingIssueTitle,
} from '../src/lib/slash-command-reconcile/check-report';

interface CliArgs {
  input?: string;
  bodyOut?: string;
  runUrl?: string;
  checkedAt?: string;
  exitCode: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { exitCode: 0, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        args.input = argv[++i];
        break;
      case '--body-out':
        args.bodyOut = argv[++i];
        break;
      case '--run-url':
        args.runUrl = argv[++i];
        break;
      case '--checked-at':
        args.checkedAt = argv[++i];
        break;
      case '--exit-code':
        args.exitCode = Number(argv[++i]);
        break;
      case '--json':
        args.json = true;
        break;
      default:
        console.warn(`Ignoring unknown argument: ${arg}`);
    }
  }
  return args;
}

function appendToFile(envVar: string, content: string): void {
  const target = process.env[envVar];
  if (!target) return;
  fs.appendFileSync(target, `${content}\n`, 'utf8');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('catalog-drift-report: --input <file> is required');
    process.exit(1);
  }

  const output = fs.readFileSync(args.input, 'utf8');
  const exitCode = Number.isFinite(args.exitCode) ? args.exitCode : 1;
  const report = parseCatalogCheckOutput(output, { exitCode });
  const title = trackingIssueTitle(report);
  const body = formatTrackingIssueBody(report, {
    checkedAt: args.checkedAt ?? new Date().toISOString(),
    runUrl: args.runUrl,
    exitCode,
  });

  if (args.bodyOut) fs.writeFileSync(args.bodyOut, `${body}\n`, 'utf8');

  const summary = formatCheckSummaryLine(report);
  console.log(summary);
  for (const reason of report.inconclusiveReasons) {
    console.log(`  inconclusive: ${reason}`);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));

  appendToFile('GITHUB_OUTPUT', `status=${report.status}`);
  appendToFile('GITHUB_OUTPUT', `new_count=${report.newCount ?? -1}`);
  appendToFile('GITHUB_OUTPUT', `needs_review_count=${report.needsReviewCount}`);
  // Issue #2026: exposed alongside new_count because the two are different kinds
  // of work — one `--write` can do, one only a human re-reading a source can.
  appendToFile('GITHUB_OUTPUT', `attestation_drift_count=${report.attestationDrift.length}`);
  appendToFile('GITHUB_OUTPUT', `blocking_warning_count=${report.blockingWarnings.length}`);
  appendToFile('GITHUB_OUTPUT', `title=${title}`);

  appendToFile(
    'GITHUB_STEP_SUMMARY',
    ['## Slash-command catalog drift', '', `- ${summary}`, `- title: ${title}`].join('\n')
  );
}

try {
  main();
} catch (error) {
  console.error('catalog-drift-report failed:', error);
  process.exit(1);
}
