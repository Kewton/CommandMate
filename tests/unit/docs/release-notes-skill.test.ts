/**
 * Verify release notes steps in the release skill and guides (Issue #2652).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReleaseNote } from '@/lib/app-update/release-notes';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILL_MD_PATH = path.join(REPO_ROOT, '.claude/skills/release/SKILL.md');
const RELEASE_GUIDE_JA_PATH = path.join(REPO_ROOT, 'docs/release-guide.md');
const RELEASE_GUIDE_EN_PATH = path.join(REPO_ROOT, 'docs/en/release-guide.md');

describe('release notes steps in release skill and guides', () => {
  const skillContent = fs.readFileSync(SKILL_MD_PATH, 'utf-8');

  it('contains 2-2a, 2-2b, and 2-3 in strict sequential order', () => {
    const idx22a = skillContent.indexOf('### 2-2a. ');
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');

    expect(idx22a).toBeGreaterThan(-1);
    expect(idx22b).toBeGreaterThan(idx22a);
    expect(idx23).toBeGreaterThan(idx22b);
  });

  it('provides a valid release note JSON example in section 2-2b', () => {
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');
    const section22b = skillContent.slice(idx22b, idx23);

    const jsonMatch = /```json\s*\n([\s\S]*?)\n```/.exec(section22b);
    expect(jsonMatch).not.toBeNull();

    const raw = JSON.parse(jsonMatch![1]);
    const parsed = parseReleaseNote(raw, raw.version);
    expect(parsed).not.toBeNull();
  });

  it('negative control: rejecting invalid release note when date is missing', () => {
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');
    const section22b = skillContent.slice(idx22b, idx23);

    const jsonMatch = /```json\s*\n([\s\S]*?)\n```/.exec(section22b);
    expect(jsonMatch).not.toBeNull();

    const raw = JSON.parse(jsonMatch![1]);
    const invalidRaw = { ...raw };
    delete (invalidRaw as Record<string, unknown>).date;

    expect(parseReleaseNote(invalidRaw, raw.version)).toBeNull();
  });

  it('contains the validation command line in section 2-2b', () => {
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');
    const section22b = skillContent.slice(idx22b, idx23);

    expect(section22b).toMatch(
      /^npx vitest run tests\/unit\/release-notes\/release-notes-files\.test\.ts > \/tmp\/rel-notes\.log 2>&1; echo "NOTES=\$\?"$/m,
    );
  });

  it('does not contain node -e in section 2-2b to preserve 2-2a script extraction', () => {
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');
    const section22b = skillContent.slice(idx22b, idx23);

    expect(section22b).not.toContain("node -e '");
  });

  it('contains exclusion conventions and plain text requirement in section 2-2b', () => {
    const idx22b = skillContent.indexOf('### 2-2b. リリースノート（release-notes/X.Y.Z.json）');
    const idx23 = skillContent.indexOf('### 2-3. ');
    const section22b = skillContent.slice(idx22b, idx23);

    expect(section22b).toContain('fix(test');
    expect(section22b).toContain('docs(');
    expect(section22b).toContain('chore(');
    expect(section22b).toContain('ci(');
    expect(section22b).toContain('refactor(');
    expect(section22b).toContain('プレーンテキスト');
  });

  it('stages release-notes and updates staged file description in section 2-4', () => {
    const idx24 = skillContent.indexOf('### 2-4. ');
    const idxPhase3 = skillContent.indexOf('## Phase 3');
    expect(idx24).toBeGreaterThan(-1);
    expect(idxPhase3).toBeGreaterThan(idx24);

    const section24 = skillContent.slice(idx24, idxPhase3);
    expect(section24).toMatch(/^git add "release-notes\/\$\{NEXT_VERSION\}\.json"$/m);
    expect(section24).toContain('上記 5 ファイル');
    expect(section24).toContain('基本 5 ファイルのみ');
    expect(section24).toContain('release-notes/X.Y.Z.json');
  });

  it('preserves the original landing page git add line in SKILL.md', () => {
    expect(skillContent).toMatch(
      /^git add package\.json package-lock\.json CHANGELOG\.md website\/index\.html$/m,
    );
  });

  it('includes release-notes and the validation test path in both release guides', () => {
    const releaseGuideJa = fs.readFileSync(RELEASE_GUIDE_JA_PATH, 'utf-8');
    const releaseGuideEn = fs.readFileSync(RELEASE_GUIDE_EN_PATH, 'utf-8');

    expect(releaseGuideJa).toContain('release-notes/');
    expect(releaseGuideJa).toContain('tests/unit/release-notes/release-notes-files.test.ts');
    expect(releaseGuideEn).toContain('release-notes/');
    expect(releaseGuideEn).toContain('tests/unit/release-notes/release-notes-files.test.ts');
  });
});
