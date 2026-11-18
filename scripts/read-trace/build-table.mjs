#!/usr/bin/env node
/**
 * Builds one read table from a traced unit run (Issue #4432 PR3).
 *
 * Run by .github/workflows/read-trace.yml on every push to develop; the table
 * is uploaded as an artifact and nothing else. Measurement only — no gate reads
 * the table.
 *
 * Usage:
 *   node scripts/read-trace/build-table.mjs --trace-dir <dir> --report <vitest.json> \
 *     --gate-env <gate-env.json> --commit <sha> --out <table.json> [--root <repo>]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTable, readerKey } from './table.mjs';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || i + 1 >= argv.length) throw new Error(`unexpected argument: ${argv[i]}`);
    out[m[1]] = argv[i + 1];
    i += 1;
  }
  for (const required of ['trace-dir', 'report', 'gate-env', 'commit', 'out']) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  return out;
}

export function readTraces(dir) {
  const traces = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^trace-.*\.json$/.test(name)) continue;
    try {
      traces.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      // An unreadable record leaves its file without a trace: opaque (no-trace).
    }
  }
  return traces;
}

export function main(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? process.cwd());
  const runGit = (gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  const table = buildTable({
    commit: args.commit,
    key: readerKey(args.commit, { runGit }),
    gateEnv: JSON.parse(fs.readFileSync(args['gate-env'], 'utf8')),
    traces: readTraces(args['trace-dir']),
    report: JSON.parse(fs.readFileSync(args.report, 'utf8')),
    repoRoot: root,
  });
  fs.writeFileSync(args.out, `${JSON.stringify(table)}\n`);
  const all = Object.values(table.files);
  process.stdout.write(
    `read-trace: table ${args.commit} files=${all.length} opaque=${all.filter((e) => e.opaque).length}\n`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
