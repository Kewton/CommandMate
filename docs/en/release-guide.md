[日本語版](../release-guide.md)

# Release Guide

This document explains the version upgrade and release procedures for CommandMate.

## Semantic Versioning

This project follows [Semantic Versioning](https://semver.org/).

### Version Format

```
MAJOR.MINOR.PATCH
```

| Type | When to Update | Example |
|------|---------------|---------|
| **MAJOR** | Breaking changes (backward-incompatible changes) | v1.0.0 → v2.0.0 |
| **MINOR** | Backward-compatible feature additions | v1.0.0 → v1.1.0 |
| **PATCH** | Backward-compatible bug fixes | v1.0.0 → v1.0.1 |

### Version Decision Criteria

| Change | Version Type |
|--------|-------------|
| API removal/modification | MAJOR |
| Configuration file format changes | MAJOR |
| Environment variable name changes (without fallback) | MAJOR |
| New feature additions | MINOR |
| New API additions | MINOR |
| New configuration options | MINOR |
| Bug fixes | PATCH |
| Documentation fixes | PATCH |
| Refactoring (no behavior change) | PATCH |
| Dependency updates (no behavior change) | PATCH |

---

## Release Procedure

### Preparation

1. **Verify all PRs are merged into main**
   ```bash
   git checkout main
   git pull origin main
   git status
   ```

2. **Verify no uncommitted changes**
   ```bash
   git status
   # Verify "nothing to commit, working tree clean"
   ```

3. **Verify all tests pass**
   ```bash
   npm run lint
   npm run test:unit
   npm run build
   ```

### Step 1: Determine Version

Check the current version and decide on the new version.

```bash
# Check current version
cat package.json | grep '"version"'
```

### Step 2: Update package.json

```bash
# Update the version in package.json
# Example: 0.1.0 → 0.2.0
```

### Step 3: Update package-lock.json

```bash
npm install --package-lock-only
```

### Step 4: Update CHANGELOG.md

1. Move content from the `[Unreleased]` section to a new version section
2. Add release date (YYYY-MM-DD format)
3. Add comparison links

**Before:**
```markdown
## [Unreleased]

### Added
- New feature description

### Fixed
- Bug fix description
```

**After:**
```markdown
## [Unreleased]

## [0.2.0] - 2026-01-30

### Added
- New feature description

### Fixed
- Bug fix description
```

**Adding comparison links (at end of file):**
```markdown
[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
```

### Step 5: Create Commit

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.2.0"
```

### Step 6: Create and Push Tag

```bash
# Create tag
git tag v0.2.0

# Push main branch and tag
git push origin main
git push origin v0.2.0
```

### Step 7: Create GitHub Release

```bash
# Auto-generate release notes
gh release create v0.2.0 --title "v0.2.0" --generate-notes

# Or use CHANGELOG.md content
gh release create v0.2.0 --title "v0.2.0" --notes "$(sed -n '/## \[0.2.0\]/,/## \[0.1.0\]/p' CHANGELOG.md | head -n -1)"
```

---

## Post-Release Verification

```bash
# List all tags
git tag -l

# Check latest tag
git describe --tags --abbrev=0

# Check GitHub Releases
gh release list

# View specific release details
gh release view v0.2.0
```

---

## Release Using Claude Code Skill

The `/release` skill can automate the above procedure.

```bash
# Patch version bump (0.1.0 → 0.1.1)
/release patch

# Minor version bump (0.1.0 → 0.2.0)
/release minor

# Major version bump (0.1.0 → 1.0.0)
/release major

# Direct version specification
/release 1.0.0
```

---

## npm version Command (Optional)

The `npm version` command can perform version updates and tag creation in one step.

```bash
# Patch version bump
npm version patch -m "chore: release v%s"

# Minor version bump
npm version minor -m "chore: release v%s"

# Major version bump
npm version major -m "chore: release v%s"

# Push tags
git push origin main --tags
```

**Note**: `npm version` does not automatically update CHANGELOG.md, so a separate update is required.

---

## Troubleshooting

### Tag Already Exists

```bash
# Error: fatal: tag 'v0.2.0' already exists
# Solution: Specify a different version or delete the existing tag

# Delete existing tag (caution: this rewrites history)
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
```

### Release Rollback

If a critical issue is discovered after release:

1. **Delete GitHub Release**
   ```bash
   gh release delete v0.2.0 --yes
   ```

2. **Delete the tag**
   ```bash
   git tag -d v0.2.0
   git push origin :refs/tags/v0.2.0
   ```

3. **After fixing, release as a new patch version**
   ```bash
   /release patch  # Release as v0.2.1
   ```

---

## Related Documents

- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- [Semantic Versioning](https://semver.org/)
- [CHANGELOG.md](../../CHANGELOG.md)
