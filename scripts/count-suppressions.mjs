#!/usr/bin/env node
/**
 * 数字だけを合わせる変更（Issue #3483）の機械的な確認。
 *
 * 使い方: node scripts/count-suppressions.mjs --base <ref> [--json]
 *
 * `git diff <base>...HEAD` を読み、次を数える。0 でなければ exit 1。
 *   - 追加された抑止のコメント: eslint-disable / @ts-ignore / @ts-expect-error / knip の ignore
 *   - 計測の設定の変更: src/lib/agent-health/metrics*.ts と scripts/agent-health/metrics*.ts
 * このスクリプトとそのテストは、検出する語を本文に含むので数えない。
 */
import { execFileSync } from 'node:child_process';

const SELF_PATHS = new Set([
  'scripts/count-suppressions.mjs',
  'tests/unit/scripts/count-suppressions-3483.test.ts',
]);
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const KNIP_CONFIG = /(?:^|\/)(?:knip\.jsonc?|\.knip\.jsonc?|knip\.config\.[cm]?[jt]s)$/;
const METRICS_FILE = /^(?:src\/lib|scripts)\/agent-health\/metrics[^/]*\.ts$/;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|\bknip\s*:|knip-ignore/;

function parseArgs(argv) {
  const args = { base: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

export function findFindings(diffText) {
  const findings = [];
  let file = null;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file || SELF_PATHS.has(file)) continue;
    const isAdd = line.startsWith('+');
    const isDel = line.startsWith('-');
    if (isAdd) {
      const text = line.slice(1);
      if (METRICS_FILE.test(file)) {
        findings.push({ kind: 'metrics-config', file, line: newLine, text });
      } else if (KNIP_CONFIG.test(file)) {
        findings.push({ kind: 'knip-config', file, line: newLine, text });
      } else if (CODE_FILE.test(file) && SUPPRESSION.test(text)) {
        findings.push({ kind: 'suppression', file, line: newLine, text });
      }
      newLine++;
    } else if (isDel) {
      if (METRICS_FILE.test(file)) {
        findings.push({ kind: 'metrics-config', file, line: newLine, text: line.slice(1), removed: true });
      }
    } else if (!line.startsWith('\\')) {
      newLine++;
    }
  }
  return findings;
}

function main() {
  const { base, json } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error('usage: node scripts/count-suppressions.mjs --base <ref> [--json]');
    process.exit(2);
  }
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', '--no-color', `${base}...HEAD`], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`git diff failed: ${err.message}`);
    process.exit(2);
  }
  const findings = findFindings(diff);
  if (json) {
    console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
  } else {
    console.log(`suppressions/metrics-config changes: ${findings.length}`);
    for (const f of findings) {
      console.log(`  [${f.kind}] ${f.file}:${f.line} ${f.removed ? '-' : '+'} ${f.text.trim()}`);
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
