#!/usr/bin/env node
/**
 * CHANGELOG fragment validator and aggregator (Issue #2640).
 *
 * Usage:
 *   node scripts/changelog-fragments.mjs check
 *   node scripts/changelog-fragments.mjs preview
 *   node scripts/changelog-fragments.mjs apply --version <X.Y.Z> --date <YYYY-MM-DD>
 *   node scripts/changelog-fragments.mjs bump-floor --current <X.Y.Z> [--next <X.Y.Z>]
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
const BUMP_PATTERN = /^<!-- bump: (minor|major) -->$/;
const FILE_NAME_PATTERN = /^(\d+)\.md$/;

/**
 * Validates and parses a single changelog fragment.
 *
 * @param {string} fileName
 * @param {string} content
 * @returns {{ issue: number | null, section: string | null, bump: 'minor' | 'major' | null, entry: string | null, errors: string[] }}
 */
export function parseFragment(fileName, content) {
  const errors = [];
  let issue = null;
  let section = null;
  let entry = null;
  let bump = null;

  const fileMatch = fileName.match(FILE_NAME_PATTERN);
  if (!fileMatch) {
    errors.push(`Invalid fragment file name "${fileName}". Must match /^\\d+\\.md$/`);
  } else {
    issue = parseInt(fileMatch[1], 10);
  }

  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === '')) {
    errors.push('Fragment file is empty');
    return { issue, section, bump, entry, errors };
  }

  const firstLine = lines[0];
  const sectionMatch = firstLine.match(SECTION_PATTERN);
  if (!sectionMatch) {
    errors.push(`Invalid first line: "${firstLine}". Must match /^<!-- ### (Added|Changed|Deprecated|Removed|Fixed|Security|Performance|Refactored|Documentation) -->$/`);
  } else {
    section = sectionMatch[1];
  }

  // Optional bump declaration (Issue #3480): line 2, right after the section comment.
  let entryIndex = 1;
  if (lines.length > 1 && /^<!--\s*bump\b/.test(lines[1])) {
    const bumpMatch = lines[1].match(BUMP_PATTERN);
    if (!bumpMatch) {
      errors.push(`Invalid bump declaration: "${lines[1]}". Must match ${BUMP_PATTERN}`);
    } else {
      bump = bumpMatch[1];
    }
    entryIndex = 2;
  }

  if (lines.length <= entryIndex || lines[entryIndex].trim() === '') {
    errors.push(`Fragment must contain an entry on line ${entryIndex + 1}`);
  } else {
    const entryLine = lines[entryIndex];
    const entryMatch = entryLine.match(ENTRY_PATTERN);
    if (!entryMatch) {
      errors.push(`Invalid line ${entryIndex + 1}: "${entryLine}". Must match /^- \\*\\*(feat|fix|docs|style|refactor|test|chore|ci)(\\([^)]+\\))?: .+?\\*\\* \\(#(\\d+)\\): .+$/`);
    } else {
      entry = entryLine;
      const entryIssue = parseInt(entryMatch[3], 10);
      if (issue !== null && entryIssue !== issue) {
        errors.push(`Issue number in entry (#${entryIssue}) does not match file name (#${issue})`);
      }
    }
  }

  for (let i = entryIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      errors.push(`Unexpected non-empty content on line ${i + 1}: "${lines[i]}"`);
    }
  }

  return { issue, section, bump, entry, errors };
}

/**
 * Reads all fragments in the given directory.
 *
 * @param {string} dir
 * @returns {{ fragments: Array<{ fileName: string, issue: number, section: string, bump: 'minor' | 'major' | null, entry: string }>, errors: string[] }}
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
        bump: result.bump,
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

const BUMP_RANK = { patch: 0, minor: 1, major: 2 };

/**
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Lowest version the next release may take, from the fragments' bump declarations
 * (Issue #3480). No declaration => patch bump of `current`. Deprecated fragments
 * announce only and never raise the floor.
 *
 * @param {string} current X.Y.Z
 * @param {Array<{ issue: number, section: string, bump?: 'minor' | 'major' | null }>} fragments
 * @returns {{ floor: string, level: 'patch' | 'minor' | 'major', issues: number[] }}
 */
export function computeBumpFloor(current, fragments) {
  const cur = parseVersion(current);
  if (!cur) throw new Error(`Invalid current version: "${current}"`);

  let level = 'patch';
  for (const f of fragments) {
    if (f.bump && f.section !== 'Deprecated' && BUMP_RANK[f.bump] > BUMP_RANK[level]) level = f.bump;
  }
  const issues = fragments
    .filter(f => f.bump && f.section !== 'Deprecated' && f.bump === level)
    .map(f => f.issue)
    .sort((a, b) => a - b);

  const [x, y, z] = cur;
  let floor;
  if (level === 'major') floor = x === 0 ? [1, 0, 0] : [x + 1, 0, 0];
  else if (level === 'minor') floor = [x, y + 1, 0];
  else floor = [x, y, z + 1];
  return { floor: floor.join('.'), level, issues };
}

/**
 * Checks that `next` is above `current` and not below the declared floor.
 *
 * @returns {{ ok: boolean, floor: string, issues: number[], reason: string | null }}
 */
export function checkNextVersion(current, next, fragments) {
  const { floor, level, issues } = computeBumpFloor(current, fragments);
  const n = parseVersion(next);
  if (!n) return { ok: false, floor, issues, reason: `Invalid next version: "${next}"` };
  if (compareVersions(n, parseVersion(current)) <= 0) {
    return { ok: false, floor, issues, reason: `Next version ${next} is not above current ${current}` };
  }
  if (compareVersions(n, parseVersion(floor)) < 0) {
    return {
      ok: false,
      floor,
      issues,
      reason: `Next version ${next} is below the floor ${floor} declared by bump: ${level} (Issue ${issues.map(i => `#${i}`).join(', ')})`,
    };
  }
  return { ok: true, floor, issues, reason: null };
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
  node scripts/changelog-fragments.mjs apply --version <X.Y.Z> --date <YYYY-MM-DD>
  node scripts/changelog-fragments.mjs bump-floor --current <X.Y.Z> [--next <X.Y.Z>]`;

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

  if (command === 'bump-floor') {
    let current = null;
    let next = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--current' && i + 1 < args.length) {
        current = args[++i];
      } else if (args[i] === '--next' && i + 1 < args.length) {
        next = args[++i];
      } else {
        console.error(USAGE);
        process.exit(2);
      }
    }
    if (!current || !parseVersion(current)) {
      console.error(USAGE);
      process.exit(2);
    }
    const { fragments, errors } = readFragments(path.join(root, 'changelog.d'));
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(err);
      }
      process.exit(1);
    }
    if (next === null) {
      console.log(computeBumpFloor(current, fragments).floor);
      process.exit(0);
    }
    const result = checkNextVersion(current, next, fragments);
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
    console.log(next);
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
