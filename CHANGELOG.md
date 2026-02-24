# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-02-24

### Added
- CMATE schedule execution feature (Issue #294)
  - CMATE.md-based schedule definition with cron syntax
  - Claude CLI executor with permission support (`--permission-mode`)
  - Execution log viewer with Message/Response detail and schedule name display
  - CMATE setup/validate button in FileTreeView toolbar
  - Step-by-step setup guide for empty schedules state
  - Environment variable sanitization for secure execution
  - i18n support (en/ja) for schedule UI
  - CMATE schedules user guide documentation (ja/en)
- Mobile tab renamed from "Notes" to "CMATE"

### Fixed
- CLAUDE_PERMISSIONS corrected to match `claude` CLI `--permission-mode` values
- Disabled schedules now filtered from active execution
- Header column validation added to CMATE.md validator
- Tree API response parsing fixed (object instead of array)
- Executor hanging prevention with CLI-specific args support

## [0.3.1] - 2026-02-23

### Fixed
- False negative in `isSessionHealthy()` for recovered sessions (Issue #354)
  - Prevent healthy sessions from being incorrectly marked as unhealthy after recovery

## [0.3.0] - 2026-02-22

### Added
- Token authentication and HTTPS support (Issue #331)
  - `CM_AUTH_TOKEN` for bearer token authentication
  - HTTPS with self-signed or custom certificate support
  - Login page UI with token input
  - AuthContext and middleware for Edge Runtime compatibility
  - Logout button with server-side auth status
  - Security documentation for token auth and HTTPS setup
- IP address/CIDR restriction for HTTP and WebSocket access (Issue #332)
  - `CM_ALLOWED_IPS` environment variable for IP whitelist
  - CIDR notation support for subnet ranges
  - 401 redirect handling in API client with polling stop
- Skills loader: display `.claude/skills` in slash command selector (Issue #343)
  - YAML frontmatter parsing with regex fallback
  - JSDoc documentation and TODO annotations per design policy

### Changed
- Auto-yes-manager refactored: decomposed `pollAutoYes()` into focused functions (Issue #323)
  - Removed misleading type assertion in test
- README rewritten with pain-first narrative elevator pitch
- vitest updated to 4.0.16

### Fixed
- SKILL.md YAML frontmatter parse errors with quoted values (Issue #351)
- Auth redirect handling in API client and polling stop on 401
- Login page flicker eliminated by using AuthContext instead of async status fetch
- LogoutButton flicker eliminated by using server-side auth status
- next-intl v4 SSR timeZone configuration
- Middleware made Edge Runtime compatible
- Server TypeError prevention in handleRequestImpl on Node.js 19+
- Slash command regex fallback for YAML-unfriendly SKILL.md frontmatter

## [0.2.13] - 2026-02-20

### Added
- Memo card copy to clipboard functionality (Issue #321)

### Fixed
- Prompt response extraction limited to `lastCapturedLine` onwards to prevent stale data (Issue #326)

## [0.2.12] - 2026-02-20

### Added
- Auto-Yes stop condition with regex pattern matching (Issue #314)
  - Custom regex pattern input to auto-stop when output matches
  - Regex tips tooltip for pattern guidance
  - Delta-based stop condition check to prevent false triggers
  - `AutoYesStopReason` moved to shared config
- Desktop demo GIF, mobile FAQ, and Cloudflare Tunnel guide in README

### Fixed
- Test environment NODE_ENV isolation (Issue #304)
  - `NODE_ENV=test` enforced in vitest config and test scripts
  - Infinite re-render loop fix in `useLocalStorageState`
  - `process.env` cast to avoid read-only NODE_ENV type error

### Changed
- README rewritten with "Mobile Dev Cockpit" positioning

## [0.2.11] - 2026-02-19

### Added
- MP4 video file upload and browser playback support (Issue #302)
  - Video security validation aligned with image upload pattern
- Root-level file/directory creation toolbar (Issue #300)
  - Dark mode support for empty state buttons
  - Path encoding fix for special characters
- Session stability improvements with duplicate prevention (Issue #306)
  - JSDoc improvements, constant extraction, DRY/ISP principles applied
- npm keywords for package discoverability

### Fixed
- Clone basePath now uses `CM_ROOT_DIR` instead of hardcoded `/tmp/repos` (Issue #308)
- iPad layout: unified z-index system, swipe/scroll separation, layout fixes (Issue #299)
  - Unreachable code fix in MarkdownEditor

## [0.2.10] - 2026-02-17

### Fixed
- Prompt-response API fallback for promptType mismatch (Issue #287)
  - `promptType` / `defaultOptionNumber` sent from client for server-side re-verification fallback
  - `isClaudeMultiChoice` broadened for type mismatch edge cases
  - User input prompt barrier to prevent false positive detection
  - `prompt-answer-sender.ts` shared module to eliminate cursor-key logic duplication
  - `prompt-response-body-builder.ts` shared utility for DRY request body construction
- Slash command selector re-display during free input mode (Issue #288)
  - `isFreeInputMode` flag prevents selector from re-appearing after custom command input
  - Enter key interception fix and filter text carry-over to free input mode
  - Mobile send button guard during free input mode

### Changed
- README improved as project landing page with complete CLI command reference (Issue #286)

## [0.2.9] - 2026-02-15

### Added
- File move/rename feature with `MoveDialog` component (Issue #162)
  - Context menu "Move/Rename" option for files and directories
  - Path validation and overwrite prevention
- File creation date (birthtime) display in `FileViewer` header and mobile view (Issue #162)
  - `date-utils.ts` with locale-aware formatting
- Content copy button in `MarkdownEditor` toolbar (Issue #162)
  - `useFileOperations` hook for file operation logic extraction

## [0.2.8] - 2026-02-14

### Fixed
- Update check API fetch caching issue with `cache: 'no-store'` (Issue #278)
- Update notification indicator dot on Info tab and mobile tab bar (Issue #278)
  - `NotificationDot` reusable component for visual update alerts

## [0.2.7] - 2026-02-14

### Fixed
- Claude CLI session recovery: cache invalidation, health check, and CLAUDECODE env removal (Issue #265)
  - `clearCachedClaudePath()` for automatic recovery on CLI update
  - `isSessionHealthy()` / `ensureHealthySession()` for broken session detection and recreation
  - `sanitizeSessionEnvironment()` to remove CLAUDECODE environment variable
  - `getCleanPaneOutput()` common helper and `isValidClaudePath()` validation
  - Session error pattern detection via `CLAUDE_SESSION_ERROR_PATTERNS` / `CLAUDE_SESSION_ERROR_REGEX_PATTERNS`
- Preserve input content on browser tab visibility change (Issue #266)
  - Input field content no longer cleared when switching browser tabs

### Changed
- Refactored `WorktreeDetailRefactored` component for DRY compliance (Issue #266)
  - Extracted shared hooks and components

## [0.2.6] - 2026-02-14

### Fixed
- Update-check API route static prerender error (Issue #270)
  - Added `force-dynamic` export to prevent Next.js static generation at build time

## [0.2.5] - 2026-02-14

### Added
- User feedback links in Info modal (Issue #264)
  - `FeedbackSection` component with bug report, feature request, question links
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - i18n support (en/ja)
- `commandmate issue` CLI command with gh CLI integration (Issue #264)
  - `commandmate issue create --bug/--feature/--question` for templated issue creation
  - `commandmate issue search <query>` for issue search
  - `commandmate issue list` for issue listing
- `commandmate docs` CLI command for RAG-like documentation access (Issue #264)
  - `commandmate docs --section <name>` for specific documentation sections
  - `commandmate docs --search <query>` for documentation search
  - `commandmate docs --all` for full documentation output
- AI tool integration guide displayed after `commandmate init` (Issue #264)
- GitHub URL constants centralized in `src/config/github-links.ts` (Issue #264)

### Fixed
- docs-reader path resolution for built CLI (Issue #264)

## [0.2.4] - 2026-02-13

### Added
- Version update notification feature (Issue #257)
  - `UpdateNotificationBanner` component for new version alerts
  - `VersionSection` component for Info screen
  - `useUpdateCheck` hook and `version-checker.ts` library
  - `/api/app/update-check` API endpoint

### Fixed
- Multiple choice prompt detection for wrapped questions (Issue #256)
  - `isQuestionLikeLine()` now handles multi-line question wrapping (trailing `。` / `.`)
  - Keyword-based detection for non-question prompts (model selection, etc.)
  - Added `questionBlockScan()` for multi-line question block analysis
- Mobile background resume error "Error loading worktree" (Issue #246)
  - Added `visibilitychange` event listener for automatic data recovery
  - Error state reset and data re-fetch on page visibility restore

## [0.2.3] - 2026-02-13

### Added
- i18n support with next-intl for English and Japanese (Issue #124)
  - Locale-based routing (`/en`, `/ja`)
  - Document translations and integration/e2e tests
- Log export feature with LogViewer (Issue #11)
  - `LogViewer` component in Info screen (desktop modal & mobile)
  - `withLogging()` API logger middleware applied to log routes
  - `log-config.ts` for centralized LOG_DIR constant
  - Log-manager regression tests
- Prompt instructionText display in active prompt UI (Issue #235)
  - `PromptPanel` and `MobilePromptSheet` show instruction text
  - Complete prompt output preserved with `rawContent` field

### Fixed
- Full prompt block included in instructionText for multiple_choice prompts (Issue #235)
- Full output passed to detectPrompt in status-detector for long prompts (Issue #235)
- next-intl middleware removed to fix redirect loop with custom server (Issue #124)
- Image and document links corrected in README files (Issue #124)
- Rebuild skill branch specification to prevent worktree misexecution

### Removed
- Dead code: claude-poller, terminal-websocket, WorktreeDetail legacy code, simple-terminal (Issue #237)

## [0.2.2] - 2026-02-10

_No changes recorded._

## [0.2.1] - 2026-02-10

_No changes recorded._

## [0.2.0] - 2026-02-08

### Changed
- **BREAKING**: Removed `CM_AUTH_TOKEN` authentication mechanism (Issue #179)
  - `src/middleware.ts` deleted (Next.js authentication middleware)
  - `CM_AUTH_TOKEN`, `NEXT_PUBLIC_CM_AUTH_TOKEN`, `MCBD_AUTH_TOKEN` environment variables are no longer used
  - Existing AUTH_TOKEN settings are silently ignored (no errors, no effect)
  - External access now requires reverse proxy authentication (Nginx + Basic Auth, Cloudflare Access, Tailscale)
  - `commandmate init` and `commandmate start` show reverse proxy warning when `CM_BIND=0.0.0.0`
  - ENV_MAPPING reduced from 8 to 7 entries
  - Client-side `api-client.ts` no longer sends Authorization header

### Added
- Codex CLI support (Issue #4)
  - Codex tab in WorktreeDetail
  - Per-CLI tool status indicators in sidebar and tabs
  - Individual session termination with confirmation dialog
  - Mobile CLI tab switcher inline with Auto Yes toggle
  - CLI tool-specific slash command filtering (Claude: 16, Codex: 10)
  - Response saving fix for tmux buffer empty line padding
- Multiline message support via tmux `paste-buffer` (Issue #163)
  - `sendTextViaBuffer()` for accurate multiline text delivery
  - Single-line uses `sendKeys`, multiline uses `paste-buffer`
- App version display in info tab (Issue #159)
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - Build-time `NEXT_PUBLIC_APP_VERSION` from `package.json`
- New security guide: `docs/security-guide.md` (Issue #179)
  - Threat model for localhost vs external access
  - Nginx + Basic Auth configuration example
  - Cloudflare Access and Tailscale setup instructions
  - Migration steps from CM_AUTH_TOKEN
  - Security checklist for external deployment
- `src/cli/config/security-messages.ts` with shared REVERSE_PROXY_WARNING constant (Issue #179)

### Fixed
- Auto-Yes false positive detection of numbered lists as multiple_choice prompts (Issue #161)
  - Two-pass `❯` detection to prevent misidentification
  - Thinking state pre-check skips prompt detection
  - Consecutive number validation as defensive measure
  - Prompt re-verification before sendKeys in prompt-response API
- Status display inconsistency: UI showing "running"/"waiting" when CLI is idle (Issue #180)
  - Consolidated inline logic into `detectSessionStatus()` in `status-detector.ts`
  - 15-line windowing to prevent past prompt false positives
- Multiline option text detection in multiple choice prompts (Issue #181)
- Deleted repositories reappearing after Sync All (Issue #190)
  - `enabled=0` exclusion marking on delete
  - Excluded repository list UI with restore button
  - New APIs: `GET /api/repositories/excluded`, `PUT /api/repositories/restore`
- File tree directory expand state lost after file operations

### Removed
- `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN` environment variable support (Issue #179)
- `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN` client-side token support (Issue #179)
- `isAuthRequired()` function from `src/lib/env.ts` (Issue #179)
- `generateAuthToken()` method from `EnvSetup` class (Issue #179)
- `CM_AUTH_TOKEN` masking patterns from logger and security-logger (Issue #179)

### Security
- Removed broken authentication that exposed tokens in client-side JavaScript (Issue #179)
- Added reverse proxy authentication recommendation for external deployments (Issue #179)

## [0.1.12] - 2026-02-04

_No changes recorded._

## [0.1.11] - 2026-02-04

### Added
- Server-side Auto-Yes polling feature (Issue #138)
  - `src/lib/auto-yes-manager.ts` for centralized polling management
  - Background polling when browser tab is inactive
  - Exponential backoff after 5 consecutive errors (max 60s)
  - Duplicate response prevention with `lastServerResponseTimestamp`
  - MAX_CONCURRENT_POLLERS=50 limit for DoS prevention
- Git Worktree parallel development environment (Issue #136)
  - `commandmate start --issue {issueNo} [--auto-port]` for issue-specific servers
  - `commandmate stop/status --issue {issueNo}` for worktree management
  - Port range 3001-3100 (main server uses 3000)
  - Issue-specific DB: `~/.commandmate/data/cm-{issueNo}.db`
  - `/worktree-setup` and `/worktree-cleanup` skills
- DB path resolution fix for global installs (Issue #135)
  - Consistent DB path via `getEnv().CM_DB_PATH`
  - Auto-migration from legacy DB paths
  - System directory protection

### Fixed
- Terminal scroll behavior on worktree switch (Issue #131)
  - Uses instant scroll for worktree changes
  - Smooth scroll only for new messages in same worktree
- Empty state now shows New File/New Directory buttons (Issue #139)
- Ready status detection for prompts with recommended commands (Issue #141)
- Worktree sync now removes deleted worktrees from DB

### Security
- worktreeID format validation (command injection prevention)
- Issue number validation (1-999999 range)
- Branch name whitelist validation (`[a-zA-Z0-9_/-]`)
- Graceful shutdown stops all auto-yes pollers

## [0.1.10] - 2026-02-02

### Added
- Git branch visualization feature (Issue #111)
  - Display current branch name in worktree detail header
  - Show warning when current branch differs from session start branch
  - Mobile support for branch information display
  - Automatic refresh (active: 2s, idle: 5s)
  - Migration #15: added `initial_branch` column to worktrees table
  - New `src/lib/git-utils.ts` module with `getGitStatus()` function
  - `BranchMismatchAlert` component for branch mismatch warnings

### Fixed
- Repository filter UI now displays even when only one repository exists (Issue #129)

### Security
- Branch visualization uses `execFile` instead of `exec` to prevent command injection
- 1 second timeout for git commands to prevent DoS
- React auto-escaping for XSS prevention in branch name display

## [0.1.9] - 2026-02-02

### Fixed
- Foreground mode (`commandmate start`) now loads .env file (Issue #125 follow-up)
  - v0.1.8 only fixed daemon mode, foreground mode was missing .env loading
  - Now both modes load .env from `~/.commandmate/.env` for global installs
  - Security warnings for external access also added to foreground mode

## [0.1.8] - 2026-02-02

### Fixed
- Global install CLI commands now load .env from correct location (Issue #125)
  - `commandmate start/stop/status` use `getEnvPath()` and `getPidFilePath()`
  - .env loaded from `~/.commandmate/.env` for global installs
  - PID file created at `~/.commandmate/.commandmate.pid`
  - Path traversal protection with symlink resolution
  - Security warnings for external network access (CM_BIND=0.0.0.0)
  - Fallback to process.env when .env loading fails

### Security
- Added path traversal protection in getConfigDir() (OWASP A01:2021)
- Security warning when server is exposed externally without authentication (OWASP A05:2021)

## [0.1.7] - 2026-02-02

### Added
- Interactive mode for `commandmate init` command (Issue #119)
  - TTY detection for automatic interactive/non-interactive mode selection
  - Prompts for CM_ROOT_DIR, CM_PORT, external access, CM_DB_PATH
  - `--defaults` flag for CI/CD environments (non-interactive)
  - Tilde expansion for paths (`~/repos` → `/Users/xxx/repos`)
  - Configuration summary display after setup
  - Global install: `.env` saved to `~/.commandmate/`
  - Local install: `.env` saved to current directory

## [0.1.6] - 2026-02-02

### Added
- Documentation updated to use `npm install -g commandmate` as primary setup method (Issue #114)
  - New CLI setup guide at `docs/user-guide/cli-setup-guide.md`
  - README.md Quick Start uses npm global install
  - git clone method moved to "Developer Setup" section
  - `--port` option documented in CLI commands table

### Fixed
- iPad fullscreen mode now uses Portal to cover full viewport (Issue #104)
- Test z-index expectations updated from 40 to 55 to match Z_INDEX.MAXIMIZED_EDITOR

### Changed
- Sidebar toggle animation uses transform instead of width for GPU acceleration (Issue #112)
  - Improves performance on iPad
  - Added SIDEBAR constant (30) to z-index.ts
- Pre-built JS compilation for server.ts enables npm CLI without TypeScript compilation (Issue #113)

## [0.1.5] - 2026-02-01

### Fixed
- Added `repository` field to package.json for npm provenance verification

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

[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/Kewton/CommandMate/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Kewton/CommandMate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kewton/CommandMate/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/Kewton/CommandMate/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/Kewton/CommandMate/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/Kewton/CommandMate/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/Kewton/CommandMate/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/Kewton/CommandMate/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/Kewton/CommandMate/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/Kewton/CommandMate/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Kewton/CommandMate/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Kewton/CommandMate/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Kewton/CommandMate/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Kewton/CommandMate/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kewton/CommandMate/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kewton/CommandMate/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kewton/CommandMate/compare/v0.1.12...v0.2.0
[0.1.12]: https://github.com/Kewton/CommandMate/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/Kewton/CommandMate/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Kewton/CommandMate/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Kewton/CommandMate/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Kewton/CommandMate/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Kewton/CommandMate/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Kewton/CommandMate/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Kewton/CommandMate/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Kewton/CommandMate/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kewton/CommandMate/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kewton/CommandMate/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
