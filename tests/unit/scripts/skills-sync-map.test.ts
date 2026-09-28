import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { counterpartPathOf, updateMap } from '../../../scripts/skills-sync-map.mjs';

describe('counterpartPathOf', () => {
  const pkg = { local: '.claude/skills/cmate-verify', counterpart: 'skills/cmate-verify' };

  it('prefers file.counterpartPath when present', () => {
    const file = {
      path: 'scripts/tests/fixtures/all-pass.yaml',
      counterpartPath: 'tests/fixtures/cmate-verify/fixtures/all-pass.yaml',
      policy: 'byte-identical',
      sha256: 'x',
    };
    expect(counterpartPathOf(pkg, file)).toBe(
      'tests/fixtures/cmate-verify/fixtures/all-pass.yaml',
    );
  });

  it('falls back to `${pkg.counterpart}/${file.path}` when counterpartPath is absent', () => {
    const file = { path: 'scripts/monitor.sh', policy: 'port-required', sha256: 'x' };
    expect(counterpartPathOf(pkg, file)).toBe('skills/cmate-verify/scripts/monitor.sh');
  });
});

describe('updateMap counterpartPath inference (Issue #2911)', () => {
  let tempDir: string;
  let repoRoot: string;
  let mapPath: string;
  let pkgLocal: string;
  let pkgDir: string;
  let counterpartDir: string;

  function sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  function setupFixture(options: {
    existingFiles?: Array<{ path: string; counterpartPath?: string; content?: string }>;
    newFiles?: Array<{ path: string; content?: string }>;
    counterpartFiles?: Array<{ path: string; content?: string }>;
  }) {
    const files = (options.existingFiles ?? []).map((f) => {
      const fullPath = path.join(pkgDir, f.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const content = f.content ?? 'existing content';
      fs.writeFileSync(fullPath, content);
      return {
        path: f.path,
        ...(f.counterpartPath ? { counterpartPath: f.counterpartPath } : {}),
        policy: 'byte-identical',
        sha256: sha256(content),
      };
    });

    for (const nf of options.newFiles ?? []) {
      const fullPath = path.join(pkgDir, nf.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, nf.content ?? 'new content');
    }

    for (const cf of options.counterpartFiles ?? []) {
      const fullPath = path.join(counterpartDir, cf.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, cf.content ?? 'counterpart content');
    }

    const map = {
      packages: [
        {
          local: pkgLocal,
          counterpart: 'skills/test-skill',
          policy: 'mapped',
          files,
        },
      ],
    };

    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-map-test-'));
    repoRoot = tempDir;
    pkgLocal = '.claude/skills/test-skill';
    pkgDir = path.join(tempDir, pkgLocal);
    mapPath = path.join(tempDir, '.claude/skills/sync-map.json');
    counterpartDir = path.join(tempDir, 'counterpart');
    fs.mkdirSync(counterpartDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('infers counterpartPath and assigns policy: port-required with REVIEW: note when existing entries in same directory point to tests/fixtures/x/<name>', () => {
    setupFixture({
      existingFiles: [
        {
          path: 'scripts/tests/fixtures/all-pass.yaml',
          counterpartPath: 'tests/fixtures/x/all-pass.yaml',
        },
        {
          path: 'scripts/tests/fixtures/bad-anchor.yaml',
          counterpartPath: 'tests/fixtures/x/bad-anchor.yaml',
        },
      ],
      newFiles: [
        {
          path: 'scripts/tests/fixtures/env-clean-ignore-block.yaml',
          content: 'new-fixture-content',
        },
      ],
    });

    const exitCode = updateMap({ repoRoot, mapPath });
    expect(exitCode).toBe(0);

    const updated = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const newEntry = updated.packages[0].files.find(
      (f: { path: string }) => f.path === 'scripts/tests/fixtures/env-clean-ignore-block.yaml',
    );

    expect(newEntry).toBeDefined();
    expect(newEntry.counterpartPath).toBe('tests/fixtures/x/env-clean-ignore-block.yaml');
    expect(newEntry.policy).toBe('port-required');
    expect(newEntry.note).toMatch(/^REVIEW:/);
    expect(newEntry.sha256).toBe(sha256('new-fixture-content'));
  });

  it('does not infer counterpartPath when existing entries in same directory do not have counterpartPath', () => {
    setupFixture({
      existingFiles: [
        {
          path: 'scripts/tests/fixtures/existing.yaml',
        },
      ],
      newFiles: [
        {
          path: 'scripts/tests/fixtures/new-fixture.yaml',
        },
      ],
    });

    const exitCode = updateMap({ repoRoot, mapPath });
    expect(exitCode).toBe(0);

    const updated = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const newEntry = updated.packages[0].files.find(
      (f: { path: string }) => f.path === 'scripts/tests/fixtures/new-fixture.yaml',
    );

    expect(newEntry).toBeDefined();
    expect(newEntry.counterpartPath).toBeUndefined();
    expect(newEntry.policy).toBe('port-required');
    expect(newEntry.note).toMatch(/^REVIEW:/);
  });

  it('does not infer counterpartPath when counterpart directories differ across existing entries in same directory', () => {
    setupFixture({
      existingFiles: [
        {
          path: 'scripts/tests/fixtures/file1.yaml',
          counterpartPath: 'tests/fixtures/dir-a/file1.yaml',
        },
        {
          path: 'scripts/tests/fixtures/file2.yaml',
          counterpartPath: 'tests/fixtures/dir-b/file2.yaml',
        },
      ],
      newFiles: [
        {
          path: 'scripts/tests/fixtures/new-fixture.yaml',
        },
      ],
    });

    const exitCode = updateMap({ repoRoot, mapPath });
    expect(exitCode).toBe(0);

    const updated = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const newEntry = updated.packages[0].files.find(
      (f: { path: string }) => f.path === 'scripts/tests/fixtures/new-fixture.yaml',
    );

    expect(newEntry).toBeDefined();
    expect(newEntry.counterpartPath).toBeUndefined();
    expect(newEntry.policy).toBe('port-required');
    expect(newEntry.note).toMatch(/^REVIEW:/);
  });

  it('does not infer counterpartPath when existing entries in same directory change their basename', () => {
    setupFixture({
      existingFiles: [
        {
          path: 'scripts/tests/fixtures/original-name.yaml',
          counterpartPath: 'tests/fixtures/x/renamed-name.yaml',
        },
      ],
      newFiles: [
        {
          path: 'scripts/tests/fixtures/new-fixture.yaml',
        },
      ],
    });

    const exitCode = updateMap({ repoRoot, mapPath });
    expect(exitCode).toBe(0);

    const updated = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const newEntry = updated.packages[0].files.find(
      (f: { path: string }) => f.path === 'scripts/tests/fixtures/new-fixture.yaml',
    );

    expect(newEntry).toBeDefined();
    expect(newEntry.counterpartPath).toBeUndefined();
    expect(newEntry.policy).toBe('port-required');
    expect(newEntry.note).toMatch(/^REVIEW:/);
  });

  it('emits warning when --counterpart is provided and counterpart file does not exist, keeping exit code 0', () => {
    setupFixture({
      existingFiles: [
        {
          path: 'scripts/tests/fixtures/all-pass.yaml',
          counterpartPath: 'tests/fixtures/x/all-pass.yaml',
        },
      ],
      newFiles: [
        {
          path: 'scripts/tests/fixtures/missing-on-counterpart.yaml',
        },
      ],
      counterpartFiles: [
        {
          path: 'tests/fixtures/x/all-pass.yaml',
        },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const exitCode = updateMap({ repoRoot, mapPath, counterpartDir });
    expect(exitCode).toBe(0);

    expect(warnSpy).toHaveBeenCalledWith(
      'warning: scripts/tests/fixtures/missing-on-counterpart.yaml has no counterpart at tests/fixtures/x/missing-on-counterpart.yaml',
    );
  });
});
