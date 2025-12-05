/**
 * Simple Terminal Page
 * Direct terminal access without WebSocket
 */

'use client';

import React, { useState } from 'react';
import { SimpleTerminal } from '@/components/SimpleTerminal';
import { ArrowLeft, Terminal } from 'lucide-react';
import Link from 'next/link';

export default function SimpleTerminalPage({
  params
}: {
  params: { id: string }
}) {
  const [selectedTool, setSelectedTool] = useState<string>('claude');

  const cliTools = [
    { id: 'claude', name: 'Claude', color: 'bg-purple-600' },
    { id: 'codex', name: 'Codex', color: 'bg-blue-600' },
    { id: 'gemini', name: 'Gemini', color: 'bg-green-600' },
  ];

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href={`/worktrees/${params.id}`}
              className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={20} />
              <span>戻る</span>
            </Link>

            <div className="flex items-center gap-2 text-white">
              <Terminal size={24} />
              <h1 className="text-xl font-bold">
                ターミナル: {params.id}
              </h1>
            </div>
          </div>

          {/* Tool Selector */}
          <div className="flex gap-2">
            {cliTools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => setSelectedTool(tool.id)}
                className={`
                  px-4 py-2 rounded-lg transition-all font-medium
                  ${selectedTool === tool.id
                    ? `${tool.color} text-white shadow-lg`
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }
                `}
              >
                {tool.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Terminal Container */}
      <div className="container mx-auto p-6">
        <div className="bg-gray-800 rounded-lg shadow-2xl overflow-hidden" style={{ height: '70vh' }}>
          <SimpleTerminal
            worktreeId={params.id}
            cliToolId={selectedTool}
          />
        </div>

        {/* Instructions */}
        <div className="mt-4 p-4 bg-gray-800 rounded-lg text-gray-300 text-sm">
          <h3 className="font-semibold mb-2 text-white">使い方:</h3>
          <ul className="space-y-1">
            <li>• コマンドを入力して Enter キーで実行</li>
            <li>• ↑/↓ キーでコマンド履歴を表示</li>
            <li>• ^C ボタンで実行中のコマンドを中断</li>
            <li>• 自動的に3秒ごとに出力が更新されます</li>
            <li>• クイックコマンドボタンで頻繁に使うコマンドを実行</li>
          </ul>
        </div>
      </div>
    </div>
  );
}