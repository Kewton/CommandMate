[日本語版](../implementation-history.md)

# Implementation History

For details on each Issue (root cause, fix approach, security measures, tests, etc.), see the linked design documents.

| Issue | Type | Summary | Key Changed Files | Design Doc |
|-------|------|---------|-------------------|------------|
| #331 | feat | Token authentication & HTTPS support (SHA-256 hash auth, Cookie/rate limiting, TLS certificates, Edge Runtime-compatible middleware, WebSocket auth, login UI) | `auth.ts`, `auth-config.ts`, `middleware.ts`, `ws-server.ts`, `server.ts`, `start.ts`, `login/page.tsx`, `login/route.ts`, `logout/route.ts`, `status/route.ts` | [link](../../dev-reports/design/issue-331-token-auth-design-policy.md) |
| #323 | refactor | pollAutoYes() refactoring (SRP decomposition using function-based approach, extract validatePollingContext/captureAndCleanOutput/processStopConditionDelta/detectAndRespondToPrompt, add getPollerState internal helper, no functional changes) | `auto-yes-manager.ts`, `auto-yes-manager.test.ts` | [link](../../dev-reports/design/issue-323-auto-yes-manager-refactoring-design-policy.md) |
| #304 | fix | Test NODE_ENV isolation (add NODE_ENV=test prefix to package.json scripts, add cleanEnvVars() helper to env.test.ts with file-level beforeEach/afterEach consolidation, add ALLOWED_WORKTREE_PATHS delete to worktree-path-validator.test.ts) | `package.json`, `tests/unit/env.test.ts`, `tests/unit/lib/worktree-path-validator.test.ts` | [link](../../dev-reports/design/issue-304-test-env-isolation-design-policy.md) |
| #264 | feat | User feedback links (FeedbackSection UI, issue/docs CLI commands, gh CLI integration, centralized GitHub URLs, AI tool integration guide) | `github-links.ts`, `FeedbackSection.tsx`, `issue.ts`, `docs.ts`, `docs-reader.ts`, `input-validators.ts`, `cli-dependencies.ts`, `init.ts`, `cli/index.ts` | [link](../../dev-reports/design/issue-264-feedback-and-docs-design-policy.md) |
| #256 | fix | Multiple choice prompt detection accuracy improvement (multi-line question support, isQuestionLikeLine Pattern 2/4 addition, SEC-001b upward scan, MF-001 SRP compliance, refactoring) | `prompt-detector.ts`, `prompt-type-guards.ts`, unit/integration tests | [link](../../dev-reports/design/issue-256-multiple-choice-prompt-detection-design-policy.md) |
| #124 | feat | i18n support (next-intl, en/ja switching UI, document English translation) | `i18n-config.ts`, `i18n.ts`, `locale-cookie.ts`, `useLocaleSwitch.ts`, `LocaleSwitcher.tsx`, `date-locale.ts`, `locales/`, `README.md`, `docs/en/` | - |
| #212 | fix | Multi-line message Pasted text detection + auto Enter (shared helper, skipPatterns extension) | `pasted-text-helper.ts`, `cli-patterns.ts`, `claude-session.ts`, `codex.ts`, `response-poller.ts` | [link](../../dev-reports/design/issue-212-pasted-text-detection-design-policy.md) |
| #211 | feat | History message copy button (stripAnsi, Toast notification) | `clipboard-utils.ts`, `ConversationPairCard.tsx`, `HistoryPane.tsx`, `WorktreeDetailRefactored.tsx` | [link](../../dev-reports/design/issue-211-history-copy-button-design-policy.md) |
| #201 | feat | Trust dialog auto-response (Claude CLI v2.x) | `claude-session.ts`, `cli-patterns.ts` | [link](../../dev-reports/design/issue-201-trust-dialog-auto-response-design-policy.md) |
| #188 | fix | Thinking false detection causing spinner persistence (5-line windowing, trailing blank line trim, indented question support) | `status-detector.ts`, `response-poller.ts`, `current-output/route.ts`, `prompt-detector.ts` | [link](../../dev-reports/design/issue-188-thinking-indicator-false-detection-design-policy.md) |
| #193 | fix | Multiple choice prompt detection (DetectPromptOptions, requireDefaultIndicator) | `prompt-detector.ts`, `cli-patterns.ts`, `response-poller.ts` | [link](../../dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md) |
| #191 | fix | Auto-Yes detectThinking() windowing (last 50 lines) | `auto-yes-manager.ts` | [link](../../dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md) |
| #190 | fix | Prevent repository resurrection on Sync All after deletion (enabled=0 exclusion) | `db-repository.ts`, repositories API routes | [link](../../dev-reports/design/issue-190-repository-exclusion-on-sync-design-policy.md) |
| #159 | feat | Display app version on info tab | `next.config.js`, `WorktreeDetailRefactored.tsx` | [link](../../dev-reports/design/issue-159-info-tab-app-version-design-policy.md) |
| #180 | fix | Status display inconsistency fix (15-line windowing) | `status-detector.ts`, worktrees route.ts x2 | [link](../../dev-reports/design/issue-180-status-display-inconsistency-design-policy.md) |
| #161 | fix | Auto-Yes numbered list false positive prevention (2-pass prompt detection, sequential number verification) | `prompt-detector.ts`, `auto-yes-manager.ts` | [link](../../dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md) |
| #151 | fix | worktree-cleanup server detection improvement (port-based detection) | `.claude/lib/process-utils.sh`, `.claude/lib/validators.sh` | [link](../../dev-reports/design/issue-151-worktree-cleanup-server-detection-design-policy.md) |
| #152 | fix | Session first message send reliability improvement (waitForPrompt) | `claude-session.ts`, `cli-patterns.ts` | [link](../../dev-reports/design/issue-152-first-message-not-sent-design-policy.md) |
| #187 | fix | Session first message send reliability improvement (stabilization wait 500ms) | `claude-session.ts` | [link](../../dev-reports/design/issue-187-session-first-message-reliability-design-policy.md) |
| #123 | fix | iPad touch long-press context menu (useLongPress hook) | `useLongPress.ts`, `useContextMenu.ts`, `FileTreeView.tsx` | [link](../../dev-reports/design/issue-123-ipad-touch-context-menu-design-policy.md) |
| #138 | feat | Server-side Auto-Yes polling (background tab support) | `auto-yes-manager.ts`, `auto-yes-resolver.ts` | [link](../../dev-reports/design/issue-138-server-side-auto-yes-polling-design-policy.md) |
| #153 | fix | Auto-Yes UI state inconsistency fix (globalThis pattern) | `auto-yes-manager.ts` | [link](../../dev-reports/design/issue-153-auto-yes-state-inconsistency-design-policy.md) |
| #136 | feat | Git Worktree parallel development environment (--issue, --auto-port) | CLI utils/, `external-apps/db.ts` | [link](../../dev-reports/design/issue-136-worktree-parallel-dev-design-policy.md) |
| #135 | fix | DB path resolution logic fix (global install support) | `db-path-resolver.ts`, `db-migration-path.ts`, `env.ts` | [link](../../dev-reports/design/issue-135-db-path-resolution-design-policy.md) |
| #111 | feat | Git branch visualization (mismatch warning, periodic refresh) | `git-utils.ts`, `BranchMismatchAlert.tsx` | [link](../../dev-reports/design/issue-111-branch-visualization-design-policy.md) |
| #21 | feat | File tree search (name/content search toggle) | `file-search.ts`, `SearchBar.tsx`, `useFileSearch.ts` | [link](../../dev-reports/design/issue-21-file-search-design-policy.md) |
| #114 | docs | npm install -g documentation setup | README.md, docs/ | - |
| #96 | feat | npm CLI support (init/start/stop/status) | `src/cli/` | [link](../../dev-reports/design/issue-96-npm-cli-design-policy.md) |
| #119 | feat | commandmate init interactive mode support | `cli/commands/init.ts`, `cli/utils/prompt.ts` | - |
| #125 | fix | .env loading fix for global install | `cli/utils/env-setup.ts`, `cli/utils/daemon.ts` | [link](../../dev-reports/design/issue-125-global-install-env-loading-design-policy.md) |
| #100 | feat | Mermaid diagram rendering (securityLevel=strict) | `MermaidDiagram.tsx`, `mermaid-config.ts` | [link](../../dev-reports/design/issue-100-mermaid-diagram-design-policy.md) |
| #95 | feat | Image file viewer (magic byte/SVG XSS verification) | `image-extensions.ts`, `ImageViewer.tsx` | [link](../../dev-reports/design/issue-95-image-viewer-design-policy.md) |
| #94 | feat | File upload (5MB limit, magic byte verification) | `uploadable-extensions.ts`, upload API route | [link](../../dev-reports/design/issue-94-file-upload-design-policy.md) |
| #113 | feat | server.ts pre-built JS conversion (remove tsx dependency) | `tsconfig.server.json`, `dist/server/` | [link](../../dev-reports/design/issue-113-server-build-design-policy.md) |
| #112 | fix | Sidebar toggle performance improvement (transform method) | `AppShell.tsx`, `z-index.ts` | [link](../../dev-reports/design/issue-112-sidebar-transform-design-policy.md) |
| #99 | feat | Markdown editor display improvement (maximize/resize) | `useFullscreen.ts`, `useLocalStorageState.ts` | [link](../../dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md) |
| #49 | feat | Markdown editor and viewer | `MarkdownEditor.tsx`, `file-operations.ts` | [link](../../dev-reports/design/issue-49-markdown-editor-design-policy.md) |
| #77 | chore | CommandMate rename Phase 3 (CM_* name unification) | `env.ts`, `.env.example`, `package.json` | [link](../../dev-reports/design/issue-77-rename-phase3-design-policy.md) |
| #76 | feat | Environment variable fallback (CM_*/MCBD_* dual support) | `env.ts` | [link](../../dev-reports/design/issue-76-env-fallback-design-policy.md) |
| #71 | feat | Clone URL registration (async jobs, URL normalization) | `clone-manager.ts`, `url-normalizer.ts` | [link](../../dev-reports/design/issue-71-clone-url-registration-design-policy.md) |
| #69 | feat | Repository deletion (Facade pattern, confirmation dialog) | `session-cleanup.ts`, repositories API | [link](../../dev-reports/design/issue-69-repository-delete-design-policy.md) |
| #31 | feat | Sidebar UX improvement (real-time status detection) | status-detector, sidebar components | [docs](../features/sidebar-status-indicator.md) |
| #22 | feat | Multi-task sidebar (2-column, sort functionality) | sidebar components | - |
| #4 | feat | CLI tool support (Codex CLI addition, Strategy pattern) | `cli-tools/`, `cli-patterns.ts`, `standard-commands.ts` | [link](../../dev-reports/design/issue-4-codex-cli-support-design-policy.md) |
