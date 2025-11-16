export default function Home() {
  return (
    <main className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold text-gray-900 mb-4">
        myCodeBranchDesk
      </h1>
      <p className="text-lg text-gray-600">
        Git worktree management with Claude CLI and tmux sessions
      </p>
      <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-sm text-blue-800">
          ✅ Phase 1: Project setup complete
        </p>
        <p className="text-sm text-gray-600 mt-2">
          Next: Implement Phase 2 - Data Layer
        </p>
      </div>
    </main>
  );
}
