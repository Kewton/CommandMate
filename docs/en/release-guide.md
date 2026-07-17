[日本語版](../release-guide.md)

# Release Guide

This document explains the version upgrade and release procedures for CommandMate.

## Semantic Versioning

This project follows [Semantic Versioning](https://semver.org/).

### Version Format

```
MAJOR.MINOR.PATCH
```

| Type | When to bump | Example |
|------|--------------|---------|
| **MAJOR** | Breaking changes (backward-incompatible) | v1.0.0 → v2.0.0 |
| **MINOR** | Backward-compatible feature additions | v1.0.0 → v1.1.0 |
| **PATCH** | Backward-compatible bug fixes | v1.0.0 → v1.0.1 |

### Version Decision Criteria

| Change | Version type |
|--------|--------------|
| Removing or changing an API | MAJOR |
| Changing a config file format | MAJOR |
| Renaming an environment variable (without fallback) | MAJOR |
| Adding a feature | MINOR |
| Adding an API | MINOR |
| Adding a config option | MINOR |
| Bug fix | PATCH |
| Documentation fix | PATCH |
| Refactoring (no behaviour change) | PATCH |
| Dependency update (no behaviour change) | PATCH |

---

## Release Flow Overview

```
Bump version on develop (package.json / package-lock.json / CHANGELOG.md)
   ↓  chore: release vX.Y.Z
PR "release: vX.Y.Z" (develop → main)  -- review approval required
   ↓  squash merge
Tag vX.Y.Z on main (annotated)
   ↓
Create GitHub Release  --->  publish.yml fires  --->  npm publish (automatic, OIDC)
   ↓
Merge main back into develop (-s ours, restores ancestry)
```

### Three premises to internalise

| Premise | Why |
|---|---|
| **You cannot push to main directly** | `.git/hooks/pre-push` rejects it via `protected_branch='main'`. A PR is the only path |
| **Creating a GitHub Release publishes to npm** | `.github/workflows/publish.yml` fires on `release: [published]` and runs `npm publish`. Creating the Release *is* publishing |
| **The back-merge is mandatory** | The develop → main PR is squashed, which severs develop's ancestry. Skip it and the next PR shows phantom conflicts |

---

## Release Procedure

### Preparation

1. **Bring `develop` up to date** (releases are cut from develop, not main)

   ```bash
   git checkout develop
   git pull origin develop
   git rev-list --left-right --count develop...origin/develop   # must be 0  0
   ```

2. **Confirm there are no uncommitted changes**

   ```bash
   git status --porcelain    # must be empty
   ```

   > Avoid `git stash`. If another agent is working in the same tree, it will corrupt their work.

3. **Confirm all quality checks pass**

   ```bash
   npm run lint
   npx tsc --noEmit
   npm run test:unit
   npm run build
   ```

4. **Confirm there are actually changes not yet on main**

   ```bash
   git fetch origin
   git diff --stat origin/main..origin/develop
   ```

   > **Note**: `git log origin/main..origin/develop` reports far more commits than reality because of squashing (e.g. 136 commits for a 15-file diff). **The tree diff (`git diff`) is authoritative.**

### Step 1: Determine Version

```bash
node -p "require('./package.json').version"
```

Pick the next version using the criteria above.

### Step 2: Update package.json / package-lock.json

```bash
npm version 0.10.1 --no-git-tag-version
```

`npm version` keeps package.json and **both places in package-lock.json (root and `packages[""]`)** consistent. Do not hand-edit them.

`--no-git-tag-version` is required — without it npm creates a tag, which collides with the PR flow below.

### Step 3: Update CHANGELOG.md

Insert a new section directly below `## [Unreleased]`.

```markdown
## [Unreleased]

## [0.10.1] - 2026-07-17

> **Highlight**: Two to four sentences on what this release is about -- what was wrong and what changed. Include measured numbers where you have them.

### Added

- feat(scope): **Bold the point**. Supporting detail (#1234)

### Changed

- fix(docs): **The point**. Supporting detail (#1234)

### Fixed

- fix(cli): **The point**. Supporting detail (#1234)

## [0.10.0] - 2026-07-16
```

Conventions:

- **Do not add compare links** (`[X.Y.Z]: https://github.com/.../compare/...`). They stop at `0.5.2` and have not been added since (leave the existing old ones in place)
- Issue references use the **`(#1234)` form**. `(Issue #1234)` is the pre-v0.9.1 style
- Prefix each entry with a conventional-commit scope (`feat(scope):`, `fix(scope):`, ...)
- Dates are JST-based
- Omit category headings that have no entries

See [`templates/changelog-entry.md`](../../.claude/skills/release/templates/changelog-entry.md) for details.

### Step 4: Commit & push

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.10.1"
git push origin develop
```

Verify with `git diff --stat` that **only these three files** changed.

### Step 5: Release PR (develop → main)

```bash
gh pr create --repo Kewton/CommandMate --base main --head develop \
  --title "release: v0.10.1" \
  --body-file <(...)
```

The PR body should cover:

- **Summary**: what this release is for
- **Version**: `0.10.0 → 0.10.1` (patch/minor/major)
- **DB migration**: whether there is one (and the `CURRENT_SCHEMA_VERSION` transition if so)
- **Actual diff**: the real numbers from `git diff --stat origin/main..origin/develop`, with a note that the commit count in `main..develop` is inflated by squash history
- **Issues covered**
- **Main changes**: Added / Changed / Fixed
- **Quality check** results

Then watch CI:

```bash
gh pr checks <PR-number> --repo Kewton/CommandMate --watch
```

> **PRs targeting main require at least one review approval** (see [CLAUDE.md](../../CLAUDE.md)). Merge with **squash** once approved.

### Step 6: Create and push the tag

Run this after the merge.

```bash
git fetch origin --tags
MERGE_SHA=$(gh pr view <PR-number> --repo Kewton/CommandMate --json mergeCommit -q '.mergeCommit.oid')

# main and develop must have identical trees (proves there is no content drift)
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse origin/develop^{tree})" ] && echo "trees match"

