/**
 * GitHub URL Constants (Centralized)
 * Issue #264: DRY - All GitHub URLs derived from GITHUB_REPO_BASE_URL
 *
 * [SEC-001] SSRF Prevention: GITHUB_API_URL is NOT included here.
 * It remains hardcoded in version-checker.ts for security reasons.
 */

export const GITHUB_REPO_BASE_URL = 'https://github.com/Kewton/CommandMate' as const;

// Issue URLs
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_BASE_URL}/issues` as const;
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPO_BASE_URL}/issues/new` as const;

// Template URLs (UI: uses filename in query parameter)
export const GITHUB_BUG_REPORT_URL = `${GITHUB_NEW_ISSUE_URL}?template=bug_report.md` as const;
export const GITHUB_FEATURE_REQUEST_URL = `${GITHUB_NEW_ISSUE_URL}?template=feature_request.md` as const;
export const GITHUB_QUESTION_URL = `${GITHUB_NEW_ISSUE_URL}?template=question.md` as const;

// Release URL (moved from version-checker.ts, re-exported there for backward compatibility)
export const GITHUB_RELEASE_URL_PREFIX = `${GITHUB_REPO_BASE_URL}/releases/` as const;

// Security Guide URL (moved from security-messages.ts)
export const GITHUB_SECURITY_GUIDE_URL = `${GITHUB_REPO_BASE_URL}/blob/main/docs/security-guide.md` as const;
