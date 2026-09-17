#!/usr/bin/env node
/**
 * CHANGELOG fragment validator and aggregator (Issue #2640).
 *
 * Usage:
 *   node scripts/changelog-fragments.mjs check
 *   node scripts/changelog-fragments.mjs preview
 *   node scripts/changelog-fragments.mjs apply --version <X.Y.Z> --date <YYYY-MM-DD>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const SECTION_ORDER = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Performance',
  'Refactored',
  'Documentation',
];

const SECTION_PATTERN = /^<!-- ### (Added|Changed|Deprecated|Removed|Fixed|Security|Performance|Refactored|Documentation) -->$/;
const ENTRY_PATTERN = /^- \*\*(feat|fix|docs|style|refactor|test|chore|ci)(\([^)]+\))?: .+?\*\* \(#(\d+)\): .+$/;
const FILE_NAME_PATTERN = /^(\d+)\.md$/;

/**
 * Validates and parses a single changelog fragment.
 *
 * @param {string} fileName
 * @param {string} content
 * @returns {{ issue: number | null, section: string | null, entry: string | null, errors: string[] }}
 */
export function parseFragment(fileName, content) {
  const errors = [];
  let issue = null;
  let section = null;
  let entry = null;

  const fileMatch = fileName.match(FILE_NAME_PATTERN);
  if (!fileMatch) {
    errors.push(`Invalid fragment file name "${fileName}". Must match /^\\d+\\.md$/`);
  } else {
    issue = parseInt(fileMatch[1], 10);
  }

  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === '')) {
    errors.push('Fragment file is empty');
    return { issue, section, entry, errors };
  }

  const firstLine = lines[0];
  const sectionMatch = firstLine.match(SECTION_PATTERN);
  if (!sectionMatch) {
    errors.push(`Invalid first line: "${firstLine}". Must match /^<!-- ### (Added|Changed|Deprecated|Removed|Fixed|Security|Performance|Refactored|Documentation) -->$/`);
  } else {
    section = sectionMatch[1];
  }

  if (lines.length < 2 || lines[1].trim() === '') {
    errors.push('Fragment must contain an entry on line 2');
  } else {
    const secondLine = lines[1];
    const entryMatch = secondLine.match(ENTRY_PATTERN);
    if (!entryMatch) {
      errors.push(`Invalid second line: "${secondLine}". Must match /^- \\*\\*(feat|fix|docs|style|refactor|test|chore|ci)(\\([^)]+\\))?: .+?\\*\\* \\(#(\\d+)\\): .+$/`);
    } else {
      entry = secondLine;
      const entryIssue = parseInt(entryMatch[3], 10);
      if (issue !== null && entryIssue !== issue) {
        errors.push(`Issue number in entry (#${entryIssue}) does not match file name (#${issue})`);
      }
    }
  }

  for (let i = 2; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      errors.push(`Unexpected non-empty content on line ${i + 1}: "${lines[i]}"`);
    }
  }

  return { issue, section, entry, errors };
}

/**
 * Reads all fragments in the given directory.
 *
 * @param {string} dir
 * @returns {{ fragments: Array<{ fileName: string, issue: number, section: string, entry: string }>, errors: string[] }}
 */
export function readFragments(dir) {
  if (!fs.existsSync(dir)) {
    return { fragments: [], errors: [] };
  }

  const entries = fs.readdirSync(dir).sort();
  const mdFiles = entries.filter(f => f.endsWith('.md') && f !== 'README.md');

  const fragments = [];
  const errors = [];

  for (const fileName of mdFiles) {
    const filePath = path.join(dir, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = parseFragment(fileName, content);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        errors.push(`${fileName}: ${err}`);
      }
    } else {
      fragments.push({
        fileName,
        issue: result.issue,
        section: result.section,
        entry: result.entry,
      });
    }
  }

  return { fragments, errors };
}

/**
 * Renders fragments into markdown sections.
 *
 * @param {Array<{ issue: number, section: string, entry: string }>} fragments
 * @returns {string}
 */
