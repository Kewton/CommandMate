# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-02-01

### Fixed
- Re-enabled `environment: npm-publish` in publish workflow
  - npm Trusted Publisher requires exact match of environment name

## [0.1.3] - 2026-02-01

### Fixed
- npm publish workflow now upgrades npm to ^11.5.1 for OIDC Trusted Publishers support
  - Node 20 ships with npm 10.8.2, but Trusted Publishers requires npm >= 11.5.1

## [0.1.2] - 2026-02-01

### Added
- Security audit job in PR CI workflow (ci-pr.yml)
  - Catches vulnerabilities before merge/release

### Changed
- Updated Next.js to 14.2.35 (latest 14.x patch)
- Updated eslint-config-next to 14.2.35
- Changed audit-level from `high` to `critical` in CI/publish workflows
  - Allows high-severity vulnerabilities that require breaking changes to fix
  - Next.js 15+ migration tracked separately

### Security
- Added npm audit to PR checks to catch vulnerabilities early

## [0.1.1] - 2026-02-01

### Added
- npm CLI support (`npm install -g commandmate`) (Issue #96)
  - `commandmate init` - Initialize configuration
  - `commandmate start` - Start server (foreground or daemon mode)
  - `commandmate stop` - Stop server
  - `commandmate status` - Show server status
- File tree search functionality (Issue #21)
  - Name search with real-time filtering (300ms debounce)
  - Content search via server API (5s timeout)
  - Search result highlighting
  - Auto-expand parent directories of matched files
  - Desktop/Mobile responsive design
- Mermaid diagram rendering in markdown preview (Issue #100)
- Image file viewer with security validation (Issue #95)
- File upload feature with security validation (Issue #94)
- Markdown editor with XSS protection (Issue #49)
- Markdown editor display improvements (Issue #99)
- pm-auto-design2dev slash command for automated workflow

### Fixed
- CLI now uses package directory instead of cwd for npm run
- Search filtering applied to nested tree items
- File tree refresh after operations
- Markdown preview code block styling

### Security
- ReDoS prevention (no regex on server-side search)
- Relative paths only in search results
- Magic byte validation for file uploads
- SVG XSS protection for image viewer
- Mermaid securityLevel='strict' setting

### Added
- Preflight check script `scripts/preflight-check.sh` for dependency validation (Issue #92)
  - Checks Node.js (v20+), npm, tmux, git, openssl
  - Claude CLI check with warning (optional)
  - Help option (`-h`/`--help`)
- Interactive environment setup script `scripts/setup-env.sh` (Issue #92)
  - Generates `.env` with CM_* variables
  - Auto-generates auth token for external access
  - Backs up existing `.env` to `.env.backup.{timestamp}`
  - Help option (`-h`/`--help`)

### Changed
- `scripts/build-and-start.sh` now includes database initialization (Issue #92)
  - Creates data directory
  - Runs `npm run db:init` before build
  - Help option (`-h`/`--help`)
- `scripts/setup.sh` now uses preflight-check.sh, setup-env.sh, and build-and-start.sh (Issue #92)
  - Integrated dependency checking
  - Interactive environment configuration
  - Streamlined 4-step setup process (preflight → npm install → env → build & start)
  - Application starts automatically after setup
- `.env.production.example` updated to use CM_* variables (Issue #92)
  - Migrated from MCBD_* to CM_* format
  - Added logging configuration options
  - Added legacy support documentation
- Updated README.md Quick Start with simplified setup (Issue #92)
- Updated docs/DEPLOYMENT.md with new setup scripts (Issue #92)
- Updated docs/internal/PRODUCTION_CHECKLIST.md with CM_* variables (Issue #92)

## [0.1.0] - 2026-01-30

### Changed
- **BREAKING**: GitHub repository renamed from `Kewton/MyCodeBranchDesk` to `Kewton/CommandMate` (Issue #80)
- All documentation links updated to new repository URL (Issue #80)
- Project branding updated from MyCodeBranchDesk to CommandMate (Issue #75)
- UI titles and headers now display "CommandMate"
- Documentation updated with new branding terminology
- Removed "chat" terminology that caused confusion (now uses "Message/Console/History")
- **BREAKING**: package.json name changed from `mycodebranch-desk` to `commandmate` (Issue #77)
- **BREAKING**: Env interface properties renamed from `MCBD_*` to `CM_*` (Issue #77)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `DATABASE_PATH` -> `CM_DB_PATH`
- .env.example updated to use CM_* environment variables as primary (Issue #77)
- All shell scripts updated to use CommandMate branding and CM_* variables (Issue #77)
- E2E tests updated to test for CommandMate heading (Issue #77)

### Added
- Migration guide for existing users (`docs/migration-to-commandmate.md`) (Issue #79)
  - Complete environment variable mapping (9 variables)
  - systemd service migration instructions
  - Claude Code settings update instructions
  - Docker environment migration guide
  - Troubleshooting section
- Environment variable fallback support for backwards compatibility (Issue #76)
  - New `CM_*` prefix supported alongside legacy `MCBD_*` prefix
  - Deprecation warnings logged when legacy names are used (once per key)
  - All 8 environment variables support fallback:
    - `CM_ROOT_DIR` / `MCBD_ROOT_DIR`
    - `CM_PORT` / `MCBD_PORT`
    - `CM_BIND` / `MCBD_BIND`
    - `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN`
    - `CM_LOG_LEVEL` / `MCBD_LOG_LEVEL`
    - `CM_LOG_FORMAT` / `MCBD_LOG_FORMAT`
    - `CM_LOG_DIR` / `MCBD_LOG_DIR`
    - `CM_DB_PATH` / `MCBD_DB_PATH`
  - Client-side fallback for `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN`
- `CM_AUTH_TOKEN` masking pattern in logger for security
- Unit tests for environment variable fallback functionality

### Deprecated
- `MCBD_*` environment variables - use `CM_*` instead (will be removed in next major version)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `MCBD_LOG_LEVEL` -> `CM_LOG_LEVEL`
  - `MCBD_LOG_FORMAT` -> `CM_LOG_FORMAT`
  - `MCBD_LOG_DIR` -> `CM_LOG_DIR`
  - `MCBD_DB_PATH` -> `CM_DB_PATH`
- `NEXT_PUBLIC_MCBD_AUTH_TOKEN` -> `NEXT_PUBLIC_CM_AUTH_TOKEN`

[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Kewton/CommandMate/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kewton/CommandMate/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kewton/CommandMate/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
