import type { Metadata, Viewport } from 'next';
import { getLocale, getMessages, getTimeZone, getTranslations } from 'next-intl/server';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { AppProviders } from '@/components/providers/AppProviders';
import './globals.css';

// [Issue #1305] `description` is locale-dependent, and t() cannot be called at
// module scope, so the static `metadata` export became `generateMetadata`.
// "CommandMate" stays a literal on purpose: it is the product name, not copy.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');

  return {
    // [Issue #1082] Title template: per-page `title` renders as "<page> | CommandMate";
    // pages without their own title fall back to `default`.
    title: {
      default: 'CommandMate',
      template: '%s | CommandMate',
    },
    description: t('meta.description'),
    // [Issue #1124] iOS PWA: Safari ignores the Web App Manifest for standalone
    // launch, so these emit apple-mobile-web-app-* meta tags for home-screen
    // installs (Android/desktop rely on manifest.ts).
    appleWebApp: {
      capable: true,
      title: 'CommandMate',
      statusBarStyle: 'default',
    },
  };
}

// [Issue #1082] themeColor follows the light/dark --background token so the
// browser chrome (mobile address bar / PWA) matches the active theme.
// [Issue #1131] viewportFit: 'cover' is required for iOS to expose non-zero
// env(safe-area-inset-*) values; without it every pt-safe/pb-safe is a no-op.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0c12' },
  ],
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  const timeZone = await getTimeZone();

  return (
    <html
      lang={locale}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background">
        <AppProviders locale={locale} messages={messages as Record<string, unknown>} timeZone={timeZone} authEnabled={!!process.env.CM_AUTH_TOKEN_HASH}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
