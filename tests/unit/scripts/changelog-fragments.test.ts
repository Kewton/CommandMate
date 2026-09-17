/**
 * Tests for CHANGELOG fragment validator and aggregator (Issue #2640).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import child_process from 'child_process';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  SECTION_ORDER,
  parseFragment,
  readFragments,
  renderSection,
  applyFragments,
} from '../../../scripts/changelog-fragments.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('parseFragment', () => {
  it('accepts valid fragment and returns empty errors', () => {
    const validContent = `<!-- ### Fixed -->\n- **fix(ui): fix tree indent** (#123): resolved indent overflow\n`;
    const result = parseFragment('123.md', validContent);
    expect(result.errors).toEqual([]);
    expect(result.issue).toBe(123);
    expect(result.section).toBe('Fixed');
    expect(result.entry).toBe('- **fix(ui): fix tree indent** (#123): resolved indent overflow');
  });

  it('rejects invalid file name "abc.md"', () => {
    const content = `<!-- ### Fixed -->\n- **fix(ui): fix tree indent** (#123): resolved indent overflow\n`;
    const result = parseFragment('abc.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid section name "Fixes"', () => {
    const content = `<!-- ### Fixes -->\n- **fix(ui): fix tree indent** (#123): resolved indent overflow\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects first line that is not a comment', () => {
    const content = `### Fixed\n- **fix(ui): fix tree indent** (#123): resolved indent overflow\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects second line with only "- " and without "**"', () => {
    const content = `<!-- ### Fixed -->\n- fix(ui): fix tree indent (#123): resolved indent overflow\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects (#N) inside "**"', () => {
    const content = `<!-- ### Fixed -->\n- **fix(ui): fix tree indent (#123)**: resolved indent overflow\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects issue number mismatch with file name', () => {
    const content = `<!-- ### Fixed -->\n- **fix(ui): fix tree indent** (#124): resolved indent overflow\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid type "perf"', () => {
    const content = `<!-- ### Performance -->\n- **perf(ui): improve render speed** (#123): 10x faster\n`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects body text on line 3', () => {
    const content = `<!-- ### Fixed -->\n- **fix(ui): fix tree indent** (#123): resolved indent overflow\nThis is extra body text`;
    const result = parseFragment('123.md', content);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('readFragments', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-changelog-d-'));
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('ignores README.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Documentation\n');
    fs.writeFileSync(
      path.join(tmpDir, '10.md'),
      `<!-- ### Fixed -->\n- **fix(cli): bug fix** (#10): details\n`
    );

    const result = readFragments(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0].fileName).toBe('10.md');
    expect(result.fragments[0].issue).toBe(10);
  });

  it('returns empty when directory does not exist', () => {
    const nonExistent = path.join(tmpDir, 'non-existent');
    const result = readFragments(nonExistent);
    expect(result).toEqual({ fragments: [], errors: [] });
  });

  it('includes file name with error for invalid fragment', () => {
    fs.writeFileSync(path.join(tmpDir, 'abc.md'), `<!-- ### Fixed -->\n- **fix(cli): test** (#10): details\n`);
    const result = readFragments(tmpDir);
    expect(result.fragments).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/^abc\.md: /);
  });
});

describe('renderSection', () => {
  it('orders sections according to SECTION_ORDER and issues descending with correct spacing', () => {
    const fragments = [
      {
        fileName: '10.md',
        issue: 10,
        section: 'Fixed',
        entry: '- **fix(cli): older fix** (#10): detail 10',
      },
      {
        fileName: '12.md',
        issue: 12,
        section: 'Fixed',
        entry: '- **fix(cli): newer fix** (#12): detail 12',
      },
      {
        fileName: '11.md',
        issue: 11,
        section: 'Added',
        entry: '- **feat(api): new feature** (#11): detail 11',
      },
    ];

    const rendered = renderSection(fragments);
    const expected = [
      '### Added',
      '',
      '- **feat(api): new feature** (#11): detail 11',
      '',
      '### Fixed',
      '',
      '- **fix(cli): newer fix** (#12): detail 12',
      '',
      '- **fix(cli): older fix** (#10): detail 10',
    ].join('\n');

    expect(rendered).toBe(expected);
  });
});

describe('applyFragments', () => {
  let tmpRoot: string;
  let changelogDir: string;
  let changelogFile: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-apply-'));
    changelogDir = path.join(tmpRoot, 'changelog.d');
    changelogFile = path.join(tmpRoot, 'CHANGELOG.md');
    fs.mkdirSync(changelogDir, { recursive: true });
  });

  afterEach(() => {
    removeTempDir(tmpRoot);
  });

  it('successfully applies fragments, replaces Unreleased section, removes fragments, and keeps README.md', () => {
    const initialChangelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
      '### Added',
      '',
      '- **feat(core): initial** (#1): initial release',
      '',
    ].join('\n');

    fs.writeFileSync(changelogFile, initialChangelog, 'utf-8');
    fs.writeFileSync(path.join(changelogDir, 'README.md'), '# README\n', 'utf-8');
    fs.writeFileSync(
      path.join(changelogDir, '10.md'),
      `<!-- ### Fixed -->\n- **fix(ui): fix bug** (#10): fixed detail\n`,
      'utf-8'
    );

    const result = applyFragments({ root: tmpRoot, version: '0.2.0', date: '2026-09-18' });
    expect(result.applied).toBe(1);
    expect(result.removed).toEqual(['10.md']);

    // Check fragment file is deleted and README.md remains
    expect(fs.existsSync(path.join(changelogDir, '10.md'))).toBe(false);
    expect(fs.existsSync(path.join(changelogDir, 'README.md'))).toBe(true);

    const updatedChangelog = fs.readFileSync(changelogFile, 'utf-8');
    const expectedChangelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.2.0] - 2026-09-18',
      '',
      '### Fixed',
      '',
      '- **fix(ui): fix bug** (#10): fixed detail',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
      '### Added',
      '',
      '- **feat(core): initial** (#1): initial release',
      '',
    ].join('\n');

    expect(updatedChangelog).toBe(expectedChangelog);
  });

  it('throws and does not modify CHANGELOG.md when fragments count is 0', () => {
    const initialChangelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n';
    fs.writeFileSync(changelogFile, initialChangelog, 'utf-8');

    expect(() => applyFragments({ root: tmpRoot, version: '0.2.0', date: '2026-09-18' })).toThrow(
      /No fragments to apply/
    );
    expect(fs.readFileSync(changelogFile, 'utf-8')).toBe(initialChangelog);
  });

  it('throws and modifies neither CHANGELOG.md nor fragments when a fragment is invalid', () => {
    const initialChangelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n';
    fs.writeFileSync(changelogFile, initialChangelog, 'utf-8');
    fs.writeFileSync(path.join(changelogDir, 'invalid.md'), 'bad content\n', 'utf-8');

    expect(() => applyFragments({ root: tmpRoot, version: '0.2.0', date: '2026-09-18' })).toThrow();
    expect(fs.readFileSync(changelogFile, 'utf-8')).toBe(initialChangelog);
    expect(fs.existsSync(path.join(changelogDir, 'invalid.md'))).toBe(true);
  });

  it('throws and modifies nothing when Unreleased section is not empty', () => {
    const initialChangelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **fix(core): existing unreleased entry** (#99): text',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(changelogFile, initialChangelog, 'utf-8');
    fs.writeFileSync(
      path.join(changelogDir, '10.md'),
      `<!-- ### Fixed -->\n- **fix(ui): fix bug** (#10): detail\n`,
      'utf-8'
    );

    expect(() => applyFragments({ root: tmpRoot, version: '0.2.0', date: '2026-09-18' })).toThrow(
      /Unreleased is not empty/
    );
    expect(fs.readFileSync(changelogFile, 'utf-8')).toBe(initialChangelog);
    expect(fs.existsSync(path.join(changelogDir, '10.md'))).toBe(true);
  });

  it('throws when ## [Unreleased] heading is missing', () => {
    const initialChangelog = '# Changelog\n\n## [0.1.0] - 2026-01-01\n';
    fs.writeFileSync(changelogFile, initialChangelog, 'utf-8');
    fs.writeFileSync(
      path.join(changelogDir, '10.md'),
      `<!-- ### Fixed -->\n- **fix(ui): fix bug** (#10): detail\n`,
      'utf-8'
    );

    expect(() => applyFragments({ root: tmpRoot, version: '0.2.0', date: '2026-09-18' })).toThrow(
      /## \[Unreleased\]/
    );
    expect(fs.readFileSync(changelogFile, 'utf-8')).toBe(initialChangelog);
    expect(fs.existsSync(path.join(changelogDir, '10.md'))).toBe(true);
  });
});

describe('CLI execution', () => {
  it('check exits 0 for repository', () => {
    const result = child_process.spawnSync(
      process.execPath,
      ['scripts/changelog-fragments.mjs', 'check'],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/changelog-fragments: \d+ fragment\(s\) OK/);
  });

  it('apply with no args exits 2', () => {
    const result = child_process.spawnSync(
      process.execPath,
      ['scripts/changelog-fragments.mjs', 'apply'],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    expect(result.status).toBe(2);
  });

  it('apply with invalid version format exits 2', () => {
    const result = child_process.spawnSync(
      process.execPath,
      ['scripts/changelog-fragments.mjs', 'apply', '--version', '1.2', '--date', '2026-09-18'],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    expect(result.status).toBe(2);
  });

  it('unknown command exits 2', () => {
    const result = child_process.spawnSync(
      process.execPath,
      ['scripts/changelog-fragments.mjs', 'unknown'],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    expect(result.status).toBe(2);
  });
});

/**
 * Non-blank lines between `## [Unreleased]` and the next `## [` heading (Issue #2641).
 *
 * Entries wait in changelog.d/ until `apply` writes them at release time. A line
 * written straight under `## [Unreleased]` brings back the conflict every parallel
 * PR used to hit there, and makes the next `apply` refuse to run.
 */
