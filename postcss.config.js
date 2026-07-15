module.exports = {
  plugins: {
    // [Issue #1178] Tailwind 4 ships its PostCSS integration as a separate
    // package. Autoprefixer is dropped: Tailwind 4 handles vendor prefixing
    // itself via Lightning CSS.
    '@tailwindcss/postcss': {},
  },
}
