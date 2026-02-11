// Build-time version from package.json (not user-configurable, distinct from .env variables)
const packageJson = require('./package.json');
const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  reactStrictMode: true,
  eslint: {
    // Temporarily ignore ESLint errors during build
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverActions: {
      // [CONS-006] Increased from 2mb to 6mb for file upload support (5MB + overhead)
      bodySizeLimit: '6mb',
    },
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/:path*',
        headers: [
          {
            // Prevent clickjacking attacks
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            // Prevent MIME type sniffing
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            // Enable XSS filter in browsers
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            // Control referrer information
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // Permissions Policy (formerly Feature Policy)
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            // Content Security Policy
            // Note: This is a baseline CSP. Adjust based on your needs.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-eval needed for Next.js dev
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' ws: wss:", // Allow WebSocket connections
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
}

module.exports = withNextIntl(nextConfig)
