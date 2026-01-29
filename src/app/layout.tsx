import type { Metadata } from 'next';
import { AppProviders } from '@/components/providers/AppProviders';
import './globals.css';

export const metadata: Metadata = {
  title: 'CommandMate',
  description: 'Git worktree management with Claude CLI and tmux sessions',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-gray-50">
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
