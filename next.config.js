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
  // Issue #671: Do not auto-redirect /proxy/<prefix>/ → /proxy/<prefix>.
  // Streamlit and similar upstreams require the trailing slash form when
  // baseUrlPath is set, so suppressing the 308 redirect keeps those apps
  // routable. Other Next.js routes retain their existing behavior; trailing
  // slash consistency is left to the caller.
  skipTrailingSlashRedirect: true,
  eslint: {
    // Temporarily ignore ESLint errors during build
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverActions: {
      // [CONS-006] Increased to 105mb for video file upload support (100MB + overhead) - Issue #302, #600
      bodySizeLimit: '105mb',
    },
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/:path*',
        headers: [
          {
            // Prevent clickjacking attacks (SAMEORIGIN allows same-origin
            // iframes, required for Issue #673 PDF preview blob: iframe)
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
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
              "media-src 'self' data:", // Allow video playback with data URIs (Issue #302)
              "font-src 'self' data:",
              "connect-src 'self' data: ws: wss:", // Allow WebSocket + data: URIs (Issue #673: PdfPreview fetch)
              // Issue #490: HTML/MARP srcdoc (DR4-007: blob: originally excluded)
              // Issue #673: blob: added for PDF preview (Blob URL + iframe) — DR4-007 retraction
              "frame-src 'self' blob:",
              // Issue #673: 'self' allows same-origin blob: iframe (PDF preview)
              // while still preventing external clickjacking.
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
      {
        // Prevent browser caching of API responses (dynamic data)
        source: '/api/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store',
          },
        ],
      },
    ];
  },
}

module.exports = withNextIntl(nextConfig)
