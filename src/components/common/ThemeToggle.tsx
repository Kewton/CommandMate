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
      className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
