#!/usr/bin/env node
/**
 * Fails when a source file under src/ contains a raw C0 control character.
 *
 * Issue #1432: operation-lock.ts and preview-diff.ts carried raw NUL (0x00) as a
 * hash separator inside template literals. file(1) then classified them as
 * `data` and grep/rg skipped them silently, hiding ~870 lines from every
 * grep-based audit, CI guard and codemod in the repo. `\x00` evaluates to the
 * same byte, so the escape is behaviour-preserving.
 *
 * tests/ is deliberately NOT scanned: several suites need a raw control byte as
 * the fixture under test (a NUL-rejection input, a binary-content payload), and
 * escaping those would change what is being asserted.
 *
 * Usage: node scripts/check-control-chars.mjs [repoRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALLOWED = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR
const EXTENSIONS = ['.ts', '.tsx'];

function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...collect(full));
    } else if (EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

export function findControlCharViolations(root) {
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const violations = [];
  for (const file of collect(srcDir)) {
    const bytes = fs.readFileSync(file);
    let line = 1;
    let column = 1;
    for (const byte of bytes) {
      if (byte < 0x20 && !ALLOWED.has(byte)) {
        violations.push({
          file: path.relative(root, file),
          line,
          column,
          byte: `0x${byte.toString(16).padStart(2, '0')}`,
        });
      }
      if (byte === 0x0a) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const violations = findControlCharViolations(root);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`::error file=${v.file},line=${v.line}::raw control character ${v.byte} (Issue #1432) — use the equivalent escape, e.g. \\x00`);
    }
    console.error(`\n${violations.length} raw control character(s) found under src/. They make grep/rg skip the whole file.`);
    process.exit(1);
  }
  console.log('Control chars: no raw C0 bytes under src/ (tab/LF/CR allowed).');
}