function unreleasedNonBlankLines(changelog: string): string[] {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[Unreleased\]\s*$/.test(line));
  expect(start, 'CHANGELOG.md has no `## [Unreleased]` heading').toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '');
}

describe('unreleasedNonBlankLines', () => {
  it('rejects an entry written under ## [Unreleased] (negative control)', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '',
      '- **fix(ui): fix bug** (#10): detail',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
      '### Added',
      '',
      '- **feat(core): initial** (#1): initial release',
      '',
    ].join('\n');

    expect(unreleasedNonBlankLines(changelog)).toEqual([
      '### Fixed',
      '- **fix(ui): fix bug** (#10): detail',
    ]);
  });

  it('accepts an empty section and ignores entries of released versions', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
      '### Added',
      '',
      '- **feat(core): initial** (#1): initial release',
      '',
    ].join('\n');

    expect(unreleasedNonBlankLines(changelog)).toEqual([]);
  });
});

describe('Guard: real repository changelog.d', () => {
  it('has changelog.d/README.md and readFragments reports no errors', () => {
    const changelogDir = path.join(REPO_ROOT, 'changelog.d');
    expect(fs.existsSync(path.join(changelogDir, 'README.md'))).toBe(true);

    const { errors } = readFragments(changelogDir);
    expect(errors).toEqual([]);
  });

  it('keeps ## [Unreleased] in CHANGELOG.md empty (entries go to changelog.d/<N>.md)', () => {
    const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');

    expect(
      unreleasedNonBlankLines(changelog),
      'Write the entry to changelog.d/<N>.md instead (see changelog.d/README.md); ' +
        '`node scripts/changelog-fragments.mjs apply` writes CHANGELOG.md at release time.'
    ).toEqual([]);
  });
});
