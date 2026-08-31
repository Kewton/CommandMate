#!/usr/bin/env tsx
/**
 * refresh-slash-command-catalog (Issue #1489)
 *
 * Reconciles src/config/slash-commands-catalog.json against each CLI's
 * authoritative source (claude docs table, codex OSS enum @release tag). Wired
 * into the /release skill so every release naturally refreshes the catalog.
 *
 * Issue #2026: `--write` adds catalog entries and locale strings, and nothing
 * else. It no longer stamps a version, because the version now lives in
 * src/config/slash-commands-attestations.json next to the command set a human
 * read off that source — and re-reading the source is the whole point. What the
 * run does instead is *say* how far each attestation has fallen behind, so the
 * work left over after `--write` is on screen rather than only in a red pin.
 *
 * Issue #2036: `--opencode-port <port>` reconciles the opencode catalog against
 * `GET /command` on a loopback opencode server. Before it, `RunReconcileOptions
 * .opencode` had no caller anywhere in the repository, so the option's `false`
 * default was the only value it could ever hold and every run — the weekly
 * catalog-drift workflow included — reported opencode as skipped. The flag is
 * opt-in and stays opt-in: the workflow does not pass it (there is no opencode
 * server on a CI runner), so its run is byte-for-byte what it was.
 *
 * Usage (`--help` prints the same list; it lives in
 * src/lib/slash-command-reconcile/runner-args.ts so a test can read it):
 *   tsx scripts/refresh-slash-command-catalog.ts [--check | --write]
 *                                                [--codex-ref <tag>]
 *                                                [--opencode-port <port>]
 *                                                [--skip-claude] [--skip-codex]
 *                                                [--skip-antigravity] [--json]
 *                                                [-h | --help]
 *
 *   --check              (default) report the diff; write nothing.
 *   --write              apply changes to the catalog + en/ja locale dictionaries.
 *   --opencode-port <n>  enumerate opencode from http://127.0.0.1:<n>/command.
 *
 * Fail-soft: a source that is unreachable or has changed shape is skipped with a
 * warning; existing catalog entries are left intact. Exit code is 0 on a normal
 * run (including "all sources down"), 2 on a malformed command line, and
 * non-zero otherwise only on an unexpected error.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  runReconcile,
  formatNoticesForReport,
  applyLocaleAdditions,
  flattenDictionary,
  describeAttestationDrift,
  DEFAULT_ATTESTATIONS,
  DEFAULT_EXCLUSIONS,
  parseRunnerArgs,
  opencodeOptionFromArgs,
  RunnerArgsError,
  RUNNER_USAGE,
  RUNNER_USAGE_EXIT_CODE,
  type RunnerArgs,
  type LocaleAddition,
  type LocaleDictionary,
  type ReconcileResult,
  type SlashCommandsCatalog,
} from '../src/lib/slash-command-reconcile';

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'src/config/slash-commands-catalog.json');
const EXCLUSIONS_PATH = path.join(REPO_ROOT, 'src/config/slash-commands-exclusions.json');
const ATTESTATIONS_PATH = path.join(REPO_ROOT, 'src/config/slash-commands-attestations.json');
const EN_LOCALE_PATH = path.join(REPO_ROOT, 'locales/en/worktree.json');
const JA_LOCALE_PATH = path.join(REPO_ROOT, 'locales/ja/worktree.json');

/**
 * Parse argv, or print the usage and exit 2.
 *
 * A malformed command line is the one failure this runner refuses to be
 * fail-soft about. Everything else here degrades to a warning because a source
 * being down is a fact about the world; `--opencode-port banana` is a fact about
 * the invocation, and continuing with it silently ignored would run a pass whose
 * report says opencode was skipped for a reason the operator did not choose.
 */
