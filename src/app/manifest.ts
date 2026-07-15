import type { MetadataRoute } from 'next';

/**
 * Web App Manifest (Issue #1124), served at `/manifest.webmanifest`.
 *
 * Colors follow the dark theme token (`--background` dark = #0a0c12) so the
 * install splash and standalone chrome match the app's default look. The 512
 * icon is duplicated with `purpose: 'maskable'` so Android can apply its
 * adaptive-icon mask without clipping the logo.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CommandMate',
    short_name: 'CommandMate',
    description: 'Git worktree management with Claude CLI and tmux sessions',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0c12',
    theme_color: '#0a0c12',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
