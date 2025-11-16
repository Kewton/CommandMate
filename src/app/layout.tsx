import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'myCodeBranchDesk',
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
        {children}
      </body>
    </html>
  );
}