function parseArgsOrExit(argv: string[]): RunnerArgs {
  try {
    const args = parseRunnerArgs(argv);
    // Unknown arguments stay a warning, with the wording they have always had:
    // the parser is pure and hands them back rather than printing them itself.
    for (const unknown of args.unknownArgs) {
      console.warn(`Ignoring unknown argument: ${unknown}`);
    }
    return args;
  } catch (error) {
    if (!(error instanceof RunnerArgsError)) throw error;
    console.error(`refresh-slash-command-catalog: ${error.message}`);
    console.error(`\n${RUNNER_USAGE}`);
    process.exit(RUNNER_USAGE_EXIT_CODE);
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Merge locale additions into a dictionary file. The merge itself is a pure
 * helper in the reconcile module (Issue #1704) so a test can pin the round trip
 * between the key the engine mints and the key the renderer resolves.
 */
function writeLocaleAdditions(
  filePath: string,
  additions: LocaleAddition[],
  pick: (addition: LocaleAddition) => string
): void {
  if (additions.length === 0) return;
  const dict = readJson<LocaleDictionary>(filePath);
  writeJson(filePath, applyLocaleAdditions(dict, additions, pick));
}

function printSummary(result: ReconcileResult, args: RunnerArgs): void {
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          changed: result.changed,
          diff: result.diff,
          warnings: result.warnings,
          notices: result.notices,
        },
        null,
        2
      )
    );
    return;
  }

  const { diff } = result;
  console.log('\nSlash-command catalog reconcile');
  console.log('================================');

  // Issue #1704: make the curation list visible in the report, so "why is this
  // never proposed?" is answered by the run itself rather than by issue archaeology.
  console.log(
    `\nHonoring ${DEFAULT_EXCLUSIONS.length} exclusion(s) from ` +
      `${path.relative(REPO_ROOT, EXCLUSIONS_PATH)}`
  );

  // Issue #2026: the same move for the other half of the decision. Say which
  // reading each tool's pins are being held to, so "why is the pin red?" is
  // answered by the run rather than by reading a test file.
  console.log(
    `Holding ${DEFAULT_ATTESTATIONS.length} attestation(s) from ` +
      `${path.relative(REPO_ROOT, ATTESTATIONS_PATH)}:`
  );
  for (const attestation of DEFAULT_ATTESTATIONS) {
    console.log(
      `  = ${attestation.tool}: ${attestation.commands.length} command(s) read off ` +
        `${attestation.tool} ${attestation.version} on ${attestation.observedAt} (#${attestation.issue})`
    );
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings (fail-soft — affected sources left untouched):');
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }

  // Issue #1603: rows the reconcile refused, by category, so a history or alias
  // row is visibly *rejected* rather than silently absent from the add list.
  const noticeLines = formatNoticesForReport(result.notices);
  if (noticeLines.length > 0) {
    console.log('\nNot added / needs review (by category):');
    for (const line of noticeLines) console.log(`  ${line}`);
  }

  if (diff.added.length === 0) {
    console.log('\nNo new commands to add.');
  } else {
    console.log(`\nNew commands (${diff.added.length}):`);
    for (const added of diff.added) {
      const desc = added.enDescription ? ` — ${added.enDescription}` : ' — (needs description)';
      console.log(`  + [${added.tool}] /${added.name}${desc}`);
    }
    // Issue #2024 put this paragraph here, at the moment the additions are on
    // screen, because nothing made the correct-addition outcome readable to the
    // operator. Issue #2026 turned "retype the pin" into "record the reading":
    // the pins no longer hold literals, so the response is an edit to a file
    // that states what the source said, not a number whose evidence is a commit
    // message. Blank-line separated, so check-report.ts's section parser skips it.
    console.log(
      '\n  Applying these will turn the catalog pins in\n' +
        '  tests/unit/lib/standard-commands.test.ts red, because the catalog will no\n' +
        '  longer match the attested set. That is the review gate, not a defect.\n' +
        `  The response is to re-read the source and update ${path.relative(REPO_ROOT, ATTESTATIONS_PATH)}\n` +
        '  (its command list, its version, and its observedAt date) — never to relax a pin.\n' +
        `  Reasoning: the "$comment" blocks in that file and in ${path.relative(REPO_ROOT, EXCLUSIONS_PATH)}.`
    );
  }

  // Issue #2026: still printed under the header check-report.ts has always
  // parsed, but these are no longer applied — the stamp is a field of the
  // attestation, so moving it is part of the human re-read this section asks for.
  const stamped = Object.entries(diff.verifiedAgainstUpdated);
  if (stamped.length > 0) {
    console.log('\nverifiedAgainst updates (not applied — re-attest by hand):');
    for (const [tool, change] of stamped) {
      console.log(`  ~ ${tool}: ${change.from ?? '(unset)'} -> ${change.to}`);
    }
  }

  // Issue #2026: the staleness signal the pins cannot give. A pin compares the
  // catalog to the attestation; only a run that fetched the source can say the
  // attestation itself has expired.
  if (diff.attestationDrift.length > 0) {
    console.log('\nAttestation drift (the recorded reading no longer matches the source):');
    for (const drift of diff.attestationDrift) {
      console.log(`  * ${describeAttestationDrift(drift)}`);
    }
  }

  if (diff.missingFromSource.length > 0) {
    console.log('\nIn catalog but not in source (review — not auto-deleted):');
    for (const missing of diff.missingFromSource) {
      console.log(`  ? [${missing.tool}] /${missing.name}`);
    }
  }

  console.log(
    args.write
      ? `\n${result.changed ? 'Applied changes.' : 'Nothing to apply.'}`
      : `\n(check mode — no files written; run with --write to apply)`
  );
}

async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv.slice(2));
  if (args.help) {
    console.log(RUNNER_USAGE);
    return;
  }

  const catalog = readJson<SlashCommandsCatalog>(CATALOG_PATH);

  const result = await runReconcile(catalog, {
    claude: args.skipClaude ? false : {},
    codex: args.skipCodex ? false : args.codexRef ? { ref: args.codexRef } : {},
    antigravity: args.skipAntigravity ? false : {},
    // Issue #2036: `false` unless --opencode-port was given, which is what keeps
    // the weekly workflow's run identical to the one it made before this flag
    // existed. Deliberately NOT printed in printSummary(): check-report.ts parses
    // that report line by line and .github/workflows/catalog-drift.yml acts on
    // the verdict, so the report's shape is an interface, not a scratch pad.
    opencode: opencodeOptionFromArgs(args),
    // Issue #1704: lets the engine notice when a new entry would silently
    // inherit a description an earlier release wrote for a different tool.
    existingEnDescriptions: flattenDictionary(readJson<LocaleDictionary>(EN_LOCALE_PATH)),
  });

  printSummary(result, args);

  if (args.write && result.changed) {
    writeJson(CATALOG_PATH, result.catalog);
    writeLocaleAdditions(EN_LOCALE_PATH, result.localeAdditions, (a) => a.en);
    writeLocaleAdditions(JA_LOCALE_PATH, result.localeAdditions, (a) => a.ja);
    console.log('\nFiles written:');
    console.log(`  ${path.relative(REPO_ROOT, CATALOG_PATH)}`);
    if (result.localeAdditions.length > 0) {
      console.log(`  ${path.relative(REPO_ROOT, EN_LOCALE_PATH)}`);
      console.log(`  ${path.relative(REPO_ROOT, JA_LOCALE_PATH)}`);
    }
  }
}

main().catch((error) => {
  console.error('refresh-slash-command-catalog failed:', error);
  process.exit(1);
});
