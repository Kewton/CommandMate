/**
 * SlashCommandList Component
 *
 * Displays slash commands grouped by category
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';

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
  const t = useTranslations('worktree');
  // Calculate flat index for each command
  let flatIndex = 0;

  if (groups.length === 0) {
    return (
      <div className={`text-sm text-muted-foreground p-4 text-center ${className}`}>
        {t('slashCommands.empty')}
      </div>
    );
  }

  return (
    <div className={`overflow-y-auto ${className}`}>
      {groups.map((group) => (
        <div key={group.category} className="mb-2">
          {/* Category label */}
          <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted">
            {group.label}
          </div>

          {/* Commands in this category */}
          <div>
            {group.commands.map((command) => {
              const currentIndex = flatIndex;
              flatIndex++;
              const isHighlighted = currentIndex === highlightedIndex;

              return (
                /* Issue #1061: full-width text-left menu row — 残置 */
                <button
                  key={command.name}
                  type="button"
                  data-command-item
                  data-highlighted={isHighlighted}
                  onClick={() => onSelect(command)}
                  className={`w-full px-3 py-2 text-left flex items-start gap-2 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors ${
                    isHighlighted ? 'bg-accent-100 dark:bg-accent-900/40' : ''
                  }`}
                >
                  <span className="text-accent-600 dark:text-accent-400 font-mono text-sm flex-shrink-0">
                    {getSlashCommandTrigger(command)}
                  </span>
                  {command.cliTools?.length === 1 && command.cliTools[0] === 'codex' && (
                    <span className="mt-0.5 rounded border border-accent-200 bg-accent-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-700 dark:border-accent-800 dark:bg-accent-950/40 dark:text-accent-300">
                      Codex
                    </span>
                  )}
                  <span className="text-muted-foreground text-sm truncate">
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
