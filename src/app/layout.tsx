import type { Metadata } from 'next';
import { getLocale, getMessages, getTimeZone } from 'next-intl/server';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { AppProviders } from '@/components/providers/AppProviders';
import './globals.css';

export const metadata: Metadata = {
  title: 'CommandMate',
  description: 'Git worktree management with Claude CLI and tmux sessions',
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