export function renderSection(fragments) {
  if (!fragments || fragments.length === 0) {
    return '';
  }

  const sectionsMap = new Map();
  for (const section of SECTION_ORDER) {
    sectionsMap.set(section, []);
  }

  for (const fragment of fragments) {
    if (sectionsMap.has(fragment.section)) {
      sectionsMap.get(fragment.section).push(fragment);
    }
  }

  const renderedSections = [];

  for (const section of SECTION_ORDER) {
    const sectionFragments = sectionsMap.get(section);
    if (!sectionFragments || sectionFragments.length === 0) {
      continue;
    }

    // Sort by issue descending
    sectionFragments.sort((a, b) => b.issue - a.issue);

    const sectionLines = [
      `### ${section}`,
      '',
      sectionFragments.map(f => f.entry).join('\n\n'),
    ];
    renderedSections.push(sectionLines.join('\n'));
  }

  return renderedSections.join('\n\n');
}

/**
 * Applies changelog fragments to CHANGELOG.md and deletes the fragment files.
 *
 * @param {{ root: string, version: string, date: string }} options
 * @returns {{ applied: number, removed: string[] }}
 */
export function applyFragments({ root, version, date }) {
  const changelogDir = path.join(root, 'changelog.d');
  const changelogFile = path.join(root, 'CHANGELOG.md');

  const { fragments, errors } = readFragments(changelogDir);
  if (errors.length > 0) {
    throw new Error(`Cannot apply fragments: errors in changelog.d:\n${errors.join('\n')}`);
  }

  if (fragments.length === 0) {
    throw new Error('No fragments to apply');
  }

  if (!fs.existsSync(changelogFile)) {
    throw new Error(`CHANGELOG.md not found at ${changelogFile}`);
  }

  const content = fs.readFileSync(changelogFile, 'utf-8');
  const lines = content.split(/\r?\n/);

  const unreleasedIndex = lines.findIndex(l => /^## \[Unreleased\]\s*$/.test(l));
  if (unreleasedIndex === -1) {
    throw new Error('## [Unreleased] heading not found in CHANGELOG.md');
  }

  let nextHeadingIndex = -1;
  for (let i = unreleasedIndex + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      nextHeadingIndex = i;
      break;
    }
  }

  const betweenLines = nextHeadingIndex !== -1
    ? lines.slice(unreleasedIndex + 1, nextHeadingIndex)
    : lines.slice(unreleasedIndex + 1);

  if (betweenLines.some(l => l.trim() !== '')) {
    throw new Error('Unreleased is not empty');
  }

  const rendered = renderSection(fragments);
  const afterLines = nextHeadingIndex !== -1 ? lines.slice(nextHeadingIndex) : [];

  const newLines = [
    ...lines.slice(0, unreleasedIndex + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    ...rendered.split('\n'),
    '',
    ...afterLines,
  ];

  fs.writeFileSync(changelogFile, newLines.join('\n'), 'utf-8');

  const removed = [];
  for (const fragment of fragments) {
    const filePath = path.join(changelogDir, fragment.fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed.push(fragment.fileName);
    }
  }

  return { applied: fragments.length, removed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const command = args[0];

  const USAGE = `Usage:
  node scripts/changelog-fragments.mjs check
  node scripts/changelog-fragments.mjs preview
  node scripts/changelog-fragments.mjs apply --version <X.Y.Z> --date <YYYY-MM-DD>`;

  if (command === 'check') {
    const dir = path.join(root, 'changelog.d');
    const { fragments, errors } = readFragments(dir);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(err);
      }
      process.exit(1);
    }
    console.log(`changelog-fragments: ${fragments.length} fragment(s) OK`);
    process.exit(0);
  }

  if (command === 'preview') {
    const dir = path.join(root, 'changelog.d');
    const { fragments, errors } = readFragments(dir);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(err);
      }
      process.exit(1);
    }
    if (fragments.length === 0) {
      console.log('changelog-fragments: no fragments');
      process.exit(0);
    }
    console.log(renderSection(fragments));
    process.exit(0);
  }

  if (command === 'apply') {
    let version = null;
    let date = null;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--version' && i + 1 < args.length) {
        version = args[++i];
      } else if (args[i] === '--date' && i + 1 < args.length) {
        date = args[++i];
      } else {
        console.error(USAGE);
        process.exit(2);
      }
    }

    if (!version || !date) {
      console.error(USAGE);
      process.exit(2);
    }

    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error(`Invalid version or date format: version="${version}", date="${date}"\n${USAGE}`);
      process.exit(2);
    }

    try {
      const result = applyFragments({ root, version, date });
      console.log(`changelog-fragments: applied ${result.applied} fragment(s) to ${version}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  console.error(USAGE);
  process.exit(2);
}
