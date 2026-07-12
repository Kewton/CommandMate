/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Geist Sans first, then Japanese fallback (Geist lacks JP glyphs),
        // then the system sans stack. CSS var is provided by next/font (geist)
        // via the className applied to <html> in src/app/layout.tsx.
        sans: [
          'var(--font-geist-sans)',
          'Hiragino Kaku Gothic ProN',
          'Noto Sans JP',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        // Geist Mono first, preserving the previous monospace stack as fallback.
        mono: [
          'var(--font-geist-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'monospace',
        ],
      },
      colors: {
        // [Issue #1041] Semantic tokens backed by CSS variables (see src/app/globals.css).
        // The `<alpha-value>` placeholder lets Tailwind compose opacity utilities.
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          foreground: 'rgb(var(--surface-foreground) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
        input: 'rgb(var(--input) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
        accent: {
          50: 'rgb(var(--accent-50) / <alpha-value>)',
          100: 'rgb(var(--accent-100) / <alpha-value>)',
          200: 'rgb(var(--accent-200) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)',
          600: 'rgb(var(--accent-600) / <alpha-value>)',
          700: 'rgb(var(--accent-700) / <alpha-value>)',
          800: 'rgb(var(--accent-800) / <alpha-value>)',
          900: 'rgb(var(--accent-900) / <alpha-value>)',
          950: 'rgb(var(--accent-950) / <alpha-value>)',
        },
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },
      // [Issue #1074] Light mode inverted to a gray page with white cards, so
      // shadow-sm must read as a real 2-layer elevation instead of the flat
      // Tailwind default (`0 1px 2px 0 rgb(0 0 0 / 0.05)`). The slate tint
      // (rgb(15 23 42)) is near-invisible on the dark #0a0c12 base, so dark is
      // unchanged (dark separates surfaces by border, not shadow). md/lg stay
      // Tailwind defaults — this issue is scoped to sm.
      boxShadow: {
        sm: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 1px rgb(15 23 42 / 0.04)',
      },
      animation: {
        'slide-in': 'slide-in 0.3s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
        // [Issue #1051] StatusDot "living" states. Infinite CSS animations so
        // polling re-renders never restart them (no JS/inline-style keying).
        // OS "reduce motion" is honored globally in globals.css (#1050), which
        // freezes these to a static dot — do not re-implement the media query.
        'status-glow': 'status-glow 2.4s ease-in-out infinite',
        'status-blink': 'status-blink 1.6s ease-in-out infinite',
      },
      keyframes: {
        'slide-in': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        // Pulsing box-shadow glow keyed to the dot's own color via currentColor,
        // so a single keyframe works for any status color (running=green).
        'status-glow': {
          '0%, 100%': { boxShadow: '0 0 3px 0 currentColor', opacity: '0.85' },
          '50%': { boxShadow: '0 0 8px 2px currentColor', opacity: '1' },
        },
        // Weak amber blink for the waiting state.
        'status-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    // [Issue #1050] Micro-interaction utilities (animate-in/out, fade/zoom/slide,
    // fill-mode, animation delay/duration) used by Modal, Radix data-state
    // primitives, and list stagger. framer-motion intentionally not used.
    require('tailwindcss-animate'),
  ],
}
