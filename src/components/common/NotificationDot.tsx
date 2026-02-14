/**
 * NotificationDot Shared Component
 * Issue #278: MF-001 - DRY principle for dot badge UI pattern
 *
 * Reusable notification dot indicator used across DesktopHeader, MobileTabBar,
 * and potentially BranchListItem (future).
 *
 * @module components/common/NotificationDot
 */

/** Props for NotificationDot component */
interface NotificationDotProps {
  /** Test identifier for querying in tests */
  'data-testid'?: string;
  /** Accessibility label for screen readers */
  'aria-label'?: string;
  /**
   * Additional CSS classes for position adjustment.
   * [SEC-SF-001] Security note: This prop MUST only receive hardcoded string literals
   * (e.g., "absolute top-0 right-0"). NEVER pass user-input-derived values to prevent
   * className injection attacks.
   */
  className?: string;
}

/**
 * NotificationDot - Shared dot badge indicator component.
 *
 * Renders a small blue circle used as a notification indicator.
 * Base styles: w-2 h-2 rounded-full bg-blue-500
 *
 * @example
 * ```tsx
 * <NotificationDot
 *   data-testid="info-update-indicator"
 *   className="absolute top-0 right-0"
 *   aria-label="Update available"
 * />
 * ```
 */
export function NotificationDot({
  'data-testid': testId,
  'aria-label': ariaLabel,
  className = '',
}: NotificationDotProps) {
  return (
    <span
      data-testid={testId}
      className={`w-2 h-2 rounded-full bg-blue-500 ${className}`.trim()}
      aria-label={ariaLabel}
    />
  );
}
