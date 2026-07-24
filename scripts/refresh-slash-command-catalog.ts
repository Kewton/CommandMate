#!/usr/bin/env tsx
/**
 * refresh-slash-command-catalog (Issue #1489)
 *
 * Reconciles src/config/slash-commands-catalog.json against each CLI's
 * authoritative source (claude docs table, codex OSS enum @release tag), so the
 * catalog content and its `verifiedAgainst` version stamp update together. Wired
 * into the /release skill so every release naturally refreshes the catalog.
 *
 * Usage:
 *   tsx scripts/refresh-slash-command-catalog.ts [--check | --write]
 *                                                [--codex-ref <tag>]
 *                                                [--skip-claude] [--skip-codex]
 *                                                [--skip-antigravity] [--json]
 *
 *   --check  (default) report the diff; write nothing.
 *   --write            apply changes to the catalog + en/ja locale dictionaries.
 *
 * Fail-soft: a source that is unreachable or has changed shape is skipped with a
 * warning; existing catalog entries are left intact. Exit code is 0 on a normal
 * run (including "all sources down") and non-zero only on an unexpected error.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  runReconcile,
  type LocaleAddition,
  type ReconcileResult,
  type SlashCommandsCatalog,
} from '../src/lib/slash-command-reconcile';

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'src/config/slash-commands-catalog.json');
const EN_LOCALE_PATH = path.join(REPO_ROOT, 'locales/en/worktree.json');
const JA_LOCALE_PATH = path.join(REPO_ROOT, 'locales/ja/worktree.json');

interface CliArgs {
  write: boolean;
  json: boolean;
  codexRef?: string;
  skipClaude: boolean;
  skipCodex: boolean;
  skipAntigravity: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    write: false,
    json: false,
    skipClaude: false,
    skipCodex: false,
    skipAntigravity: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--write':
        args.write = true;
        break;
      case '--check':
        args.write = false;
        break;
      case '--json':
        args.json = true;
        break;
      case '--codex-ref':
        args.codexRef = argv[++i];
        break;
      case '--skip-claude':
        args.skipClaude = true;
        break;
      case '--skip-codex':
        args.skipCodex = true;
        break;
      case '--skip-antigravity':
        args.skipAntigravity = true;
        break;
      default:
        console.warn(`Ignoring unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

type LocaleDictionary = Record<string, unknown>;

/** Set a dotted key (e.g. slashCommands.descriptions.loop) inside a dictionary. */
function setNested(dict: LocaleDictionary, dottedKey: string, value: string): void {
  const parts = dottedKey.split('.');
  let node: Record<string, unknown> = dict;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = node[key];
    if (!next || typeof next !== 'object') {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function applyLocaleAdditions(
  filePath: string,
  additions: LocaleAddition[],
  pick: (addition: LocaleAddition) => string
): void {
  if (additions.length === 0) return;
  const dict = readJson<LocaleDictionary>(filePath);
  for (const addition of additions) {
    setNested(dict, addition.key, pick(addition));
  }
  writeJson(filePath, dict);
}

function printSummary(result: ReconcileResult, args: CliArgs): void {
  if (args.json) {
    console.log(JSON.stringify({ changed: result.changed, diff: result.diff, warnings: result.warnings }, null, 2));
    return;
  }

  const { diff } = result;
  console.log('\nSlash-command catalog reconcile');
  console.log('================================');

  if (result.warnings.length > 0) {
    console.log('\nWarnings (fail-soft — affected sources left untouched):');
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }

  if (diff.added.length === 0) {
    console.log('\nNo new commands to add.');
  } else {
    console.log(`\nNew commands (${diff.added.length}):`);
    for (const added of diff.added) {
      const desc = added.enDescription ? ` — ${added.enDescription}` : ' — (needs description)';
      console.log(`  + [${added.tool}] /${added.name}${desc}`);
    }
  }

  const stamped = Object.entries(diff.verifiedAgainstUpdated);
  if (stamped.length > 0) {
    console.log('\nverifiedAgainst updates:');
    for (const [tool, change] of stamped) {
      console.log(`  ~ ${tool}: ${change.from ?? '(unset)'} -> ${change.to}`);
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
  const args = parseArgs(process.argv.slice(2));
  const catalog = readJson<SlashCommandsCatalog>(CATALOG_PATH);

  const result = await runReconcile(catalog, {
    claude: args.skipClaude ? false : {},
    codex: args.skipCodex ? false : args.codexRef ? { ref: args.codexRef } : {},
    antigravity: args.skipAntigravity ? false : {},
  });

  printSummary(result, args);

  if (args.write && result.changed) {
    writeJson(CATALOG_PATH, result.catalog);
    applyLocaleAdditions(EN_LOCALE_PATH, result.localeAdditions, (a) => a.en);
    applyLocaleAdditions(JA_LOCALE_PATH, result.localeAdditions, (a) => a.ja);
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