git tag -a "v0.10.1" "$MERGE_SHA" -m "v0.10.1"
git push origin "v0.10.1"
```

The tag must be **annotated** (`-a`) -- every existing tag is.

### Step 7: Create the GitHub Release -- this triggers npm publish

Release notes are the **CHANGELOG section, transcribed verbatim** (`--generate-notes` is the pre-v0.10.0 style).

```bash
awk '/^## \[0\.10\.1\]/{f=1} /^## \[0\.10\.0\]/{f=0} f' CHANGELOG.md > /tmp/release-notes.md

gh release create "v0.10.1" --repo Kewton/CommandMate \
  --title "v0.10.1" \
  --notes-file /tmp/release-notes.md
```

> ⚠️ **`publish.yml` fires at this moment and npm publish begins.** Creating the Release *is* publishing to npm. It cannot be undone (see below).

### Step 8: Confirm the publish workflow completed

```bash
gh run list --repo Kewton/CommandMate --workflow=publish.yml --limit 1
# wait for status=completed conclusion=success

npm view commandmate version    # should be the new version
```

### Step 9: Merge main back into develop (restore ancestry)

**Mandatory.** Squashing means main's commit is no longer an ancestor of develop. Skip this and the next develop → main PR will show phantom conflicts.

```bash
git checkout develop
git pull origin develop
git merge -s ours origin/main -m "chore: merge release v0.10.1 to develop (restore ancestry)"

# verify the tree survived (-s ours keeps develop's tree)
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse develop^{tree})" ] && echo "trees match"

git push origin develop
```

Confirm it worked:

```bash
git fetch origin
git merge-base --is-ancestor origin/main origin/develop && echo "ancestry restored"
```

---

## About publishing to npm

**Do not run `npm publish` locally.**

`.github/workflows/publish.yml` runs `npm publish --provenance --access public` via npm Trusted Publishers (OIDC authentication), triggered by the GitHub Release `published` event.

- There are no publish credentials locally
- OIDC only works inside a GitHub Actions run
- A local publish would ship without provenance

If the workflow fails, fix the cause -- do not work around it with a local publish.

### What the workflow does

`npm ci` → `npm audit --audit-level=critical` → `npm run test:unit` → `npm run build` → `npm run build:cli` → `npm run build:server` → package size check → `npm publish --provenance --access public`

---

## Post-release verification

```bash
# tags
git tag -l --sort=-v:refname | head -3

# GitHub Release
gh release view v0.10.1

# npm
npm view commandmate version
npm view commandmate@0.10.1 dist --json    # size and provenance

# fetch it for real from a clean environment (run this OUTSIDE the repo)
cd $(mktemp -d) && npx --yes commandmate@latest --version
```

> Run the `npx` check from a **neutral directory outside the repository**. Inside the CommandMate repo, npx resolves the local `bin` instead, so you would not be verifying the published artifact at all.

---

## Releasing with the Claude Code Skill

The [`/release`](../../.claude/skills/release/SKILL.md) skill runs the procedure above.

```bash
/release patch      # patch bump (0.10.0 → 0.10.1)
/release minor      # minor bump (0.10.0 → 0.11.0)
/release major      # major bump (0.10.0 → 1.0.0)
/release 1.0.0      # explicit version
```

The skill does not merge the PR either -- approval is required.

---

## Troubleshooting

### Push to main was rejected

```
❌ Error: Direct push to 'main' is not allowed.
   Please create a Pull Request instead.
```

This is `.git/hooks/pre-push` doing its job. **Do not bypass it with `--no-verify`.** Go back to the PR flow in Step 5.

### The tag already exists

```bash
# error: fatal: tag 'v0.10.1' already exists
# fix: pick a different version
```

Deleting the existing tag is pointless once the version is published to npm (see below).

### The publish workflow failed

```bash
gh run view <run-id> --repo Kewton/CommandMate --log-failed
```

Fix the cause and release again as a new patch version. **The same version number cannot be republished.**

### Rolling back a release

> ⚠️ **Once published to npm, a release cannot meaningfully be rolled back.**
>
> - npm heavily restricts unpublishing (only within 72 hours, under conditions)
> - **A version number, once used, cannot be reused even after unpublishing**
> - **Deleting the GitHub Release or the tag does not remove the package from npm**
>
> The correct response to a problem found after release is to **fix it and ship a new patch version**.

Before publishing (i.e. before the Release is created), you can unwind with:

```bash
git tag -d v0.10.1
git push origin :refs/tags/v0.10.1
```

After publishing, release the fix as the next patch version.

---

## Related Documents

- [`/release` skill](../../.claude/skills/release/SKILL.md) -- automates this procedure
- [CHANGELOG entry template](../../.claude/skills/release/templates/changelog-entry.md)
- `.github/workflows/publish.yml` -- Release-triggered automatic publish (OIDC)
- `.git/hooks/pre-push` -- rejects direct pushes to main
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- [Semantic Versioning](https://semver.org/)
- [CHANGELOG.md](../../CHANGELOG.md)
