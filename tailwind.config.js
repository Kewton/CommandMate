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
      colors: {
        primary: {
          50: '#ecfeff',   // cyan-50
          100: '#cffafe',  // cyan-100
          200: '#a5f3fc',  // cyan-200
          300: '#67e8f9',  // cyan-300
          400: '#22d3ee',  // cyan-400 (dark mode accent)
          500: '#06b6d4',  // cyan-500
          600: '#0891b2',  // cyan-600 (light mode accent)
          700: '#0e7490',  // cyan-700
        },
        'cmd-bg-dark': '#0f1117',
      },
      animation: {
        'slide-in': 'slide-in 0.3s ease-out',
      },
      keyframes: {
        'slide-in': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
