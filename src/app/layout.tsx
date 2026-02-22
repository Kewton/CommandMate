import type { Metadata } from 'next';
import { getLocale, getMessages, getTimeZone } from 'next-intl/server';
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
    <html lang={locale}>
      <body className="min-h-screen bg-gray-50">
        <AppProviders locale={locale} messages={messages as Record<string, unknown>} timeZone={timeZone} authEnabled={!!process.env.CM_AUTH_TOKEN_HASH}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
