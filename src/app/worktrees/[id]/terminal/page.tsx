/**
 * Terminal Page
 * Provides direct terminal access through the browser
 */

'use client';

import React, { useState } from 'react';
import { TerminalComponent } from '@/components/Terminal';
import { ArrowLeft, Terminal, Monitor, Code } from 'lucide-react';
import Link from 'next/link';

export default function TerminalPage({
  params
}: {
  params: { id: string }
}) {
  const [selectedTool, setSelectedTool] = useState<string>('claude');

  const cliTools = [
    { id: 'claude', name: 'Claude', icon: '🤖', color: 'bg-purple-600' },
    { id: 'codex', name: 'Codex', icon: '⚡', color: 'bg-blue-600' },
    { id: 'gemini', name: 'Gemini', icon: '✦', color: 'bg-green-600' },
    { id: 'bash', name: 'Bash', icon: '💻', color: 'bg-gray-600' },
  ];

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href={`/worktrees/${params.id}`}
              className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={20} />
              <span>Back</span>
            </Link>

            <div className="flex items-center gap-2 text-white">
              <Terminal size={20} />
              <h1 className="text-lg font-semibold">
                Terminal: {params.id}
              </h1>
            </div>
          </div>

          {/* CLI Tool Selector */}
          <div className="flex items-center gap-2">
            {cliTools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => setSelectedTool(tool.id)}
                className={`
                  px-4 py-2 rounded-lg flex items-center gap-2 transition-all
                  ${selectedTool === tool.id
                    ? `${tool.color} text-white shadow-lg`
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }
                `}
              >
                <span className="text-lg">{tool.icon}</span>
                <span className="text-sm font-medium">{tool.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Terminal Container */}
      <div className="flex-1 p-4">
        <div className="h-full bg-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <TerminalComponent
            worktreeId={params.id}
            cliToolId={selectedTool}
            className="h-full"
          />
        </div>
      </div>

      {/* Status Bar */}
      <div className="bg-gray-800 border-t border-gray-700 px-4 py-2">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <Monitor size={14} />
              Terminal Mode
            </span>
            <span className="flex items-center gap-1">
              <Code size={14} />
              {selectedTool.toUpperCase()} Session
            </span>
          </div>
          <div>
            <span className="text-gray-500">
              Press Ctrl+C to interrupt • Ctrl+D to exit
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}