/**
 * SlashCommandSelector Component
 *
 * PC: Dropdown selector for slash commands
 * Mobile: Bottom sheet selector for slash commands
 */

'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { SlashCommandList } from './SlashCommandList';

export interface SlashCommandSelectorProps {
  /** Whether the selector is open */
  isOpen: boolean;
  /** Command groups to display */
  groups: SlashCommandGroup[];
  /** Callback when a command is selected */
  onSelect: (command: SlashCommand) => void;
  /** Callback to close the selector */
  onClose: () => void;
  /** Whether to render as mobile bottom sheet */
  isMobile?: boolean;
  /** Position for desktop dropdown */
  position?: { top: number; left: number };
}

/**
 * SlashCommandSelector component
 *
 * Renders as dropdown on desktop and bottom sheet on mobile
 *
 * @example
 * ```tsx
 * <SlashCommandSelector
 *   isOpen={showSelector}
 *   groups={groups}
 *   onSelect={handleSelect}
 *   onClose={() => setShowSelector(false)}
 *   isMobile={isMobile}
 * />
 * ```
 */
export function SlashCommandSelector({
  isOpen,
  groups,
  onSelect,
  onClose,
  isMobile = false,
  position,
}: SlashCommandSelectorProps) {
  const [filter, setFilter] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter groups based on search
  const filteredGroups = useMemo(() => {
    if (!filter.trim()) {
      return groups;
    }

    const lowerFilter = filter.toLowerCase();

    return groups
      .map((group) => ({
        ...group,
        commands: group.commands.filter((cmd) => {
          const nameMatch = cmd.name.toLowerCase().includes(lowerFilter);
          const descMatch = cmd.description.toLowerCase().includes(lowerFilter);
          return nameMatch || descMatch;
        }),
      }))
      .filter((group) => group.commands.length > 0);
  }, [groups, filter]);

  // Flat list for keyboard navigation
  const flatCommands = useMemo(() => {
    return filteredGroups.flatMap((group) => group.commands);
  }, [filteredGroups]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setFilter('');
      setHighlightedIndex(0);
      // Focus input after a short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle command selection
  const handleSelect = useCallback(
    (command: SlashCommand) => {
      onSelect(command);
      onClose();
    },
    [onSelect, onClose]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) =>
            Math.min(prev + 1, flatCommands.length - 1)
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatCommands[highlightedIndex]) {
            handleSelect(flatCommands[highlightedIndex]);
          }
          break;
      }
    },
    [isOpen, flatCommands, highlightedIndex, onClose, handleSelect]
  );

  // Add keyboard listener
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  if (!isOpen) {
    return null;
  }

  // Mobile: Bottom sheet
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* Bottom sheet */}
        <div
          data-testid="slash-command-bottom-sheet"
          className="fixed bottom-0 left-0 right-0 bg-white rounded-t-xl z-50 max-h-[70vh] flex flex-col shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h2 className="text-lg font-semibold">Commands</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-full hover:bg-gray-100"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-2 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search commands..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Command list */}
          <SlashCommandList
            groups={filteredGroups}
            onSelect={handleSelect}
            highlightedIndex={highlightedIndex}
            className="flex-1 overflow-y-auto pb-20"
          />
        </div>
      </>
    );
  }

  // Desktop: Dropdown
  return (
    <div
      role="listbox"
      className="absolute bg-white border border-gray-200 rounded-lg shadow-lg z-50 w-80 max-h-96 flex flex-col"
      style={position ? { top: position.top, left: position.left } : { bottom: '100%', left: 0, marginBottom: '4px' }}
    >
      {/* Search */}
      <div className="px-3 py-2 border-b border-gray-100">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search commands..."
          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* Command list */}
      <SlashCommandList
        groups={filteredGroups}
        onSelect={handleSelect}
        highlightedIndex={highlightedIndex}
        className="flex-1 overflow-y-auto"
      />

      {/* Keyboard hints */}
      <div className="px-3 py-1.5 border-t border-gray-100 text-xs text-gray-400 flex gap-3">
        <span>
          <kbd className="px-1 py-0.5 bg-gray-100 rounded">Enter</kbd> select
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-gray-100 rounded">Esc</kbd> close
        </span>
      </div>
    </div>
  );
}
