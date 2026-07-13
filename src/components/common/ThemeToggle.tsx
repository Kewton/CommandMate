/**
 * ThemeToggle Component
 *
 * Provides a button to toggle between light and dark themes.
 * Uses next-themes for theme management.
 * Includes mounted state to prevent SSR hydration mismatch.
 *
 * Issue #424: Dark Modern UI support
 */

'use client';

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';

/**
 * ThemeToggle - Toggle between light and dark mode
 *
 * Issue #1073 (Must Fix S3-001): this control is shared by the sidebar footer
 * AND the app Header, so it is styled with theme-NEUTRAL semantic tokens
 * (`text-muted-foreground` / `hover:bg-muted` / `focus:ring-ring`) rather than
 * the sidebar-* scale, to avoid regressing the header appearance.
 *
 * @example
 * ```tsx
 * <ThemeToggle />
 * ```
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch by only rendering after mount
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Render a placeholder with the same dimensions to prevent layout shift
    return (
      <div
        data-testid="theme-toggle-placeholder"
        className="w-8 h-8"
        aria-hidden="true"
      />
    );
  }

  const isDark = theme === 'dark';

  return (
    <button
      data-testid="theme-toggle"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        <Sun className="w-5 h-5" data-testid="theme-icon-sun" />
      ) : (
        <Moon className="w-5 h-5" data-testid="theme-icon-moon" />
      )}
    </button>
  );
}
