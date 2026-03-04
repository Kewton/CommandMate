/**
 * SlashCommandList Component
 *
 * Displays slash commands grouped by category
 */

'use client';

import React from 'react';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';

export interface SlashCommandListProps {
  /** Command groups to display */
  groups: SlashCommandGroup[];
  /** Callback when a command is selected */
  onSelect: (command: SlashCommand) => void;
  /** Currently highlighted index (for keyboard navigation) */
  highlightedIndex?: number;
  /** Optional className for the container */
  className?: string;
}

/**
 * SlashCommandList component
 *
 * Renders slash commands grouped by category with selection support
 *
 * @example
 * ```tsx
 * <SlashCommandList
 *   groups={groups}
 *   onSelect={(cmd) => console.log('Selected:', cmd.name)}
 *   highlightedIndex={0}
 * />
 * ```
 */
export function SlashCommandList({
  groups,
  onSelect,
  highlightedIndex = -1,
  className = '',
}: SlashCommandListProps) {
  // Calculate flat index for each command
  let flatIndex = 0;

  if (groups.length === 0) {
    return (
      <div className={`text-sm text-gray-500 p-4 text-center ${className}`}>
        No commands available
      </div>
    );
  }

  return (
    <div className={`overflow-y-auto ${className}`}>
      {groups.map((group) => (
        <div key={group.category} className="mb-2">
          {/* Category label */}
          <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-800">
            {group.label}
          </div>

          {/* Commands in this category */}
          <div>
            {group.commands.map((command) => {
              const currentIndex = flatIndex;
              flatIndex++;
              const isHighlighted = currentIndex === highlightedIndex;

              return (
                <button
                  key={command.name}
                  type="button"
                  data-command-item
                  data-highlighted={isHighlighted}
                  onClick={() => onSelect(command)}
                  className={`w-full px-3 py-2 text-left flex items-start gap-2 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 transition-colors ${
                    isHighlighted ? 'bg-cyan-100 dark:bg-cyan-900/40' : ''
                  }`}
                >
                  <span className="text-cyan-600 dark:text-cyan-400 font-mono text-sm flex-shrink-0">
                    /{command.name}
                  </span>
                  <span className="text-gray-600 dark:text-gray-300 text-sm truncate">
                    {command.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
