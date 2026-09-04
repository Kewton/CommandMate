#!/usr/bin/env node
/**
 * Decides what an `npm audit --json` run means, so CI can tell "the registry
 * did not answer" apart from "the tree has a vulnerability".
 *
 * [Issue #2313] On 2026-09-04 the registry's audit endpoints
 * (`/-/npm/v1/security/advisories/bulk` and `.../audits/quick`) stopped
 * answering POSTs — TCP accepted, request fully sent, then either 0 bytes for
 * npm's whole `fetch-timeout` or `{"error":"Service Unavailable"}` — while
 * status.npmjs.org kept reporting every component operational. `npm audit`
 * exits 1 in that state exactly as it does for a real finding, so a bare
 * `npm audit --audit-level=critical` step turned an npm-side outage into a
 * red "Security Audit" on every PR, indistinguishable on the PR page from a
 * critical CVE in the tree.
 *
 * The two outcomes have different shapes on stdout, and that is what this
 * script reads (npm's exit code is logged but not trusted, because it is 1
 * in both cases):
 *
 *   registry unreachable   { "message": "network timeout at: …",
 *                            "error": { "summary": "", "detail": "" } }
 *                          — captured verbatim during the outage. No
 *                          `auditReportVersion`, so nothing was audited.
 *   a real report          { "auditReportVersion": 2, "vulnerabilities": {…},
 *                            "metadata": { "vulnerabilities": { "critical": N, … } } }
 *
 * Only the second is a verdict. The first is reported as a GitHub warning
 * annotation and exits 0 — the step goes yellow, the job stays green, and the
 * text says in so many words that the tree was NOT audited on this run. That
 * is a narrower concession than `continue-on-error: true` on the job, which
 * would also wave through a real critical finding.
 *
 * Anything that is neither shape (not JSON, an unknown envelope, a missing
 * file) exits 1: the script refuses to guess, and prints what it got so the
 * log says why.
 *
 * Usage:
 *   npm audit --audit-level=critical --json --fetch-timeout=60000 --fetch-retries=1 > out.json
 *   node scripts/check-npm-audit.mjs out.json "$?" [--level=critical]
 *
 * `--fetch-timeout` / `--fetch-retries` matter: npm's default fetch-timeout is
 * 300000ms, the same 5 minutes as the step cap, so without them a hanging
 * endpoint is killed by the runner before npm can emit the error envelope
 * this script needs to read.
 */

import { readFileSync } from 'fs';

/** npm's severity ladder, lowest first; `--level=X` gates X and everything above it. */
export const AUDIT_LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * @typedef {{ kind: 'unreachable', message: string }
 *   | { kind: 'report', counts: Record<string, number>, overGate: number, level: string }
 *   | { kind: 'unreadable', message: string }} Verdict
 */

/**
 * Classify the text `npm audit --json` wrote to stdout.
 *
 * Pure: no I/O, no exit. `text` is the raw stdout; `level` is the gate
 * (`critical` by default, matching the CI job's `--audit-level`).
 *
 * @param {string} text
 * @param {string} [level]
 * @returns {Verdict}
 */
export function classifyAuditOutput(text, level = 'critical') {
  if (!AUDIT_LEVELS.includes(level)) {
    return { kind: 'unreadable', message: `unknown --level '${level}' (want one of ${AUDIT_LEVELS.join(', ')})` };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', message: 'stdout is not JSON' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { kind: 'unreadable', message: 'stdout is JSON but not an object' };
  }

  // A real report always carries auditReportVersion. Check it FIRST: a report
  // can legitimately contain an `error`-named advisory field somewhere, and
  // the envelope below must only win when there is no report at all.
  if (typeof json.auditReportVersion === 'number') {
    const counts = {};
    const raw = json.metadata && json.metadata.vulnerabilities;
    for (const lvl of AUDIT_LEVELS) {
      const n = raw && typeof raw[lvl] === 'number' ? raw[lvl] : 0;
      counts[lvl] = n;
    }
    const overGate = AUDIT_LEVELS.slice(AUDIT_LEVELS.indexOf(level)).reduce((sum, lvl) => sum + counts[lvl], 0);
    return { kind: 'report', counts, overGate, level };
  }

  // npm's error envelope: `{ message, error: { summary, detail } }` (network
  // timeout, 5xx from the registry, DNS failure …). No report was produced.
  if ('error' in json) {
    const err = json.error;
    const message =
      (typeof json.message === 'string' && json.message) ||
      (err && typeof err === 'object' && (err.summary || err.code || err.detail)) ||
      (typeof err === 'string' ? err : JSON.stringify(err));
    return { kind: 'unreachable', message: String(message || 'npm reported an error without a message') };
  }

  return { kind: 'unreadable', message: 'JSON has neither auditReportVersion nor an error envelope' };
}

function main(argv) {
  const [file, npmExitCode, ...flags] = argv;
  if (!file) {
    console.log('::error::usage: check-npm-audit.mjs <audit-json-file> <npm-exit-code> [--level=critical]');
    return 2;
  }
  const levelFlag = flags.find((f) => f.startsWith('--level='));
  const level = levelFlag ? levelFlag.slice('--level='.length) : 'critical';

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.log(`::error::npm audit left no output at ${file}: ${e && e.message ? e.message : e}`);
    return 1;
  }

  const verdict = classifyAuditOutput(text, level);
  console.log(`npm audit exit code: ${npmExitCode === undefined ? '(not given)' : npmExitCode}`);

  switch (verdict.kind) {
    case 'unreachable':
      console.log(
        `::warning title=npm audit did not run::The registry's audit endpoint did not answer ` +
          `(${verdict.message}). This is a network / registry failure, not a vulnerability ` +
          `finding — the dependency tree was NOT audited on this run. See Issue #2313.`
      );
      return 0;
    case 'report': {
      const summary = AUDIT_LEVELS.map((l) => `${l}=${verdict.counts[l]}`).join(' ');
      console.log(`npm audit report: ${summary} (gate: ${verdict.level} and above)`);
      if (verdict.overGate > 0) {
        console.log(
          `::error title=npm audit::${verdict.overGate} vulnerabilit${verdict.overGate === 1 ? 'y' : 'ies'} ` +
            `at or above '${verdict.level}'. Run \`npm audit --audit-level=${verdict.level}\` locally for the list.`
        );
        return 1;
      }
      return 0;
    }
    case 'unreadable':
    default:
      console.log(`::error title=npm audit::Cannot read the audit result (${verdict.message}). Refusing to guess. Raw output:`);
      console.log(text.slice(0, 4000));
      return 1;
  }
}

// Only run as a CLI when invoked directly; the unit test imports the classifier.
if (process.argv[1] && /check-npm-audit\.mjs$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
