/**
 * Virtual install diff (Issue #1233)
 *
 * The classification matrix is the security-relevant part: an existing file may
 * only be described as a clean update when a receipt proves CommandMate wrote
 * it and it has not been touched since. Every other shape of "there is already
 * something there" must surface as a conflict, because the alternative is a
 * silent overwrite of the user's work.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

vi.mock('@/lib/git/git-exec', () => ({
  execGitCommand: vi.fn(),
  execFileAsync: vi.fn(),
}));

import {
  SKILL_DIFF_MAX_LINES,
  SkillDiffReason,
  SkillPreviewWarning,
  buildSkillPreviewDiff,
  buildUnifiedDiff,
  computeSkillTreeHash,
  detectLineEnding,
  findGitIgnoredPaths,
  isBinaryContent,
  readExistingSkillTree,
  readSkillGitTargetState,
  resolveSkillInstallRoot,
  skillInstallRoot,
  type SkillExistingTree,
  type SkillGitTargetState,
  type SkillPlannedFile,
} from '@/lib/skills/preview-diff';
import { execFileAsync, execGitCommand } from '@/lib/git/git-exec';

const execGitCommandMock = vi.mocked(execGitCommand);
const execFileAsyncMock = vi.mocked(execFileAsync) as unknown as ReturnType<typeof vi.fn>;

const SKILL_ID = 'demo-skill';
const ROOT = skillInstallRoot(SKILL_ID);

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(Buffer.from(bytes as never)).digest('hex');
}

function plannedFile(
  relativePath: string,
  content: string,
  overrides: Partial<SkillPlannedFile> = {}
): SkillPlannedFile {
  const bytes = Buffer.from(content, 'utf-8');
  return {
    relativePath,
    sha256: digest(bytes),
    size: bytes.byteLength,
    executable: false,
    bytes,
    generated: false,
    ...overrides,
  };
}

function existingFile(relativePath: string, content: string, executable = false) {
  const bytes = Buffer.from(content, 'utf-8');
  return { path: relativePath, sha256: digest(bytes), size: bytes.byteLength, executable, bytes };
}

function emptyTree(): SkillExistingTree {
  return { present: false, files: [], irregularPaths: [], truncated: false };
}

const CLEAN_GIT: SkillGitTargetState = {
  headState: 'attached',
  branch: 'main',
  headCommit: 'a'.repeat(40),
  dirty: false,
};

function build(
  plannedFiles: SkillPlannedFile[],
  existing: SkillExistingTree = emptyTree(),
  receiptFiles: Map<string, { sha256: string; executable: boolean }> | null = null,
  git: SkillGitTargetState = CLEAN_GIT,
  gitIgnoredPaths: Set<string> = new Set()
) {
  return buildSkillPreviewDiff({
    skillId: SKILL_ID,
    worktreePath: '/srv/worktrees/demo',
    plannedFiles,
    existing,
    receiptFiles,
    git,
    gitIgnoredPaths,
  });
}

beforeEach(() => {
  execGitCommandMock.mockReset();
  execFileAsyncMock.mockReset();
});

describe('content classification helpers', () => {
  it('treats a NUL byte near the start as binary', () => {
    expect(isBinaryContent(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryContent(Buffer.from('plain text', 'utf-8'))).toBe(false);
  });

  it('distinguishes LF, CRLF, mixed and no terminators', () => {
    expect(detectLineEnding(Buffer.from('a\nb\n'))).toBe('lf');
    expect(detectLineEnding(Buffer.from('a\r\nb\r\n'))).toBe('crlf');
    expect(detectLineEnding(Buffer.from('a\r\nb\n'))).toBe('mixed');
    expect(detectLineEnding(Buffer.from('no newline'))).toBe('none');
  });
});

describe('computeSkillTreeHash', () => {
  it('is order independent', () => {
    const a = [
      { path: 'b.md', sha256: 'b'.repeat(64), executable: false },
      { path: 'a.md', sha256: 'a'.repeat(64), executable: false },
    ];
    expect(computeSkillTreeHash(a)).toBe(computeSkillTreeHash([...a].reverse()));
  });

  it('changes when only the executable bit changes', () => {
    const base = [{ path: 'run.sh', sha256: 'c'.repeat(64), executable: false }];
    const exec = [{ path: 'run.sh', sha256: 'c'.repeat(64), executable: true }];
    expect(computeSkillTreeHash(base)).not.toBe(computeSkillTreeHash(exec));
  });

  it('gives an empty tree a stable hash', () => {
    expect(computeSkillTreeHash([])).toBe(computeSkillTreeHash([]));
    expect(computeSkillTreeHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveSkillInstallRoot', () => {
  it('resolves under the worktree', () => {
    expect(resolveSkillInstallRoot('/srv/wt', SKILL_ID)).toBe(
      path.join('/srv/wt', '.agents/skills', SKILL_ID)
    );
  });

  it.each(['../escape', 'a/../../b', '/abs', '.hidden', 'Upper', 'a\0b'])(
    'rejects %s',
    (badId) => {
      expect(() => resolveSkillInstallRoot('/srv/wt', badId)).toThrow();
    }
  );
});

describe('buildUnifiedDiff', () => {
  it('renders a pure addition as all + lines', () => {
    const body = buildUnifiedDiff(null, Buffer.from('one\ntwo\n'), { remainingBytes: 1e6 });
    expect(body.additions).toBe(2);
    expect(body.deletions).toBe(0);
    expect(body.text).toContain('+one');
    expect(body.text).toContain('+two');
    expect(body.text).toMatch(/^@@ -0,0 \+1,2 @@/);
  });

  it('emits nothing when both sides are identical', () => {
    const bytes = Buffer.from('same\n');
    expect(buildUnifiedDiff(bytes, bytes, { remainingBytes: 1e6 }).text).toBeNull();
  });

  it('keeps common context out of the change region', () => {
    const before = Buffer.from('a\nb\nc\n');
    const after = Buffer.from('a\nB\nc\n');
    const body = buildUnifiedDiff(before, after, { remainingBytes: 1e6 });
    expect(body.additions).toBe(1);
    expect(body.deletions).toBe(1);
    expect(body.text).toContain('-b');
    expect(body.text).toContain('+B');
    expect(body.text).toContain(' a');
  });

  it('truncates instead of emitting an unbounded body', () => {
    const huge = Buffer.from(Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'));
    const body = buildUnifiedDiff(null, huge, { remainingBytes: 1e6 });
    expect(body.truncated).toBe(true);
    expect(body.text).toContain('… diff truncated');
    expect((body.text ?? '').split('\n').length).toBeLessThanOrEqual(SKILL_DIFF_MAX_LINES + 2);
  });

  it('stops once the shared budget is spent', () => {
    const budget = { remainingBytes: 40 };
    const first = buildUnifiedDiff(null, Buffer.from('x'.repeat(200)), budget);
    expect(first.truncated).toBe(true);
    expect(budget.remainingBytes).toBeLessThan(40);

    const second = buildUnifiedDiff(null, Buffer.from('y'.repeat(200)), budget);
    expect(second.truncated).toBe(true);
    expect(budget.remainingBytes).toBe(0);
  });

  it('keeps a CRLF payload distinguishable from its LF twin', () => {
    const body = buildUnifiedDiff(Buffer.from('a\n'), Buffer.from('a\r\n'), {
      remainingBytes: 1e6,
    });
    expect(body.text).not.toBeNull();
    expect(body.additions).toBe(1);
  });
});

describe('buildSkillPreviewDiff — classification', () => {
  it('marks every package file as add on an empty destination', () => {
    const preview = build([plannedFile('SKILL.md', '# demo\n')]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      path: `${ROOT}/SKILL.md`,
      change: 'add',
      reason: SkillDiffReason.NEW_FILE,
    });
    expect(preview.stats.added).toBe(1);
    expect(preview.currentTreeHash).toBe(computeSkillTreeHash([]));
  });

  it('classifies an existing file with no receipt as unmanaged, never as an overwrite', () => {
    const preview = build([plannedFile('SKILL.md', 'new\n')], {
      present: true,
      files: [existingFile('SKILL.md', 'hand written\n')],
      irregularPaths: [],
      truncated: false,
    });
    expect(preview.entries[0].change).toBe('unmanaged');
    expect(preview.entries[0].reason).toBe(SkillDiffReason.UNMANAGED_SKILL);
    expect(preview.stats.unmanaged).toBe(1);
  });

  it('classifies a receipt-recorded file that was edited locally as a conflict', () => {
    const recorded = existingFile('SKILL.md', 'as installed\n');
    const drifted = existingFile('SKILL.md', 'user edited\n');
    const preview = build(
      [plannedFile('SKILL.md', 'v2\n')],
      { present: true, files: [drifted], irregularPaths: [], truncated: false },
      new Map([['SKILL.md', { sha256: recorded.sha256, executable: false }]])
    );
    expect(preview.entries[0].change).toBe('conflict');
    expect(preview.entries[0].reason).toBe(SkillDiffReason.LOCAL_MODIFICATION);
  });

  it('classifies an untouched managed file as modify when the package supersedes it', () => {
    const installed = existingFile('SKILL.md', 'v1\n');
    const preview = build(
      [plannedFile('SKILL.md', 'v2\n')],
      { present: true, files: [installed], irregularPaths: [], truncated: false },
      new Map([['SKILL.md', { sha256: installed.sha256, executable: false }]])
    );
    expect(preview.entries[0].change).toBe('modify');
    expect(preview.entries[0].reason).toBe(SkillDiffReason.MANAGED_UPDATE);
    expect(preview.entries[0].diff).toContain('+v2');
  });

  it('classifies a byte-identical managed file as unchanged with no diff body', () => {
    const installed = existingFile('SKILL.md', 'same\n');
    const preview = build(
      [plannedFile('SKILL.md', 'same\n')],
      { present: true, files: [installed], irregularPaths: [], truncated: false },
      new Map([['SKILL.md', { sha256: installed.sha256, executable: false }]])
    );
    expect(preview.entries[0].change).toBe('unchanged');
    expect(preview.entries[0].diff).toBeNull();
  });

  it('treats a mode-only change as a modify rather than unchanged', () => {
    const installed = existingFile('run.sh', 'echo hi\n', false);
    const preview = build(
      [plannedFile('run.sh', 'echo hi\n', { executable: true })],
      { present: true, files: [installed], irregularPaths: [], truncated: false },
      new Map([['run.sh', { sha256: installed.sha256, executable: false }]])
    );
    expect(preview.entries[0].change).toBe('modify');
  });

  it('surfaces a receipt-recorded file the package no longer ships', () => {
    const orphan = existingFile('legacy.md', 'old\n');
    const preview = build(
      [plannedFile('SKILL.md', 'v2\n')],
      { present: true, files: [orphan], irregularPaths: [], truncated: false },
      new Map([['legacy.md', { sha256: orphan.sha256, executable: false }]])
    );
    const entry = preview.entries.find((e) => e.path.endsWith('legacy.md'));
    expect(entry?.change).toBe('unmanaged');
    expect(entry?.reason).toBe(SkillDiffReason.RECEIPT_ORPHAN);
  });

  it('reports a non-regular entry as a conflict', () => {
    const preview = build([plannedFile('SKILL.md', 'x\n')], {
      present: true,
      files: [],
      irregularPaths: ['link.md'],
      truncated: false,
    });
    const entry = preview.entries.find((e) => e.path.endsWith('link.md'));
    expect(entry?.change).toBe('conflict');
    expect(entry?.reason).toBe(SkillDiffReason.NOT_A_REGULAR_FILE);
  });

  it('lists the generated receipt as a planned write like any other file', () => {
    const preview = build([
      plannedFile('SKILL.md', '# demo\n'),
      plannedFile('.commandmate-receipt.json', '{"a":1}', { generated: true }),
    ]);
    const receipt = preview.entries.find((e) => e.path.endsWith('.commandmate-receipt.json'));
    expect(receipt?.generated).toBe(true);
    expect(receipt?.change).toBe('add');
  });

  it('folds the planned files into the planned tree hash', () => {
    const files = [plannedFile('SKILL.md', '# demo\n')];
    const preview = build(files);
    expect(preview.plannedTreeHash).toBe(
      computeSkillTreeHash([
        { path: 'SKILL.md', sha256: files[0].sha256, executable: false },
      ])
    );
    expect(preview.plannedTreeHash).not.toBe(preview.currentTreeHash);
  });

  it('keeps an untouched existing file in the planned tree hash', () => {
    const keeper = existingFile('extra.md', 'keep\n');
    const preview = build([plannedFile('SKILL.md', '# demo\n')], {
      present: true,
      files: [keeper],
      irregularPaths: [],
      truncated: false,
    });
    expect(preview.plannedTreeHash).toBe(
      computeSkillTreeHash([
        { path: 'SKILL.md', sha256: digest(Buffer.from('# demo\n')), executable: false },
        { path: 'extra.md', sha256: keeper.sha256, executable: false },
      ])
    );
  });
});

describe('buildSkillPreviewDiff — warnings', () => {
  it('reports a detached HEAD rather than an absent branch', () => {
    const preview = build([plannedFile('SKILL.md', 'x\n')], emptyTree(), null, {
      headState: 'detached',
      branch: null,
      headCommit: 'b'.repeat(40),
      dirty: false,
    });
    expect(preview.warnings).toContain(SkillPreviewWarning.DETACHED_HEAD);
  });

  it('reports an unborn HEAD', () => {
    const preview = build([plannedFile('SKILL.md', 'x\n')], emptyTree(), null, {
      headState: 'unborn',
      branch: 'main',
      headCommit: null,
      dirty: false,
    });
    expect(preview.warnings).toContain(SkillPreviewWarning.UNBORN_HEAD);
  });

  it('reports a dirty working tree', () => {
    const preview = build([plannedFile('SKILL.md', 'x\n')], emptyTree(), null, {
      ...CLEAN_GIT,
      dirty: true,
    });
    expect(preview.warnings).toContain(SkillPreviewWarning.WORKING_TREE_DIRTY);
  });

  it('reports an ignored destination instead of silently writing an invisible file', () => {
    const preview = build(
      [plannedFile('SKILL.md', 'x\n')],
      emptyTree(),
      null,
      CLEAN_GIT,
      new Set([`${ROOT}/SKILL.md`])
    );
    expect(preview.entries[0].gitIgnored).toBe(true);
    expect(preview.warnings).toContain(SkillPreviewWarning.PATH_GIT_IGNORED);
  });

  it('reports binary content and omits its diff body', () => {
    const preview = build([plannedFile('logo.png', 'PNG ')]);
    expect(preview.entries[0].binary).toBe(true);
    expect(preview.entries[0].diff).toBeNull();
    expect(preview.warnings).toContain(SkillPreviewWarning.BINARY_CONTENT);
  });

  it('reports a CRLF payload', () => {
    const preview = build([plannedFile('SKILL.md', 'a\r\nb\r\n')]);
    expect(preview.entries[0].lineEnding).toBe('crlf');
    expect(preview.warnings).toContain(SkillPreviewWarning.LINE_ENDING_CRLF);
  });

  it('reports truncation', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const preview = build([plannedFile('big.md', huge)]);
    expect(preview.stats.truncatedFiles).toBe(1);
    expect(preview.warnings).toContain(SkillPreviewWarning.DIFF_TRUNCATED);
  });

  it('reports an incomplete scan of the destination', () => {
    const preview = build([plannedFile('SKILL.md', 'x\n')], {
      present: true,
      files: [],
      irregularPaths: [],
      truncated: true,
    });
    expect(preview.warnings).toContain(SkillPreviewWarning.TREE_SCAN_TRUNCATED);
  });

  it('emits no warnings for a clean install onto an empty destination', () => {
    expect(build([plannedFile('SKILL.md', 'x\n')]).warnings).toEqual([]);
  });
});

describe('readExistingSkillTree', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-skill-tree-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports an absent directory as not present', () => {
    const tree = readExistingSkillTree(path.join(tmp, 'missing'));
    expect(tree).toEqual({ present: false, files: [], irregularPaths: [], truncated: false });
  });

  it('lists regular files with their digests and mode', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# demo\n');
    fs.writeFileSync(path.join(tmp, 'scripts/run.sh'), 'echo hi\n', { mode: 0o755 });

    const tree = readExistingSkillTree(tmp);
    expect(tree.present).toBe(true);
    expect(tree.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(tree.files.find((f) => f.path === 'SKILL.md')?.sha256).toBe(digest('# demo\n'));
    expect(tree.files.find((f) => f.path === 'scripts/run.sh')?.executable).toBe(true);
  });

  it('records a symlink as irregular rather than following it', () => {
    fs.writeFileSync(path.join(tmp, 'real.md'), 'real\n');
    fs.symlinkSync('/etc/passwd', path.join(tmp, 'escape.md'));

    const tree = readExistingSkillTree(tmp);
    expect(tree.irregularPaths).toContain('escape.md');
    expect(tree.files.map((f) => f.path)).toEqual(['real.md']);
  });

  it('reports a file where the install root should be as irregular', () => {
    const file = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(readExistingSkillTree(file)).toMatchObject({ present: true, irregularPaths: [''] });
  });
});

describe('readSkillGitTargetState', () => {
  function stubGit(values: Record<string, string | null>) {
    execGitCommandMock.mockImplementation(async (args: string[]) => values[args[0]] ?? null);
  }

  it('reports an attached HEAD', async () => {
    stubGit({ 'symbolic-ref': 'feature/x', 'rev-parse': 'c'.repeat(40), status: '' });
    await expect(readSkillGitTargetState('/wt')).resolves.toEqual({
      headState: 'attached',
      branch: 'feature/x',
      headCommit: 'c'.repeat(40),
      dirty: false,
    });
  });

  it('reports a detached HEAD with its commit', async () => {
    stubGit({ 'symbolic-ref': null, 'rev-parse': 'd'.repeat(40), status: '' });
    await expect(readSkillGitTargetState('/wt')).resolves.toMatchObject({
      headState: 'detached',
      branch: null,
      headCommit: 'd'.repeat(40),
    });
  });

  it('reports an unborn HEAD with no commit', async () => {
    stubGit({ 'symbolic-ref': 'main', 'rev-parse': null, status: '' });
    await expect(readSkillGitTargetState('/wt')).resolves.toMatchObject({
      headState: 'unborn',
      branch: 'main',
      headCommit: null,
    });
  });

  it('reports an unresolvable HEAD as unknown rather than attached', async () => {
    stubGit({ 'symbolic-ref': null, 'rev-parse': null, status: null });
    await expect(readSkillGitTargetState('/wt')).resolves.toMatchObject({
      headState: 'unknown',
      headCommit: null,
    });
  });

  it('rejects an abbreviated commit as no commit at all', async () => {
    stubGit({ 'symbolic-ref': 'main', 'rev-parse': 'abc1234', status: '' });
    await expect(readSkillGitTargetState('/wt')).resolves.toMatchObject({
      headState: 'unborn',
      headCommit: null,
    });
  });

  it('reports a dirty working tree', async () => {
    stubGit({ 'symbolic-ref': 'main', 'rev-parse': 'e'.repeat(40), status: ' M a.txt' });
    await expect(readSkillGitTargetState('/wt')).resolves.toMatchObject({ dirty: true });
  });
});

describe('findGitIgnoredPaths', () => {
  it('returns nothing without invoking git for an empty list', async () => {
    await expect(findGitIgnoredPaths('/wt', [])).resolves.toEqual(new Set());
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('parses the NUL-separated match list', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: `${ROOT}/SKILL.md\0`, stderr: '' });
    await expect(findGitIgnoredPaths('/wt', [`${ROOT}/SKILL.md`])).resolves.toEqual(
      new Set([`${ROOT}/SKILL.md`])
    );
  });

  it('treats the exit-1 "nothing matched" case as no matches, not an error', async () => {
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stdout: '' }));
    await expect(findGitIgnoredPaths('/wt', [`${ROOT}/SKILL.md`])).resolves.toEqual(new Set());
  });

  it('falls back to no matches when git fails without output', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('git missing'));
    await expect(findGitIgnoredPaths('/wt', [`${ROOT}/SKILL.md`])).resolves.toEqual(new Set());
  });
});
